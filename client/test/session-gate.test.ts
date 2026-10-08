/**
 * session-gate.test.ts — issue #9 Part A: the client-as-router session gate.
 *
 * Real sockets end-to-end: the REAL loopback proxy + the REAL SessionGate +
 * a controllable fake upstream + the fake arbiter (sessions endpoints).
 *
 * Covers (issue #9 test plan):
 *   (a) /s/<tok>/v1/chat/completions forwards to the upstream as
 *       /v1/chat/completions (prefix stripped)
 *   (b) plain /v1/... passthrough is UNCHANGED with a gate attached
 *       (regression guard for the lease-gated job flow)
 *   (c) max=1: the second session's request PARKS; when the first finishes
 *       the second proceeds WITHOUT any client retry
 *   (d) pause override ⇒ held; unpause ⇒ proceeds (daemon-driven: override
 *       learned from the real /api/state poll)
 *   (e) hold cap exceeded ⇒ 503 + Retry-After; a retry after admission works
 *   (f) arbiter down at first sight ⇒ fail-open (request forwarded)
 *   (g) registration on first sight with token + client identity, throttled
 *       to ≤1 per 10s per session thereafter
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLlmProxy, waitProxyReady, type LlmProxy } from '../src/proxy.js';
import { SessionGate, sniffPhaseChunk, type SessionGateSnapshot, type SessionHistory, type SessionPhaseSnapshot } from '../src/session-gate.js';
import { ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * Upstream whose responses are released by hand: every request is recorded
 * (method/path/body) and stays open until release(n) answers it. This is
 * how a test makes a session "occupy a slot" deterministically.
 */
function startControllableUpstream(): Promise<{
  url: string;
  hits: { method: string; path: string; body: string }[];
  release: (n?: number) => void;
  close: () => Promise<void>;
}> {
  const hits: { method: string; path: string; body: string }[] = [];
  const waiting: Array<http.ServerResponse> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body });
      waiting.push(res);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        hits,
        release(n = 1) {
          for (let i = 0; i < n && waiting.length > 0; i++) {
            const res = waiting.shift()!;
            const hit = hits[Math.max(0, hits.length - n + i)];
            // #45: a real OpenAI-compatible response echoes the served
            // model + a usage block — the gate's response-side peek reads
            // them (a fixed stand-in when the body didn't parse).
            let model = 'resp-model';
            try { model = (JSON.parse(hit?.body || '{}') as { model?: string }).model ?? model; } catch { /* keep default */ }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-1', model, choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } }));
          }
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function postChat(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Gate wired to a register stub; returns the gate + call log. */
function makeGate(opts: {
  maxActive?: number;
  holdCapMs?: number;
  register?: (token: string, gate: SessionGateSnapshot | null, sessionId?: string, history?: SessionHistory, phase?: SessionPhaseSnapshot | null, lastActivity?: number) => Promise<boolean>;
  now?: () => number;
  clientName?: string;
} = {}): { gate: SessionGate; registered: string[]; calls: { token: string; gate: SessionGateSnapshot | null; sessionId?: string; history?: SessionHistory; phase?: SessionPhaseSnapshot | null; lastActivity?: number }[] } {
  const registered: string[] = [];
  const calls: { token: string; gate: SessionGateSnapshot | null; sessionId?: string; history?: SessionHistory; phase?: SessionPhaseSnapshot | null; lastActivity?: number }[] = [];
  const gate = new SessionGate({
    maxActive: opts.maxActive ?? 1,
    holdCapMs: opts.holdCapMs ?? 30_000,
    now: opts.now,
    clientName: opts.clientName,
    register:
      opts.register ??
      (async (token, gateSnapshot, sessionId, history, phase, lastActivity) => {
        registered.push(token);
        calls.push({ token, gate: gateSnapshot, sessionId, history, phase, lastActivity });
        return true;
      }),
  });
  return { gate, registered, calls };
}

async function harness(opts: { gate: SessionGate }): Promise<{ proxy: LlmProxy; up: Awaited<ReturnType<typeof startControllableUpstream>> }> {
  const up = await startControllableUpstream();
  cleanup.push(() => up.close());
  const proxy = startLlmProxy({ port: 0, target: up.url, gate: opts.gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  return { proxy, up };
}

// ---------------------------------------------------------------------------
// (a) + (b): path contract
// ---------------------------------------------------------------------------

test('(a) /s/<tok>/v1/chat/completions forwards to the engine as /v1/chat/completions', async () => {
  const { gate } = makeGate();
  const { proxy, up } = await harness({ gate });

  const resP = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'upstream hit');
  up.release();
  const res = await resP;
  assert.equal(res.status, 200);

  assert.equal(up.hits[0]!.path, '/v1/chat/completions', 'prefix stripped');
  assert.equal(up.hits[0]!.method, 'POST');
  assert.match(up.hits[0]!.body, /"model":"m"/, 'body forwarded verbatim');
});

test('(b) plain /v1/... passthrough is unchanged with a gate attached (job-flow regression guard)', async () => {
  const { gate, registered } = makeGate();
  const { proxy, up } = await harness({ gate });

  const resP = postChat(proxy.base_url, '/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'upstream hit');
  up.release();
  const res = await resP;
  assert.equal(res.status, 200);
  assert.equal(up.hits[0]!.path, '/v1/chat/completions');
  assert.deepEqual(registered, [], 'plain traffic never registers a session');

  // Root path keeps the current passthrough behavior too.
  const res2P = fetch(`${proxy.base_url}/`);
  await waitFor(() => up.hits.length === 2, 3000, 'root hit');
  up.release();
  const res2 = await res2P;
  assert.equal(res2.status, 200);
  assert.equal(up.hits[1]!.path, '/');
});

// ---------------------------------------------------------------------------
// (c) capacity + hold semantics
// ---------------------------------------------------------------------------

test('(c) max=1: second session parks; first finishing releases it with NO client retry', async () => {
  const { gate } = makeGate({ maxActive: 1 });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]); // arbiter reachable

  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'session A forwarded');

  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  // B must PARK: no upstream hit, gate reports it queued, and B's response
  // has not started (the agent's HTTP client just waits on the wire).
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.hits.length, 1, 'parked request never reached the engine');
  assert.equal(gate.queueDepth, 1, 'second session is queued');

  // First session finishes → slot frees → head of queue admitted as-is.
  up.release(1);
  assert.equal((await resA).status, 200);
  await waitFor(() => up.hits.length === 2, 3000, 'parked request forwarded on slot free');
  up.release(1);
  const rB = await resB;
  assert.equal(rB.status, 200, 'held request proceeds without a client retry');
  assert.equal(up.hits.length, 2);
  assert.equal(up.hits[1]!.path, '/v1/chat/completions');
  assert.equal(gate.queueDepth, 0);
});

// ---------------------------------------------------------------------------
// (e) hold cap
// ---------------------------------------------------------------------------

test('(e) hold cap exceeded ⇒ retryable 503 + Retry-After; retry after admission succeeds', async () => {
  const { gate } = makeGate({ maxActive: 1, holdCapMs: 250 });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]);

  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'session A forwarded');

  const resB = await postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  assert.equal(resB.status, 503, 'parked past the cap ⇒ retryable 503');
  const ra = Number(resB.headers.get('retry-after'));
  assert.ok(ra >= 15 && ra <= 20, `Retry-After ~15s + jitter, got ${ra}`);
  const body = (await resB.json()) as { error: string; retry?: boolean };
  assert.equal(body.error, 'session queued');
  assert.equal(body.retry, true);

  // First session finishes; the retry now finds a free slot and proceeds.
  up.release(1);
  await resA;
  const retryP = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'retry forwarded');
  up.release(1);
  const retry = await retryP;
  assert.equal(retry.status, 200);
});

// ---------------------------------------------------------------------------
// (f) fail-open
// ---------------------------------------------------------------------------

test('(f) arbiter down at first sight ⇒ fail-open (request forwarded, not held)', async () => {
  const { gate } = makeGate({
    maxActive: 1,
    register: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const { proxy, up } = await harness({ gate });

  // Even with capacity 1 and a session already in flight, a dead arbiter
  // must never wedge a second conversation.
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'B fail-open forwarded');
  up.release(2);
  assert.equal((await resA).status, 200);
  assert.equal((await resB).status, 200);
  assert.ok(gate.failOpen);
});

// ---------------------------------------------------------------------------
// (g) registration throttle (gate level, clock seam)
// ---------------------------------------------------------------------------

test('(g) registration fires on first sight, throttled to ≤1 per 10s per session', async () => {
  const clock = { t: 1_000_000 };
  const { gate, registered } = makeGate({ maxActive: 5, now: () => clock.t });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]);

  let hits = 0;
  // NOTE: send returns the response promise WRAPPED ({ res }) — an async
  // function's returned promise is recursively unwrapped by `await`, which
  // would block on the response before the test can release the upstream.
  const send = async (tok: string): Promise<{ res: Promise<Response> }> => {
    const res = postChat(proxy.base_url, `/s/${tok}/v1/chat/completions`);
    await waitFor(() => up.hits.length > hits, 3000, `forward for ${tok}`);
    hits = up.hits.length;
    return { res };
  };

  const r1 = await send('tokG');
  up.release();
  await r1.res;
  assert.deepEqual(registered, ['tokG'], 'first sight registers');

  // More traffic on the same session within the window: no re-register.
  const r2 = await send('tokG');
  up.release();
  await r2.res;
  assert.equal(registered.length, 1, 'throttled within 10s');

  // A different token registers independently.
  const r3 = await send('tokH');
  up.release();
  await r3.res;
  assert.deepEqual(registered, ['tokG', 'tokH']);

  // Past the window: the next request refreshes the heartbeat.
  clock.t += 10_001;
  const r4 = await send('tokG');
  up.release();
  await r4.res;
  await waitFor(() => registered.length === 3, 1000, 'throttled refresh after window');
  assert.equal(registered[2], 'tokG');
});

// ---------------------------------------------------------------------------
// Gate-state visibility: snapshot() + the gate block on the register wire
// ---------------------------------------------------------------------------

test('snapshot: active / queued / both / idle — the router queue truth', async () => {
  const { gate } = makeGate({ maxActive: 1 });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]);

  // Unknown token ⇒ null (nothing to report).
  assert.equal(gate.snapshot('tokNope'), null);

  // A holds the only slot (in flight, released by hand).
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  assert.deepEqual(gate.snapshot('tokA'), { state: 'active', waiting: 0 }, 'holding a slot ⇒ active');

  // B parks behind A ⇒ queued with its waiting count.
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 1000, 'B queued');
  assert.deepEqual(gate.snapshot('tokB'), { state: 'queued', waiting: 1, position: 1 }, 'parked ⇒ queued + count + 1st in line (#44)');

  // BOTH: pause A while it still holds the slot — its next request parks
  // behind the operator hold while inflight > 0 ⇒ active, count reported.
  gate.onStatePoll([{ token: 'tokA', override: { override: 'pause', until: null } }]);
  const resA2 = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(gate.snapshot('tokA'), { state: 'active', waiting: 1 }, 'inflight + parked ⇒ active with the count (no position — active holds a slot, not in the queue)');

  // Drain: A finishes, B is admitted, then A's parked request follows —
  // releases are sequential (each parked request only reaches the upstream
  // after the slot frees). After everything settles, both sessions are
  // idle ⇒ null (a session that stopped waiting must not stay tagged).
  gate.onStatePoll([]);
  up.release(1);
  assert.equal((await resA).status, 200);
  await waitFor(() => up.hits.length === 2, 3000, 'B admitted');
  up.release(1);
  assert.equal((await resB).status, 200);
  await waitFor(() => up.hits.length === 3, 3000, "A's parked request admitted");
  up.release(1);
  assert.equal((await resA2).status, 200);
  await waitFor(() => gate.snapshot('tokA') === null && gate.snapshot('tokB') === null, 2000, 'idle ⇒ null');
});

test('register calls carry the gate snapshot (active at refresh, queued while parked, null when idle)', async () => {
  const clock = { t: 2_000_000 };
  const { gate, calls } = makeGate({ maxActive: 1, now: () => clock.t });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]);

  // First sight registers BEFORE the request is forwarded ⇒ idle snapshot.
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  assert.deepEqual(calls[0], { token: 'tokA', gate: null, sessionId: undefined, history: undefined, phase: null, lastActivity: undefined }, 'first-sight register: no gate block, no traffic history yet, no phase (#67: the no-phase report rides every heartbeat), no observed request time yet (#76: the ring fills after this register)');

  // B first-sights and parks; its register fires at first sight (before
  // the park), so it is also gate-less — the REFRESH is what reports it.
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 1000, 'B queued');
  assert.equal(calls.length, 2);

  // Past the throttle window, the daemon-tick heartbeat re-registers BOTH
  // with their live snapshots: A active (holding), B queued (waiting 1).
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.length === 4, 1000, 'heartbeat registers');
  const byTok = new Map(calls.slice(2).map((c) => [c.token, c.gate]));
  assert.deepEqual(byTok.get('tokA'), { state: 'active', waiting: 0 });
  assert.deepEqual(byTok.get('tokB'), { state: 'queued', waiting: 1, position: 1 });

  // Drain everything (sequential releases — B only reaches the upstream
  // after A's slot frees); the next heartbeat then reports idle ⇒ null
  // (the body OMITS the gate block — the arbiter clears the stored gate).
  up.release(1);
  assert.equal((await resA).status, 200);
  await waitFor(() => up.hits.length === 2, 3000, 'B admitted');
  up.release(1);
  assert.equal((await resB).status, 200);
  await waitFor(() => gate.snapshot('tokB') === null, 2000, 'B idle');
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.filter((c) => c.token === 'tokB').length === 3, 1000, 'B heartbeat refresh');
  assert.equal(calls.filter((c) => c.token === 'tokB').at(-1)!.gate, null, 'idle ⇒ null snapshot');
});

test('register wire: the gate block rides the POST body and the arbiter stores + echoes it', async () => {
  // The daemon's register closure shape ({token, client identity, gate?})
  // POSTed to the fake arbiter — the wire contract between the two.
  const arb: FakeArbiter = await startFakeArbiter();
  cleanup.push(() => arb.close());
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${arb.url}/api/sessions/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.ok(res.status === 200 || res.status === 201, `register status ${res.status}`);
  };

  // First sight (idle): NO gate block on the wire (back-compat: an old
  // arbiter never sees the field).
  await post({ token: 'tokW', client_name: 'mac-w', last_activity: Date.now() });
  assert.deepEqual(arb.sessionRegisters[0]!.gate, undefined, 'idle heartbeat omits the gate key');

  // Parked heartbeat: the block rides verbatim.
  await post({ token: 'tokW', client_name: 'mac-w', last_activity: Date.now(), gate: { state: 'queued', waiting: 2 } });
  assert.deepEqual(arb.sessionGates.get('tokW'), { state: 'queued', waiting: 2 }, 'arbiter stores the block');
  const st = (await (await fetch(`${arb.url}/api/state`)).json()) as {
    sessions: { token: string; gate: unknown }[];
  };
  assert.deepEqual(st.sessions.find((x) => x.token === 'tokW')?.gate, { state: 'queued', waiting: 2 }, '/api/state echoes it');

  // Idle heartbeat again: no block ⇒ the stored gate CLEARS.
  await post({ token: 'tokW', client_name: 'mac-w', last_activity: Date.now() });
  assert.equal(arb.sessionGates.get('tokW'), null, 'absent gate clears the stored block');
});

// ---------------------------------------------------------------------------
// Daemon integration: (d) pause/unpause via the real /api/state poll,
// (g) registration carries client identity, via the real daemon wiring.
// ---------------------------------------------------------------------------

test('daemon integration: session registers with client identity; pause override holds, unpause proceeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-gate-'));
  const arb: FakeArbiter = await startFakeArbiter();
  const up = await startControllableUpstream();
  cleanup.push(() => arb.close());
  cleanup.push(() => up.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'test-client',
    ip: '100.94.165.102',
    proxy_port: 0,
    llm_target: up.url,
    aggregate_port: 0,
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [], // no lease work; the gate must be live from boot anyway
  };
  const logs: string[] = [];
  const daemon = new ClientDaemon(cfg, { pollMs: 50, log: { info: (m) => logs.push(m) } });
  cleanup.push(() => daemon.stop());
  await daemon.start();
  const baseUrl = daemon.proxyUrl;
  assert.ok(baseUrl, 'proxy up at boot (no lease needed)');

  // First request: forwarded, and the arbiter got a session registration
  // carrying the token AND the client identity.
  const r1p = postChat(baseUrl!, '/s/tokD/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'session forwarded');
  up.release();
  assert.equal((await r1p).status, 200);
  await waitFor(() => arb.sessionRegisters.length >= 1, 2000, 'session register POST');
  const reg = arb.sessionRegisters[0]!;
  assert.equal(reg.token, 'tokD');
  assert.equal(reg.client_id, 'c-test', 'client identity on registration');
  assert.equal(reg.client_name, 'test-client');

  // Operator pauses the session (arbiter-side override; the daemon learns it
  // from its /api/state poll).
  arb.setSessionOverride('tokD', 'pause');
  await waitFor(() => logs.some((l) => l.includes('session tokD override: none → pause')), 2000, 'override learned from poll');

  const r2p = postChat(baseUrl!, '/s/tokD/v1/chat/completions');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.hits.length, 1, 'paused session is HELD, not forwarded');
  assert.equal(daemon.sessionGate?.queueDepth, 1);

  // Unpause: the held request proceeds with no client retry.
  arb.setSessionOverride('tokD', null);
  await waitFor(() => logs.some((l) => l.includes('session tokD override: pause → none')), 2000, 'unpause learned');
  await waitFor(() => up.hits.length === 2, 2000, 'held request forwarded on unpause');
  up.release();
  assert.equal((await r2p).status, 200, 'unpause releases the hold transparently');
});

// ---------------------------------------------------------------------------
// (h) #54 fleet adoption — arbiter session rows name their owner
// ---------------------------------------------------------------------------

test('(h) a session row owned by ANOTHER client is not adopted (fleet)', async () => {
  const { gate, registered } = makeGate({ maxActive: 1, clientName: 'urza' });
  // mac-sam owns tokMac (its gate tag is live there); urza owns tokMine;
  // tokOld predates #50 mesh attribution (no owner named) → adopted.
  gate.onStatePoll([
    { token: 'tokMac', client_name: 'mac-sam' },
    { token: 'tokMine', client_name: 'urza' },
    { token: 'tokOld' },
  ]);
  gate.heartbeat(); // what the daemon tick does for adopted rows
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(registered.sort(), ['tokMine', 'tokOld'], 'foreign-owned row never registered; own + ownerless adopted');
  assert.equal(gate.snapshot('tokMac'), null, 'foreign row never enters local tracking');
});

// ---------------------------------------------------------------------------
// #41 — gate posture on the register heartbeat: the router publishes its
// OWN armed-vs-fail_open state so the operator's surfaces can say whether
// the slot cap is actually in force. `armed` while the link is up;
// `fail_open` after onLinkDown (the arbiter-unreachable path the daemon
// already drives). A daemon with the gate DISABLED (session_gate: false)
// reports NOTHING — there is no gate to have a posture.
// ---------------------------------------------------------------------------

test('#41 posture on the wire: armed while the link is up, fail_open after the link drops', async () => {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-posture-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'posture-client',
    ip: '',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    aggregate_port: 0,
    repo_root: dir,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
  };
  try {
    const d = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
    await d.start();
    // The gate is ON by default; the proxy (which builds it) comes up in
    // start(), so within a couple of 50ms ticks a register carries the key.
    await waitFor(
      () => arb.registers.some((b) => b.gate_posture === 'armed'),
      3000,
      'a register body with gate_posture=armed',
    );
    // The fake arbiter going dark is the daemon's fail-open path: the next
    // state poll fails, onLinkDown flips the flag, the NEXT register says
    // fail_open. (Stop the arbiter — the exact production failure mode.)
    await arb.close();
    await waitFor(
      () => (d.sessionGate ? d.sessionGate.failOpen : false),
      5000,
      'the gate flipped to fail-open after the arbiter died',
    );
    // Note: registers now fail (the arbiter is down) — the posture rides
    // the LAST register that got through, so prove the getter contract here
    // and let the server-side test cover storage. The surfaces read the
    // last-known posture, which is the honest posture at link-death time.
    assert.ok(d.sessionGate?.failOpen, 'failOpen true while the arbiter is unreachable');
    await d.stop();
  } finally {
    await arb.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#41 posture key absent when the session gate is disabled (no gate = no posture)', async () => {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-nogate-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'nogate-client',
    ip: '',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    aggregate_port: 0,
    repo_root: dir,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
    session_gate: false,
  };
  try {
    const d = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
    await d.start();
    await waitFor(() => arb.registers.length >= 2, 3000, 'two registers');
    for (const b of arb.registers) {
      assert.ok(!('gate_posture' in b), 'a gate-less daemon never sends the key');
    }
    assert.equal(d.sessionGate, null, 'no gate built at all');
    await d.stop();
  } finally {
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #42 Slice 0 — the router captures X-Hermes-Session-Id per request and
// publishes it on the register heartbeat (ADD-key). Sanitizer posture:
// bounded printable (≤128 chars, no control chars) — an invalid header is
// DROPPED, admission never changes, and a stored id never clears from a
// later headerless request (last-known-wins).
// ---------------------------------------------------------------------------

test('#42 header capture: the id reaches the register heartbeat; a headerless later request never clears it', async () => {
  const clock = { t: 2_000_000 };
  const { gate, calls } = makeGate({ now: () => clock.t });
  const { proxy, up } = await harness({ gate });

  const resP = fetch(`${proxy.base_url}/s/tokId/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hermes-session-id': '20261005_172826_f38167' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await waitFor(() => up.hits.length === 1, 3000, 'upstream hit');
  up.release(1);
  const res = await resP;
  assert.equal(res.status, 200);
  // touch() runs BEFORE the first-sight register, so the very first
  // heartbeat on the token already carries the captured id.
  await waitFor(() => calls.some((c) => c.token === 'tokId' && c.sessionId === '20261005_172826_f38167'), 3000, 'the captured id on a register call');

  // A headerless follow-up on the SAME token: forwarded exactly as before,
  // and the NEXT heartbeat (past the 10s throttle, via the daemon tick)
  // still carries the stored id — last-known-wins.
  const res2P = postChat(proxy.base_url, '/s/tokId/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'second upstream hit');
  up.release(1);
  const res2 = await res2P;
  assert.equal(res2.status, 200);
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.filter((c) => c.token === 'tokId').length >= 2, 3000, 'a second register heartbeat on the token');
  const last = calls.filter((c) => c.token === 'tokId').at(-1)!;
  assert.equal(last.sessionId, '20261005_172826_f38167', 'the headerless request never cleared the stored id');
});

test('#42 header sanitizer: an oversized header is dropped, the request forwards exactly as before', async () => {
  const { gate, calls } = makeGate();
  const { proxy, up } = await harness({ gate });

  const resP = fetch(`${proxy.base_url}/s/tokHuge/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hermes-session-id': 'x'.repeat(300) },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await waitFor(() => up.hits.length === 1, 3000, 'upstream hit');
  up.release(1);
  const res = await resP;
  assert.equal(res.status, 200, 'an oversized id never blocks admission');
  await waitFor(() => calls.some((c) => c.token === 'tokHuge'), 3000, 'the register call');
  const c = calls.find((x) => x.token === 'tokHuge')!;
  assert.equal(c.sessionId, undefined, 'the oversized value is DROPPED, not truncated');
});

test('#42 no header at all: the register heartbeat omits the id (old behavior intact)', async () => {
  const { gate, calls } = makeGate();
  const { proxy, up } = await harness({ gate });
  const resP = postChat(proxy.base_url, '/s/tokPlain/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'upstream hit');
  up.release(1);
  const res = await resP;
  assert.equal(res.status, 200);
  await waitFor(() => calls.some((c) => c.token === 'tokPlain'), 3000, 'the register call');
  const c = calls.find((x) => x.token === 'tokPlain')!;
  assert.equal(c.sessionId, undefined, 'headerless sessions carry no id');
});

// ---------------------------------------------------------------------------
// #43 — the register heartbeat publishes the port the proxy ACTUALLY bound
// (config proxy_port may be 0 = ephemeral, so only the daemon knows). The
// Sessions surface needs it to hand over the exact /model line.
// ---------------------------------------------------------------------------

test('#43 register heartbeat carries proxy_port once the proxy binds', async () => {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-proxyport-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'port-client',
    ip: '',
    proxy_port: 0, // ephemeral — the row must carry the REAL bound port
    llm_target: 'http://127.0.0.1:1',
    aggregate_port: 0,
    repo_root: dir,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
  };
  try {
    const d = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
    await d.start();
    const bound = Number(new URL(d.proxyUrl!).port);
    assert.ok(bound > 0, 'the proxy bound a real port');
    // The first register precedes ensureProxy; a heartbeat within a couple
    // of 50ms ticks must carry the key.
    await waitFor(
      () => arb.registers.some((b) => b.proxy_port === bound),
      3000,
      `a register body with proxy_port=${bound}`,
    );
    await d.stop();
  } finally {
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#44 queue position on the wire: three parked sessions carry 1-based FIFO places', async () => {
  const clock = { t: 5_000_000 };
  const { gate, calls } = makeGate({ maxActive: 1, now: () => clock.t });
  const { proxy, up } = await harness({ gate });

  const resA = postChat(proxy.base_url, '/s/posA/v1/chat/completions'); // takes the slot
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  const resB = postChat(proxy.base_url, '/s/posB/v1/chat/completions'); // parks first
  const resC = postChat(proxy.base_url, '/s/posC/v1/chat/completions'); // parks second
  await waitFor(() => gate.queueDepth === 2, 2000, 'B and C queued');

  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.filter((c) => c.gate?.state === 'queued').length >= 2, 3000, 'queued heartbeats');
  const pos = (tok: string) => calls.filter((c) => c.token === tok).at(-1)!.gate?.position;
  assert.equal(pos('posB'), 1, 'B parked first ⇒ 1st in line');
  assert.equal(pos('posC'), 2, 'C parked second ⇒ 2nd in line');
  assert.equal(calls.filter((c) => c.token === 'posA').at(-1)!.gate?.position, undefined, 'the session HOLDING the slot reports no position');

  // Drain (sequential releases); nothing wedged, the parked path unchanged.
  up.release(1);
  assert.equal((await resA).status, 200);
  await waitFor(() => up.hits.length === 2, 3000, 'B admitted');
  up.release(1);
  assert.equal((await resB).status, 200);
  await waitFor(() => up.hits.length === 3, 3000, 'C admitted');
  up.release(1);
  assert.equal((await resC).status, 200);
});

test('#45 session history on the wire: request ring + response-sniffed model/tokens reach the heartbeat', async () => {
  const clock = { t: 90_000_000 };
  const { gate, calls } = makeGate({ maxActive: 1, now: () => clock.t });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]); // arbiter reachable

  // A chat-completions request on a session path: the ring counts it, the
  // response echo carries the model, the usage block carries total_tokens.
  const resP = postChat(proxy.base_url, '/s/hist1/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'hit forwarded');
  up.release(1);
  assert.equal((await resP).status, 200);

  clock.t += 10_001; // past the heartbeat throttle
  gate.heartbeat();
  await waitFor(() => calls.some((c) => c.token === 'hist1' && c.history), 3000, 'history heartbeat');
  const last = calls.filter((c) => c.token === 'hist1').at(-1)!;
  assert.ok(last.history, 'the heartbeat carries the history ADD-key');
  assert.equal(last.history!.rpm.length, 10, 'exactly 10 per-minute buckets');
  assert.equal(last.history!.rpm.at(-1), 1, 'the newest minute counted this request');
  assert.equal(last.history!.model, 'm', 'the model came from the upstream response echo');
  assert.equal(last.history!.tokens, 42, 'the token total came from the streamed usage block');

  // A parked request still counts (the router saw it even if it waits).
  const resA = postChat(proxy.base_url, '/s/hist2/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'hist2 takes the slot');
  const resB = postChat(proxy.base_url, '/s/hist3/v1/chat/completions'); // parked (cap=1)
  await waitFor(() => gate.queueDepth === 1, 2000, 'hist3 parked');
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.some((c) => c.token === 'hist3' && c.history), 3000, 'parked hist3 history');
  assert.ok((calls.filter((c) => c.token === 'hist3').at(-1)!.history!.rpm.at(-1) ?? 0) >= 1, 'parked request counted in the ring');

  up.release(1);
  assert.equal((await resA).status, 200);
  await waitFor(() => up.hits.length === 3, 3000, 'hist3 admitted');
  up.release(1);
  assert.equal((await resB).status, 200);
});

test('#76 last_activity on the wire: the newest REQUEST time, never the heartbeat tick (the inflation fix)', async () => {
  const clock = { t: 200_000_000 };
  const { gate, calls } = makeGate({ maxActive: 1, now: () => clock.t });
  const { proxy, up } = await harness({ gate });
  gate.onStatePoll([]); // arbiter reachable

  // Request at t=200s. The first register fires inside the request path —
  // before recordRequest pushes the ring entry. The daemon maps that
  // ring-less report to its own clock (index.ts: lastActivity ?? Date.now()),
  // the pre-#76 posture for a token the router has not seen yet.
  const resP = postChat(proxy.base_url, '/s/lact1/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'hit forwarded');
  up.release(1);
  assert.equal((await resP).status, 200);
  await waitFor(() => calls.some((c) => c.token === 'lact1'), 3000, 'first register');
  const first = calls.filter((c) => c.token === 'lact1').at(0)!;
  assert.equal(first.lastActivity, undefined, 'ring-less first sight reports no observed request time');

  // The ring now holds the request instant. The HEARTBEAT (a 10s tick, no
  // traffic) must report THAT time — not the tick's own clock. The old
  // Date.now() stamp + the arbiter's max-keep pinned every row to "now".
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.filter((c) => c.token === 'lact1').length >= 2, 3000, 'heartbeat register');
  const hb = calls.filter((c) => c.token === 'lact1').at(-1)!;
  assert.equal(hb.lastActivity, 200_000_000, 'the heartbeat reports the request instant (the ring entry)');
  assert.notEqual(hb.lastActivity, clock.t, 'never the tick time (the old inflation)');

  // A newer request updates the ring → the next heartbeat reports it.
  const resP2 = postChat(proxy.base_url, '/s/lact1/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'second hit forwarded');
  up.release(1);
  assert.equal((await resP2).status, 200);
  clock.t += 10_001;
  gate.heartbeat();
  await waitFor(() => calls.filter((c) => c.token === 'lact1').length >= 3, 3000, 'heartbeat register 2');
  const hb2 = calls.filter((c) => c.token === 'lact1').at(-1)!;
  assert.equal(hb2.lastActivity, 200_010_001, 'the newer request instant wins');

  // A poll-adopted token (the arbiter reports a row the router never saw —
  // no local ring) reports undefined on its first heartbeat. The caller
  // falls back to its own clock — the pre-#76 posture for that row.
  gate.onStatePoll([{ token: 'lact2' }]);
  gate.heartbeat();
  await waitFor(() => calls.some((c) => c.token === 'lact2'), 3000, 'adopted session heartbeat');
  const adopted = calls.filter((c) => c.token === 'lact2').at(-1)!;
  assert.equal(adopted.lastActivity, undefined, 'no local ring ⇒ undefined (the caller clock stands)');
});

// ---------------------------------------------------------------------------
// #67 — the response-phase sniffer on the wire + the engine-pin plane in
// the gate (poll-learned state, release-time resolution shape, fail-quiet).
// ---------------------------------------------------------------------------

/** A hand-streamed SSE engine: frames ride out only when the test says so. */
async function startSseEngine(): Promise<{
  url: string;
  started: Promise<void>;
  send: (frame: string) => void;
  end: () => void;
  close: () => Promise<void>;
}> {
  let stream: http.ServerResponse | null = null;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((r) => { markStarted = r; });
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    stream = res;
    markStarted();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    started,
    send: (frame) => { stream!.write(frame); },
    end: () => { stream!.end(); stream = null; },
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

test('#67 phase sniffer (unit): the delta classes the visual contract names, and nothing else becomes a phase', () => {
  assert.equal(sniffPhaseChunk('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}'), 'thinking');
  assert.equal(sniffPhaseChunk('data: {"choices":[{"delta":{"content":"hello"}}]}'), 'output');
  assert.equal(sniffPhaseChunk('data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}'), 'tools');
  // A delta that carries content AND tool_calls classifies tools (the tie order).
  assert.equal(sniffPhaseChunk('data: {"choices":[{"delta":{"content":"","tool_calls":[{}]}}]}'), 'tools');
  // Buffers work like strings.
  assert.equal(sniffPhaseChunk(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}')), 'output');
  // No delta row ⇒ no phase, ever: role row, [DONE], keep-alive, plain JSON, empty delta, empty.
  for (const junk of [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    'data: [DONE]',
    ': keep-alive\n\n',
    '{"id":"chatcmpl-1","choices":[{"message":{"content":"hi"}}]}',
    'data: {"choices":[{"delta":{}}]}',
    '',
  ]) {
    assert.equal(sniffPhaseChunk(junk), undefined, `no invented phase for ${JSON.stringify(junk)}`);
  }
});

test('#67 phase on the wire: heartbeats carry the live SSE phase and clear it at settle — the observer never steals a byte', async () => {
  const sse = await startSseEngine();
  const clock = { t: 91_000_000 };
  const { gate, calls } = makeGate({ maxActive: 1, now: () => clock.t });
  // A server whose handler runs gate.route with a seam that pipes the SSE
  // engine into res — byte-for-byte what the proxy/aggregate forward seam
  // does — so the gate's pipe-attached sniffer sees the frames as they
  // flow to the client.
  const srv = http.createServer((req, res) => {
    const m = /^\/s\/([^/]+)/.exec(req.url ?? '');
    const token = m?.[1] ?? 'x';
    const path = (req.url ?? '').replace(/^\/s\/[^/]+/, '');
    const seam = () => {
      const u = new URL(sse.url + path);
      const up = http.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: { 'content-type': 'application/json' } },
        (upr) => {
          res.writeHead(upr.statusCode ?? 200, upr.headers);
          upr.pipe(res);
        },
      );
      req.pipe(up);
    };
    gate.route(req, res, token, path, seam);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  gate.onStatePoll([]);
  const resP = fetch(`${base}/s/ph1/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await waitFor(() => calls.some((c) => c.token === 'ph1'), 3000, 'ph1 registered');
  await sse.started; // the seam dialed the engine; frames now reach a live stream

  // Unclassifiable frames change nothing; the reasoning frame stamps 'thinking'.
  sse.send('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n');
  sse.send('data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking hard"}}]}\n\n');
  await waitFor(() => {
    clock.t += 10_001;
    gate.heartbeat();
    return calls.filter((c) => c.token === 'ph1').length >= 2 && calls.filter((c) => c.token === 'ph1').at(-1)!.phase?.state === 'thinking';
  }, 3000, 'heartbeat carrying the thinking phase');
  const hb = calls.filter((c) => c.token === 'ph1').at(-1)!;
  assert.ok(hb.phase && typeof hb.phase.at === 'number' && hb.phase.at <= clock.t, 'the phase block carries its observation instant');

  // Visible output: last write wins.
  sse.send('data: {"choices":[{"index":0,"delta":{"content":"the answer"}}]}\n\n');
  await waitFor(() => {
    clock.t += 10_001;
    gate.heartbeat();
    return calls.filter((c) => c.token === 'ph1').length >= 3 && calls.filter((c) => c.token === 'ph1').at(-1)!.phase?.state === 'output';
  }, 3000, 'heartbeat carrying the output phase');

  // Settle: the stream ends; the next heartbeat reports the no-phase block
  // (null — the arbiter CLEARS the stored phase on that report).
  sse.send('data: [DONE]\n\n');
  sse.end();
  const r = await resP;
  const text = await r.text();
  assert.ok(text.includes('thinking hard') && text.includes('the answer') && text.includes('[DONE]'),
    'every SSE byte reached the client — the sniffer copies, never consumes');
  await waitFor(() => {
    clock.t += 10_001;
    gate.heartbeat();
    return calls.filter((c) => c.token === 'ph1').length >= 4 && calls.filter((c) => c.token === 'ph1').at(-1)!.phase === null;
  }, 3000, 'settled session reports the no-phase block');
});

/** An eager engine: answers every request immediately (echoes the marker). */
async function startEagerEngine(marker: string): Promise<{
  url: string;
  hits: { path: string; body: string }[];
  close: () => Promise<void>;
}> {
  const hits: { path: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-e', model: marker, choices: [{ message: { content: marker } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    hits,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

test('#67 pin: a late-bound seam + the learned pin resolve at RELEASE time (the gate half of the queued switch)', async () => {
  // The gate contract the aggregate relies on: route() stores the seam on
  // the PARK, onStatePoll learns the pin, and admission calls the seam —
  // which resolves the engine AT CALL TIME. A pin arriving mid-park changes
  // where the parked request GOES without touching queue order or re-reading
  // the body. (The aggregate test proves the end-to-end engine landing.)
  const engineA = await startControllableUpstream();
  const engineB = await startEagerEngine('pinned-engine'); // answers at once: the parked request completes on B
  cleanup.push(() => engineA.close());
  const clock = { t: 93_000_000 };
  const { gate } = makeGate({ maxActive: 1, now: () => clock.t });

  const srv = http.createServer((req, res) => {
    const m = /^\/s\/([^/]+)/.exec(req.url ?? '');
    const token = m?.[1] ?? 'x';
    const path = (req.url ?? '').replace(/^\/s\/[^/]+/, '');
    const seam = () => {
      const pin = gate.pinFor(token); // resolved AT CALL TIME (pinnedEntryFor shape)
      const base = pin ? pin.url : engineA.url;
      const u = new URL(base + path);
      const up = http.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: { 'content-type': 'application/json' } },
        (upr) => {
          res.writeHead(upr.statusCode ?? 200, upr.headers);
          upr.pipe(res);
        },
      );
      req.pipe(up);
    };
    gate.route(req, res, token, path, seam);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  gate.onStatePoll([]);
  const post = (token: string) => fetch(`${base}/s/${token}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'switch-me' }),
  });

  // Two sessions: tokA takes the one slot (engine A, held), tokB PARKS
  // behind the cap — a session never queues behind its own traffic.
  const res1 = post('tokA');
  await waitFor(() => engineA.hits.length === 1, 3000, 'tokA forwarded to A');
  const res2 = post('tokB');
  await waitFor(() => gate.queueDepth === 1, 2000, 'tokB parked');

  // The pin lands on the parked session (the running one is fenced).
  gate.onStatePoll([{ token: 'tokB', engine_pin: { server_id: 'srv-b', url: engineB.url, set_at: 1 } }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gate.queueDepth, 1, 'the pin alone never releases the park');
  assert.equal(engineB.hits.length, 0, 'the pin alone never dispatches');

  engineA.release(1);
  const [r1, r2] = await Promise.all([res1, res2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, 'one parked request = one continuous response — no retry, no 503');
  assert.equal(engineA.hits.length, 1, 'the running request never moved (fence)');
  assert.equal(engineB.hits.length, 1, 'the parked request resolved the pin at release');
  assert.equal(JSON.parse(engineB.hits[0]!.body).model, 'switch-me', 'the parked body arrived whole');
});

test('#67 pin: absent/malformed engine_pin blocks learn nothing (fail-quiet); a disappearing block clears the pin', () => {
  const { gate } = makeGate();
  gate.onStatePoll([
    { token: 't1', engine_pin: { server_id: 'srv-a', url: 'http://e:1', set_at: 1 } },
    { token: 't2', engine_pin: { server_id: '', url: 'http://e:1', set_at: 1 } },
    { token: 't3', engine_pin: { server_id: 'srv-a', url: 8080 as never, set_at: 1 } },
    { token: 't4', engine_pin: 'pinned' as never },
    { token: 't5', engine_pin: { server_id: 'srv-a', url: 'http://e:1', engine_model: 'row-id', set_at: 1 } },
  ]);
  assert.equal(gate.pinFor('t1')?.server_id, 'srv-a');
  assert.equal(gate.pinFor('t2'), null, 'an empty server_id never learns a pin');
  assert.equal(gate.pinFor('t3'), null, 'a block whose url is not a string never learns a pin');
  assert.equal(gate.pinFor('t4'), null, 'a non-object block never learns a pin');
  assert.equal(gate.pinFor('t5')?.engine_model, 'row-id', 'the splice key rides through untouched');
  gate.onStatePoll([{ token: 't1' }]);
  assert.equal(gate.pinFor('t1'), null, 'the pin clears when the arbiter stops publishing it');
});

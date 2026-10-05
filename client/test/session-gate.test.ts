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
import { SessionGate, type SessionGateSnapshot } from '../src/session-gate.js';
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
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] }));
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
  register?: (token: string, gate: SessionGateSnapshot | null) => Promise<boolean>;
  now?: () => number;
  clientName?: string;
} = {}): { gate: SessionGate; registered: string[]; calls: { token: string; gate: SessionGateSnapshot | null }[] } {
  const registered: string[] = [];
  const calls: { token: string; gate: SessionGateSnapshot | null }[] = [];
  const gate = new SessionGate({
    maxActive: opts.maxActive ?? 1,
    holdCapMs: opts.holdCapMs ?? 30_000,
    now: opts.now,
    clientName: opts.clientName,
    register:
      opts.register ??
      (async (token, gateSnapshot) => {
        registered.push(token);
        calls.push({ token, gate: gateSnapshot });
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
  assert.deepEqual(gate.snapshot('tokB'), { state: 'queued', waiting: 1 }, 'parked ⇒ queued + count');

  // BOTH: pause A while it still holds the slot — its next request parks
  // behind the operator hold while inflight > 0 ⇒ active, count reported.
  gate.onStatePoll([{ token: 'tokA', override: { override: 'pause', until: null } }]);
  const resA2 = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(gate.snapshot('tokA'), { state: 'active', waiting: 1 }, 'inflight + parked ⇒ active with the count');

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
  assert.deepEqual(calls[0], { token: 'tokA', gate: null }, 'first-sight register: no gate block yet');

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
  assert.deepEqual(byTok.get('tokB'), { state: 'queued', waiting: 1 });

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

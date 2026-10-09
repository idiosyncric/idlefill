/**
 * session-control.test.ts — #46: the true-pause interrupt half.
 *
 * The loopback control surface (POST /sessions/<token>/release) on the
 * REAL proxy + REAL SessionGate, end to end on real sockets.
 *
 * The gate HOLDS a parked session's requests (the agent's HTTP client waits
 * on the wire), so inside Hermes a paused / over-capacity turn looks like
 * "thinking" forever. The release route answers that parked request with
 * the retryable 503 + Retry-After the hold-cap contract already defines and
 * frees the queue slot — the idlefill half of "stop thinking, not just
 * stall the next call".
 *
 * Covers:
 *   (r1) the `waitSince` ADD-key: a PARKED session's gate snapshot carries
 *        the hold's anchor instant (the age the dashboard + 503 render
 *        from it); an ACTIVE session's snapshot does NOT (no age); and the
 *        key rides the register heartbeat (the ADD-key on the wire).
 *   (r2) release a PARKED hold (over-capacity): the response resolves to
 *        the retryable 503 + Retry-After (the hold-cap body, one shape),
 *        and the queue slot is freed (the gate no longer counts it queued).
 *   (r3) release is IDEMPOTENT + a no-op on an unknown / already-settled
 *        token: 200 { ok:true, released:0 }, never an error, and it never
 *        touches another session's parked hold.
 *   (r4) auth is FAIL-CLOSED: a WRONG / missing token is a 401 and a NO-OP
 *        — the parked hold stays parked (queue still 1, the request has
 *        NOT been answered), so a bad token can never release a hold.
 *   (r5) method guard: a GET on the release path is a 405 (a mistaken
 *        fetch is visible, not a silent no-op); the path is distinct from
 *        the /s/<token> session passthrough and /sessions/<token>/transcript.
 *   (r6) the control write never reaches the LLM target (it is answered on
 *        the loopback bind before passthrough).
 *
 * Honest limits (stated so the surface doesn't over-promise): the release
 * does NOT interrupt in-flight traffic and does NOT clear the operator
 * pause override — it answers the PARKED request and frees the slot. That
 * is the idlefill half; the in-Hermes "/stop" of a truly in-flight turn is
 * a Hermes-side hook (see the issue #46 report).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startLlmProxy, waitProxyReady, type LlmProxy } from '../src/proxy.js';
import { SessionGate, type SessionGateSnapshot } from '../src/session-gate.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** The control token the proxy will compare against X-Idlefill-Edit. */
const CONTROL_TOKEN = 'test-control-token';

/** A controllable upstream: every request is recorded and held open until
 *  release() — the deterministic way to make a session occupy a slot. */
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
            let model = 'resp-model';
            try {
              model = (JSON.parse(hit?.body || '{}') as { model?: string }).model ?? model;
            } catch {
              /* keep default */
            }
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

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function postChat(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

/** A gate with a register stub that records every heartbeat's gate block. */
function makeGate(opts: { maxActive?: number; holdCapMs?: number; heartbeatMs?: number } = {}): {
  gate: SessionGate;
  calls: { token: string; gate: SessionGateSnapshot | null }[];
} {
  const calls: { token: string; gate: SessionGateSnapshot | null }[] = [];
  const gate = new SessionGate({
    maxActive: opts.maxActive ?? 1,
    holdCapMs: opts.holdCapMs ?? 30_000,
    heartbeatMs: opts.heartbeatMs,
    log: () => {},
    register: async (token, gateSnapshot) => {
      calls.push({ token, gate: gateSnapshot });
      return true;
    },
  });
  return { gate, calls };
}

/**
 * A FULLY WIRed harness: REAL proxy with BOTH a real SessionGate (so
 * /s/<token> traffic parks) and the sessionControl surface (so
 * /sessions/<token>/release is answered on the loopback bind). The control
 * token is the one the proxy compares against X-Idlefill-Edit.
 */
async function controlHarness(): Promise<{
  proxy: LlmProxy;
  up: Awaited<ReturnType<typeof startControllableUpstream>>;
  gate: SessionGate;
  calls: { token: string; gate: SessionGateSnapshot | null }[];
}> {
  const up = await startControllableUpstream();
  cleanup.push(() => up.close());
  const { gate, calls } = makeGate({ maxActive: 1 });
  const proxy = startLlmProxy({
    port: 0,
    target: up.url,
    gate,
    sessionControl: { token: CONTROL_TOKEN, gate },
  });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  return { proxy, up, gate, calls };
}

async function postRelease(baseUrl: string, token: string, controlToken: string): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${encodeURIComponent(token)}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idlefill-edit': controlToken },
  });
}

// ---------------------------------------------------------------------------
// (r1) the waitSince ADD-key on the gate snapshot + register heartbeat
// ---------------------------------------------------------------------------
test('(r1) a parked session carries waitSince (the hold anchor); an active one does not; a park on an already-registered session rides the wire right away', async () => {
  // A long heartbeat window: the queued state must ride via the PARK
  // TRANSITION (not a tick), so this isolates that channel.
  const { gate, calls } = makeGate({ maxActive: 1, heartbeatMs: 999_999 });
  const up = await startControllableUpstream();
  cleanup.push(() => up.close());
  const proxy = startLlmProxy({ port: 0, target: up.url, gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  gate.onStatePoll([]); // arbiter reachable

  // B takes the only slot first (forwarded, not parked) and completes: it
  // becomes a REGISTERED + idle session (the common "session already known"
  // state — the acceptance case for #46).
  const resB0 = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'B forwarded');
  await waitFor(() => calls.some((c) => c.token === 'tokB'), 3000, 'B first-sight register resolves (registered)');
  up.release(1);
  assert.equal((await resB0).status, 200);

  // A now holds the slot (in flight). Its snapshot is active, NO age (a
  // holder is not waiting — the waitSince key is absent by construction).
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 2, 3000, 'A forwarded');
  const snapA = gate.snapshot('tokA');
  assert.deepEqual(snapA, { state: 'active', waiting: 0 }, 'in-flight ⇒ active, no waitSince');

  // B (already registered) sends a request → it PARKS. Because the session
  // is registered and this is its first hold, the #46 park-transition
  // register rides the arbiter right away (within one poll window, not the
  // 10s heartbeat) carrying the queued snapshot + the waitSince anchor.
  const callsBefore = calls.length;
  const resB2 = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1 && gate.snapshot('tokB')?.state === 'queued', 3000, 'B parked');
  const snapB = gate.snapshot('tokB');
  assert.equal(snapB?.state, 'queued');
  assert.equal(snapB?.waiting, 1);
  assert.equal(typeof snapB?.waitSince, 'number', 'a queued snapshot carries the waitSince anchor (#46)');
  assert.ok((snapB?.waitSince ?? 0) > 0 && (snapB?.waitSince ?? 0) <= Date.now(), 'waitSince is a plausible epoch-ms instant');

  await waitFor(
    () =>
      calls
        .slice(callsBefore)
        .some((c) => c.token === 'tokB' && c.gate?.state === 'queued' && typeof c.gate?.waitSince === 'number'),
    2000,
    'the park-transition register carries waitSince (rides right away, not the heartbeat)',
  );
  const wireB = calls
    .slice(callsBefore)
    .find((c) => c.token === 'tokB' && c.gate?.state === 'queued');
  assert.equal(typeof wireB?.gate?.waitSince, 'number', 'the wire carries the hold anchor (ADD-key)');
  assert.equal(wireB?.gate?.waitSince, snapB?.waitSince, 'the wire instant matches the snapshot instant');

  // Release B's hold; settle A so everything closes.
  gate.releaseHold('tokB');
  up.release(1);
  await resA;
  await resB2;
});

// ---------------------------------------------------------------------------
// (r2) release a parked hold: the request resolves to the retryable 503 +
//      Retry-After, and the queue slot is freed
// ---------------------------------------------------------------------------
test('(r2) releasing a parked hold answers the request with the hold-cap 503 + Retry-After and frees the queue slot', async () => {
  const { proxy, up, gate } = await controlHarness();
  gate.onStatePoll([]);

  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');

  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 3000, 'B parked');
  assert.equal(up.hits.length, 1, 'B parked — never reached the engine');

  // Release B's hold with the CONTROL token.
  const rel = await postRelease(proxy.base_url, 'tokB', CONTROL_TOKEN);
  assert.equal(rel.status, 200, 'authed release is a 200');
  const relBody = (await rel.json()) as { ok: boolean; released: number };
  assert.equal(relBody.ok, true);
  assert.equal(relBody.released, 1, 'the one parked hold was released');

  // The parked request is now ANSWERED (the hold-cap contract: retryable
  // 503 + Retry-After), not stalled — the in-session "held by gate" signal.
  const rb = await resB;
  assert.equal(rb.status, 503, 'the released hold answers 503 (retryable), not 200');
  const ra = Number(rb.headers.get('retry-after'));
  assert.ok(ra >= 15 && ra <= 20, `Retry-After ~15s + jitter, got ${ra}`);
  const body = (await rb.json()) as { error: string; retry?: boolean };
  assert.equal(body.error, 'session queued');
  assert.equal(body.retry, true);

  // The queue slot is freed: the gate no longer counts B as queued, and the
  // freed slot is offered to the rest of the queue (B was the only waiter).
  assert.equal(gate.queueDepth, 0, 'the queue slot is freed after the release');
  assert.equal(gate.snapshot('tokB'), null, 'B is no longer queued after its hold is answered');

  // A's in-flight request is UNTOUCHED (the release never interrupts
  // in-flight traffic): it still completes normally when released.
  up.release(1);
  const raA = await resA;
  assert.equal(raA.status, 200, 'in-flight session A was not disturbed by the release');
});

// ---------------------------------------------------------------------------
// (r3) release is idempotent + a no-op on an unknown / settled token
// ---------------------------------------------------------------------------
test('(r3) release is idempotent: an unknown or already-settled token is a 200 no-op (released: 0), never an error, and never touches another hold', async () => {
  const { proxy, up, gate } = await controlHarness();
  gate.onStatePoll([]);

  // Park B so there IS a hold somewhere to prove the no-op leaves alone.
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 3000, 'B parked');

  // Unknown token: 200 no-op, released 0 — and B's hold is STILL parked.
  const rUnknown = await postRelease(proxy.base_url, 'never-seen-token', CONTROL_TOKEN);
  assert.equal(rUnknown.status, 200, 'an unknown token is a 200 (idempotent), not an error');
  const bUnknown = (await rUnknown.json()) as { ok: boolean; released: number };
  assert.equal(bUnknown.ok, true);
  assert.equal(bUnknown.released, 0, 'unknown token releases nothing');
  assert.equal(gate.queueDepth, 1, 'B is still parked (the no-op touched nothing)');

  // Settle B's hold, then release the SAME token again: 200 released 0
  // (idempotent — the hold is already gone).
  gate.releaseHold('tokB');
  await resB;
  const rAgain = await postRelease(proxy.base_url, 'tokB', CONTROL_TOKEN);
  assert.equal(rAgain.status, 200, 'a second release of a settled token is a 200');
  const bAgain = (await rAgain.json()) as { ok: boolean; released: number };
  assert.equal(bAgain.released, 0, 're-releasing a settled token releases nothing');

  up.release(1);
  await resA;
});

// ---------------------------------------------------------------------------
// (r4) auth is fail-closed: a wrong / missing token is a 401 NO-OP
// ---------------------------------------------------------------------------
test('(r4) a wrong or missing token is a 401 no-op — the parked hold stays parked (a bad token can never release a hold)', async () => {
  const { proxy, up, gate } = await controlHarness();
  gate.onStatePoll([]);

  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 3000, 'B parked');

  // Wrong token: 401, and a NO-OP — the hold is still parked, the request
  // has NOT been answered yet.
  const rWrong = await postRelease(proxy.base_url, 'tokB', 'NOT-the-token');
  assert.equal(rWrong.status, 401, 'a wrong token is a 401');
  const bWrong = (await rWrong.json()) as { error: string };
  assert.equal(bWrong.error, 'unauthorized');
  assert.equal(gate.queueDepth, 1, 'the hold is STILL parked (401 is a no-op, not a release)');
  assert.equal(gate.snapshot('tokB')?.state, 'queued', 'B is still queued after the 401');

  // Missing token header: 401 as well (fail closed).
  const rNone = await fetch(`${proxy.base_url}/sessions/tokB/release`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(rNone.status, 401, 'a missing token is a 401');
  assert.equal(gate.queueDepth, 1, 'still parked after the missing-token 401');

  // The RIGHT token now releases it.
  const rRight = await postRelease(proxy.base_url, 'tokB', CONTROL_TOKEN);
  assert.equal(rRight.status, 200);
  const bRight = (await rRight.json()) as { released: number };
  assert.equal(bRight.released, 1, 'the authed release finally answers the hold');
  assert.equal((await resB).status, 503, 'the hold is answered 503 only by the authed release');

  up.release(1);
  await resA;
});

// ---------------------------------------------------------------------------
// (r5) method guard: a GET on the release path is a 405
// ---------------------------------------------------------------------------
test('(r5) a GET on the release path is a 405 (a mistaken fetch is visible, not a silent no-op)', async () => {
  const { proxy, up, gate } = await controlHarness();
  gate.onStatePoll([]);

  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions');
  await waitFor(() => up.hits.length === 1, 3000, 'A forwarded');
  const resB = postChat(proxy.base_url, '/s/tokB/v1/chat/completions');
  await waitFor(() => gate.queueDepth === 1, 3000, 'B parked');

  const rGet = await fetch(`${proxy.base_url}/sessions/tokB/release`, { method: 'GET' });
  assert.equal(rGet.status, 405, 'a GET is a 405 (POST-only)');
  assert.equal(gate.queueDepth, 1, 'the GET did not release the hold');

  // Clean up so the process exits.
  gate.releaseHold('tokB');
  up.release(1);
  await resA;
  await resB;
});

// ---------------------------------------------------------------------------
// (r6) the control write never reaches the LLM target
// ---------------------------------------------------------------------------
test('(r6) the control path is answered on the loopback bind and never reaches the LLM target', async () => {
  const { proxy, up, gate } = await controlHarness();
  gate.onStatePoll([]);
  const hitsBefore = up.hits.length;

  // No session traffic at all: a release against a fresh router is a
  // loopback-answered no-op and MUST NOT be forwarded to the upstream.
  const r = await postRelease(proxy.base_url, 'nope', CONTROL_TOKEN);
  assert.equal(r.status, 200, 'the control path is answered (200 no-op)');
  const body = (await r.json()) as { released: number };
  assert.equal(body.released, 0);
  assert.equal(up.hits.length, hitsBefore, 'the control write never reached the LLM target');
  assert.equal(gate.queueDepth, 0, 'nothing was parked, nothing released');
});

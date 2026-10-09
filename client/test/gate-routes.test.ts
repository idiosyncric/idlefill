/**
 * gate-routes.test.ts — #42 slice 2: the plugin's daemon-side gate routes
 * on the client loopback proxy (real sockets, the plugin's exact calls):
 *
 *   - unknown session_id → the fail-quiet shape: 200 {state:'armed'},
 *     NO hold, NO fake state (an unknown id must never cause a hold);
 *   - a heartbeat bind then a state read → the gate's REAL state
 *     (the session_id → token index resolves, armed is reported);
 *   - a session the gate has QUEUED reports 'queued' + its 1-based
 *     position (the real queue place — never a fake zero);
 *   - an unregistered (unknown) token is rejected: the state read for
 *     it stays armed and the heartbeat bind for it learns nothing
 *     (the gate keeps no row for a token with no traffic and no arbiter
 *     adoption — the plugin's fail-open answer is the same either way).
 *
 * The body of a state read is {state, position?} ONLY: no token field,
 * no other keys (the token never leaves the gate in a response body).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SessionGate, type SessionGateDeps } from '../src/session-gate.js';
import { startLlmProxy, waitProxyReady, type LlmProxy } from '../src/proxy.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A gate with a fake register (resolves true) and a real clock seam. */
function makeGate(overrides: Partial<SessionGateDeps> = {}): SessionGate {
  const deps: SessionGateDeps = {
    register: async () => true,
    maxActive: 1,
    holdCapMs: 60_000,
    heartbeatMs: 60_000, // no register fires from the heartbeat bind in tests
    ...overrides,
  };
  return new SessionGate(deps);
}

/** Start the loopback proxy with a gate on an ephemeral port. */
async function startProxy(gate: SessionGate): Promise<LlmProxy> {
  // A live (unused) upstream: the gate routes never forward, but the
  // proxy wants a parseable target URL.
  const up = http.createServer();
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const port = (up.address() as { port: number }).port;
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        up.closeAllConnections?.();
        up.close(() => r());
      }),
  );
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${port}`, gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  return proxy;
}

/** A parked (never forwarded) request — a real request whose reply
 *  hangs on the wire until the test ends (force-exit handles the rest). */
function parkRequest(base: string, path: string): void {
  const req = http.request(`${base}${path}`, (res) => {
    res.resume();
  });
  req.end();
}

async function readState(base: string, params: string): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/gate/state${params}`);
  const body = await res.text();
  return { status: res.status, body, json: JSON.parse(body) as Record<string, unknown> };
}

// --- 1: unknown session_id → fail-quiet shape, no hold --------------------

test('unknown session_id: 200 {state:"armed"}, no hold, no fake state', async () => {
  const proxy = await startProxy(makeGate());
  const got = await readState(proxy.base_url, '?session_id=never-seen-id');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { state: 'armed' }); // NO position (no queue), NO token key
  assert.ok(!('position' in got.json));
  assert.ok(!('token' in got.json));
  assert.ok(!got.body.includes('never-seen-id'), 'the id never echoes back either');
  // A malformed (oversized) id fails quiet the same way — never a hold.
  const huge = 'x'.repeat(200);
  const got2 = await readState(proxy.base_url, `?session_id=${huge}`);
  assert.equal(got2.status, 200);
  assert.deepEqual(got2.json, { state: 'armed' });
  // Absent session_id (a plugin bug on the wire): armed, never an error.
  const got3 = await readState(proxy.base_url, '');
  assert.equal(got3.status, 200);
  assert.deepEqual(got3.json, { state: 'armed' });
});

// --- 2: heartbeat bind → state read returns the gate's real state ---------

test('heartbeat then state read: the real state (armed) for the bound session', async () => {
  const gate = makeGate();
  const proxy = await startProxy(gate);
  const hb = await fetch(`${proxy.base_url}/gate/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'h-abc123', token: 'tok-hb' }),
  });
  assert.equal(hb.status, 200, 'the contract answer is 200 (idempotent)');
  const got = await readState(proxy.base_url, '?session_id=h-abc123');
  assert.equal(got.status, 200);
  assert.equal(got.json.state, 'armed'); // the gate's real state: nothing holds tok-hb
  // The state read needs no token param: the index resolved it. The
  // explicit token param answers the same truth (same session, same row).
  const got2 = await readState(proxy.base_url, '?session_id=h-abc123&token=tok-hb');
  assert.equal(got2.json.state, 'armed');
  // Idempotent: a second heartbeat (the plugin's throttle window is
  // client-side; the route itself must stay quiet and true).
  const hb2 = await fetch(`${proxy.base_url}/gate/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'h-abc123', token: 'tok-hb' }),
  });
  assert.equal(hb2.status, 200);
  assert.equal((await readState(proxy.base_url, '?session_id=h-abc123')).json.state, 'armed');
  // A bad heartbeat body is a fail-quiet 200 (nothing learned, no error).
  const bad = await fetch(`${proxy.base_url}/gate/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(bad.status, 200);
  assert.equal((await readState(proxy.base_url, '?session_id=h-abc123')).json.state, 'armed');
});

// --- 3: a queued session reports queued + its real position ---------------

test('a queued session reports queued with its 1-based position', async () => {
  const gate = makeGate({ maxActive: 1 });
  const proxy = await startProxy(gate);
  // Session A takes the only slot (a parked-on-the-wire request).
  parkRequest(proxy.base_url, '/s/tok-a/v1/chat/completions');
  await new Promise((r) => setTimeout(r, 50)); // A admitted (inflight 1)
  // Session B has no slot: its request parks in the gate's queue.
  parkRequest(proxy.base_url, '/s/tok-b/v1/chat/completions');
  await new Promise((r) => setTimeout(r, 50)); // B parked
  const gotA = await readState(proxy.base_url, '?session_id=id-a&token=tok-a');
  assert.equal(gotA.json.state, 'armed'); // A holds the slot — nothing waits
  assert.ok(!('position' in gotA.json));
  const gotB = await readState(proxy.base_url, '?session_id=id-b&token=tok-b');
  assert.deepEqual(gotB.json, { state: 'queued', position: 1 }); // the real queue place
  // The position is router truth (the #44 posture): the gate's own
  // snapshot agrees with what the plugin read.
  assert.equal(gate.snapshot('tok-b')?.state, 'queued');
  assert.equal(gate.queueDepth, 1);
  // A token the gate has never seen: armed (no row, no hold).
  assert.deepEqual((await readState(proxy.base_url, '?session_id=id-x&token=tok-x')).json, { state: 'armed' });
});

// --- 4: an unregistered (unknown) token is rejected ------------------------

test('an unregistered token: the read stays armed and the bind learns nothing', async () => {
  const gate = makeGate();
  const proxy = await startProxy(gate);
  const tokGhost = 'tok-ghost-000';
  // A state read naming an unregistered token directly: armed (the gate
  // has no row for it — the plugin's fail-open answer, never a hold).
  const got = await readState(proxy.base_url, `?session_id=id-ghost&token=${tokGhost}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { state: 'armed' });
  // A heartbeat that names the same token: 200 (the route is idempotent),
  // but the gate keeps NO row for it — it was never adopted by the
  // arbiter and carries no traffic. The id→token index must not have
  // learned a binding to a row the gate does not track: a state read
  // by id alone (index consult) stays armed.
  const hb = await fetch(`${proxy.base_url}/gate/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'id-ghost', token: tokGhost }),
  });
  assert.equal(hb.status, 200);
  assert.deepEqual((await readState(proxy.base_url, '?session_id=id-ghost')).json, { state: 'armed' });
  // A token with no session_id at all in the payload: nothing to bind
  // (200, no state learned) — an id-less heartbeat is a no-op, never an
  // error the plugin would retry-loop on.
  const hbNoId = await fetch(`${proxy.base_url}/gate/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok-noid' }),
  });
  assert.equal(hbNoId.status, 200);
});

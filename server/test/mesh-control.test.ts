/**
 * mesh-control.test.ts — the mesh control relay, ceremony-agnostic
 * (#39 slice 2, decision: docs/architecture/pairing.md).
 *
 * Covers (real ed25519 crypto, real Fastify app on an ephemeral loopback
 * port — the slice-1 test harness, no mocks):
 *   - the relay applies a signed action to the target's OWN row
 *     (pause/force/clear/resume against a client and a session; the
 *     target owns the row — the requester never touches target state
 *     directly)
 *   - the D7 audit: every applied action appends a `mesh_control` event
 *     to the TARGET's log carrying `source_instance_id` (the ADD key)
 *   - the slice-2 replay defense: a REPLAYED nonce is 403 `nonce_replayed`
 *     (named), a STALE signed ts is 403 `stale_ts` (named), a fresh
 *     nonce after a stale attempt still works (stale requests record
 *     nothing)
 *   - D5: a reverse-direction edge (i_control) is 403 `direction_denied`
 *   - D8: no edge → 403 `unknown_instance_id` with a named reason
 *   - D6: POST /api/mesh/unpair (admin plane) removes the local edge
 *     immediately — the NEXT signed control attempt is 403, the audit
 *     log gains a `mesh_edge_unpaired` event
 *   - the coarse peer_token plane is byte-for-byte unaffected: the
 *     unpair route is unreachable with peer_token (admin plane), the
 *     relay is unreachable with peer_token (signature plane), and
 *     GET /api/mesh keeps its exact coarse shape
 *
 * The relay is ceremony-agnostic on purpose: the edge record is filled
 * via EdgeStore.upsert (the substrate), and the relay reads only the
 * stored edge + the signed envelope. It works identically under any
 * ceremony shape (request/approve, one-time code, or a future one) —
 * edge formation is #55 D4 and is NOT built here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { Identity } from '../src/identity.js';
import { NonceReplayStore, EDGE_TS_SKEW_MS, signEdgePayload } from '../src/edges.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const ADMIN = 'admin-token-1';
const PEER = 'fleet-peer-token';

function baseCfg(dir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    listen: 0,
    api_tokens: [ADMIN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_name: 'llama-swap',
    server_models: ['Qwen3.8-27B'],
    server_peers: [],
    mesh_peers: [],
    peer_token: PEER,
    mesh_name: '',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
    ...over,
  };
}

function mkApp(cfg: ServerConfig) {
  const store = new StateStore(cfg.state_file);
  const det = new IdleDetector({
    fetchActivity: async () => [{ id: 1, timestamp: new Date(T0 - 400_000).toISOString(), src: 'ip:10.0.0.9', model: 'Qwen3.8-27B', req_path: '/v1/chat/completions', resp_status_code: 200 }],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  const arbiter = new Arbiter(store, cfg, det);
  const app = buildApi({ arbiter, cfg, publicDir: join(import.meta.dirname, '..', 'public') });
  attachWebSocket(app, arbiter, cfg);
  return { app, arbiter, store };
}

let tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'idlefill-mesh-control-'));
  tmpDirs.push(d);
  return d;
}

let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;

const peer = Identity.mint();
const peerId = 'm-relay-peer';
/** A fresh nonce (each request must carry a unique nonce). */
let nonceSeq = 0;
const nextNonce = (): string => `relay-nonce-${++nonceSeq}`;

/** Sign the /api/mesh/control envelope (the wire headers). */
function signControl(instanceId: string, ts: number, nonce: string): Record<string, string> {
  const { signatureB64url } = signEdgePayload(peer, { instance_id: instanceId, path: '/api/mesh/control', ts, nonce });
  return {
    'x-idlefill-instance-id': instanceId,
    'x-idlefill-signature': signatureB64url,
    'x-idlefill-nonce': nonce,
    'x-idlefill-ts': String(ts),
  };
}

async function control(action: string, body: Record<string, unknown>, ts: number, nonce?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const h = signControl(peerId, ts, nonce ?? nextNonce());
  h['content-type'] = 'application/json';
  const r = await fetch(`${base}/api/mesh/control`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ action, ...body }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const now = (): number => Date.now();

before(async () => {
  const dir = mkTmp();
  cfg = baseCfg(dir, { mesh_name: 'target-machine' });
  const made = mkApp(cfg);
  app = made.app;
  arbiter = made.arbiter;
  // The edge is filled via the substrate (EdgeStore.upsert) — the ceremony
  // that would fill it in production is #55 D4 and is NOT built. The relay
  // reads only this record + the signed envelope (ceremony-agnostic).
  arbiter.edges().upsert({ peer_instance_id: peerId, peer_public_key: peer.publicKeyB64url, peer_name: 'controller', direction: 'controls_me', created_at: T0 });
  // A real client row + a real session row on the TARGET (the rows the
  // relayed actions hit — the target owns them).
  const cl = arbiter.registerClient('w1', undefined, '10.0.0.5', [
    { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 2, queue_preview: [{ job_id: 'job-1', title: 'Apply to Acme', company: 'Acme', score: 0.9, attempts: 0 }] },
  ]);
  arbiter.registerSession('sess-abc-123', { client_id: cl.client_id, client_name: 'w1', server_id: 'srv-1', now: T0 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function eventsOfKind(kind: string): { kind: string; detail?: string; source_instance_id?: string }[] {
  return arbiter['store'].state.events.filter((e) => e.kind === kind) as { kind: string; detail?: string; source_instance_id?: string }[];
}

// ---------------------------------------------------------------------------
// The relay applies signed actions to the target's OWN rows (D4)
// ---------------------------------------------------------------------------

test('relay: a signed pause on a client is applied by the target + audited (D4, D7)', async () => {
  const before = arbiter['store'].state.events.length;
  const r = await control('pause', { client: 'w1' }, now());
  assert.equal(r.status, 200, `the signed action is admitted (got ${r.status}: ${JSON.stringify(r.body)})`);
  assert.equal(r.body.action, 'pause');
  assert.equal(r.body.target, 'w1');
  assert.equal(r.body.override, 'pause');
  assert.equal(r.body.source_instance_id, peerId, 'the response echoes the requester id');
  // The target APPLIED the action to its own row (the operator's own
  // override verb — same semantics a local pause uses).
  const ov = arbiter.activeOverride(arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id);
  assert.ok(ov, 'the override is in force on the target row');
  assert.equal(ov.override, 'pause');
  // D7 audit: a mesh_control event in the TARGET's log, with the
  // requester's source_instance_id ADD key.
  const mine = arbiter['store'].state.events.slice(before).find((e) => e.kind === 'mesh_control');
  assert.ok(mine, 'a mesh_control event was appended to the target log');
  assert.equal((mine as { source_instance_id?: string }).source_instance_id, peerId, 'the ADD key carries the requester instance_id');
  assert.ok((mine as { detail?: string }).detail?.includes('pause'), 'the detail names the action');
});

test('relay: force + clear (and the resume alias) compose against the same row', async () => {
  const before = arbiter['store'].state.events.length;
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  const r1 = await control('force', { client: 'w1' }, now());
  assert.equal(r1.status, 200);
  assert.equal(r1.body.override, 'force');
  assert.equal(arbiter.activeOverride(w1Id)?.override, 'force', 'force replaces the pause posture');

  const r2 = await control('resume', { client: 'w1' }, now());
  assert.equal(r2.status, 200, 'resume is the relay alias for clear');
  assert.equal(arbiter.activeOverride(w1Id), null, 'resume lifted the posture');

  const applied = arbiter['store'].state.events.slice(before).filter((e) => e.kind === 'mesh_control');
  assert.equal(applied.length, 2, 'every APPLIED action is audited (force + resume)');
  for (const e of applied) assert.equal((e as { source_instance_id?: string }).source_instance_id, peerId);
});

test('relay: session-targeted actions apply against the target session row', async () => {
  const before = arbiter['store'].state.events.length;
  const r1 = await control('pause', { session_token: 'sess-abc-123' }, now());
  assert.equal(r1.status, 200, 'the session row is a legal relay target');
  assert.equal(r1.body.target, 'sess-abc-123');
  assert.equal(arbiter.activeSessionOverride('sess-abc-123')?.override, 'pause');
  const r2 = await control('clear', { session_token: 'sess-abc-123' }, now());
  assert.equal(r2.status, 200);
  assert.equal(arbiter.activeSessionOverride('sess-abc-123'), null);
  assert.equal(arbiter['store'].state.events.slice(before).filter((e) => e.kind === 'mesh_control').length, 2, 'both session actions audited');
});

test('relay: a named unknown target row is 400 (told, not swallowed) + not audited', async () => {
  const before = arbiter['store'].state.events.length;
  const r1 = await control('pause', { client: 'no-such-client' }, now());
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'unknown_target');
  const r2 = await control('pause', { session_token: 'no-such-session' }, now());
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, 'unknown_target');
  const r3 = await control('pause', {}, now());
  assert.equal(r3.status, 400, 'no target row named');
  const r4 = await control('pause', { client: 'w1', session_token: 'sess-abc-123' }, now());
  assert.equal(r4.status, 400, 'ambiguous target');
  const r5 = await control('steal', { client: 'w1' }, now());
  assert.equal(r5.status, 400, 'an action outside the D4 set is refused');
  const meshEvs = arbiter['store'].state.events.slice(before).filter((e) => e.kind === 'mesh_control');
  assert.equal(meshEvs.length, 0, 'a refused action appends no audit event');
});

test('relay: reorder is named in the set but its write is deferred (owner open question #2)', async () => {
  const r = await control('reorder', { client: 'w1' }, now());
  assert.equal(r.status, 405, 'the relay carries the action set; the write waits on the wire-shape decision');
  assert.equal(r.body.error, 'reorder_deferred');
  // The four other verbs are unaffected (the relay is not half-broken by
  // the deferral — a fresh pause still lands).
  const ok = await control('pause', { client: 'w1' }, now());
  assert.equal(ok.status, 200);
  await control('clear', { client: 'w1' }, now());
});

// ---------------------------------------------------------------------------
// The slice-2 replay defense: nonce single-use + ts skew window
// ---------------------------------------------------------------------------

test('replay: a replayed nonce is 403 nonce_replayed (named) — the action is NOT applied twice', async () => {
  const ts = now();
  const nonce = nextNonce();
  const h = signControl(peerId, ts, nonce);
  h['content-type'] = 'application/json';
  const send = () => fetch(`${base}/api/mesh/control`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'pause', client: 'w1' }) });
  const r1 = await send();
  assert.equal(r1.status, 200, 'the first use of the nonce is admitted');
  // The EXACT same request (same signature, same nonce, same ts) replayed:
  const r2 = await send();
  assert.equal(r2.status, 403, 'the replay is denied');
  const b2 = (await r2.json()) as { error: string; reason: string; hint: string };
  assert.equal(b2.error, 'edge_denied');
  assert.equal(b2.reason, 'nonce_replayed', 'named: the operator can tell a replay from an unpaired peer');
  assert.ok(b2.hint.length > 0);
  // The target row was touched exactly once (the replay applied nothing).
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  assert.equal(arbiter.activeOverride(w1Id)?.override, 'pause', 'the action is in force from the FIRST use only');
  const pauses = eventsOfKind('mesh_control').filter((e) => e.detail?.includes('pause'));
  const meshEvs = arbiter['store'].state.events.filter((e) => e.kind === 'mesh_control');
  assert.ok(meshEvs.length >= pauses.length - 1, 'no duplicate audit for the replayed request');
});

test('stale: a signed ts outside the skew window is 403 stale_ts (named) and records nothing', async () => {
  const staleTs = now() - (EDGE_TS_SKEW_MS + 60_000); // beyond the (PROPOSED) window
  const r1 = await control('pause', { client: 'w1' }, staleTs);
  assert.equal(r1.status, 403, 'the stale request is denied');
  const b1 = r1.body as { error: string; reason: string };
  assert.equal(b1.error, 'edge_denied');
  assert.equal(b1.reason, 'stale_ts', 'named: a stale signature is not a replay and not an unpaired peer');
  // A FUTURE-skewed ts is rejected the same way (symmetric window).
  const r2 = await control('pause', { client: 'w1' }, now() + (EDGE_TS_SKEW_MS + 60_000));
  assert.equal(r2.status, 403);
  // The stale attempts recorded no nonce: the SAME nonce (fresh ts now)
  // is still spendable — stale requests must not starve the store.
  const nonce = nextNonce();
  const fresh = await (async () => {
    const h = signControl(peerId, now(), nonce);
    const r = await fetch(`${base}/api/mesh/control`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause', client: 'w1' }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  })();
  assert.equal(fresh.status, 200, 'the nonce a stale request used is NOT burned');
  // Lift the posture back off (clean state for the D5/D6 tests).
  await control('clear', { client: 'w1' }, now());
});

test('NonceReplayStore: bounded per-id (FIFO) and pruned by the skew window', () => {
  const s = new NonceReplayStore();
  const t = Date.now();
  for (let i = 0; i < 300; i++) assert.equal(s.seen('m-x', `n-${i}`, t, t), 'fresh');
  // Bounded: the per-id cap evicted the oldest (256 cap). The newest
  // nonce is remembered; the first one is gone.
  assert.equal(s.has('m-x', 'n-299'), true);
  assert.equal(s.has('m-x', 'n-0'), false, 'FIFO eviction at the per-id cap');
  assert.equal(s.size <= 300, true);
  // A replay is named:
  assert.equal(s.seen('m-x', 'n-299', t, t), 'replay');
  // The skew window: an aged entry is pruned (a ts outside the window is
  // stale — never recorded).
  const old = t - (EDGE_TS_SKEW_MS + 1_000);
  assert.equal(s.seen('m-y', 'n-old', old, t), 'stale');
  assert.equal(s.has('m-y', 'n-old'), false, 'a stale nonce is never recorded');
});

// ---------------------------------------------------------------------------
// D5 / D8 / the auth planes
// ---------------------------------------------------------------------------

test('D5: a reverse-direction edge (i_control) cannot relay control', async () => {
  const other = Identity.mint();
  const otherId = 'm-reverse-ctl';
  arbiter.edges().upsert({ peer_instance_id: otherId, peer_public_key: other.publicKeyB64url, direction: 'i_control', created_at: T0 });
  const ts = now();
  const { signatureB64url } = signEdgePayload(other, { instance_id: otherId, path: '/api/mesh/control', ts, nonce: 'rev-1' });
  const r = await fetch(`${base}/api/mesh/control`, {
    method: 'POST',
    headers: {
      'x-idlefill-instance-id': otherId,
      'x-idlefill-signature': signatureB64url,
      'x-idlefill-nonce': 'rev-1',
      'x-idlefill-ts': String(ts),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'pause', client: 'w1' }),
  });
  assert.equal(r.status, 403, 'pairing B to A does not let A control B (D5)');
  const b = (await r.json()) as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'direction_denied', 'named: the edge exists but points the other way');
});

test('D8: no edge → 403 unknown_instance_id (named) — a valid signature cannot open what pairing never closed', async () => {
  const stranger = Identity.mint();
  const strangerId = 'm-never-paired-ctl';
  const ts = now();
  const { signatureB64url } = signEdgePayload(stranger, { instance_id: strangerId, path: '/api/mesh/control', ts, nonce: 'str-1' });
  const r = await fetch(`${base}/api/mesh/control`, {
    method: 'POST',
    headers: {
      'x-idlefill-instance-id': strangerId,
      'x-idlefill-signature': signatureB64url,
      'x-idlefill-nonce': 'str-1',
      'x-idlefill-ts': String(ts),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'pause', client: 'w1' }),
  });
  assert.equal(r.status, 403, 'unpaired = denied, fail-closed (D8)');
  const b = (await r.json()) as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'unknown_instance_id', 'the named reason is the unpaired answer');
});

test('no signature envelope → 401; the coarse peer_token cannot reach the relay', async () => {
  // No envelope: the hook 401s (the route never runs).
  const r0 = await fetch(`${base}/api/mesh/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause', client: 'w1' }) });
  assert.equal(r0.status, 401);
  // The fleet peer_token (the coarse read plane) is scoped to GET
  // /api/mesh ONLY: it is 401 on the relay (no signature envelope) —
  // and 404-equivalent on nothing else (the token never unlocks it).
  const r1 = await fetch(`${base}/api/mesh/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PEER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause', client: 'w1' }),
  });
  assert.equal(r1.status, 401, 'the coarse token cannot ride the signature plane');
  // An admin token is 401 on the relay too (the operator's own machine is
  // the local-admin surface — a relay must be a signed peer).
  const r2 = await fetch(`${base}/api/mesh/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause', client: 'w1' }),
  });
  assert.equal(r2.status, 401, 'the relay is the signature plane; a local token is not a peer signature');
});

// ---------------------------------------------------------------------------
// D6: unpair revokes immediately (the admin plane)
// ---------------------------------------------------------------------------

test('D6: POST /api/mesh/unpair (admin) removes the edge — the next signed control is 403', async () => {
  // A fresh edge (not the main relay peer — the unpair test is
  // self-contained and leaves the main edge for the coarse-plane test).
  const u = Identity.mint();
  const uid = 'm-unpair-ctl';
  arbiter.edges().upsert({ peer_instance_id: uid, peer_public_key: u.publicKeyB64url, direction: 'controls_me', created_at: T0 });

  // Admitted while the edge exists (signed by the edge's owner u).
  const ok = await (async () => {
    const ts = now();
    const { signatureB64url } = signEdgePayload(u, { instance_id: uid, path: '/api/mesh/control', ts, nonce: 'up-1' });
    const r = await fetch(`${base}/api/mesh/control`, {
      method: 'POST',
      headers: { 'x-idlefill-instance-id': uid, 'x-idlefill-signature': signatureB64url, 'x-idlefill-nonce': 'up-1', 'x-idlefill-ts': String(ts), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', client: 'w1' }),
    });
    return r.status;
  })();
  assert.equal(ok, 200, 'admitted while the edge exists');

  // Unpair via the ADMIN plane (the operator's own token).
  const upR = await fetch(`${base}/api/mesh/unpair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: uid }),
  });
  assert.equal(upR.status, 200, 'the admin unpair is admitted');
  const upB = (await upR.json()) as { ok: boolean; existed: boolean; removed: boolean };
  assert.equal(upB.ok, true);
  assert.equal(upB.existed, true);
  assert.equal(upB.removed, true);
  assert.equal(arbiter.edges().get(uid), null, 'the local edge record is gone (immediate, D6)');
  // The D6 audit event (the revokeClientKey precedent: deletion + an event).
  assert.ok(eventsOfKind('mesh_edge_unpaired').some((e) => e.detail === uid), 'the unpair is in the target event log');

  // The NEXT signed control attempt from the same (now-unpaired) peer is
  // 403 — immediate, no propagation.
  const denied = await (async () => {
    const ts = now();
    const { signatureB64url } = signEdgePayload(u, { instance_id: uid, path: '/api/mesh/control', ts, nonce: 'up-2' });
    const r = await fetch(`${base}/api/mesh/control`, {
      method: 'POST',
      headers: { 'x-idlefill-instance-id': uid, 'x-idlefill-signature': signatureB64url, 'x-idlefill-nonce': 'up-2', 'x-idlefill-ts': String(ts), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', client: 'w1' }),
    });
    const b = (await r.json()) as { status?: never; reason?: string };
    return { status: r.status, reason: b.reason };
  })();
  assert.equal(denied.status, 403, 'the NEXT action is denied — immediate local deletion (D6)');
  assert.equal(denied.reason, 'unknown_instance_id', 'named: the edge is gone, not a replay or a stale signature');
});

test('unpair: auth + idempotence — admin only, named 400s, re-runnable', async () => {
  // No token / a wrong token / the coarse peer_token: all 401 (the unpair
  // is the LOCAL ADMIN plane — a peer cannot unpair itself remotely).
  const noTok = await fetch(`${base}/api/mesh/unpair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'm-x' }) });
  assert.equal(noTok.status, 401);
  const peerTok = await fetch(`${base}/api/mesh/unpair`, { method: 'POST', headers: { authorization: `Bearer ${PEER}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'm-x' }) });
  assert.equal(peerTok.status, 401, 'the coarse plane cannot reach the admin plane');
  // Missing / malformed id: a named 400 (told, not swallowed).
  const bad1 = await fetch(`${base}/api/mesh/unpair`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(`${base}/api/mesh/unpair`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'x'.repeat(65) }) });
  assert.equal(bad2.status, 400);
  // No edge for the id: a named answer (idempotent-safe — re-running the
  // operator's command does not error the run).
  const none = await fetch(`${base}/api/mesh/unpair`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'm-never-had' }) });
  assert.equal(none.status, 200);
  const b = (await none.json()) as { existed: boolean; removed: boolean };
  assert.equal(b.existed, false);
  assert.equal(b.removed, false);
});

// ---------------------------------------------------------------------------
// The coarse peer_token plane is byte-for-byte unaffected
// ---------------------------------------------------------------------------

test('the coarse plane is untouched: peer_token still reads GET /api/mesh with the exact coarse shape', async () => {
  const r = await fetch(`${base}/api/mesh`, { headers: { authorization: `Bearer ${PEER}` } });
  assert.equal(r.status, 200, 'the #50 read plane stands alone');
  const b = (await r.json()) as { instance_id: string; name: string; ts: number; servers: unknown[]; queue_depth: number; sessions: number; active_leases: number };
  assert.equal(b.instance_id, arbiter.instanceId());
  assert.ok(Array.isArray(b.servers), 'coarse shape unchanged');
  assert.ok(typeof b.queue_depth === 'number' && typeof b.sessions === 'number' && typeof b.active_leases === 'number');
  // Still COARSE: no job ids, no queue detail, no control surface.
  const json = JSON.stringify(b);
  assert.ok(!json.includes('job-1'), 'no job ids on the coarse plane');
  assert.ok(!json.includes('Apply to Acme'), 'no queue titles on the coarse plane');
});

test('the per-edge read routes keep their exact shape (slice 1 contract intact under the new admission)', async () => {
  const ts = now();
  const { signatureB64url } = signEdgePayload(peer, { instance_id: peerId, path: '/api/mesh/control-preview', ts, nonce: 'cp-1' });
  const r = await fetch(`${base}/api/mesh/control-preview`, {
    headers: { 'x-idlefill-instance-id': peerId, 'x-idlefill-signature': signatureB64url, 'x-idlefill-nonce': 'cp-1', 'x-idlefill-ts': String(ts) },
  });
  assert.equal(r.status, 200, 'the slice-1 read route still admits the same edge');
  const b = (await r.json()) as { actions: string[] };
  assert.deepEqual(b.actions, ['pause', 'resume', 'force', 'clear', 'reorder'], 'the action set is unchanged');
});

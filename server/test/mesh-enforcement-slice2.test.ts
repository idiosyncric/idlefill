/**
 * mesh-enforcement-slice2.test.ts — the #39 enforcement-half acceptance
 * tests (docs/architecture/pairing.md: GET /api/mesh/detail D3 +
 * POST /api/mesh/control D4, D5 direction, D6/D8 fail-closed).
 *
 * The relay itself shipped in slice 2 (cb63b25, `mesh-control.test.ts`);
 * this file is the ACCEPTANCE half of the issue's enforcement plane,
 * pinned against the pairing.md acceptance list with real ed25519 crypto
 * and a real Fastify app on an ephemeral loopback port (the slice-1 test
 * harness, no mocks):
 *
 *   1. no edge record → 403 `edge_denied` / `unknown_instance_id` on
 *      BOTH routes (a valid signature cannot open what pairing never
 *      closed — D8 fail-closed);
 *   2. a paired edge record (the D5 `controls_me` direction) allows the
 *      detail read: the target's queue DETAIL (job ids + titles) crosses
 *      the wire — the coarse plane never carries it;
 *   3. a control verb changes ONLY the target's own rows: a relayed
 *      pause on one client leaves every other client row and the session
 *      rows' overrides untouched (the target applies the verb to its OWN
 *      row — the requester never touches target state directly);
 *   4. an unknown verb is rejected (400 `bad_action`, told not swallowed,
 *      no state change, no audit);
 *   5. the detail route NEVER returns raw log lines or request bodies
 *      (mesh.md D5, payload-free): a client's stored `client_log` tail
 *      and lease ids never appear on the detail projection — only the
 *      queue_preview metadata the local dashboard shows;
 *   6. bonus path binding: a signature minted for /api/mesh/control-
 *      preview is rejected on /api/mesh/control (the signed payload
 *      binds the route path — a cross-route replay is `bad_signature`).
 *
 * Real crypto throughout (Identity.mint, node:crypto ed25519): no
 * mocked signatures, no fixture keys.
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
import { signEdgePayload } from '../src/edges.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');
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
  const d = mkdtempSync(join(tmpdir(), 'idlefill-mesh-enforce-'));
  tmpDirs.push(d);
  return d;
}

let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;

// The PAIRED controller (a real keypair, real signature).
const controller = Identity.mint();
const controllerId = 'enforce-ctl';
// A never-paired stranger (a real keypair, a valid signature — and
// still denied: the signature cannot open what pairing never closed).
const stranger = Identity.mint();
const strangerId = 'enforce-stranger';

let nonceSeq = 0;
const nextNonce = (): string => `enforce-nonce-${++nonceSeq}`;

/** Sign the canonical {instance_id, path, ts, nonce} payload for one route. */
function signHeaders(identity: Identity, instanceId: string, path: string, ts: number, nonce: string): Record<string, string> {
  const { signatureB64url } = signEdgePayload(identity, { instance_id: instanceId, path, ts, nonce });
  return {
    'x-idlefill-instance-id': instanceId,
    'x-idlefill-signature': signatureB64url,
    'x-idlefill-nonce': nonce,
    'x-idlefill-ts': String(ts),
  };
}

/** GET /api/mesh/detail with a signed envelope. */
async function detailCall(identity: Identity, instanceId: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const h = signHeaders(identity, instanceId, '/api/mesh/detail', Date.now(), nextNonce());
  const r = await fetch(`${base}/api/mesh/detail`, { headers: h });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text || '{}') as Record<string, unknown>, text };
}

/** POST /api/mesh/control with a signed envelope (fresh nonce per call). */
async function controlCall(
  identity: Identity,
  instanceId: string,
  body: Record<string, unknown>,
  path = '/api/mesh/control',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const h = signHeaders(identity, instanceId, path, Date.now(), nextNonce());
  h['content-type'] = 'application/json';
  const r = await fetch(`${base}/api/mesh/control`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const now = (): number => Date.now();

before(async () => {
  const dir = mkTmp();
  cfg = baseCfg(dir, { mesh_name: 'enforce-target' });
  const made = mkApp(cfg);
  app = made.app;
  arbiter = made.arbiter;
  // The paired edge record (the #55 D4 ceremony fills it in production;
  // the substrate's upsert fills it here — the enforcement plane is
  // ceremony-agnostic by construction).
  arbiter.edges().upsert({
    peer_instance_id: controllerId,
    peer_public_key: controller.publicKeyB64url,
    peer_name: 'controller-machine',
    direction: 'controls_me',
    created_at: T0,
  });
  // Two client rows on the TARGET (the rows the relayed verbs may hit):
  //  - w1 carries a queue preview (job ids + titles — the D3 detail);
  //  - w2 carries a stored raw LOG TAIL (client_log, the #61 A2 plane)
  //    and a queue preview. The detail route must show w2's queue but
  //    NEVER its log lines (mesh.md D5: payload-free).
  arbiter.registerClient('w1', undefined, '10.0.0.5', [
    { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 2, queue_preview: [{ job_id: 'job-a1', title: 'Apply to Acme', company: 'Acme', score: 0.9, attempts: 0 }, { job_id: 'job-a2', title: 'Research Zeta', company: 'Zeta', score: 0.7, attempts: 1 }] },
  ]);
  arbiter.registerClient(
    'w2',
    undefined,
    '10.0.0.6',
    [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 1, queue_preview: [{ job_id: 'job-b1', title: 'Draft cover letter', company: 'Globex', score: 0.8, attempts: 0 }] }],
    undefined,
    { client_log: ['RAW-LOG-MARKER-1 executor started run', 'RAW-LOG-MARKER-2 tool call completed in 42ms'] },
  );
  // Two session rows (also the target's OWN rows).
  const w1 = arbiter['store'].state.clients.find((c) => c.name === 'w1')!;
  const w2 = arbiter['store'].state.clients.find((c) => c.name === 'w2')!;
  arbiter.registerSession('enforce-sess-1', { client_id: w1.client_id, client_name: 'w1', server_id: 'srv-1', now: T0 });
  arbiter.registerSession('enforce-sess-2', { client_id: w2.client_id, client_name: 'w2', server_id: 'srv-1', now: T0 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 1. No edge record → 403 with a named reason (D8 fail-closed)
// ---------------------------------------------------------------------------

test('enforcement 1a: no local edge record → detail is 403 with a NAMED reason', async () => {
  const r = await detailCall(stranger, strangerId);
  assert.equal(r.status, 403, 'a valid signature from an UNPAIRED instance is denied (D8)');
  const b = r.body as { error: string; reason: string; hint: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'unknown_instance_id', 'the named reason: no local edge record for the requesting instance');
  assert.ok(b.hint.length > 0, 'the hint tells the operator what to pair');
  // Nothing leaks: the 403 body carries no queue detail of any kind.
  assert.ok(!r.text.includes('job-a1'), 'the denial leaks no queue detail');
});

test('enforcement 1b: no local edge record → control is 403 with a NAMED reason', async () => {
  const r = await controlCall(stranger, strangerId, { action: 'pause', client: 'w1' });
  assert.equal(r.status, 403, 'a valid signature from an UNPAIRED instance is denied (D8)');
  const b = r.body as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'unknown_instance_id', 'the named reason: no local edge record');
  // The target row was untouched by the denied request.
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  assert.equal(arbiter.activeOverride(w1Id), null, 'a denied control action mutates nothing');
  // No audit event for a denied action (D7: only APPLIED actions log).
  const meshEvs = arbiter['store'].state.events.filter((e) => e.kind === 'mesh_control');
  assert.equal(meshEvs.length, 0, 'a denied action appends no mesh_control audit');
});

// ---------------------------------------------------------------------------
// 2. A paired edge record allows the detail read (D3 + D5)
// ---------------------------------------------------------------------------

test('enforcement 2: a paired (controls_me) edge record allows the detail read', async () => {
  const r = await detailCall(controller, controllerId);
  assert.equal(r.status, 200, 'the paired edge is admitted (D5: controls_me)');
  const b = r.body as { instance_id: string; ts: number; clients: { name: string; online: boolean; projects: { name: string; queue_depth: number; queue_preview: { job_id: string; title: string; company: string; score: number | null; attempts: number }[] }[] }[] };
  assert.equal(b.instance_id, arbiter.instanceId(), 'the response names the TARGET instance');
  assert.ok(Array.isArray(b.clients) && b.clients.length === 2, 'both of the target LOCAL clients are rows (no transitivity: peers are not rows)');
  const w1 = b.clients.find((c) => c.name === 'w1');
  assert.ok(w1, 'w1 is visible');
  const p1 = w1?.projects.find((x) => x.name === 'career-ops');
  assert.equal(p1?.queue_depth, 2);
  assert.deepEqual(p1?.queue_preview.map((x) => x.job_id), ['job-a1', 'job-a2'], 'queue DETAIL crosses: job ids (the coarse plane never carries them)');
  assert.equal(p1?.queue_preview[0]?.title, 'Apply to Acme', 'and titles — the detail a local dashboard reader sees');
  assert.equal(p1?.queue_preview[0]?.company, 'Acme');
  assert.equal(p1?.queue_preview[0]?.score, 0.9);
  assert.equal(p1?.queue_preview[0]?.attempts, 0);
  const w2 = b.clients.find((c) => c.name === 'w2');
  assert.equal(w2?.projects[0]?.queue_preview?.[0]?.job_id, 'job-b1', 'w2\'s queue crosses too');
});

test('enforcement 2b: a reverse-direction edge (i_control) is denied on the controlled side (D5)', async () => {
  const reverse = Identity.mint();
  const reverseId = 'enforce-reverse';
  arbiter.edges().upsert({ peer_instance_id: reverseId, peer_public_key: reverse.publicKeyB64url, direction: 'i_control', created_at: T0 });
  const r = await detailCall(reverse, reverseId);
  assert.equal(r.status, 403, 'pairing B to A does not let A read/control B');
  const b = r.body as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'direction_denied', 'named: the edge exists but points the other way');
  const c = await controlCall(reverse, reverseId, { action: 'pause', client: 'w1' });
  assert.equal(c.status, 403, 'control is denied on a reverse edge too');
  assert.equal((c.body as { reason: string }).reason, 'direction_denied');
  arbiter.edges().remove(reverseId); // keep the acceptance tests deterministic
});

// ---------------------------------------------------------------------------
// 3. A control verb changes ONLY the target's own rows
// ---------------------------------------------------------------------------

test('enforcement 3: a relayed pause changes only the named target row', async () => {
  // Baseline: no override anywhere.
  const rows = arbiter['store'].state.clients;
  for (const c of rows) assert.equal(arbiter.activeOverride(c.client_id), null, 'baseline: no override in force');
  assert.equal(arbiter.activeSessionOverride('enforce-sess-1'), null);
  assert.equal(arbiter.activeSessionOverride('enforce-sess-2'), null);

  const r = await controlCall(controller, controllerId, { action: 'pause', client: 'w2' });
  assert.equal(r.status, 200, 'the signed action is admitted');
  const b = r.body as { ok: boolean; action: string; target: string; override: string; source_instance_id: string };
  assert.equal(b.ok, true);
  assert.equal(b.action, 'pause');
  assert.equal(b.target, 'w2', 'the response names the target row it hit');
  assert.equal(b.override, 'pause');
  assert.equal(b.source_instance_id, controllerId, 'the response carries the requester identity');

  const w1Id = rows.find((c) => c.name === 'w1')!.client_id;
  const w2Id = rows.find((c) => c.name === 'w2')!.client_id;
  const ov2 = arbiter.activeOverride(w2Id);
  assert.ok(ov2 && ov2.override === 'pause', 'the NAMED row (w2, the target\'s own row) now carries the pause');
  assert.equal(arbiter.activeOverride(w1Id), null, 'the OTHER client row (w1) is untouched — the verb hits only its own row');
  assert.equal(arbiter.activeSessionOverride('enforce-sess-1'), null, 'session row 1 untouched');
  assert.equal(arbiter.activeSessionOverride('enforce-sess-2'), null, 'session row 2 untouched (a client verb never bleeds into session rows)');

  // D7 audit: the target's log carries the action + the requester id.
  const evs = arbiter['store'].state.events.filter((e) => e.kind === 'mesh_control');
  assert.equal(evs.length, 1, 'exactly one audit for the one applied action');
  assert.equal((evs[0] as { source_instance_id?: string }).source_instance_id, controllerId, 'the ADD key carries the requesting instance_id');
  assert.ok((evs[0] as { detail?: string }).detail?.includes('pause') && (evs[0] as { detail?: string }).detail?.includes('w2'), 'the detail names the action + the row');

  // A second verb on the OTHER row composes against it alone (resume
  // lifts; w2 keeps its pause — each verb applies to its own row).
  const r2 = await controlCall(controller, controllerId, { action: 'resume', client: 'w1' });
  assert.equal(r2.status, 200);
  assert.equal(arbiter.activeOverride(w1Id), null, 'resume (the clear alias) leaves w1 with no posture');
  assert.equal(arbiter.activeOverride(w2Id)?.override, 'pause', 'w2\'s pause survives a verb aimed at w1');
  // Lift w2 back off so later tests start clean.
  const r3 = await controlCall(controller, controllerId, { action: 'clear', client: 'w2' });
  assert.equal(r3.status, 200);
  assert.equal(arbiter.activeOverride(w2Id), null);
});

test('enforcement 3b: a session-targeted verb changes only that session row', async () => {
  const r = await controlCall(controller, controllerId, { action: 'force', session_token: 'enforce-sess-2' });
  assert.equal(r.status, 200);
  assert.equal((r.body as { target: string }).target, 'enforce-sess-2');
  assert.equal(arbiter.activeSessionOverride('enforce-sess-2')?.override, 'force', 'the named session row carries the force');
  assert.equal(arbiter.activeSessionOverride('enforce-sess-1'), null, 'the other session row is untouched');
  const w2Id = arbiter['store'].state.clients.find((c) => c.name === 'w2')!.client_id;
  assert.equal(arbiter.activeOverride(w2Id), null, 'a session verb never bleeds into client rows');
  await controlCall(controller, controllerId, { action: 'clear', session_token: 'enforce-sess-2' });
  assert.equal(arbiter.activeSessionOverride('enforce-sess-2'), null);
});

test('enforcement 3c: an unknown target row is 400 and mutates nothing', async () => {
  const before = arbiter['store'].state.events.length;
  const r = await controlCall(controller, controllerId, { action: 'pause', client: 'no-such-machine-client' });
  assert.equal(r.status, 400, 'told, not swallowed: the named row is not a row on this machine');
  const b = r.body as { error: string; reason: string };
  assert.equal(b.error, 'unknown_target');
  assert.equal(b.reason, 'unknown_client');
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  assert.equal(arbiter.activeOverride(w1Id), null, 'no row was touched');
  assert.equal(arbiter['store'].state.events.length, before, 'a refused action appends no audit');
});

// ---------------------------------------------------------------------------
// 4. An unknown verb is rejected
// ---------------------------------------------------------------------------

test('enforcement 4: a verb outside the pairing.md D4 set is rejected (named, no change)', async () => {
  const before = arbiter['store'].state.events.length;
  for (const bad of ['steal', 'delete', 'PAUSE', 'pause-job', '']) {
    const r = await controlCall(controller, controllerId, { action: bad, client: 'w1' });
    assert.equal(r.status, 400, `action ${JSON.stringify(bad)} is refused`);
    const b = r.body as { error: string; hint: string };
    assert.equal(b.error, 'bad_action', 'named: the operator is told the action is outside the set');
    assert.ok(b.hint.includes('pause') && b.hint.includes('reorder'), 'the hint names the D4 set');
  }
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  assert.equal(arbiter.activeOverride(w1Id), null, 'none of the refused verbs touched any row');
  assert.equal(arbiter['store'].state.events.length, before, 'refused verbs append no audit (D7: only applied actions)');
  // The spec set itself is intact: the four working verbs still apply
  // (pause → force → resume on the same row).
  assert.equal((await controlCall(controller, controllerId, { action: 'pause', client: 'w1' })).status, 200);
  assert.equal((await controlCall(controller, controllerId, { action: 'force', client: 'w1' })).status, 200);
  assert.equal((await controlCall(controller, controllerId, { action: 'resume', client: 'w1' })).status, 200);
  assert.equal(arbiter.activeOverride(w1Id), null, 'the D4 verbs compose against the same row');
});

// ---------------------------------------------------------------------------
// 5. The detail route NEVER returns raw log lines or request bodies (D5)
// ---------------------------------------------------------------------------

test('enforcement 5: the detail projection is payload-free — no raw log lines, no bodies', async () => {
  // The target HAS raw material: a client_log tail (w2) and a real
  // lease with a job_id. The detail response must carry neither —
  // only the queue_preview metadata the local dashboard shows.
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  // The harness detector has no polled feed, so the grant's idle verdict
  // rides an explicit signal (the documented test-callers path — the
  // signal applies verbatim).
  const lease = arbiter.requestLease({
    client_id: w1Id,
    project: 'career-ops',
    job_id: 'job-a1',
    estimated_seconds: 900,
    signal: { now: Date.now(), idle: true, idle_for_s: 900, last_activity: null, last_log_write: null, signal_degraded: false, degraded_reason: null, feed_enabled: true },
  });
  assert.ok(lease.ok && lease.lease, 'seed a real active lease (its id + job id are raw material)');
  const leaseId = lease.lease!.lease_id;

  const r = await detailCall(controller, controllerId);
  assert.equal(r.status, 200);
  // Raw log lines: the stored client_log tail NEVER crosses the wire.
  assert.ok(!r.text.includes('RAW-LOG-MARKER-1'), 'w2\'s raw log line 1 never appears on the detail route');
  assert.ok(!r.text.includes('RAW-LOG-MARKER-2'), 'w2\'s raw log line 2 never appears on the detail route');
  assert.ok(!r.text.includes('client_log'), 'no client_log key rides the projection at all');
  // Request bodies / job payloads: no lease ids, no job payloads — the
  // detail is the queue projection (D3), not the state file.
  assert.ok(!r.text.includes(leaseId), 'no lease ids on the detail route');
  assert.ok(!r.text.includes('payload'), 'no payload material');
  // The shape is exactly the D3 projection: instance_id + ts + clients
  // (name/online/projects[queue_depth + queue_preview]).
  const b = r.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(b).sort(), ['clients', 'instance_id', 'ts'], 'the projection carries exactly the D3 keys — nothing else');
  for (const c of b.clients as { name: string; online: boolean; projects: Record<string, unknown>[] }[]) {
    assert.deepEqual(Object.keys(c).sort(), ['name', 'online', 'projects'], 'per-client: name + online + projects only');
    for (const p of c.projects) {
      assert.deepEqual(Object.keys(p).sort(), ['name', 'queue_depth', 'queue_preview'], 'per-project: the queue projection only');
    }
  }
  // And the DETAIL that is allowed still crosses (this is the route's
  // reason to exist): job ids + titles, payload-free.
  assert.ok(r.text.includes('job-a1') && r.text.includes('Apply to Acme'), 'queue detail (ids + titles) still crosses — payload-free');
});

// ---------------------------------------------------------------------------
// 6. Path binding: a /control-preview signature is not a /control signature
// ---------------------------------------------------------------------------

test('enforcement 6: a signature minted for another route is rejected (path binding)', async () => {
  // Sign a /control-preview payload but present it on /control: the
  // signed payload binds the route path, so verification against the
  // stored public key fails (the body does not match the claimed path).
  const h = signHeaders(controller, controllerId, '/api/mesh/control-preview', Date.now(), nextNonce());
  h['content-type'] = 'application/json';
  const r = await fetch(`${base}/api/mesh/control`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'pause', client: 'w1' }) });
  assert.equal(r.status, 403, 'a cross-route signature is denied, not admitted');
  const b = (await r.json()) as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'bad_signature', 'named: the signature does not bind this route (D8: a mismatch is a rejection, never a crash)');
  const w1Id = arbiter['store'].state.clients.find((c) => c.name === 'w1')!.client_id;
  assert.equal(arbiter.activeOverride(w1Id), null, 'the cross-route replay mutated nothing');
});

// ---------------------------------------------------------------------------
// The coarse plane stays byte-for-byte coarse (the unpaired surface)
// ---------------------------------------------------------------------------

test('enforcement 7: the coarse plane stays coarse — no detail leaks through /api/mesh', async () => {
  const r = await fetch(`${base}/api/mesh`, { headers: { authorization: `Bearer ${PEER}` } });
  assert.equal(r.status, 200, 'the #50 read plane stands alone (zero pairing)');
  const text = await r.text();
  assert.ok(!text.includes('job-a1'), 'no job ids on the coarse plane');
  assert.ok(!text.includes('Apply to Acme'), 'no queue titles on the coarse plane');
  assert.ok(!text.includes('RAW-LOG-MARKER-1'), 'no raw log lines on the coarse plane');
});

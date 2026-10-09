/**
 * edges.test.ts — mesh edge records + the fail-closed per-edge posture
 * (#39 slice 1, decision: docs/architecture/pairing.md).
 *
 * Covers:
 *   - EdgeStore: missing file = empty (no crash), upsert persists a 0600
 *     file, a reload sees the edges, an EMPTY file loads empty and stays
 *     in place, a CORRUPT file recovers to an empty store without
 *     throwing (stale moved aside as `.corrupt-*`), remove is immediate
 *   - verifyRequester with REAL ed25519 crypto: a signature under the
 *     stored public key verifies; a tampered payload fails; a signature
 *     from a DIFFERENT key fails; an unknown instance_id is rejected
 *     (D8); a missing instance_id is rejected; the path binding holds
 *     (a /detail signature is not a /control-preview signature)
 *   - the routes: GET /api/mesh/detail + /api/mesh/control-preview are
 *     403 with a NAMED reason when no edge exists (D8 fail-closed),
 *     unreachable with the coarse peer_token (and with an admin token),
 *     401 without a signature envelope, and — with a real edge — 200
 *     carrying the queue detail / the inert action set (D5 direction
 *     denial included)
 *   - the coarse read plane is unaffected: peer_token still reads
 *     GET /api/mesh, the anonymous /api/state shape is unchanged
 *
 * Hermetic: real Fastify app on an ephemeral loopback port, real
 * node:crypto ed25519 keypairs via the #55 Identity substrate. No network.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { Identity } from '../src/identity.js';
import { EdgeStore, edgesFileOf, signEdgePayload, verifyRequester, type EdgeSignaturePayload } from '../src/edges.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const ADMIN = 'admin-token-1';
const PEER = 'fleet-peer-token';
const NONCE = 'nonce-abc-123';

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

/** Sign an edge envelope exactly the wire layer parses it (headers). */
function signHeaders(identity: Identity, instanceId: string, path: string, ts: number, nonce: string): Record<string, string> {
  const { signatureB64url } = signEdgePayload(identity, { instance_id: instanceId, path, ts, nonce });
  return {
    'x-idlefill-instance-id': instanceId,
    'x-idlefill-signature': signatureB64url,
    'x-idlefill-nonce': nonce,
    'x-idlefill-ts': String(ts),
  };
}

let tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'idlefill-edges-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// EdgeStore — the file substrate (D2)
// ---------------------------------------------------------------------------

test('EdgeStore: a missing file loads empty and never crashes (the D8 default)', () => {
  const dir = mkTmp();
  const file = join(dir, 'mesh_edges.json');
  const store = new EdgeStore(file);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('m-whoever'), null);
});

test('EdgeStore: an EMPTY file loads empty and is left in place (not corruption)', () => {
  const dir = mkTmp();
  const file = join(dir, 'mesh_edges.json');
  writeFileSync(file, '');
  const store = new EdgeStore(file);
  assert.deepEqual(store.list(), []);
  assert.ok(existsSync(file), 'an empty file is the no-edges state — not moved aside');
  const store2 = new EdgeStore(file);
  assert.deepEqual(store2.list(), []);
});

test('EdgeStore: upsert persists a 0600 sibling file, reload sees the edges', () => {
  const dir = mkTmp();
  const file = edgesFileOf(join(dir, 'state.json'));
  const a = Identity.mint();
  const store = new EdgeStore(file);
  store.upsert({ peer_instance_id: a.instanceId ?? 'm-aaaaaaaaaaaa', peer_public_key: a.publicKeyB64url, peer_name: 'lab box', direction: 'controls_me', created_at: T0 });
  assert.equal(EdgeStore.fileMode(file), 0o600, 'owner-only on disk');
  // Never in the state file (D2: the state file rides every atomic save).
  assert.ok(!existsSync(join(dir, 'state.json')) || !readFileSync(join(dir, 'state.json'), 'utf-8').includes(a.publicKeyB64url), 'no edge material in state.json');
  const again = new EdgeStore(file);
  const rec = again.get('m-aaaaaaaaaaaa');
  assert.ok(rec, 'edge survives a reload');
  assert.equal(rec?.peer_public_key, a.publicKeyB64url);
  assert.equal(rec?.direction, 'controls_me');
  assert.equal(rec?.peer_name, 'lab box');
  assert.equal(rec?.created_at, T0);
});

test('EdgeStore: a corrupt file recovers to an empty store without throwing', () => {
  const dir = mkTmp();
  const file = join(dir, 'mesh_edges.json');
  writeFileSync(file, '{ this is not json');
  const store = new EdgeStore(file); // must not throw
  assert.deepEqual(store.list(), [], 'empty store after corruption');
  const stale = readdirSync(dir).filter((f) => f.startsWith('mesh_edges.json.corrupt-'));
  assert.equal(stale.length, 1, 'the stale file is preserved, not deleted');
  assert.ok(!existsSync(file), 'the corrupt file itself is moved aside');
  // The store stays usable: a fresh edge writes a valid file.
  const b = Identity.mint();
  store.upsert({ peer_instance_id: 'm-bbbbbbbbbbbb', peer_public_key: b.publicKeyB64url, direction: 'i_control', created_at: T0 + 1 });
  assert.equal(EdgeStore.fileMode(file), 0o600);
  assert.deepEqual(new EdgeStore(file).list().map((r) => r.peer_instance_id), ['m-bbbbbbbbbbbb']);
});

test('EdgeStore: a shape-invalid record inside a valid file recovers to empty (never half-loaded)', () => {
  const dir = mkTmp();
  const file = join(dir, 'mesh_edges.json');
  // A structurally invalid record (an unknown direction) makes the WHOLE
  // file corrupt — a partially-trusted edge file would be worse than no
  // edge file. (An unparseable public key, by contrast, is a SHAPE-valid
  // record: it loads, and that peer is denied at verification — D8.)
  writeFileSync(
    file,
    JSON.stringify({ v: 1, edges: [{ peer_instance_id: 'm-ok', peer_public_key: 'abc', direction: 'sideways', created_at: T0 }] }),
  );
  const store = new EdgeStore(file); // must not throw
  assert.deepEqual(store.list(), []);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('mesh_edges.json.corrupt-')), 'moved aside');
});

test('EdgeStore: remove is immediate (D6: the next lookup finds no edge)', () => {
  const dir = mkTmp();
  const file = join(dir, 'mesh_edges.json');
  const store = new EdgeStore(file);
  const a = Identity.mint();
  store.upsert({ peer_instance_id: 'm-cccccccccccc', peer_public_key: a.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  assert.ok(store.get('m-cccccccccccc'));
  assert.equal(store.remove('m-cccccccccccc'), true);
  assert.equal(store.get('m-cccccccccccc'), null, 'denial is immediate — no propagation delay');
  assert.equal(store.remove('m-cccccccccccc'), false);
  assert.deepEqual(new EdgeStore(file).list(), [], 'the deletion persists');
});

test('EdgeStore: upsert rejects malformed records at the door', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const a = Identity.mint();
  assert.throws(() => store.upsert({ peer_instance_id: 'x'.repeat(65), peer_public_key: a.publicKeyB64url, direction: 'controls_me', created_at: T0 }), /malformed/);
  assert.throws(() => store.upsert({ peer_instance_id: 'm-d', peer_public_key: a.publicKeyB64url, direction: 'sideways' as never, created_at: T0 }), /malformed/);
  assert.throws(() => store.upsert({ peer_instance_id: 'm-d', peer_public_key: '', direction: 'controls_me', created_at: T0 }), /malformed/);
  assert.throws(() => store.upsert({ peer_instance_id: 'm-d', peer_public_key: 'x'.repeat(65), direction: 'controls_me', created_at: T0 }), /malformed/);
  assert.throws(() => store.upsert({ peer_instance_id: 'm-d', peer_public_key: a.publicKeyB64url, direction: 'controls_me', created_at: Number.NaN }), /malformed/);
  assert.deepEqual(store.list(), [], 'rejections never leak a half-record');
});

test('EdgeStore: allows() applies the D5 direction policy', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const a = Identity.mint();
  const b = Identity.mint();
  store.upsert({ peer_instance_id: 'm-ctrl', peer_public_key: a.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  store.upsert({ peer_instance_id: 'm-i-ctrl', peer_public_key: b.publicKeyB64url, direction: 'i_control', created_at: T0 });
  assert.equal(store.allows('m-ctrl', 'controls_me'), true);
  assert.equal(store.allows('m-ctrl', 'i_control'), false);
  assert.equal(store.allows('m-i-ctrl', 'i_control'), true);
  assert.equal(store.allows('m-i-ctrl', 'controls_me'), false, 'a reverse-direction edge does not admit control of this machine');
  assert.equal(store.allows('m-none', 'controls_me'), false);
});

// ---------------------------------------------------------------------------
// verifyRequester — real ed25519 crypto
// ---------------------------------------------------------------------------

test('verifyRequester: a real signature under the stored public key verifies', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const peer = Identity.mint();
  const id = 'm-peer-real-1';
  store.upsert({ peer_instance_id: id, peer_public_key: peer.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  const payload: EdgeSignaturePayload = { instance_id: id, path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const sig = signEdgePayload(peer, payload).signatureB64url;
  const v = verifyRequester(store, id, payload, sig);
  assert.equal(v.ok, true, 'the genuine signature verifies');
  if (v.ok) assert.equal(v.edge.peer_instance_id, id);
});

test('verifyRequester: a tampered payload fails (bad_signature)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const peer = Identity.mint();
  const id = 'm-peer-real-2';
  store.upsert({ peer_instance_id: id, peer_public_key: peer.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  const payload: EdgeSignaturePayload = { instance_id: id, path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const sig = signEdgePayload(peer, payload).signatureB64url;
  // Tamper the signed body after the fact: the signature no longer covers it.
  const tampered = { ...payload, nonce: NONCE + '-tampered' };
  assert.equal(verifyRequester(store, id, tampered, sig).ok, false, 'tampered nonce rejected');
  if (!verifyRequester(store, id, tampered, sig).ok) {
    assert.equal(verifyRequester(store, id, tampered, sig).reason, 'bad_signature');
  }
  const tsTampered = { ...payload, ts: T0 + 60_000 };
  assert.equal(verifyRequester(store, id, tsTampered, sig).ok, false, 'tampered ts rejected');
  const pathTampered = { ...payload, path: '/api/mesh/control-preview' };
  assert.equal(verifyRequester(store, id, pathTampered, sig).ok, false, 'the path binding: a /detail signature is not a /control-preview signature');
});

test('verifyRequester: a signature from a DIFFERENT key fails (bad_signature)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const stored = Identity.mint();
  const impostor = Identity.mint();
  const id = 'm-peer-real-3';
  store.upsert({ peer_instance_id: id, peer_public_key: stored.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  const payload: EdgeSignaturePayload = { instance_id: id, path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const sig = signEdgePayload(impostor, payload).signatureB64url;
  const v = verifyRequester(store, id, payload, sig);
  assert.equal(v.ok, false, 'an impostor key cannot mint a valid signature for the stored id');
  if (!v.ok) assert.equal(v.reason, 'bad_signature');
});

test('verifyRequester: an unknown instance_id is rejected (D8 fail-closed)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const stranger = Identity.mint();
  const payload: EdgeSignaturePayload = { instance_id: 'm-never-paired', path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const sig = signEdgePayload(stranger, payload).signatureB64url;
  // Even a perfectly valid signature: no edge = denial (D8).
  const v = verifyRequester(store, payload.instance_id, payload, sig);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'unknown_instance_id', 'the named reason is the unpaired answer');
});

test('verifyRequester: a missing instance_id is rejected (named, no crash)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const peer = Identity.mint();
  const payload: EdgeSignaturePayload = { instance_id: 'm-x', path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const sig = signEdgePayload(peer, payload).signatureB64url;
  assert.equal(verifyRequester(store, null, payload, sig).ok, false);
  assert.equal(verifyRequester(store, '', payload, sig).ok, false);
  const v = verifyRequester(store, undefined, payload, sig);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'missing_instance_id');
});

test('verifyRequester: a garbage signature / missing signature is rejected (never throws)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  const peer = Identity.mint();
  const id = 'm-peer-real-4';
  store.upsert({ peer_instance_id: id, peer_public_key: peer.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  const payload: EdgeSignaturePayload = { instance_id: id, path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  assert.equal(verifyRequester(store, id, payload, null).ok, false, 'no signature at all');
  assert.equal(verifyRequester(store, id, payload, '!!!not-base64!!!').ok, false, 'unparseable signature');
  const short = signEdgePayload(peer, { ...payload, nonce: 'short' }).signatureB64url.slice(0, 8);
  assert.equal(verifyRequester(store, id, payload, short).ok, false, 'a truncated signature');
});

test('verifyRequester: an unparseable stored public key denies (D8: fail-closed, never throws)', () => {
  const dir = mkTmp();
  const store = new EdgeStore(join(dir, 'mesh_edges.json'));
  // A shape-valid record with an unparseable key: the store loads it
  // (it is not file corruption), but verification can never succeed —
  // the peer is denied, the arbiter does not crash.
  store.upsert({ peer_instance_id: 'm-badkey', peer_public_key: 'abc', direction: 'controls_me', created_at: T0 });
  const payload: EdgeSignaturePayload = { instance_id: 'm-badkey', path: '/api/mesh/detail', ts: T0, nonce: NONCE };
  const v = verifyRequester(store, 'm-badkey', payload, 'c2ln');
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'bad_signature');
});

// ---------------------------------------------------------------------------
// The routes — fail-closed posture over HTTP (D8)
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;
let dir: string;

before(async () => {
  dir = await mkTmp();
  cfg = baseCfg(dir, { mesh_peers: [], mesh_name: 'target-machine' });
  const made = mkApp(cfg);
  app = made.app;
  arbiter = made.arbiter;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

test('D8: no edge exists → both per-edge routes are 403 with a NAMED reason', async () => {
  // A real, valid signature from a real key — and still denied, because
  // the target has no edge for this instance_id. That is the posture:
  // the signature cannot open what pairing never closed.
  const stranger = Identity.mint();
  const id = 'm-never-paired';
  const detail = signHeaders(stranger, id, '/api/mesh/detail', T0, NONCE);
  const r1 = await fetch(`${base}/api/mesh/detail`, { headers: detail });
  assert.equal(r1.status, 403, 'detail is denied without an edge');
  const b1 = (await r1.json()) as { error: string; reason: string; hint: string };
  assert.equal(b1.error, 'edge_denied');
  assert.equal(b1.reason, 'unknown_instance_id', 'the reason is named, not a bare 403');
  assert.ok(b1.hint.length > 0);

  const preview = signHeaders(stranger, id, '/api/mesh/control-preview', T0, NONCE);
  const r2 = await fetch(`${base}/api/mesh/control-preview`, { headers: preview });
  assert.equal(r2.status, 403, 'control-preview is denied without an edge');
  const b2 = (await r2.json()) as { error: string; reason: string };
  assert.equal(b2.error, 'edge_denied');
  assert.equal(b2.reason, 'unknown_instance_id');
});

test('the coarse peer_token cannot reach the per-edge routes', async () => {
  // peer_token is scoped to GET /api/mesh ONLY (the #50 plane): the
  // per-edge routes are signature-authenticated, and the token answers
  // 401 on them (no signature envelope) — not 403, not 200.
  const h = { authorization: 'Bearer ' + PEER } as Record<string, string>;
  assert.equal((await fetch(`${base}/api/mesh/detail`, { headers: h })).status, 401);
  assert.equal((await fetch(`${base}/api/mesh/control-preview`, { headers: h })).status, 401);
});

test('an admin token cannot reach the per-edge routes either (a peer, not a local reader)', async () => {
  const h = { authorization: 'Bearer ' + ADMIN } as Record<string, string>;
  assert.equal((await fetch(`${base}/api/mesh/detail`, { headers: h })).status, 401, 'the local operator reads their own machine via /api/state');
  assert.equal((await fetch(`${base}/api/mesh/control-preview`, { headers: h })).status, 401);
});

test('no signature envelope at all → 401 (the hook answers, the route never runs)', async () => {
  assert.equal((await fetch(`${base}/api/mesh/detail`)).status, 401);
  assert.equal((await fetch(`${base}/api/mesh/detail`, { headers: { 'x-idlefill-instance-id': 'm-x' } })).status, 401);
  assert.equal((await fetch(`${base}/api/mesh/detail`, { headers: { 'x-idlefill-instance-id': 'm-x', 'x-idlefill-signature': 'sig' } })).status, 401);
});

test('with a real edge: a genuine signature unlocks detail + control-preview (D5, D3, D4 shapes)', async () => {
  const peer = Identity.mint();
  const id = 'm-paired-peer';
  arbiter.edges().upsert({ peer_instance_id: id, peer_public_key: peer.publicKeyB64url, peer_name: 'controller', direction: 'controls_me', created_at: T0 });

  // The target has real queue detail — the paired edge may read it.
  arbiter.registerClient('w1', undefined, '10.0.0.5', [
    { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 3, queue_preview: [{ job_id: 'job-1', title: 'Apply to Acme', company: 'Acme', score: 0.9, attempts: 0 }, { job_id: 'job-2', title: 'Research Zeta', company: 'Zeta', score: 0.7, attempts: 1 }] },
  ]);

  const detail = signHeaders(peer, id, '/api/mesh/detail', T0, NONCE);
  const r1 = await fetch(`${base}/api/mesh/detail`, { headers: detail });
  assert.equal(r1.status, 200, 'a valid signature under the stored public key is admitted');
  const b1 = (await r1.json()) as { instance_id: string; clients: { name: string; projects: { name: string; queue_depth: number; queue_preview: { job_id: string; title: string }[] }[] }[] };
  assert.equal(b1.instance_id, arbiter.instanceId());
  const w1 = b1.clients.find((c) => c.name === 'w1');
  assert.ok(w1, 'the target LOCAL client is visible (no transitivity: peers are not rows)');
  const p = w1?.projects.find((x) => x.name === 'career-ops');
  assert.equal(p?.queue_depth, 3);
  assert.deepEqual(p?.queue_preview.map((x) => x.job_id), ['job-1', 'job-2'], 'queue DETAIL crosses (job ids + titles) — the coarse plane never carries it');
  assert.equal(p?.queue_preview[0]?.title, 'Apply to Acme');

  const preview = signHeaders(peer, id, '/api/mesh/control-preview', T0, NONCE);
  const r2 = await fetch(`${base}/api/mesh/control-preview`, { headers: preview });
  assert.equal(r2.status, 200, 'control-preview admits the same edge');
  const b2 = (await r2.json()) as { instance_id: string; actions: string[]; clients: { name: string; override: string | null }[] };
  assert.equal(b2.instance_id, arbiter.instanceId());
  assert.deepEqual(b2.actions, ['pause', 'resume', 'force', 'clear', 'reorder'], 'the D4 action set is named (the relay itself is slice 2)');
  const w1ov = b2.clients.find((c) => c.name === 'w1');
  assert.equal(w1ov?.override, null, 'the current override posture rides the preview (inert: nothing mutated)');

  // The edge on disk is the credential (D2): 0600, sibling to state.json,
  // and the state file never carries the peer public key.
  const edgeFile = edgesFileOf(cfg.state_file);
  assert.equal(EdgeStore.fileMode(edgeFile), 0o600);
  const stateRaw = readFileSync(cfg.state_file, 'utf-8');
  assert.ok(!stateRaw.includes(peer.publicKeyB64url), 'the peer public key never touches state.json');
  assert.ok(!stateRaw.includes('mesh_edges'), 'no edge material in the state file');
});

test('D5: a reverse-direction edge (i_control) is denied on the controlled side', async () => {
  const other = Identity.mint();
  const id = 'm-reverse-peer';
  arbiter.edges().upsert({ peer_instance_id: id, peer_public_key: other.publicKeyB64url, direction: 'i_control', created_at: T0 });
  const h = signHeaders(other, id, '/api/mesh/detail', T0, NONCE);
  const r = await fetch(`${base}/api/mesh/detail`, { headers: h });
  assert.equal(r.status, 403, 'pairing B to A does not let A control B');
  const b = (await r.json()) as { error: string; reason: string };
  assert.equal(b.error, 'edge_denied');
  assert.equal(b.reason, 'direction_denied', 'named: the edge exists but points the other way');
});

test('D6: removing the edge denies the next request immediately (no propagation)', async () => {
  // The paired peer from the earlier test still holds a valid key; its
  // edge is deleted on THIS side — the next signed request is 403.
  const peer = Identity.mint();
  const id = 'm-revoked-peer';
  arbiter.edges().upsert({ peer_instance_id: id, peer_public_key: peer.publicKeyB64url, direction: 'controls_me', created_at: T0 });
  const h = signHeaders(peer, id, '/api/mesh/detail', T0, NONCE);
  assert.equal((await fetch(`${base}/api/mesh/detail`, { headers: h })).status, 200, 'admitted while the edge exists');
  assert.equal(arbiter.edges().remove(id), true);
  const r = await fetch(`${base}/api/mesh/detail`, { headers: h });
  assert.equal(r.status, 403, 'the NEXT request is denied — immediate local deletion (D6)');
  const b = (await r.json()) as { reason: string };
  assert.equal(b.reason, 'unknown_instance_id');
});

test('the coarse read plane is unaffected: peer_token still reads GET /api/mesh', async () => {
  const r = await fetch(`${base}/api/mesh`, { headers: { authorization: 'Bearer ' + PEER } });
  assert.equal(r.status, 200, 'the #50 read plane stands alone');
  const b = (await r.json()) as Record<string, unknown>;
  assert.equal(b.instance_id, arbiter.instanceId());
  assert.ok(Array.isArray(b.servers), 'coarse shape unchanged');
  // And it is still coarse: no job ids or queue detail on the unpaired surface.
  const json = JSON.stringify(b);
  assert.ok(!json.includes('job-1'), 'no job ids on the coarse plane');
  assert.ok(!json.includes('Apply to Acme'), 'no queue titles on the coarse plane');
});

test('the anonymous /api/state shape is unchanged: no new top-level keys', async () => {
  const r = await fetch(`${base}/api/state`);
  assert.equal(r.status, 200);
  const st = (await r.json()) as Record<string, unknown>;
  for (const k of Object.keys(st)) {
    assert.ok(!k.includes('edge'), `no edge material published on /api/state (saw ${k})`);
  }
  assert.ok('clients' in st && 'servers' in st, 'the existing shape stands');
});

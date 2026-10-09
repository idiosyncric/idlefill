/**
 * mesh.test.ts — the mesh federation read plane (#50).
 *
 * Covers:
 *   - sanitizeSnapshot: hostile/malformed remote payloads clamped or rejected
 *   - MeshFederation.refresh: success, failure keeps the last snapshot with
 *     an exception-only error, stale fetches render offline
 *   - GET /api/mesh auth: fleet peer_token works here ONLY, admin tokens
 *     work, anonymous + wrong token are 401
 *   - peer_token scope: it never unlocks any other /api/* route
 *   - /api/state: the `mesh` key is absent when unwired, present when wired
 *   - instance_id persists across a restart; peer snapshots NEVER touch
 *     state.json (ephemeral by design)
 *   - the snapshot is coarse: no job ids, titles, URLs, or payloads
 *
 * Hermetic: a real Fastify app on an ephemeral loopback port + an injected
 * fake fetcher. No network.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import {
  MeshFederation,
  PEER_STALE_MS,
  ROSTER_PULL_MS,
  buildMeshSnapshot,
  sanitizeSnapshot,
  sanitizeRoster,
  mintInstanceId,
  buildRosterFetcher,
  type MeshFetcher,
  type MeshSnapshot,
  type RosterFetcher,
  type RosterEdgeRow,
  type EdgeFiller,
} from '../src/mesh.js';
import { FleetClient, enrollmentFileOf, loadEnrollment, enrollmentFileMode } from '../src/fleet-client.js';
import { Identity } from '../src/identity.js';
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
    peer_token: '',
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

function mkApp(cfg: ServerConfig, mesh?: MeshFederation) {
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
  const app = buildApi({ arbiter, cfg, publicDir: join(import.meta.dirname, '..', 'public'), mesh });
  attachWebSocket(app, arbiter, cfg);
  return { app, arbiter, store };
}

// ---------------------------------------------------------------------------
// sanitizeSnapshot — a remote snapshot is UNTRUSTED input
// ---------------------------------------------------------------------------

test('sanitizeSnapshot: a good snapshot passes through', () => {
  const good: MeshSnapshot = {
    instance_id: 'm-abc123',
    name: 'urza',
    ts: T0,
    servers: [{ name: 'llama-swap', idle: true, idle_for_s: 600, degraded: false }],
    queue_depth: 42,
    sessions: 2,
    active_leases: 1,
  };
  const out = sanitizeSnapshot(good);
  assert.ok(out);
  assert.equal(out.instance_id, 'm-abc123');
  assert.equal(out.queue_depth, 42);
  assert.equal(out.servers.length, 1);
  assert.equal(out.servers[0]!.idle_for_s, 600);
});

test('sanitizeSnapshot: missing identity is rejected outright', () => {
  assert.equal(sanitizeSnapshot(null), null);
  assert.equal(sanitizeSnapshot('nope'), null);
  assert.equal(sanitizeSnapshot([]), null);
  assert.equal(sanitizeSnapshot({ name: 'no id' }), null);
  assert.equal(sanitizeSnapshot({ instance_id: '   ' }), null);
});

test('sanitizeSnapshot: hostile values are clamped, never trusted', () => {
  const hostile = {
    instance_id: 'x'.repeat(5000),
    name: 'y'.repeat(5000),
    ts: 'not a number',
    servers: Array.from({ length: 500 }, (_, i) => ({
      name: 'n'.repeat(5000),
      idle: 'truthy string',
      idle_for_s: -50,
      degraded: 1,
    })).concat([null, 7, 'junk', []]),
    queue_depth: -12,
    sessions: Number.NaN,
    active_leases: 3.7,
    version: 'v'.repeat(900),
  };
  const out = sanitizeSnapshot(hostile);
  assert.ok(out);
  assert.ok(out.instance_id.length <= 64, 'instance_id capped');
  assert.ok(out.name.length <= 64, 'name capped');
  assert.equal(out.ts, 0, 'non-numeric ts → 0');
  assert.ok(out.servers.length <= 20, 'server rows capped');
  for (const s of out.servers) {
    assert.ok(s.name.length <= 64);
    assert.equal(s.idle, false, 'non-boolean idle → false');
    assert.equal(s.idle_for_s, null, 'negative idle_for_s → null');
    assert.equal(s.degraded, false, 'non-boolean degraded → false');
  }
  assert.equal(out.queue_depth, 0, 'negative → 0');
  assert.equal(out.sessions, 0, 'NaN → 0');
  assert.equal(out.active_leases, 3, 'floored');
  assert.ok((out.version ?? '').length <= 64);
});

test('sanitizeSnapshot: unknown extra keys never ride through', () => {
  const out = sanitizeSnapshot({
    instance_id: 'm-1',
    name: 'a',
    ts: T0,
    servers: [],
    queue_depth: 0,
    sessions: 0,
    active_leases: 0,
    job_ids: ['secret-job'],
    payload: 'the whole queue',
    url: 'http://internal',
  });
  assert.ok(out);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('secret-job'), 'no job ids leak');
  assert.ok(!json.includes('the whole queue'), 'no payloads leak');
  assert.ok(!json.includes('http://internal'), 'no engine URLs leak');
});

// ---------------------------------------------------------------------------
// MeshFederation — pull, failure posture, liveness
// ---------------------------------------------------------------------------

const PEER_URL = 'http://peer-1';

function snap(over: Partial<MeshSnapshot> = {}): MeshSnapshot {
  return {
    instance_id: 'm-peer1',
    name: 'peer-one',
    ts: T0,
    servers: [{ name: 'llama-swap', idle: true, idle_for_s: 900, degraded: false }],
    queue_depth: 7,
    sessions: 1,
    active_leases: 0,
    ...over,
  };
}

test('refresh: a successful pull records the snapshot + observed instance id', async () => {
  const cfg = baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL, name: 'lab box' }], peer_token: PEER });
  const fetcher: MeshFetcher = async (url, token) => {
    assert.equal(url, `${PEER_URL}/api/mesh`, 'pulls the mesh endpoint');
    assert.equal(token, PEER, 'presents the fleet read token');
    return snap();
  };
  const m = new MeshFederation(cfg, fetcher);
  assert.equal(m.enabled, true);
  await m.refresh(T0);
  const [v] = m.view(T0);
  assert.ok(v);
  assert.equal(v.online, true);
  assert.equal(v.name, 'lab box', 'config name wins');
  assert.equal(v.instance_id, 'm-peer1', 'observed id recorded');
  assert.equal(v.fetch_age_s, 0);
  assert.equal(v.error, undefined, 'no error row on success');
  assert.equal(v.snapshot?.queue_depth, 7);
});

test('refresh: a failed pull keeps the last snapshot, adds an exception-only error', async () => {
  const cfg = baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL }] });
  let mode: 'ok' | 'fail' = 'ok';
  const fetcher: MeshFetcher = async () => {
    if (mode === 'fail') throw new Error('ECONNREFUSED');
    return snap();
  };
  const m = new MeshFederation(cfg, fetcher);
  await m.refresh(T0);
  assert.equal(m.view(T0)[0]!.error, undefined);

  mode = 'fail';
  await m.refresh(T0 + 10_000);
  const v = m.view(T0 + 10_000)[0]!;
  assert.equal(v.error, 'ECONNREFUSED');
  assert.equal(v.snapshot?.queue_depth, 7, 'last snapshot stands');
  assert.equal(v.online, true, 'still inside the 90s window');
  assert.equal(v.fetch_age_s, 10, 'age counts from the last SUCCESS');

  mode = 'ok';
  await m.refresh(T0 + 20_000);
  const w = m.view(T0 + 20_000)[0]!;
  assert.equal(w.error, undefined, 'error cleared on recovery');
});

test('refresh: past the 90s window a peer renders offline (snapshot still shown)', async () => {
  const cfg = baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL }] });
  const m = new MeshFederation(cfg, async () => snap());
  await m.refresh(T0);
  const v = m.view(T0 + PEER_STALE_MS + 1)[0]!;
  assert.equal(v.online, false);
  assert.ok(v.snapshot, 'the last snapshot stays visible for context');
});

test('refresh: a malformed remote payload is an error, never a snapshot', async () => {
  const cfg = baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL }] });
  const m = new MeshFederation(cfg, async () => ({ nonsense: true }));
  await m.refresh(T0);
  const v = m.view(T0)[0]!;
  assert.equal(v.snapshot, null);
  assert.equal(v.error, 'malformed snapshot');
  assert.equal(v.online, false, 'never succeeded → offline');
  assert.equal(v.fetch_age_s, null);
});

test('refresh: no peers configured = inert (fetcher never called)', async () => {
  const cfg = baseCfg(await mkTmp());
  let calls = 0;
  const m = new MeshFederation(cfg, async () => {
    calls++;
    return snap();
  });
  assert.equal(m.enabled, false);
  await m.refresh(T0);
  assert.equal(calls, 0);
  assert.deepEqual(m.view(T0), []);
});

test('mesh_peers: trailing slashes normalized, blank urls dropped, no self-entry', async () => {
  const cfg = baseCfg(await mkTmp(), {
    mesh_peers: [{ url: 'http://a/' }, { url: '  ' }, { url: 'self' }, { url: 'http://a' }],
  });
  const m = new MeshFederation(cfg, async () => snap());
  const urls = m.view(T0).map((v) => v.url);
  assert.deepEqual(urls, ['http://a'], 'normalized + deduped + blanks/self dropped');
});

test('peer name falls back to the observed snapshot name, then the URL host', async () => {
  const cfg = baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL }] });
  const m = new MeshFederation(cfg, async () => snap());
  await m.refresh(T0);
  assert.equal(m.view(T0)[0]!.name, 'peer-one', 'observed name');
  const m2 = new MeshFederation(cfg, async () => {
    throw new Error('down');
  });
  assert.equal(m2.view(T0)[0]!.name, 'peer-1', 'URL host');
});

// ---------------------------------------------------------------------------
// buildMeshSnapshot — the local side is coarse by construction
// ---------------------------------------------------------------------------

test('buildMeshSnapshot: carries counts + engine state, never job detail', () => {
  const s = buildMeshSnapshot(
    'm-1',
    'urza',
    [
      { name: 'llama-swap', signal: { idle: true, idle_for_s: 600, signal_degraded: false } },
      { name: 'unwatched', signal: null },
    ],
    12,
    3,
    1,
    T0,
    '2',
  );
  assert.equal(s.instance_id, 'm-1');
  assert.equal(s.name, 'urza');
  assert.equal(s.version, '2');
  assert.equal(s.servers.length, 2);
  assert.deepEqual(s.servers[0], { name: 'llama-swap', idle: true, idle_for_s: 600, degraded: false });
  assert.deepEqual(s.servers[1], { name: 'unwatched', idle: false, idle_for_s: null, degraded: false }, 'no detector → not idle, not degraded');
  assert.equal(s.queue_depth, 12);
  assert.equal(s.sessions, 3);
  assert.equal(s.active_leases, 1);
});

// ---------------------------------------------------------------------------
// HTTP surface: /api/mesh auth + the /api/state mesh key
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'idlefill-mesh-'));
  tmpDirs.push(d);
  return d;
}

let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;

before(async () => {
  const dir = await mkTmp();
  cfg = baseCfg(dir, {
    mesh_peers: [{ url: 'http://peer-1', name: 'peer-one' }],
    peer_token: PEER,
    mesh_name: 'home-arbiter',
  });
  const fed = new MeshFederation(cfg, async () => snap());
  const made = mkApp(cfg, fed);
  app = made.app;
  arbiter = made.arbiter;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await fed.refresh(T0);
});

after(async () => {
  await app.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

test('GET /api/mesh: the fleet peer_token works here', async () => {
  const res = await fetch(`${base}/api/mesh`, { headers: { authorization: `Bearer ${PEER}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as MeshSnapshot;
  assert.equal(body.name, 'home-arbiter', 'config mesh_name');
  assert.equal(body.instance_id, arbiter.instanceId());
  assert.equal(body.servers.length, 1);
  assert.equal(body.servers[0]!.name, 'llama-swap');
});

test('GET /api/mesh: a local admin token also works (surfaces read the same endpoint)', async () => {
  const res = await fetch(`${base}/api/mesh`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 200);
});

test('GET /api/mesh: anonymous and wrong-token are 401', async () => {
  assert.equal((await fetch(`${base}/api/mesh`)).status, 401);
  assert.equal((await fetch(`${base}/api/mesh`, { headers: { authorization: 'Bearer nope' } })).status, 401);
});

test('peer_token is scoped: it unlocks NO other /api/* route', async () => {
  const h = { authorization: `Bearer ${PEER}` };
  // Reads
  assert.equal((await fetch(`${base}/api/leases`, { headers: h })).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: h })).status, 401);
  assert.equal((await fetch(`${base}/api/servers`, { headers: h })).status, 401);
  // Writes
  assert.equal((await fetch(`${base}/api/projects/career-ops`, { method: 'POST', headers: h, body: JSON.stringify({ paused: true }) })).status, 401);
  assert.equal((await fetch(`${base}/api/clients/x/override`, { method: 'POST', headers: h, body: JSON.stringify({ override: 'pause' }) })).status, 401);
  // And the admin token still works everywhere it did before.
  assert.equal((await fetch(`${base}/api/leases`, { headers: { authorization: `Bearer ${ADMIN}` } })).status, 200);
});

test('peer_token does not unlock the WS lease-events channel', async () => {
  // The WS handshake validates with isValidToken only — the read token must
  // not reach the events stream.
  const WebSocket = (await import('ws')).default;
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/leases/events?token=${PEER}`);
    const t = setTimeout(() => {
      ws.terminate();
      resolve(-1);
    }, 3000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(t);
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      clearTimeout(t);
      ws.close();
      resolve(101);
    });
    ws.on('error', () => {
      clearTimeout(t);
    });
  });
  assert.equal(status, 401, 'read token rejected at the WS handshake');
});

test('/api/state carries the mesh key: identity + merged peer view', async () => {
  const res = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 200);
  const st = (await res.json()) as Record<string, unknown>;
  const mesh = st.mesh as { instance_id: string; peers: Record<string, unknown>[] };
  assert.ok(mesh, 'mesh key present when wired');
  assert.equal(mesh.instance_id, arbiter.instanceId());
  assert.equal(mesh.peers.length, 1);
  const p = mesh.peers[0]!;
  assert.equal(p.url, 'http://peer-1');
  assert.equal(p.name, 'peer-one');
  // The snapshot was pulled at fake-clock T0; /api/state evaluates liveness
  // against the REAL clock, so the peer is honestly offline here (the
  // fetch_age is enormous). The online flag itself is covered against a
  // controlled clock in the MeshFederation unit tests.
  assert.equal(p.online, false);
  assert.ok((p.fetch_age_s as number) > PEER_STALE_MS / 1000);
  assert.equal(p.instance_id, 'm-peer1');
  // Coarse: the peer row carries counts, never job detail.
  const json = JSON.stringify(p);
  assert.ok(!json.includes('job_id'), 'no job ids in the mesh view');
});

test('/api/state: the anonymous dashboard read still works and sees the mesh key', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const st = (await res.json()) as Record<string, unknown>;
  assert.ok(st.mesh, 'the peer strip renders for the anonymous dashboard too');
});

test('instance_id persists across a restart (the state file is the identity store)', async () => {
  const first = arbiter.instanceId();
  assert.match(first, /^m-[0-9a-f]{12}$/);
  // Re-load the same state file into a fresh arbiter: same id.
  const again = mkApp(cfg);
  assert.equal(again.arbiter.instanceId(), first);
  // And it is on disk.
  const raw = JSON.parse(readFileSync(cfg.state_file, 'utf-8'));
  assert.equal(raw.instance_id, first);
});

test('peer snapshots NEVER touch state.json (ephemeral by design)', async () => {
  const raw = JSON.parse(readFileSync(cfg.state_file, 'utf-8'));
  const json = JSON.stringify(raw);
  assert.ok(!json.includes('m-peer1'), 'no peer snapshot persisted');
  assert.ok(!('mesh' in raw), 'no mesh key in the state file');
  assert.ok(!json.includes('peer-1'), 'no peer urls persisted');
});

test('unwired build: /api/state has no mesh key at all (shape unchanged)', async () => {
  const dir = await mkTmp();
  const bare = mkApp(baseCfg(dir));
  await bare.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = bare.app.server.address();
  const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const st = (await (await fetch(`${b}/api/state`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, unknown>;
  assert.ok(!('mesh' in st), 'no mesh key when the module is not wired');
  // The /api/mesh route still answers (this instance publishes its own snapshot).
  const r = await fetch(`${b}/api/mesh`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(r.status, 200);
  await bare.app.close();
});

test('mintInstanceId: unique + shaped', () => {
  const a = mintInstanceId();
  const b = mintInstanceId();
  assert.match(a, /^m-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('totalQueueDepth sums client-reported depths (the coarse mesh depth)', () => {
  arbiter.registerClient('c1', undefined, '10.0.0.1', [
    { name: 'career-ops', model: 'm', estimated_seconds: 900, queue_depth: 4 },
    { name: 'other', model: 'm', estimated_seconds: 900, queue_depth: 8 },
  ]);
  arbiter.registerClient('c2', undefined, '10.0.0.2', [{ name: 'career-ops', model: 'm', estimated_seconds: 900, queue_depth: 1 }]);
  assert.equal(arbiter.totalQueueDepth(), 13);
});

// ---------------------------------------------------------------------------
// fleet_id seam (#55 D5, slice 2) — the multi-tenant seam, machine identity
// only: one ADD key on the instance row, default `home`, config-overridable,
// published on the mesh snapshot. No accounts, sessions, or roles.
// ---------------------------------------------------------------------------

test('fleet_id: a config with the key set produces the value on the row and the snapshot', async () => {
  const dir = await mkTmp();
  const store = new StateStore(join(dir, 'state.json'));
  const cfg = baseCfg(dir, { fleet_id: 'urza-lab' });
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  const arb = new Arbiter(store, cfg, det);
  assert.equal(arb.fleetId(), 'urza-lab', 'config value wins');
  // Persisted on the instance row, next to instance_id (the identity store).
  arb.instanceId();
  store.save();
  const raw = JSON.parse(readFileSync(cfg.state_file, 'utf-8'));
  assert.equal(raw.fleet_id, 'urza-lab', 'fleet_id is in state.json');
  assert.ok(raw.instance_id, 'the instance row itself is still persisted');
  // And it rides the mesh snapshot as an ADD key.
  const snap = buildMeshSnapshot(arb.instanceId(), 'a', [], 0, 0, 0, T0, undefined, undefined, arb.fleetId());
  assert.equal(snap.fleet_id, 'urza-lab');
});

test('fleet_id: no config key (and no persisted row) produces the `home` default', async () => {
  const dir = await mkTmp();
  const store = new StateStore(join(dir, 'state.json'));
  const cfg = baseCfg(dir); // fleet_id absent — baseCfg carries no such key
  assert.equal(cfg.fleet_id, undefined, 'precondition: the config key is absent');
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  const arb = new Arbiter(store, cfg, det);
  assert.equal(arb.fleetId(), 'home', 'the D5 default');
  const raw = JSON.parse(readFileSync(cfg.state_file, 'utf-8'));
  assert.equal(raw.fleet_id, 'home', 'the default is persisted too');
  // A reload reads the persisted row: same answer, no config involved.
  const again = new StateStore(cfg.state_file);
  const arb2 = new Arbiter(again, baseCfg(dir), det);
  assert.equal(arb2.fleetId(), 'home');
});

test('fleet_id: an old-shaped snapshot without the field parses fine (absent = unset, never a crash)', () => {
  const legacy: Record<string, unknown> = {
    instance_id: 'm-legacy1',
    name: 'old peer',
    ts: T0,
    servers: [],
    queue_depth: 3,
    sessions: 0,
    active_leases: 0,
  }; // pre-slice-2 shape: no fleet_id key at all
  const out = sanitizeSnapshot(legacy);
  assert.ok(out, 'the legacy snapshot is still a usable snapshot');
  assert.equal(out.instance_id, 'm-legacy1');
  assert.equal(out.queue_depth, 3);
  assert.equal(out.fleet_id, undefined, 'absent stays unset — not `home`, not a crash');
  // And the reader's view of it is well-formed.
  const cfg = baseCfg('/tmp', { mesh_peers: [{ url: 'http://legacy-peer' }] });
  const fed = new MeshFederation(cfg, async () => legacy);
  void fed.refresh(T0);
});

test('fleet_id: two instances with different fleet_id values are distinguishable in the snapshot reader', async () => {
  const snapA = { ...snap(), instance_id: 'm-fleet-a', fleet_id: 'alpha-fleet' };
  const snapB = { ...snap(), instance_id: 'm-fleet-b', fleet_id: 'beta-fleet' };
  const fed = new MeshFederation(
    baseCfg(await mkTmp(), { mesh_peers: [{ url: 'http://a' }, { url: 'http://b' }] }),
    async (url) => (url === 'http://a/api/mesh' ? snapA : snapB),
  );
  await fed.refresh(T0);
  const view = fed.view(T0);
  const a = view.find((v) => v.url === 'http://a')!;
  const b = view.find((v) => v.url === 'http://b')!;
  assert.equal(a.snapshot?.fleet_id, 'alpha-fleet');
  assert.equal(b.snapshot?.fleet_id, 'beta-fleet');
  assert.notEqual(a.snapshot?.fleet_id, b.snapshot?.fleet_id, 'the two tenants are told apart by the reader');
  // One of the two is a pre-seam peer: its label is simply unset, and the
  // other instance's label is untouched by it.
  const legacy = { ...snap(), instance_id: 'm-fleet-c' };
  const c = new MeshFederation(baseCfg(await mkTmp(), { mesh_peers: [{ url: 'http://c' }] }), async () => legacy);
  await c.refresh(T0);
  assert.equal(c.view(T0)[0]!.snapshot?.fleet_id, undefined);
  assert.equal(c.view(T0)[0]!.snapshot?.instance_id, 'm-fleet-c');
});

// ---------------------------------------------------------------------------
// Fleet roster pull (#55 D3, PROPOSED — the roster discovery seam)
//
// The service is the directory, never the pipe: a roster row adds a peer
// that is then pulled like any configured peer. The merge is ADD-only:
// an explicit mesh_peers entry wins over a roster row for the same
// instance_id, and a failed pull never touches the last-known peer set.
// ---------------------------------------------------------------------------

function rosterEnvelope(rows: Record<string, unknown>[]): unknown {
  return { instances: rows };
}

function rosterRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: 'm-roster1',
    name: 'roster-one',
    public_key: 'pk-roster-one',
    urls: [ROSTER_URL],
    last_seen: T0,
    ...over,
  };
}

const ROSTER_URL = 'http://roster-1:8787';

test('roster: no fleet_url means the pull never happens (byte-for-byte unchanged)', async () => {
  let rosterCalls = 0;
  const fetcher: MeshFetcher = async () => snap();
  const rosterFetcher: RosterFetcher = async () => {
    rosterCalls++;
    return rosterEnvelope([rosterRow()]);
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL }] }), fetcher);
  assert.equal(m.enabled, true, 'the static peer is there');
  // No fleet_url in baseCfg: the pull must be a no-op, every tick.
  await m.pullRoster(rosterFetcher, T0);
  await m.pullRoster(rosterFetcher, T0 + 2 * ROSTER_PULL_MS);
  assert.equal(rosterCalls, 0, 'the roster fetcher was never called');
  const urls = m.view(T0).map((v) => v.url);
  assert.deepEqual(urls, [PEER_URL], 'the peer set is the static config, byte-for-byte');
});

test('roster: an unreachable fleet service falls back to mesh_peers with no crash', async () => {
  const fetcher: MeshFetcher = async () => snap();
  const m = new MeshFederation(
    baseCfg(await mkTmp(), { mesh_peers: [{ url: PEER_URL, name: 'lab box' }], fleet_url: 'http://fleet-dead:8789' }),
    fetcher,
  );
  await m.pullRoster(async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  }, T0);
  // No crash; the static peer set stands.
  assert.deepEqual(m.view(T0).map((v) => v.url), [PEER_URL]);
  // And the read plane still works: the configured peer is pulled normally.
  await m.refresh(T0);
  const v = m.view(T0)[0]!;
  assert.equal(v.online, true);
  assert.equal(v.name, 'lab box');
  assert.equal(v.snapshot?.queue_depth, 7);
  // A second failure also never crashes (the next pull is due after the
  // PROPOSED 15 s interval and fails the same way).
  await m.pullRoster(async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  }, T0 + ROSTER_PULL_MS);
  assert.deepEqual(m.view(T0 + ROSTER_PULL_MS).map((v) => v.url), [PEER_URL]);
});

test('roster: a roster row adds a peer that is pulled like a configured peer', async () => {
  const meshFetcher: MeshFetcher = async (url, token) => {
    assert.equal(token, PEER, 'the merged peer is pulled with the fleet read token');
    if (url === `${ROSTER_URL}/api/mesh`) return { ...snap(), instance_id: 'm-roster1', name: 'roster-one' };
    return snap();
  };
  const m = new MeshFederation(
    baseCfg(await mkTmp(), {
      mesh_peers: [{ url: PEER_URL, name: 'lab box' }],
      fleet_url: 'http://fleet-1:8789',
      peer_token: PEER,
    }),
    meshFetcher,
  );
  const rosterFetcher: RosterFetcher = async (fleetUrl) => {
    assert.equal(fleetUrl, 'http://fleet-1:8789', 'pulls from the configured fleet url');
    return rosterEnvelope([rosterRow()]);
  };
  // The roster row's url is NOT in mesh_peers: it must appear after the pull.
  assert.equal(m.view(T0).find((v) => v.url === ROSTER_URL), undefined, 'precondition: not a configured peer');
  await m.pullRoster(rosterFetcher, T0);
  const after = m.view(T0);
  assert.deepEqual(after.map((v) => v.url).sort(), [PEER_URL, ROSTER_URL], 'the roster row added a peer');
  const r = after.find((v) => v.url === ROSTER_URL)!;
  assert.equal(r.instance_id, 'm-roster1', 'the roster identity rides the row');
  assert.equal(r.name, 'roster-one', 'the roster name rides the row');
  // It behaves EXACTLY like a configured peer: refresh pulls its /api/mesh.
  await m.refresh(T0);
  const pulled = m.view(T0).find((v) => v.url === ROSTER_URL)!;
  assert.equal(pulled.online, true, 'the merged peer was pulled (not an error row)');
  assert.equal(pulled.error, undefined);
  assert.equal(pulled.snapshot?.queue_depth, 7, 'its snapshot is the real peer snapshot');
});

test('roster: an explicit mesh_peers entry beats a roster row for the same instance_id', async () => {
  // The configured peer reports instance m-roster1 on its FIRST fetch.
  // The roster ALSO lists m-roster1 at a different url. The merge must
  // keep ONLY the configured row (the explicit entry wins), never add the
  // roster url as a second row for the same instance.
  const m = new MeshFederation(
    baseCfg(await mkTmp(), {
      mesh_peers: [{ url: PEER_URL, name: 'lab box' }],
      fleet_url: 'http://fleet-1:8789',
      peer_token: PEER,
    }),
    async (url) => (url === `${PEER_URL}/api/mesh` ? { ...snap(), instance_id: 'm-roster1', name: 'peer-one' } : snap()),
  );
  // First: establish the configured peer's observed identity.
  await m.refresh(T0);
  assert.equal(m.view(T0)[0]!.instance_id, 'm-roster1', 'precondition: the configured peer reports m-roster1');
  const rosterFetcher: RosterFetcher = async () =>
    rosterEnvelope([
      rosterRow({ instance_id: 'm-roster1', urls: ['http://roster-1:8787'] }),
      rosterRow({ instance_id: 'm-roster2', name: 'roster-two', urls: ['http://roster-2:8787'] }),
    ]);
  await m.pullRoster(rosterFetcher, T0);
  const urls = m.view(T0).map((v) => v.url).sort();
  // m-roster1's roster url is NOT added (the explicit entry wins);
  // m-roster2 (a NEW instance) IS added.
  assert.deepEqual(urls, [PEER_URL, 'http://roster-2:8787']);
  const kept = m.view(T0).find((v) => v.url === PEER_URL)!;
  assert.equal(kept.name, 'lab box', 'the configured name is untouched by the roster');
  // Idempotent: a second pull for the same row changes nothing.
  await m.pullRoster(rosterFetcher, T0 + ROSTER_PULL_MS);
  assert.deepEqual(m.view(T0 + ROSTER_PULL_MS).map((v) => v.url).sort(), [PEER_URL, 'http://roster-2:8787']);
});

test('roster: a malformed row is dropped, not trusted (the good rows survive)', async () => {
  // Hostile rows: no identity, no usable urls, non-string junk, oversized
  // strings, a non-array envelope member. Each is dropped; the one good
  // row lands.
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap());
  const rosterFetcher: RosterFetcher = async () =>
    rosterEnvelope([
      { name: 'no id', urls: ['http://no-id:8787'] },
      { instance_id: 'm-nourl', urls: [] },
      { instance_id: 'm-nonstr', urls: [7, null, 'self', 'ftp://nope'] },
      { instance_id: 'x'.repeat(5000), name: 'y'.repeat(5000), public_key: 'z'.repeat(5000), urls: ['http://big:8787'] },
      null,
      'junk',
      rosterRow({ instance_id: 'm-good', name: 'good', urls: ['http://good:8787', 'http://good:8787/'] }),
    ]);
  await m.pullRoster(rosterFetcher, T0);
  const urls = m.view(T0).map((v) => v.url);
  // Only the good row lands (the url deduped to one entry — the trailing
  // slash is normalized by the merge, same rule as the config path).
  assert.deepEqual(urls, ['http://good:8787'], 'the malformed rows are dropped, the good row is trusted only');
  const row = m.view(T0)[0]!;
  assert.equal(row.instance_id, 'm-good');
  assert.equal(row.name, 'good');
  // And the envelope-level malformations never crash the merge.
  assert.equal(sanitizeRoster(null).length, 0);
  assert.equal(sanitizeRoster({}).length, 0);
  assert.equal(sanitizeRoster({ instances: 'nope' }).length, 0);
  assert.equal(sanitizeRoster('nope').length, 0);
});

test('roster: the pull is throttled to one per PROPOSED interval', async () => {
  let rosterCalls = 0;
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap());
  const rosterFetcher: RosterFetcher = async () => {
    rosterCalls++;
    return rosterEnvelope([rosterRow()]);
  };
  // Due on the first tick (now >= 0). Not due again before the interval.
  await m.pullRoster(rosterFetcher, T0);
  assert.equal(rosterCalls, 1);
  await m.pullRoster(rosterFetcher, T0 + 1000);
  assert.equal(rosterCalls, 1, 'inside the PROPOSED interval: no second pull');
  await m.pullRoster(rosterFetcher, T0 + ROSTER_PULL_MS);
  assert.equal(rosterCalls, 2, 'the interval elapsed: the next pull happens');
});

test('roster: ROSTER_PULL_MS is the PROPOSED default (15 s, the poll tick)', () => {
  assert.equal(ROSTER_PULL_MS, 15_000);
});

// ---------------------------------------------------------------------------
<// Roster edge fill (#55 D4, the pairing ceremony — PROPOSED wire)
//
// The roster publishes each instance's directed edges as an ADD key; the
// local instance writes the LOCAL side's edge record (last-known-keys).
// The filler is a seam: these tests pass a recorder, the production
// writer (index.ts) wraps EdgeStore.upsert ADD-only.
// ---------------------------------------------------------------------------

/** A 59-char base64url stand-in for an ed25519 SPKI key (the real shape). */
const KEY_A = 'A'.repeat(59);
const KEY_B = 'B'.repeat(59);
const LOCAL = 'm-local1';

interface FillCall {
  localId: string;
  edge: RosterEdgeRow;
  peerKey: string;
  peerName: string | undefined;
  direction: 'controls_me' | 'i_control';
}

/** A roster envelope with a LOCAL row + peer rows carrying edges. */
function edgeEnvelope(): unknown {
  return {
    instances: [
      { instance_id: LOCAL, name: 'local', public_key: 'L'.repeat(59), urls: ['http://local:8787'], last_seen: T0, edges: [{ from: 'm-ctrl1', to: LOCAL }, { from: LOCAL, to: 'm-ctrl2' }] },
      { instance_id: 'm-ctrl1', name: 'controller-one', public_key: KEY_A, urls: ['http://ctrl-1:8787'], last_seen: T0, edges: [{ from: 'm-ctrl1', to: LOCAL }] },
      { instance_id: 'm-ctrl2', name: 'controller-two', public_key: KEY_B, urls: ['http://ctrl-2:8787'], last_seen: T0, edges: [{ from: LOCAL, to: 'm-ctrl2' }] },
    ],
  };
}

test('sanitizeRoster: the edges ADD key parses valid directed edges', () => {
  const rows = sanitizeRoster(edgeEnvelope());
  assert.equal(rows.length, 3, 'all three rows survive');
  const local = rows.find((r) => r.instance_id === LOCAL)!;
  assert.deepEqual(local.edges, [
    { from: 'm-ctrl1', to: LOCAL },
    { from: LOCAL, to: 'm-ctrl2' },
  ], 'both of the local row\'s edges, order kept');
  const ctrl1 = rows.find((r) => r.instance_id === 'm-ctrl1')!;
  assert.deepEqual(ctrl1.edges, [{ from: 'm-ctrl1', to: LOCAL }], 'the peer row carries its edge too');
});

test('sanitizeRoster: edges ABSENT on a pre-ceremony roster = no edges (byte-for-byte)', () => {
  const rows = sanitizeRoster({ instances: [{ instance_id: 'm-old', name: 'old', public_key: KEY_A, urls: ['http://old:8787'] }] });
  assert.equal(rows.length, 1, 'the row survives without the field');
  assert.deepEqual(rows[0]!.edges, [], 'absent = an empty edge list');
});

test('sanitizeRoster: malformed edges drop individually, never the row', () => {
  const rows = sanitizeRoster({
    instances: [
      {
        instance_id: LOCAL,
        name: 'local',
        public_key: 'L'.repeat(59),
        urls: ['http://local:8787'],
        edges: [
          { from: 'm-good', to: LOCAL }, // valid — survives
          { from: LOCAL, to: LOCAL }, // self-edge — dropped
          { to: LOCAL }, // missing from — dropped
          { from: 7, to: LOCAL }, // non-string from — dropped
          { from: 'x'.repeat(65), to: LOCAL }, // over-long end — dropped
          null,
          'junk',
          { from: 'm-good', to: LOCAL }, // duplicate — deduped
        ],
      },
    ],
  });
  assert.equal(rows.length, 1, 'the ROW survives (edges are not row facts)');
  assert.deepEqual(rows[0]!.edges, [{ from: 'm-good', to: LOCAL }], 'only the valid edge, deduped');
});

test('sanitizeRoster: the edge list is BOUNDED (untrusted input)', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ from: `m-a${i}`, to: LOCAL }));
  const rows = sanitizeRoster({ instances: [{ instance_id: LOCAL, name: 'l', public_key: 'L'.repeat(59), urls: ['http://local:8787'], edges: many }] });
  assert.equal(rows[0]!.edges.length, 64, 'capped at the row bound');
});

test('edge fill: a roster edge for the LOCAL instance writes the LOCAL side\'s record (last-known-keys)', async () => {
  const calls: FillCall[] = [];
  const filler: EdgeFiller = (localId, edge, peerKey, peerName, direction) => {
    calls.push({ localId, edge, peerKey, peerName, direction });
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => LOCAL,
    edgeFiller: filler,
  });
  await m.pullRoster(async () => edgeEnvelope(), T0);

  // Two edges involve the local instance: m-ctrl1 -> local (local is
  // controlled → controls_me) and local -> m-ctrl2 (local controls →
  // i_control). The peer's public key comes from the PEER'S OWN row.
  assert.equal(calls.length, 2, 'one fill per directed edge touching the local instance');
  const inbound = calls.find((c) => c.edge.from === 'm-ctrl1')!;
  assert.deepEqual(inbound, {
    localId: LOCAL,
    edge: { from: 'm-ctrl1', to: LOCAL },
    peerKey: KEY_A, // the m-ctrl1 row's key, never the local row's
    peerName: 'controller-one',
    direction: 'controls_me', // this peer controls me
  });
  const outbound = calls.find((c) => c.edge.to === 'm-ctrl2')!;
  assert.deepEqual(outbound, {
    localId: LOCAL,
    edge: { from: LOCAL, to: 'm-ctrl2' },
    peerKey: KEY_B,
    peerName: 'controller-two',
    direction: 'i_control', // I control this peer
  });
  // The edge fill does not disturb the PEER SET: the roster rows still
  // add their peers exactly as before (the fill is a side channel). The
  // local row's own url is merged like any roster row (slice-5 behavior:
  // the service lists this machine too; the merge never special-cases
  // the local id — a peer entry for oneself is harmless: it is pulled
  // with the peer_token and just shows the local snapshot).
  const urls = m.view(T0).map((v) => v.url).sort();
  assert.deepEqual(urls, ['http://ctrl-1:8787', 'http://ctrl-2:8787', 'http://local:8787'], 'the peer merge is byte-for-byte the slice-5 behavior');
});

test('edge fill: an edge the LOCAL instance does not touch writes nothing', async () => {
  const calls: FillCall[] = [];
  const filler: EdgeFiller = (localId, edge, peerKey, peerName, direction) => calls.push({ localId, edge, peerKey, peerName, direction });
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => 'm-unrelated',
    edgeFiller: filler,
  });
  await m.pullRoster(async () => edgeEnvelope(), T0);
  assert.equal(calls.length, 0, 'none of the edges involve m-unrelated');
});

test('edge fill: a peer with NO usable key writes nothing (fail-closed, never a crash)', async () => {
  const calls: FillCall[] = [];
  const filler: EdgeFiller = (localId, edge, peerKey, peerName, direction) => calls.push({ localId, edge, peerKey, peerName, direction });
  // The edge names m-ghost, which is NOT in the roster (no row, no key).
  // The local row ALSO names an edge to a peer whose row has an unusable
  // key (over 64 chars) — both must skip, never crash.
  const env = {
    instances: [
      { instance_id: LOCAL, name: 'local', public_key: 'L'.repeat(59), urls: ['http://local:8787'], edges: [{ from: 'm-ghost', to: LOCAL }, { from: LOCAL, to: 'm-bigkey' }] },
      { instance_id: 'm-bigkey', name: 'big', public_key: 'K'.repeat(65), urls: ['http://big:8787'], edges: [{ from: LOCAL, to: 'm-bigkey' }] },
    ],
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => LOCAL,
    edgeFiller: filler,
  });
  await m.pullRoster(async () => env, T0);
  assert.equal(calls.length, 0, 'no usable peer key = no record written (D8 fail-closed)');
});

test('edge fill: a SELF-edge on the roster writes nothing', async () => {
  const calls: FillCall[] = [];
  const filler: EdgeFiller = (localId, edge, peerKey, peerName, direction) => calls.push({ localId, edge, peerKey, peerName, direction });
  const env = {
    instances: [
      { instance_id: LOCAL, name: 'local', public_key: 'L'.repeat(59), urls: ['http://local:8787'], edges: [{ from: LOCAL, to: LOCAL }] },
    ],
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => LOCAL,
    edgeFiller: filler,
  });
  await m.pullRoster(async () => env, T0);
  assert.equal(calls.length, 0, 'a machine cannot pair to itself');
});

test('edge fill: re-pulling the SAME roster does not re-write the edge (no 15 s churn)', async () => {
  let calls = 0;
  const filler: EdgeFiller = () => {
    calls++;
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => LOCAL,
    edgeFiller: filler,
  });
  await m.pullRoster(async () => edgeEnvelope(), T0);
  assert.equal(calls, 2, 'the first pull writes both edges');
  await m.pullRoster(async () => edgeEnvelope(), T0 + ROSTER_PULL_MS);
  assert.equal(calls, 2, 'the re-pull is a no-op for known (peer, key) pairs');
});

test('edge fill: an UNWROUGHT roster (no filler) pulls byte-for-byte as before', async () => {
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap());
  await m.pullRoster(async () => edgeEnvelope(), T0);
  const urls = m.view(T0).map((v) => v.url).sort();
  // The roster lists the local instance too (slice-5 merge rule: every row
  // is a peer row; the merge never special-cases the local id).
  assert.deepEqual(urls, ['http://ctrl-1:8787', 'http://ctrl-2:8787', 'http://local:8787'], 'the merge is unchanged without the ceremony wiring');
});

test('edge fill: a THROWING filler never breaks the pull (the never-throw posture)', async () => {
  let calls = 0;
  const filler: EdgeFiller = () => {
    calls++;
    if (calls === 1) throw new Error('edges: malformed edge record');
  };
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => LOCAL,
    edgeFiller: filler,
  });
  // Must resolve (not reject): a writer failure is a no-op for the edge.
  await m.pullRoster(async () => edgeEnvelope(), T0);
  assert.equal(calls, 2, 'both edges were attempted');
  const urls = m.view(T0).map((v) => v.url).sort();
  assert.deepEqual(urls, ['http://ctrl-1:8787', 'http://ctrl-2:8787', 'http://local:8787'], 'the peer merge survived the writer failure');
});

test('edge fill: an EMPTY local instance id disables the fill (no crash)', async () => {
  const calls: FillCall[] = [];
  const filler: EdgeFiller = (localId, edge, peerKey, peerName, direction) => calls.push({ localId, edge, peerKey, peerName, direction });
  const m = new MeshFederation(baseCfg(await mkTmp(), { fleet_url: 'http://fleet-1:8789' }), async () => snap(), {
    localInstanceId: () => '', // a not-yet-minted identity must not fill
    edgeFiller: filler,
  });
  await m.pullRoster(async () => edgeEnvelope(), T0);
  assert.equal(calls.length, 0, 'no local id = no fill');

// Fleet enrollment + signed roster pull (#55 D2 + D3, slice 7)
//
// The seam is closed: `buildRosterFetcher` returns the SIGNED fetcher when
// fleet_url + fleet_instance_id + fleet_enrollment_token are all present
// (enroll once → persisted credential in fleet_enrollment.json → a signed
// nonce per pull); any one absent = the pull is a no-op, byte-for-byte,
// exactly pre-slice-5 (the Service-down rule). The stub below is a REAL
// node:http server implementing the slice-3 wire contract with real
// ed25519 verification — a second real HTTP peer, not a mock.
// ---------------------------------------------------------------------------

const STUB_PEER_URL = 'http://stub-peer:8787';

class StubFleet {
  private server: Server | null = null;
  base = '';
  instances = new Map<
    string,
    { instance_id: string; name: string; public_key: string; credential: string; urls: string[]; presence: string | null; last_seen: number | null }
  >();
  private tokens = new Map<string, { used: boolean }>();
  private noncesSeen = new Set<string>();
  enrollCount = 0;
  heartbeatCount = 0;
  rosterPulls: { instance_id: string }[] = [];

  mintToken(): string {
    const t = `flt_${randomBytes(12).toString('base64url')}`;
    this.tokens.set(t, { used: false });
    return t;
  }
  tokenUsed(t: string): boolean {
    return this.tokens.get(t)?.used === true;
  }
  /** Simulate a fleet re-deploy: the instance store is wiped (a stored credential goes stale). */
  resetInstances(): void {
    this.instances.clear();
  }
  /** Seed a pre-enrolled peer (the roster's other machines). */
  seed(name: string, urls: string[]): void {
    const { publicKey } = generateKeyPairSync('ed25519');
    const id = `m-stub${randomBytes(8).toString('hex')}`;
    this.instances.set(id, {
      instance_id: id,
      name,
      public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      credential: `cred-${randomBytes(8).toString('hex')}`,
      urls,
      presence: 'online',
      last_seen: T0,
    });
  }

  async start(): Promise<string> {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://stub');
      const send = (code: number, body: Record<string, unknown>) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const readAll = async (): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
      };
      try {
        if (u.pathname === '/token' && req.method === 'POST') {
          return send(200, { token: this.mintToken() });
        }
        if (u.pathname === '/enroll' && req.method === 'POST') {
          const raw = JSON.parse((await readAll()).toString('utf-8') || '{}') as Record<string, unknown>;
          const token = typeof raw.token === 'string' ? raw.token : '';
          const pk = typeof raw.public_key === 'string' ? raw.public_key : '';
          const name = typeof raw.name === 'string' ? raw.name.trim() : '';
          const t = this.tokens.get(token);
          if (!t || t.used) return send(401, { error: t?.used ? 'token_used' : 'invalid_token' });
          if (name === '' || name.length > 64) return send(400, { error: 'invalid_name' });
          let validKey = false;
          try {
            validKey = createPublicKey({ key: Buffer.from(pk, 'base64url'), type: 'spki', format: 'der' }).asymmetricKeyType === 'ed25519';
          } catch {
            validKey = false;
          }
          if (!validKey) return send(400, { error: 'invalid_public_key' });
          t.used = true;
          this.enrollCount++;
          const instance_id = `m-${randomBytes(8).toString('hex')}`;
          const credential = randomBytes(32).toString('base64url');
          this.instances.set(instance_id, { instance_id, name, public_key: pk, credential, urls: [], presence: null, last_seen: null });
          return send(200, { instance_id, credential, nonce: randomBytes(16).toString('base64url') });
        }
        // Signed-nonce auth — the same named denials as the real service.
        let instance_id = '';
        let nonce = '';
        let signature = '';
        let body: Record<string, unknown> = {};
        if (req.method === 'GET') {
          instance_id = u.searchParams.get('instance_id') ?? '';
          nonce = u.searchParams.get('nonce') ?? '';
          signature = u.searchParams.get('signature') ?? '';
        } else {
          const raw = (await readAll()).toString('utf-8');
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            body = {};
          }
          instance_id = typeof body.instance_id === 'string' ? body.instance_id : '';
          nonce = typeof body.nonce === 'string' ? body.nonce : '';
          signature = typeof body.signature === 'string' ? body.signature : '';
        }
        if (!instance_id || !nonce || !signature) return send(401, { error: 'missing_auth' });
        const inst = this.instances.get(instance_id);
        if (!inst) return send(401, { error: 'unknown_instance' });
        let valid = false;
        try {
          const pub = createPublicKey({ key: Buffer.from(inst.public_key, 'base64url'), type: 'spki', format: 'der' });
          valid = verify(null, new TextEncoder().encode(nonce), pub, Buffer.from(signature, 'base64url'));
        } catch {
          valid = false;
        }
        if (!valid) return send(401, { error: 'bad_signature' });
        const key = `${instance_id}\u0000${nonce}`;
        if (this.noncesSeen.has(key)) return send(401, { error: 'nonce_replayed' });
        this.noncesSeen.add(key);
        if (u.pathname === '/roster' && req.method === 'GET') {
          this.rosterPulls.push({ instance_id });
          return send(200, {
            instances: [...this.instances.values()].map((i) => ({
              instance_id: i.instance_id,
              name: i.name,
              public_key: i.public_key,
              urls: i.urls,
              last_seen: i.last_seen,
            })),
          });
        }
        if (u.pathname === '/heartbeat' && req.method === 'POST') {
          this.heartbeatCount++;
          const urls = Array.isArray(body.urls) ? (body.urls.filter((x): x is string => typeof x === 'string') as string[]) : null;
          if (urls) inst.urls = urls.slice(0, 16);
          const presence = typeof body.presence === 'string' ? body.presence : null;
          if (presence) inst.presence = presence;
          inst.last_seen = Date.now();
          return send(200, { ok: true });
        }
        return send(404, { error: 'not_found' });
      } catch (err) {
        return send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const a = server.address() as AddressInfo;
        this.base = `http://127.0.0.1:${a.port}`;
        resolve();
      });
    });
    return this.base;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.server;
      if (!s) return resolve();
      s.closeAllConnections?.();
      s.close((e) => (e ? reject(e) : resolve()));
    });
  }
}

test('slice 7: no fleet_url = the signed pull is inert (no pull, no enroll, peer set byte-for-byte)', async () => {
  const dir = await mkTmp();
  const identity = Identity.mint(); // in-memory only — no file side-effects
  const cfg = baseCfg(dir, { mesh_peers: [{ url: PEER_URL, name: 'lab box' }] });
  assert.equal(cfg.fleet_url, undefined, 'precondition: no fleet_url');
  const fetcher = buildRosterFetcher(cfg, identity);
  const mesh = new MeshFederation(cfg, async () => snap());
  await mesh.pullRoster(fetcher, T0);
  await mesh.pullRoster(fetcher, T0 + 2 * ROSTER_PULL_MS);
  assert.deepEqual(mesh.view(T0).map((v) => v.url), [PEER_URL], 'the static peer set stands, byte-for-byte');
  assert.ok(!existsSync(enrollmentFileOf(cfg.state_file)), 'no fleet_enrollment.json — no enroll was attempted');
});

test('slice 7: fleet_url but no instance identity = no pull, no crash, byte-for-byte', async () => {
  const dir = await mkTmp();
  const identity = Identity.mint();
  // fleet_url present, identity + token absent (the owner has not
  // provisioned the fleet — the common pre-provisioning state).
  const cfg = baseCfg(dir, { mesh_peers: [{ url: PEER_URL, name: 'lab box' }], fleet_url: 'http://fleet.example:8789' });
  const fetcher = buildRosterFetcher(cfg, identity);
  const mesh = new MeshFederation(cfg, async () => snap());
  // The fetcher rejects (not enrolled) — pullRoster swallows it exactly
  // like a service-down failure: a no-op, never a crash.
  await mesh.pullRoster(fetcher, T0);
  assert.deepEqual(mesh.view(T0).map((v) => v.url), [PEER_URL], 'the static peer set stands');
  assert.ok(!existsSync(enrollmentFileOf(cfg.state_file)), 'no credential file was written');
  // The read plane still works after the swallowed failure.
  await mesh.refresh(T0);
  assert.equal(mesh.view(T0)[0]!.online, true, 'no crash — the mesh read plane is untouched');
  // Variant: identity declared but the token absent is also inert.
  const cfg2 = baseCfg(dir, { mesh_peers: [{ url: PEER_URL }], fleet_url: 'http://fleet.example:8789', fleet_instance_id: 'declared-seam' });
  const mesh2 = new MeshFederation(cfg2, async () => snap());
  await mesh2.pullRoster(buildRosterFetcher(cfg2, identity), T0);
  assert.deepEqual(mesh2.view(T0).map((v) => v.url), [PEER_URL], 'the identity-only variant is a no-op too');
  assert.ok(!existsSync(enrollmentFileOf(cfg2.state_file)), 'still no credential file');
});

test('slice 7: a signed client against a stub fleet service enrolls + pulls rows (real HTTP, real crypto)', async () => {
  const stub = new StubFleet();
  const base = await stub.start();
  stub.seed('stub-peer', [STUB_PEER_URL]); // a pre-enrolled peer the roster lists
  const dir = await mkTmp();
  const identity = Identity.loadOrCreate(join(dir, 'state.json'));
  const token = stub.mintToken();
  const cfg = baseCfg(dir, {
    mesh_peers: [{ url: PEER_URL, name: 'lab box' }],
    fleet_url: base,
    fleet_instance_id: 'declared-seam',
    fleet_enrollment_token: token,
    mesh_name: 'home-arbiter',
  });
  const fetcher = buildRosterFetcher(cfg, identity);
  const mesh = new MeshFederation(cfg, async () => snap());
  await mesh.pullRoster(fetcher, T0);

  // Enroll: exactly once, with the token + the arbiter's ed25519 public key.
  assert.equal(stub.enrollCount, 1, 'one enroll (the token is single-use)');
  assert.equal(stub.tokenUsed(token), true, 'the token was consumed');
  const arb = [...stub.instances.values()].find((i) => i.public_key === identity.publicKeyB64url);
  assert.ok(arb, 'the arbiter enrolled with its #55 D1 public key');
  assert.equal(arb.name, 'home-arbiter', 'the enrollment name is the mesh display name');
  assert.match(arb.instance_id as string, /^m-[0-9a-f]{16}$/, 'the fleet issued an instance id');
  // The credential persisted to the sibling file (the #39 D2 posture).
  const file = enrollmentFileOf(cfg.state_file);
  assert.ok(existsSync(file), 'fleet_enrollment.json was persisted');
  assert.equal(enrollmentFileMode(file), 0o600, 'owner-only (0600)');
  const rec = loadEnrollment(file);
  assert.equal(rec?.instance_id, arb.instance_id, 'the persisted id matches the service');
  assert.equal(rec?.credential, arb.credential, 'the persisted credential matches the service');
  // The signed roster pull returned rows and the seeded row merged in (ADD-only).
  assert.equal(stub.rosterPulls.length, 1, 'one signed roster pull');
  assert.equal(stub.rosterPulls[0]!.instance_id, arb.instance_id, 'the pull authenticated as the enrolled instance');
  const seed = [...stub.instances.values()].find((i) => i.name === 'stub-peer')!;
  const urls = mesh.view(T0).map((v) => v.url).sort();
  assert.deepEqual(urls, [PEER_URL, STUB_PEER_URL], 'the roster row merged as a peer');
  const row = mesh.view(T0).find((v) => v.url === STUB_PEER_URL)!;
  assert.equal(row.instance_id, seed.instance_id, 'the roster identity rides the row');
  // Throttled tick: no re-enroll, no extra pull (the persisted credential
  // is reused; the interval gate stands).
  await mesh.pullRoster(fetcher, T0 + 1000);
  assert.equal(stub.enrollCount, 1, 'no re-enroll inside the interval');
  assert.equal(stub.rosterPulls.length, 1, 'no second pull inside the interval');
  // Past the interval: re-pulls, still signed, still accepted; the peer
  // set is stable (ADD-only, no churn).
  await mesh.pullRoster(fetcher, T0 + ROSTER_PULL_MS);
  assert.equal(stub.rosterPulls.length, 2, 'the interval elapsed: the signed pull happens again');
  assert.deepEqual(mesh.view(T0 + ROSTER_PULL_MS).map((v) => v.url).sort(), [PEER_URL, STUB_PEER_URL]);
  await stub.close();
});

test('slice 7: a stale credential re-enrolls (D2 recovery: fleet reset → wiped file + fresh token)', async () => {
  const stub = new StubFleet();
  const base = await stub.start();
  const dir = await mkTmp();
  const identity = Identity.loadOrCreate(join(dir, 'state.json'));
  // First enrollment — a live credential.
  const token1 = stub.mintToken();
  const file = enrollmentFileOf(join(dir, 'state.json'));
  const c1 = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: token1, name: 'urza' }, identity);
  const enr1 = await c1.ensureEnrolled();
  assert.equal(enr1.ok, true, 'the first enrollment succeeds');
  assert.ok(existsSync(file), 'the credential is persisted');
  // The fleet re-deploys (instance store wiped): the stored credential is
  // STALE — the service knows no such instance. The pull is fail-quiet.
  stub.resetInstances();
  assert.equal(await c1.signedRoster(), null, 'a stale credential is a 401 → no-op (no crash)');
  // D2 recovery (wiped machine): the credential file goes, the operator
  // issues a fresh token. The client re-enrolls with the SAME identity
  // (the ed25519 keypair is unchanged — it is the machine's truth).
  rmSync(file, { force: true });
  const token2 = stub.mintToken();
  const c2 = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: token2, name: 'urza' }, identity);
  assert.equal(c2.enrolled, false, 'the wiped file means the client is unenrolled');
  const enr2 = await c2.ensureEnrolled();
  assert.equal(enr2.ok, true, 'the fresh token re-enrolls');
  assert.match(enr2.instance_id as string, /^m-[0-9a-f]{16}$/, 'the fleet re-issues an id');
  assert.notEqual(enr2.credential, enr1.credential, 'a new credential (the old one is invalid)');
  const rec2 = loadEnrollment(file);
  assert.equal(rec2?.instance_id, enr2.instance_id, 'the re-enrolled credential is persisted');
  assert.equal(rec2?.credential, enr2.credential);
  // And the re-enrolled identity can pull the roster again.
  const rows = (await c2.signedRoster()) as { instances: { instance_id: string }[] };
  assert.ok(rows.instances.some((i) => i.instance_id === enr2.instance_id), 'the re-enrolled instance is in the roster');
  await stub.close();
>
});

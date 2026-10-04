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
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import {
  MeshFederation,
  PEER_STALE_MS,
  buildMeshSnapshot,
  sanitizeSnapshot,
  mintInstanceId,
  type MeshFetcher,
  type MeshSnapshot,
} from '../src/mesh.js';
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

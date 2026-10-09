/**
 * metrics-remote.test.ts — cross-mesh telemetry, the read-time peer
 * metrics pull (#79, decision: docs/architecture/mesh-telemetry.md).
 *
 * Two real Fastify apps (the slice-1 harness, app.inject — no network):
 * a PEER (its own metrics store, serve side) and a PULLER (the
 * dashboard's arbiter, an injected remote-metrics fetcher that rides
 * inject against the peer's real routes).
 *
 * Covers:
 *  - the D4 auth matrix: SERVE side (no `peer` param) = fleet peer_token
 *    ONLY — anonymous 401, wrong token 401, a LOCAL ADMIN token 401 (the
 *    one route where admin does NOT work); PULL side (`peer=` param) =
 *    local admin ONLY — peer_token 401, anonymous 401.
 *  - the local route's param contract mirrored: bad series/bucket 400,
 *    from>to 400, the 2,000-point OLDEST-trim cap + `truncated`.
 *  - the D3 cache: hit inside the TTL answers `stale: true` with the
 *    ORIGINAL pulled_at; `mesh_metrics_cache_s: 0` pulls live; a failed
 *    fetch DROPS the cache line (the next good fetch is fresh, not stale).
 *  - untrusted input: a malformed envelope is a 502 render gap; garbage
 *    points are dropped individually (off-kind, no finite ts).
 *  - the ephemeral guarantee: a remote pull leaves NOTHING in state.json
 *    and NO metrics-*.jsonl files in the puller's directory.
 *  - the PeerView ADD key `metrics_cache` (absent until the first pull).
 *  - local `/api/metrics` + `/api/mesh` stay untouched: the local route
 *    still answers anonymous 200 and 401s the peer_token; the snapshot
 *    keeps its coarse shape byte-for-byte.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { MeshFederation, sanitizeRemoteMetrics, type RemoteMetricsFetcher } from '../src/mesh.js';
import { MetricsStore } from '../src/metrics.js';
import type { ServerConfig } from '../src/types.js';

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
    projects: [],
    state_file: join(dir, 'state.json'),
    ...over,
  };
}

function mkArbiter(cfg: ServerConfig): Arbiter {
  const store = new StateStore(cfg.state_file);
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  return new Arbiter(store, cfg, det);
}

let tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'idlefill-metrics-remote-'));
  tmpDirs.push(d);
  return d;
}

function bearer(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` };
}

let peerDir: string;
let pullerDir: string;
let peer: FastifyInstance;
let peerMetrics: MetricsStore;
let peerInstanceId: string;

/** The puller's inject-transport: a REAL fetch over inject, mutable per test. */
let fetchMode: 'good' | 'down' | 'garbage-envelope' | 'garbage-points' = 'good';

function peerInjectFetcher(url: string, token: string): Promise<unknown> {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  return (async () => {
    if (fetchMode === 'down') throw new Error('fetch: ECONNREFUSED');
    const res = await peer.inject({ method: 'GET', url: path, headers: bearer(token) });
    if (res.statusCode >= 400) throw new Error(`fetch HTTP ${res.statusCode}`);
    if (fetchMode === 'garbage-envelope') return { series: 'not-an-array' };
    if (fetchMode === 'garbage-points') {
      return {
        series: [
          { key: 'srv-a', points: [{ ts: 'not-a-number' }, { ts: Date.now(), kind: 'engine' }, { ts: Date.now(), kind: 'lease' }] },
        ],
        truncated: false,
      };
    }
    return res.json();
  })();
}

function mkPuller(over: Partial<ServerConfig> = {}): { app: FastifyInstance; mesh: MeshFederation } {
  const dir = mkTmp();
  const cfg = baseCfg(dir, {
    mesh_peers: [{ url: 'http://peer.test', name: 'peer-box' }],
    ...over,
  });
  const snapFetcher = async (url: string, token: string) => peerInjectFetcher(url, token);
  const remoteFetcher: RemoteMetricsFetcher = async (url, token) => peerInjectFetcher(url, token);
  const mesh = new MeshFederation(cfg, snapFetcher, { remoteMetricsFetcher: remoteFetcher });
  const app = buildApi({ arbiter: mkArbiter(cfg), cfg, publicDir: join(import.meta.dirname, '..', 'public'), mesh });
  return { app, mesh };
}

before(async () => {
  peerDir = mkTmp();
  pullerDir = mkTmp();
  void pullerDir;
  peerMetrics = new MetricsStore({ stateFile: join(peerDir, 'state.json'), rawWindowHours: 48, retentionDays: 400, log: () => {} });
  const peerCfg = baseCfg(peerDir, { mesh_name: 'peer-box' });
  peer = buildApi({ arbiter: mkArbiter(peerCfg), cfg: peerCfg, publicDir: join(peerDir, 'public'), metrics: peerMetrics });
  const res = await peer.inject({ method: 'GET', url: '/api/mesh', headers: bearer(PEER) });
  assert.equal(res.statusCode, 200);
  peerInstanceId = (res.json() as { instance_id: string }).instance_id;
});

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function engineLine(ts: number): Record<string, unknown> {
  return {
    ts,
    kind: 'engine',
    server_id: 'srv-a',
    idle: true,
    idle_for_s: 42,
    degraded: false,
    req_delta: 1,
    feed_last_id: ts,
    grants: 0,
    denials: {},
    active_leases: 0,
    active_sessions: 0,
  };
}

// ---------------------------------------------------------------------------
// D4 auth matrix — SERVE side (no `peer` param): the peer_token plane only.
// ---------------------------------------------------------------------------

test('serve side: the fleet peer_token unlocks it and carries the peer ADD key', async () => {
  const res = await peer.inject({ method: 'GET', url: '/api/metrics/remote?series=engine', headers: bearer(PEER) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { series: unknown[]; truncated: boolean; peer: string };
  assert.ok(Array.isArray(body.series));
  assert.equal(body.truncated, false);
  assert.equal(body.peer, peerInstanceId);
});

test('serve side: anonymous 401, wrong token 401, LOCAL ADMIN 401', async () => {
  for (const headers of [{}, bearer('wrong-token'), bearer(ADMIN)]) {
    const res = await peer.inject({ method: 'GET', url: '/api/metrics/remote?series=engine', headers });
    assert.equal(res.statusCode, 401);
  }
});

test('serve side: the local route param contract mirrored (400s)', async () => {
  const cases = [
    '/api/metrics/remote?series=bogus',
    '/api/metrics/remote', // series required
    '/api/metrics/remote?series=engine&bucket=bogus',
    '/api/metrics/remote?series=engine&from=5&to=4',
    '/api/metrics/remote?series=engine&from=abc',
  ];
  for (const url of cases) {
    const res = await peer.inject({ method: 'GET', url, headers: bearer(PEER) });
    assert.equal(res.statusCode, 400, url);
  }
});

test('serve side: the 2,000-point cap trims the OLDEST and sets truncated', async () => {
  const now = Date.now();
  for (let i = 0; i < 2001; i++) peerMetrics.appendEngineSample(engineLine(now - 3_600_000 + i * 100) as never);
  const res = await peer.inject({
    method: 'GET',
    url: `/api/metrics/remote?series=engine&bucket=raw&from=${now - 3_600_000 - 1000}&to=${now}`,
    headers: bearer(PEER),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { series: { key: string; points: { ts: number }[] }[]; truncated: boolean };
  assert.equal(body.truncated, true);
  const pts = body.series.find((s) => s.key === 'srv-a')!.points;
  assert.equal(pts.length, 2000);
  assert.ok(pts[0]!.ts > now - 3_600_000); // the oldest 1 was trimmed
});

// ---------------------------------------------------------------------------
// D4 auth matrix — PULL side (`peer=` param): the admin plane only.
// ---------------------------------------------------------------------------

test('pull side: peer_token 401, anonymous 401 (the pairing lives at the route)', async () => {
  const { app } = mkPuller();
  for (const headers of [{}, bearer(PEER)]) {
    const res = await app.inject({ method: 'GET', url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine`, headers });
    assert.equal(res.statusCode, 401);
  }
});

test('pull side: unknown peer instance_id is a named 404', async () => {
  const { app } = mkPuller();
  const res = await app.inject({ method: 'GET', url: '/api/metrics/remote?peer=m-nope&series=engine', headers: bearer(ADMIN) });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: string }).error, 'unknown peer instance_id');
});

test('pull happy path: the peer lines ride labeled with the ADD keys', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now()); // fills instance_id from the peer's coarse snapshot
  const now = Date.now();
  const res = await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 4_000_000}&to=${now}`,
    headers: bearer(ADMIN),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    series: { key: string; points: Record<string, unknown>[] }[];
    truncated: boolean;
    peer: string;
    pulled_at: number;
    stale: boolean;
  };
  assert.equal(body.peer, peerInstanceId);
  assert.equal(body.stale, false);
  assert.ok(Number.isFinite(body.pulled_at));
  const pts = body.series.find((s) => s.key === 'srv-a')?.points ?? [];
  assert.ok(pts.length > 0);
  assert.equal(pts[0]!.kind, 'engine');
});

test('D3 cache: a hit inside the TTL answers stale:true with the ORIGINAL pulled_at', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now());
  const now = Date.now();
  const url = `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 4_000_000}&to=${now}`;
  const a = await app.inject({ method: 'GET', url, headers: bearer(ADMIN) });
  const b = await app.inject({ method: 'GET', url, headers: bearer(ADMIN) });
  const ba = a.json() as { pulled_at: number; stale: boolean };
  const bb = b.json() as { pulled_at: number; stale: boolean };
  assert.equal(ba.stale, false);
  assert.equal(bb.stale, true);
  assert.equal(bb.pulled_at, ba.pulled_at); // the ORIGINAL fetch clock, not the cache-hit clock
});

test('D3 cache: mesh_metrics_cache_s=0 pulls live every time (never stale)', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller({ mesh_metrics_cache_s: 0 });
  await mesh.refresh(Date.now());
  const now = Date.now();
  const url = `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 4_000_000}&to=${now}`;
  const a = await app.inject({ method: 'GET', url, headers: bearer(ADMIN) });
  const b = await app.inject({ method: 'GET', url, headers: bearer(ADMIN) });
  assert.equal((b.json() as { stale: boolean }).stale, false);
  assert.ok((b.json() as { pulled_at: number }).pulled_at >= (a.json() as { pulled_at: number }).pulled_at);
});

test('D3 failure: a failed fetch 502s and drops the cache line (federation level, later pulls fresh)', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now());
  const now = Date.now();
  fetchMode = 'down';
  const bad = await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 500_000}&to=${now - 400_000}`,
    headers: bearer(ADMIN),
  });
  assert.equal(bad.statusCode, 502);
  assert.equal((bad.json() as { error: string }).error, 'peer metrics fetch failed');
  fetchMode = 'good';

  // The drop rule (grill report, "Failure mode"): a failed fetch drops the
  // line. Prove it with a controlled clock: a fresh line, then a failure
  // PAST the TTL — the line must be gone (the view stops counting it), and
  // the next good fetch is fresh, never a stale ghost of the dead peer.
  const t0 = now;
  await mesh.pullMetrics(peerInstanceId, { series: 'engine', from: t0 - 600_000, to: t0, bucket: 'raw' }, t0);
  assert.equal(mesh.view(t0)[0]!.metrics_cache?.entries, 1);
  fetchMode = 'down';
  const t1 = t0 + 120_000; // past the 60 s TTL: the fetch runs and fails
  await assert.rejects(() => mesh.pullMetrics(peerInstanceId, { series: 'engine', from: t0 - 600_000, to: t0, bucket: 'raw' }, t1));
  assert.equal(mesh.view(t1)[0]!.metrics_cache, undefined); // line DROPPED, nothing lingers
  fetchMode = 'good';
  const pulled = await mesh.pullMetrics(peerInstanceId, { series: 'engine', from: t0 - 600_000, to: t0, bucket: 'raw' }, t1);
  assert.equal(pulled.stale, false);
});

test('untrusted input: a malformed envelope is a 502 render gap, not a crash or a poison', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now());
  fetchMode = 'garbage-envelope';
  const now = Date.now();
  const res = await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 600_000}&to=${now}`,
    headers: bearer(ADMIN),
  });
  assert.equal(res.statusCode, 502);
});

test('untrusted input: garbage POINTS drop individually (off-kind, no finite ts)', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now());
  fetchMode = 'garbage-points';
  const now = Date.now();
  const res = await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 600_000}&to=${now}`,
    headers: bearer(ADMIN),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { series: { points: Record<string, unknown>[] }[] };
  assert.equal(body.series.length, 1);
  assert.equal(body.series[0]!.points.length, 1); // the ts-string and off-kind lines were dropped
  assert.equal(body.series[0]!.points[0]!.kind, 'engine');
  fetchMode = 'good';
});

test('sanitizeRemoteMetrics: key caps, dupes dropped, absurd strings dropped', () => {
  const big = 'x'.repeat(600);
  const out = sanitizeRemoteMetrics(
    {
      series: [
        { key: 'k1', points: [{ ts: 1, kind: 'engine_hour', model_loaded: big }] },
        { key: 'k1', points: [{ ts: 2, kind: 'engine_hour' }] }, // dupe
        { key: 'k2', points: [{ ts: 3, kind: 'engine_hour' }] },
      ],
      truncated: true,
    },
    { series: 'engine', bucket: 'hour' },
  );
  assert.ok(out);
  assert.equal(out.truncated, true);
  assert.equal(out.series.length, 2); // dupe dropped
  assert.equal(out.series[0]!.points.length, 0); // the absurd-string point dropped
  assert.equal(out.series[1]!.points.length, 1);
});

// ---------------------------------------------------------------------------
// The ephemeral guarantee (D3): remote lines never persist anywhere.
// ---------------------------------------------------------------------------

test('ephemeral: a pull leaves nothing in state.json and no metrics files on the PULLER', async () => {
  fetchMode = 'good';
  const dir = mkTmp();
  const cfg = baseCfg(dir, { mesh_peers: [{ url: 'http://peer.test' }] });
  const mesh = new MeshFederation(cfg, async (u, t) => peerInjectFetcher(u, t), {
    remoteMetricsFetcher: async (u, t) => peerInjectFetcher(u, t),
  });
  const app = buildApi({ arbiter: mkArbiter(cfg), cfg, publicDir: join(peerDir, 'public'), mesh });
  await mesh.refresh(Date.now());
  const now = Date.now();
  const res = await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 600_000}&to=${now}`,
    headers: bearer(ADMIN),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(readdirSync(dir).every((n) => !n.startsWith('metrics-'))); // no store files appeared
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) as Record<string, unknown>;
  assert.ok(!JSON.stringify(state).includes('srv-a')); // no remote line inside state.json
  assert.ok(!('metrics_cache' in state));
});

// ---------------------------------------------------------------------------
// The PeerView ADD key (wire key #2): absent until the first pull, counts only.
// ---------------------------------------------------------------------------

test('PeerView: metrics_cache absent until the first pull, then counts entries', async () => {
  fetchMode = 'good';
  const { app, mesh } = mkPuller();
  await mesh.refresh(Date.now());
  const before = await app.inject({ method: 'GET', url: '/api/state' });
  const peersBefore = (before.json() as { mesh: { peers: Record<string, unknown>[] } }).mesh.peers;
  assert.equal(peersBefore.length, 1);
  assert.ok(!('metrics_cache' in peersBefore[0]!));
  const now = Date.now();
  await app.inject({
    method: 'GET',
    url: `/api/metrics/remote?peer=${peerInstanceId}&series=engine&bucket=raw&from=${now - 600_000}&to=${now}`,
    headers: bearer(ADMIN),
  });
  const after = await app.inject({ method: 'GET', url: '/api/state' });
  const peersAfter = (after.json() as { mesh: { peers: { metrics_cache?: { entries: number; last_pulled_at: number } }[] } }).mesh.peers;
  assert.equal(peersAfter[0]!.metrics_cache?.entries, 1);
  assert.ok(Number.isFinite(peersAfter[0]!.metrics_cache?.last_pulled_at));
});

// ---------------------------------------------------------------------------
// The fences: local routes byte-for-byte untouched.
// ---------------------------------------------------------------------------

test('fences: local /api/metrics keeps anonymous read + peer_token 401; /api/mesh keeps the coarse shape', async () => {
  const anon = await peer.inject({ method: 'GET', url: '/api/metrics?series=engine&bucket=raw' });
  assert.equal(anon.statusCode, 200);
  const withPeer = await peer.inject({ method: 'GET', url: '/api/metrics?series=engine', headers: bearer(PEER) });
  assert.equal(withPeer.statusCode, 401);
  const snap = await peer.inject({ method: 'GET', url: '/api/mesh', headers: bearer(PEER) });
  const s = snap.json() as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(s).sort(),
    ['active_leases', 'fleet_id', 'instance_id', 'name', 'public_key', 'queue_depth', 'servers', 'sessions', 'ts'].sort(),
  );
});

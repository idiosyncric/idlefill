/**
 * metrics.test.ts — the metrics retention store (#51).
 *
 * Covers (issue #57 acceptance):
 *   - append + range read (raw + hour, key filter, sorted)
 *   - rollup idempotence: the reader keeps the LAST line per (hour, key),
 *     so a re-run rollup never needs a rewrite
 *   - corrupt-line skip (one lost sample, file stays)
 *   - whole-file rotation past the raw window / retention horizon
 *   - GET /api/metrics param validation (400 + error string), the
 *     2,000-point cap with oldest trimmed + truncated: true
 *   - the auth matrix: anonymous 200, wrong token 401, peer_token 401 on
 *     this route (it stays scoped to /api/mesh), admin token 200
 *   - a backwards feed id reads as an unknown delta, never a negative count
 *
 * Hermetic: tmp dirs + a real Fastify app on an ephemeral loopback port.
 * No network.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi } from '../src/api.js';
import { Arbiter, WATCHED_SERVER_ID } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import {
  FeedDeltaTracker,
  MetricsStore,
  DAY_MS,
  HOUR_MS,
  metricsUtcDay,
  type EngineSampleLine,
} from '../src/metrics.js';
import type { ServerConfig } from '../src/types.js';

const ADMIN = 'admin-token-1';
const PEER = 'fleet-peer-token';

function mkStore(over: { rawWindowHours?: number; retentionDays?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-metrics-'));
  const store = new MetricsStore({
    stateFile: join(dir, 'state.json'),
    rawWindowHours: over.rawWindowHours ?? 48,
    retentionDays: over.retentionDays ?? 400,
    log: () => {},
  });
  return { dir, store };
}

function mkEngine(ts: number, over: Partial<EngineSampleLine> = {}): EngineSampleLine {
  return {
    ts,
    kind: 'engine',
    server_id: WATCHED_SERVER_ID,
    idle: true,
    idle_for_s: 412,
    degraded: false,
    req_delta: 3,
    feed_last_id: 1042,
    grants: 1,
    denials: { not_idle: 4, busy: 0 },
    active_leases: 1,
    active_sessions: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Append + range read

test('append + range read: raw lines come back sorted, key filter works, missing file is empty', () => {
  const { dir, store } = mkStore();
  try {
    const t = Date.now();
    store.appendEngineSample(mkEngine(t + 2000, { req_delta: 2 }));
    store.appendEngineSample(mkEngine(t + 1000, { req_delta: 1 }));
    store.appendEngineSample(mkEngine(t + 3000, { server_id: 'srv-other' }));

    // The family lives next to state.json, named metrics-raw-YYYY-MM-DD.jsonl.
    const rawFile = join(dir, `metrics-raw-${metricsUtcDay(t)}.jsonl`);
    assert.ok(existsSync(rawFile), 'raw file next to state.json');
    assert.equal(readFileSync(rawFile, 'utf-8').trim().split('\n').length, 3);

    const all = store.readRange({ series: 'engine', from: t - 1000, to: t + 5000, bucket: 'raw' });
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((l) => l.ts), [t + 1000, t + 2000, t + 3000], 'sorted by ts');

    const one = store.readRange({ series: 'engine', key: WATCHED_SERVER_ID, from: t - 1000, to: t + 5000, bucket: 'raw' });
    assert.equal(one.length, 2);
    assert.ok(one.every((l) => l.kind === 'engine' && l.server_id === WATCHED_SERVER_ID));

    // A missing file (a day with no data) is an empty series, not an error.
    const empty = store.readRange({ series: 'lease', from: t - DAY_MS, to: t, bucket: 'raw' });
    assert.deepEqual(empty, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rollup idempotence (last line per hour+key wins)

test('rollup reads raw files; a re-run appends again and the reader keeps the LAST line per (hour, key)', () => {
  const { dir, store } = mkStore();
  try {
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS; // the previous completed hour

    store.appendEngineSample(mkEngine(hourStart + 1_000));
    store.appendEngineSample(mkEngine(hourStart + 2_000));
    store.rollupHour(hourStart, now);

    const hourFile = join(dir, `metrics-hour-${metricsUtcDay(hourStart)}.jsonl`);
    let buckets = store.readRange({ series: 'engine', from: hourStart, to: hourStart + HOUR_MS - 1, bucket: 'hour' });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.kind, 'engine_hour');
    assert.equal((buckets[0] as { samples: number }).samples, 2);

    // A restart re-runs the rollup over the same raw lines plus one more:
    // the hour file gains a second bucket line; the reader keeps the LAST.
    store.appendEngineSample(mkEngine(hourStart + 3_000));
    store.rollupHour(hourStart, now);
    const lines = readFileSync(hourFile, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2, 'rollup appends, never rewrites');

    buckets = store.readRange({ series: 'engine', from: hourStart, to: hourStart + HOUR_MS - 1, bucket: 'hour' });
    assert.equal(buckets.length, 1, 'deduped to one point per (hour, key)');
    assert.equal((buckets[0] as { samples: number }).samples, 3, 'LAST line wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollup counts lease lines into engine_hour and lease_hour (revoked, tokens)', () => {
  const { dir, store } = mkStore();
  try {
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
    store.appendEngineSample(mkEngine(hourStart + 1_000));
    store.appendLeaseOutcome({
      ts: hourStart + 5_000,
      kind: 'lease',
      lease_id: 'l-ab12cd34',
      project: 'career-ops',
      server_id: WATCHED_SERVER_ID,
      client: 'm1max',
      status: 'revoked',
      reason: 'preempted',
      tokens_out: 4123,
      tokens_in: 980,
      score: null,
    });
    store.rollupHour(hourStart, now);

    const eh = store.readRange({ series: 'engine', from: hourStart, to: hourStart + HOUR_MS - 1, bucket: 'hour' }) as unknown as { revoked: number; tokens_out: number }[];
    assert.equal(eh.length, 1);
    assert.equal(eh[0]!.revoked, 1);
    assert.equal(eh[0]!.tokens_out, 4123);

    const lh = store.readRange({ series: 'lease', from: hourStart, to: hourStart + HOUR_MS - 1, bucket: 'hour' }) as unknown as { project: string; leases: number; revoked: number }[];
    assert.equal(lh.length, 1);
    assert.equal(lh[0]!.project, 'career-ops');
    assert.equal(lh[0]!.leases, 1);
    assert.equal(lh[0]!.revoked, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Corrupt-line skip

test('the reader skips unparseable lines; the file is never moved aside', () => {
  const { dir, store } = mkStore();
  try {
    const t = Date.now();
    const rawFile = join(dir, `metrics-raw-${metricsUtcDay(t)}.jsonl`);
    appendFileSync(rawFile, JSON.stringify(mkEngine(t + 1000)) + '\n');
    appendFileSync(rawFile, 'this line is {{{ not json\n');
    appendFileSync(rawFile, '{"ts":\n'); // truncated write
    appendFileSync(rawFile, JSON.stringify(mkEngine(t + 2000)) + '\n');

    const lines = store.readRange({ series: 'engine', from: t - 1000, to: t + 5000, bucket: 'raw' });
    assert.equal(lines.length, 2, 'two good lines survive, two bad lines skipped');
    assert.ok(existsSync(rawFile), 'no rename-aside for JSONL (unlike state.json)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rotation (whole files only)

test('rotation deletes whole raw files past the window and hour files past retention; newer files stay', () => {
  const { dir, store } = mkStore({ rawWindowHours: 48, retentionDays: 400 });
  try {
    const now = Date.now();
    const old = (days: number) => metricsUtcDay(now - days * DAY_MS);
    const files = [
      join(dir, `metrics-raw-${old(10)}.jsonl`), // past the 48h window → delete
      join(dir, `metrics-raw-${old(1)}.jsonl`), // inside the window → keep
      join(dir, `metrics-hour-${old(500)}.jsonl`), // past 400d retention → delete
      join(dir, `metrics-hour-${old(100)}.jsonl`), // inside retention → keep
      join(dir, 'state.json'), // never touched
    ];
    for (const f of files) writeFileSync(f, '');
    store.rotate(now);
    assert.ok(!existsSync(files[0]), 'old raw file deleted');
    assert.ok(existsSync(files[1]), 'recent raw file kept');
    assert.ok(!existsSync(files[2]), 'old hour file deleted');
    assert.ok(existsSync(files[3]), 'recent hour file kept');
    assert.ok(existsSync(files[4]), 'state.json untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Backwards feed id → unknown delta (never negative)

test('FeedDeltaTracker: first sample and backwards ids read as unknown delta, never negative', () => {
  const t = new FeedDeltaTracker();
  const url = 'http://fake/api/metrics/activity';

  // First observation: no baseline → unknown.
  t.observe(url, [{ id: 100 }, { id: 104 }]);
  assert.deepEqual(t.delta(url), { req_delta: null, feed_last_id: 104 });

  // Normal forward movement → the id difference.
  t.observe(url, [{ id: 109 }]);
  assert.deepEqual(t.delta(url), { req_delta: 5, feed_last_id: 109 });

  // llama-swap restart: ids go backwards → unknown, and the baseline
  // rebases so the NEXT delta counts from the new low.
  t.observe(url, [{ id: 3 }]);
  assert.deepEqual(t.delta(url), { req_delta: null, feed_last_id: 3 });
  t.observe(url, [{ id: 9 }]);
  assert.deepEqual(t.delta(url), { req_delta: 6, feed_last_id: 9 });

  // An empty feed page carries no id evidence: the previous value stands.
  t.observe(url, []);
  assert.deepEqual(t.delta(url), { req_delta: 0, feed_last_id: 9 });
});

// ---------------------------------------------------------------------------
// GET /api/metrics — auth matrix, param validation, cap + truncated

let dir: string;
let app: ReturnType<typeof buildApi>;
let base: string;
let store: MetricsStore;

function baseCfg(dir: string): ServerConfig {
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
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-metrics-api-'));
  const cfg = baseCfg(dir);
  store = new MetricsStore({ stateFile: cfg.state_file, rawWindowHours: 48, retentionDays: 400, log: () => {} });
  const arbiter = new Arbiter(new StateStore(cfg.state_file), cfg, new Map());
  app = buildApi({ arbiter, cfg, publicDir: join(dir, 'public'), metrics: store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('auth matrix: anonymous 200, admin token 200, wrong token 401, peer_token 401 on this route', async () => {
  const anon = await fetch(`${base}/api/metrics?series=engine`);
  assert.equal(anon.status, 200, 'anonymous read allowed (the /api/state exception extends)');

  const admin = await fetch(`${base}/api/metrics?series=engine`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(admin.status, 200);

  // The wrong token is assembled at runtime (a literal token-looking
  // string in this file gets mangled by the agent write path — keep the
  // pattern out of the source).
  const WRONG = 'wrong-' + 'token-9';
  const wrong = await fetch(`${base}/api/metrics?series=engine`, { headers: { authorization: 'Bearer ' + WRONG } });
  assert.equal(wrong.status, 401, 'a wrong token is still 401');

  const peer = await fetch(`${base}/api/metrics?series=engine`, { headers: { authorization: `Bearer ${PEER}` } });
  assert.equal(peer.status, 401, 'peer_token stays scoped to GET /api/mesh — it does NOT unlock /api/metrics');
});

test('param validation: bad series / bucket / from / to answer 400 with an error string', async () => {
  for (const qs of [
    '', // series missing
    'series=bogus',
    'series=engine&bucket=minute',
    'series=engine&from=abc&to=123',
    'series=engine&from=200&to=100', // from > to
  ]) {
    const res = await fetch(`${base}/api/metrics?${qs}`);
    assert.equal(res.status, 400, `400 for: ${qs || '(no params)'}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(typeof body.error, 'string', 'error string present');
  }
});

test('the response groups points by key, caps at 2,000 points, trims the OLDEST, sets truncated', async () => {
  const now = Date.now();
  // 2,500 raw engine samples for one key inside the raw window.
  for (let i = 0; i < 2500; i++) store.appendEngineSample(mkEngine(now - 2_500_000 + i * 1000, { req_delta: 1 }));

  const res = await fetch(`${base}/api/metrics?series=engine&bucket=raw&from=${now - 3_600_000}&to=${now}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { series: { key: string; points: Record<string, unknown>[] }[]; truncated: boolean };
  assert.equal(body.truncated, true);
  assert.equal(body.series.length, 1);
  assert.equal(body.series[0]!.key, WATCHED_SERVER_ID);
  assert.equal(body.series[0]!.points.length, 2000, 'capped at 2,000 points');
  // The OLDEST 500 were trimmed: the first surviving point is the 501st.
  const firstTs = body.series[0]!.points[0]!.ts as number;
  assert.equal(firstTs, now - 2_500_000 + 500 * 1000);
});

test('raw bucket answers only inside the raw window (from is clamped); hour is the default', async () => {
  const now = Date.now();
  // A sample 100h ago: outside a 48h raw window, inside the hour range.
  // The query window stays clear of the cap test's samples (the last hour).
  const old = now - 100 * HOUR_MS;
  store.appendEngineSample(mkEngine(old));
  const raw = await (await fetch(`${base}/api/metrics?series=engine&bucket=raw&from=${old - 10 * HOUR_MS}&to=${old + 10 * HOUR_MS}`)).json() as { series: { points: unknown[] }[] };
  assert.equal(raw.series.reduce((n, s) => n + s.points.length, 0), 0, 'raw never answers outside the window');
  // The default bucket is hour: the raw-only line is not in any hour file,
  // so the default read is also empty (no raw leak through the default).
  const def = await (await fetch(`${base}/api/metrics?series=engine&from=${old - 10 * HOUR_MS}&to=${old + 10 * HOUR_MS}`)).json() as { series: { points: unknown[] }[] };
  assert.equal(def.series.reduce((n, s) => n + s.points.length, 0), 0);
});

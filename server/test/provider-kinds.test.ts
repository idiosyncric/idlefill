/**
 * provider-kinds.test.ts — #62: per-row `provider_kind` engine adapters.
 * One kind selects the idle-signal implementation AND the metrics sampler:
 *   llama-swap (default, unchanged)  — activity feed + feed-id deltas
 *   strata     — /metrics JSON parsed into feed entries; request + token
 *                truth from the engine's own `totals` counters (HTTP only)
 *   omlx       — feed-off (log mtime) + the oMLX usage sqlite store as
 *                request/token truth (co-located)
 *
 * Covers:
 *   - parseStrataMetrics: finished jobs → newest-first feed entries with
 *     COMPLETION timestamps; an in-flight generation counts as current
 *     activity; ids ride totals.requests (the delta stays a request count)
 *   - readStrataCounters: totals → EngineCounters; absent → null
 *   - the strata fetcher: transport + Bearer + counters observer (one HTTP
 *     call feeds idle detection AND the metrics sampler)
 *   - kind defaults: defaultActivityPathFor + config applyDefaults +
 *     upsertServerConnection seeding/normalizing (strata url → origin,
 *     omlx → feed-off) and kind-change re-derivation on patch
 *   - invalid kind rejected (never silently defaulted)
 *   - honest fail-closed: a feed-off row with no log signal names the
 *     kind gap (no_signal_reason), not "activity fetch failed"
 *   - CounterDeltaTracker: first sample / backwards counter read unknown,
 *     never negative
 *   - SqliteOmlxUsageReader: sums model_usage_hourly from a real temp
 *     sqlite file; a missing store reads unreachable (null), never zero
 *   - rollupHour carries requests_source + engine token truth
 *   - /api/servers accepts provider on create + patch, echoes it, and
 *     keeps auth_token write-only
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  IdleDetector,
  makeActivityFetcherFor,
  parseStrataMetrics,
  readStrataCounters,
  defaultActivityPathFor,
  STRATA_SRC,
} from '../src/idle.js';
import { applyDefaults } from '../src/config.js';
import { Arbiter, WATCHED_SERVER_ID, feedOrigin } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { CounterDeltaTracker, SqliteOmlxUsageReader, OmlxUsageReaders, defaultOmlxUsageDb } from '../src/omlx.js';
import { MetricsStore } from '../src/metrics.js';
import { buildApi } from '../src/api.js';
import type { ServerConfig, EngineSampleLine } from '../src/types.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');

// ---------------------------------------------------------------------------
// parseStrataMetrics — shape verified against the live strata 2026-10-05.

const STRATA_BODY = {
  engine: { model: 'qwen-test', max_context: 262144 },
  live: { state: 'idle', queued: 0 },
  // time = start epoch-SEC, duration_s, finish — the live field names.
  requests: [
    { time: 1791232752.345, duration_s: 3.7, finish: 'stop', prompt_tokens: 62181, output_tokens: 305 },
    { time: 1791232700.0, duration_s: 10.0, finish: 'error', prompt_tokens: 10, output_tokens: 2 },
  ],
  totals: { since: 1791214353.0, requests: 1235, prompt_tokens: 109169204, output_tokens: 1280424 },
  time: 1791232756.309,
};

test('parseStrataMetrics: finished jobs → newest-first entries with completion timestamps', () => {
  const entries = parseStrataMetrics(STRATA_BODY);
  assert.equal(entries.length, 2);
  // Completion (time+duration), not start: idle means "nothing FINISHED recently".
  assert.equal(entries[0]!.timestamp, new Date(Math.round((1791232752.345 + 3.7) * 1000)).toISOString());
  assert.ok(entries[0]!.timestamp > entries[1]!.timestamp, 'newest-first');
  // Ids ride totals.requests walking backwards (the delta stays a count).
  assert.equal(entries[0]!.id, 1235);
  assert.equal(entries[1]!.id, 1234);
  assert.equal(entries[0]!.src, STRATA_SRC);
  assert.equal(entries[0]!.model, 'qwen-test');
  assert.equal(entries[1]!.resp_status_code, 500, 'finish=error reads non-200');
});

test('parseStrataMetrics: an in-flight generation IS current activity', () => {
  const body = { ...STRATA_BODY, live: { state: 'generating' }, requests: [] };
  const entries = parseStrataMetrics(body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.timestamp, new Date(Math.round(1791232756.309 * 1000)).toISOString());
  assert.equal(entries[0]!.id, 1236, 'the in-flight generation is the next request past totals.requests');
});

test('parseStrataMetrics: live idle/stopped state adds no entry; garbage body yields []', () => {
  assert.equal(parseStrataMetrics({ ...STRATA_BODY, live: { state: 'idle' }, requests: [] }).length, 0);
  assert.equal(parseStrataMetrics(null).length, 0);
  assert.equal(parseStrataMetrics({ requests: 'not-an-array' }).length, 0);
});

test('readStrataCounters: totals → engine counters; missing/absent → null', () => {
  const c = readStrataCounters(STRATA_BODY);
  assert.deepEqual(c, { requests: 1235, tokens_in: 109169204, tokens_out: 1280424 });
  assert.equal(readStrataCounters({ engine: {} }), null);
  assert.equal(readStrataCounters({ totals: { prompt_tokens: 5 } }), null, 'no requests counter = no counters');
});

// ---------------------------------------------------------------------------
// The strata fetcher: one HTTP call feeds idle detection AND the sampler.

test('strata fetcher: Bearer rides, entries parse, totals observed (one call)', async () => {
  const seen: { url?: string; headers?: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers });
    return { ok: true, json: async () => STRATA_BODY } as Response;
  };
  const observed: { requests: number }[] = [];
  try {
    const f = makeActivityFetcherFor('strata', (c) => observed.push(c));
    const entries = await f('https://strata.example/metrics', 'sekrit');
    assert.equal(entries.length, 2);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.requests, 1235);
    assert.ok(seen[0]!.headers?.authorization && seen[0]!.headers.authorization.includes('sekrit'));
    // No token = no header (the keyless-row back-compat rule).
    await f('https://strata.example/metrics');
    assert.equal(seen[1]!.headers?.authorization, undefined);
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Kind defaults: path, config, seeding, patch re-derivation.

test('defaultActivityPathFor: the kind selects the feed shape', () => {
  assert.equal(defaultActivityPathFor('llama-swap'), '/api/metrics/activity');
  assert.equal(defaultActivityPathFor('strata'), '/metrics');
  assert.equal(defaultActivityPathFor('omlx'), '', 'oMLX has no HTTP feed — feed-off');
  assert.equal(defaultActivityPathFor(undefined), '/api/metrics/activity', 'absent = llama-swap (back-compat)');
});

test('config: server_provider selects the watched-row feed default; garbage kind falls back', () => {
  const strata = applyDefaults({ server_provider: 'strata', llama_swap_url: 'https://s.example/v1' });
  assert.equal(strata.server_provider, 'strata');
  assert.equal(strata.activity_path, '/metrics', 'the kind supplies the path');
  const omlx = applyDefaults({ server_provider: 'omlx' });
  assert.equal(omlx.activity_path, '');
  const garbage = applyDefaults({ server_provider: 'ollama' });
  assert.equal(garbage.server_provider, undefined, 'garbage kind = llama-swap, never a silent guess');
  assert.equal(garbage.activity_path, '/api/metrics/activity');
  const explicit = applyDefaults({ server_provider: 'strata', activity_path: '/custom' });
  assert.equal(explicit.activity_path, '/custom', 'an explicit path always beats the kind default');
});

test('feedOrigin: strata operators paste the OpenAI base; the feed lives on the origin', () => {
  assert.equal(feedOrigin('https://strata.samwarth.com/v1'), 'https://strata.samwarth.com');
  assert.equal(feedOrigin('http://host:8080/v1/'), 'http://host:8080');
  assert.equal(feedOrigin('not a url'), 'not a url', 'unparseable passes through');
});

test('upsertServerConnection: provider kind on create (validate, normalize, default path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-kinds-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json') }),
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 1000 }],
  };
  const arbiter = new Arbiter(store, cfg, new Map());

  const bad = arbiter.upsertServerConnection({ name: 'x', url: 'http://x:1', provider: 'ollama' });
  assert.equal(bad.ok, false, 'an unsupported kind is rejected, never silently defaulted');
  assert.match(bad.reason!, /unknown provider kind/);

  // strata create: url normalizes to the ORIGIN, path defaults to /metrics.
  const st = arbiter.upsertServerConnection({ name: 'strata', url: 'https://s.example/v1', provider: 'strata' });
  assert.equal(st.ok, true);
  assert.equal(st.server!.url, 'https://s.example');
  assert.equal(st.server!.activity_path, '/metrics');
  assert.equal(st.server!.provider, 'strata');

  // omlx create: feed-off sticks.
  const om = arbiter.upsertServerConnection({ name: 'omlx', url: 'http://127.0.0.1:8000', provider: 'omlx' });
  assert.equal(om.ok, true);
  assert.equal(om.server!.activity_path, '', 'the omlx kind declares feed-off by default');

  // llama-swap create keeps the old contract exactly.
  const ls = arbiter.upsertServerConnection({ name: 'swap', url: 'http://10.0.0.2:11434' });
  assert.equal(ls.server!.activity_path, '/api/metrics/activity');
  assert.equal(ls.server!.provider, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('upsertServerConnection: kind change on patch re-derives the feed defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-kindchg-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json') }),
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 1000 }],
  };
  const arbiter = new Arbiter(store, cfg, new Map());
  // The broken state #62 fixes: a strata engine added as a llama-swap row.
  const created = arbiter.upsertServerConnection({ name: 'strata', url: 'https://s.example/v1', activity_path: '/api/metrics/activity' });
  assert.equal(created.ok, true);
  const patched = arbiter.upsertServerConnection({ id: created.server!.id, provider: 'strata' });
  assert.equal(patched.ok, true);
  assert.equal(patched.server!.url, 'https://s.example', 'kind change normalizes the url to the origin');
  assert.equal(patched.server!.activity_path, '/metrics', 'kind change fixes the invented feed path in one save');
  // Back to llama-swap re-derives the llama-swap path.
  const back = arbiter.upsertServerConnection({ id: created.server!.id, provider: 'llama-swap' });
  assert.equal(back.server!.activity_path, '/api/metrics/activity');
  // An explicit path in the SAME body beats the re-derivation.
  const keep = arbiter.upsertServerConnection({ id: created.server!.id, provider: 'strata', activity_path: '/metrics?x=1' });
  assert.equal(keep.server!.activity_path, '/metrics?x=1');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Honest fail-closed (#62 acceptance): the kind gap, not a fetch lie.

test('fail-closed honesty: feed-off + no log signal names the kind gap', async () => {
  const d = new IdleDetector({
    fetchActivity: async () => {
      throw new Error('must not fetch');
    },
    logMtime: () => null, // remote row: the local glob matches nothing
    llama_swap_url: 'http://10.10.10.241:8080',
    activity_path: '', // feed-off
    log_glob: '/logs/server.log',
    idle_seconds: 300,
    provider: 'omlx',
  });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, false, 'fail-closed: no signal ⇒ never idle');
  assert.equal(sig.idle_for_s, null);
  assert.equal(sig.signal_degraded, false, 'nothing was fetched — not a fetch failure');
  assert.equal(sig.degraded_reason, null, 'the old lie: "activity fetch failed" is NOT used');
  assert.match(sig.no_signal_reason ?? '', /no idle signal for provider kind omlx/, 'the kind gap is named');
});

test('the kind gap reason is absent when a signal resolves', async () => {
  const d = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => T0 - 400_000,
    llama_swap_url: 'http://omlx.local:8000',
    activity_path: '',
    log_glob: '/logs/server.log',
    idle_seconds: 300,
    provider: 'omlx',
  });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.no_signal_reason, undefined);
  assert.equal(sig.idle, true);
});

// ---------------------------------------------------------------------------
// CounterDeltaTracker: FeedDeltaTracker's posture for raw counters.

test('CounterDeltaTracker: first sample unknown, delta computed, restart unknown', () => {
  const t = new CounterDeltaTracker();
  assert.equal(t.delta('a').req_delta, null, 'first sample = unknown, never a guess');
  t.observe('a', { requests: 100, tokens_in: 1000, tokens_out: 500 });
  assert.equal(t.delta('a').req_delta, null, 'observe then first consume still has no baseline');
  t.observe('a', { requests: 105, tokens_in: 1100, tokens_out: 550 });
  const d1 = t.delta('a');
  assert.deepEqual([d1.req_delta, d1.tokens_in_delta, d1.tokens_out_delta], [5, 100, 50]);
  // Engine restart resets the counters: unknown, never negative.
  t.observe('a', { requests: 3, tokens_in: 10, tokens_out: 5 });
  const d2 = t.delta('a');
  assert.equal(d2.req_delta, null);
  assert.equal(d2.tokens_in_delta, null);
  assert.equal(d2.tokens_out_delta, null);
});

// ---------------------------------------------------------------------------
// SqliteOmlxUsageReader against a REAL temp store (node:sqlite, the same
// table/shape as the live ~/.omlx/usage.sqlite3).

test('SqliteOmlxUsageReader: sums model_usage_hourly; missing store reads unreachable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-omlx-'));
  const dbPath = join(dir, 'usage.sqlite3');
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE model_usage_hourly (' +
      'timestamp_hour INTEGER NOT NULL, model_id TEXT NOT NULL, requests INTEGER NOT NULL, ' +
      'prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, ' +
      'prefill_seconds REAL NOT NULL, generation_seconds REAL NOT NULL, request_seconds REAL NOT NULL, ' +
      'timed_requests INTEGER NOT NULL, PRIMARY KEY (timestamp_hour, model_id)) WITHOUT ROWID',
  );
  const ins = db.prepare(
    'INSERT INTO model_usage_hourly VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  ins.run(1791219600, 'Model-A', 15, 1354805, 22855, 1336672, 117.8, 901.2, 1019.0, 15);
  ins.run(1791219600, 'Model-B', 1, 568, 53, 0, 1.3, 0.6, 2.0, 1);
  db.close();

  const r = new SqliteOmlxUsageReader(dbPath);
  assert.equal(r.available(), true);
  assert.deepEqual(r.readTotals(), { requests: 16, tokens_in: 1355373, tokens_out: 22908 });

  const missing = new SqliteOmlxUsageReader(join(dir, 'nope.sqlite3'));
  assert.equal(missing.available(), false);
  assert.equal(missing.readTotals(), null, 'unreachable ≠ zero (never a lie about idle usage)');

  // OmlxUsageReaders warns once while missing, self-heals when it appears.
  const lines: string[] = [];
  const readers = new OmlxUsageReaders((m) => lines.push(m));
  readers.forPath(join(dir, 'later.sqlite3'));
  readers.forPath(join(dir, 'later.sqlite3'));
  assert.equal(lines.length, 1, 'one warning while missing, not one per poll');
  assert.equal(defaultOmlxUsageDb().endsWith('.omlx/usage.sqlite3') || defaultOmlxUsageDb().includes('usage.sqlite3'), true);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The hour rollup carries the #62 add-keys.

test('rollupHour: requests_source + engine token truth ride the hour line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-rollup-'));
  const store = new MetricsStore({ stateFile: join(dir, 'state.json'), rawWindowHours: 48, retentionDays: 400 });
  const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
  const sample = (ts: number, line: Partial<EngineSampleLine>): void => {
    store.appendEngineSample({
      ts, kind: 'engine', server_id: 'srv-strata', idle: true, idle_for_s: 900, degraded: false,
      req_delta: 5, feed_last_id: null, grants: 0, denials: {}, active_leases: 0, active_sessions: 0,
      requests_source: 'metrics-counter', tokens_in_delta: 100, tokens_out_delta: 40, ...line,
    });
  };
  sample(hour + 1000, {});
  sample(hour + 60_000, { tokens_in_delta: 50, tokens_out_delta: 20 });
  store.rollupHour(hour, T0);
  const lines = store.readRange({ series: 'engine', from: hour, to: T0, bucket: 'hour' });
  const h = lines.find((l) => l.kind === 'engine_hour') as Record<string, unknown> | undefined;
  assert.ok(h, 'the hour bucket exists');
  assert.equal(h!['requests_source'], 'metrics-counter');
  assert.equal(h!['req_total'], 10);
  assert.equal(h!['engine_tokens_in'], 150, 'deltas sum across the hour');
  assert.equal(h!['engine_tokens_out'], 60);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The API surface: provider on create/patch, echoed back, key still hidden.

test('/api/servers accepts provider and keeps it visible (auth_token stays hidden)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-api-kinds-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json'), api_tokens: ['tok'] }),
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 1000 }],
  };
  const arbiter = new Arbiter(store, cfg, new Map(), {
    detectorFactory: (row) =>
      new IdleDetector({
        fetchActivity: async () => [],
        logMtime: () => null,
        llama_swap_url: row.url,
        activity_path: row.activity_path,
        log_glob: row.log_glob ?? '',
        idle_seconds: cfg.idle_seconds,
        ...(row.provider ? { provider: row.provider } : {}),
      }),
  });
  const app = buildApi({ arbiter, cfg, publicDir: join(dir, 'public') });

  const created = await app.inject({
    method: 'POST', url: '/api/servers?token=tok',
    payload: { name: 'strata', url: 'https://s.example/v1', provider: 'strata', auth_token: 'topsecret' },
  });
  assert.equal(created.statusCode, 200);
  const row = created.json().server;
  assert.equal(row.provider, 'strata');
  assert.equal(row.url, 'https://s.example');
  assert.equal(row.activity_path, '/metrics');
  assert.equal(row.auth_token, undefined, 'the credential never rides the echo');
  assert.equal(row.auth_set, true);

  const bad = await app.inject({
    method: 'POST', url: '/api/servers?token=tok',
    payload: { name: 'x', url: 'http://x:1', provider: 'ollama' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /unknown provider kind/);

  const patched = await app.inject({
    method: 'POST', url: '/api/servers?token=tok',
    payload: { id: row.id, provider: 'omlx' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().server.provider, 'omlx');
  assert.equal(patched.json().server.activity_path, '');

  // The anonymous /api/state view carries provider on the signal too.
  const st = await app.inject({ method: 'GET', url: '/api/state' });
  const srow = st.json().servers.find((x: { id: string }) => x.id === row.id);
  assert.equal(srow.provider, 'omlx');
  assert.equal(srow.signal.no_signal_reason, 'no idle signal for provider kind omlx (supported: llama-swap, strata, omlx)', 'fail-closed reason names the gap (no log glob)');
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the seeded watched row carries server_provider (#60 B seed, #62 kind)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-seed-kind-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json'), server_provider: 'strata', llama_swap_url: 'https://s.example/v1' }),
    projects: [],
  };
  const arbiter = new Arbiter(store, cfg, new Map());
  arbiter.ensureServersSeeded();
  const watched = store.state.servers.find((s) => s.id === WATCHED_SERVER_ID)!;
  assert.equal(watched.provider, 'strata');
  assert.equal(watched.url, 'https://s.example');
  assert.equal(watched.activity_path, '/metrics');
  rmSync(dir, { recursive: true, force: true });
});

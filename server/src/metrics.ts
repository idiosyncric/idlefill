/**
 * Metrics retention store (#51, decision doc: docs/architecture/metrics-history.md).
 *
 * Append-only JSONL next to `state.json` (the `state_file` directory):
 *
 *   metrics-raw-YYYY-MM-DD.jsonl   engine samples, lease outcomes, session
 *                                  lines, interleaved — deleted past the raw
 *                                  window (D5).
 *   metrics-hour-YYYY-MM-DD.jsonl  hour buckets, one line per (hour, series)
 *                                  — deleted past the retention horizon (D5).
 *
 * The rollup reads RAW files, never an in-memory accumulator: a restart
 * mid-hour loses nothing (D5). The reader keeps the LAST line per
 * (hour, series key), so a re-run rollup is idempotent without rewriting
 * any file.
 *
 * Corrupt posture (D5, unlike state.json): the reader skips unparseable
 * lines; a missing file is an empty series; an append failure logs and
 * drops one sample — it NEVER throws into its caller (tick, finishLease,
 * register). A bad line never moves the whole file aside.
 *
 * Denials ride as counters inside the engine sample (D5): never one line
 * per denial. The window counters live here; the arbiter wrapper
 * ({@link instrumentArbiterForMetrics}) feeds them without arbiter.ts
 * changing.
 *
 * The feed `id` monotonicity across a llama-swap restart is unverified
 * (D3 grill note): FeedDeltaTracker treats a backwards id as an UNKNOWN
 * delta, never a negative count.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WATCHED_SERVER_ID, type Arbiter } from './arbiter.js';
import type { RequestsSource } from './types.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type MetricsSeries = 'engine' | 'lease' | 'session';
export type MetricsBucket = 'hour' | 'raw';

// ---------------------------------------------------------------------------
// Line shapes (docs/architecture/metrics-history.md, "File family and line
// shapes"). Field names match the existing state vocabulary.

export interface EngineSampleLine {
  ts: number;
  kind: 'engine';
  server_id: string;
  idle: boolean;
  idle_for_s: number | null;
  degraded: boolean;
  /** Requests since the previous sample; null = unknown (backwards feed id). */
  req_delta: number | null;
  /** Newest feed id observed for this engine; null = the feed never answered. */
  feed_last_id: number | null;
  grants: number;
  /** Denials by reason since the previous sample (D5: counters, not lines). */
  denials: Record<string, number>;
  active_leases: number;
  /** D2: until #45 lands, the session series is only this count. */
  active_sessions: number;
  /**
   * Where this sample's request count came from (#62). Absent = 'feed-delta'
   * (every pre-#62 line reads unchanged). ADD key.
   */
  requests_source?: RequestsSource;
  /**
   * Engine-reported token deltas since the previous sample (#62): strata
   * /metrics totals or the oMLX usage store. null = unknown (first sample,
   * backwards counter, unreachable store). Only present for the
   * counter-backed kinds. ADD keys.
   */
  tokens_in_delta?: number | null;
  tokens_out_delta?: number | null;
  /**
   * Load axis (#52 slice 1 — DATA ONLY): the captured engine load reading
   * for this tick, same key names as the signal block (design doc D5:
   * "The #51 engine sample line carries the SAME key names. The sample is
   * where the series lives."). Absent keys = no reading (a failed load
   * read never fills them with a fake zero); `load_age_s` labels the
   * reading's age against the `metrics_load_stale_s` window. Display and
   * sample only — never a verdict input (D4 stays off). ADD keys.
   */
  load_source?: string;
  /**
   * The D4 busy predicate on this tick's load reading (slice 3) —
   * present only on a FRESH read (the `metrics_load_stale_s` window):
   * strata `live.state` not in {idle, stopped, none}; llama-swap
   * `gpu_util_percent` above the owner-set `metrics_llamaswap_busy_gpu_percent`
   * (no default — absent knob = the key is absent, LOCKED UNSET by the
   * owner); oMLX `active_requests` > 0 (the D8 amendment, slice 5). Stale is
   * unknown → absent (D2 rule 2). A true load_busy DELAYS the grant: the
   * sample's `idle` reflects it (the feed says idle, the engine is busy).
   * ADD key.
   */
  load_busy?: boolean;
  load_age_s?: number;
  /**
   * WHY the last load read failed (#52 slice 4, D4 strata auth gap): the
   * last FAILED read's operator-readable reason — e.g. a strata row with NO
   * credential whose `/metrics` answers 401 (the D4 busy predicate can
   * never fire until the operator sets the row's `auth_token`). Present
   * when the row has NO good reading; CLEARED on the next successful read.
   * Display and sample only — never a verdict input. Absent = the read is
   * currently good (or never ran). ADD key.
   */
  load_fail_reason?: string;
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
  tokens_per_second?: number | null;
  in_flight?: number;
  /**
   * The scheduler queue depth (oMLX 0.7.0 `/api/status` `waiting_requests`
   * — the first queue count in the fleet, the D8 amendment, #52 slice 5;
   * absent on llama-swap and strata). Same key name as the signal block
   * (D5). ADD key.
   */
  queue_depth?: number;
  model_loaded?: string;
  model_quant?: string;
  omlx_loaded_count?: number;
}

export interface LeaseOutcomeLine {
  ts: number;
  kind: 'lease';
  lease_id: string;
  project: string;
  server_id: string;
  client: string;
  status: string;
  reason: string | null;
  tokens_out: number;
  tokens_in: number;
  score: number | null;
}

/** Session line shape (#45's heartbeat block will feed this; #51 defines it). */
export interface SessionSampleLine {
  ts: number;
  kind: 'session';
  token: string;
  reqs_per_min: number;
  model: string;
}

export interface EngineHourLine {
  ts: number; // hour start (epoch-ms)
  kind: 'engine_hour';
  server_id: string;
  samples: number;
  req_total: number;
  idle_samples: number;
  grants: number;
  revoked: number;
  tokens_out: number;
  tokens_in: number;
  /**
   * #62 ADD-keys: the source the hour's req/token numbers rode, and the
   * engine-reported TOKEN truth (sum of the raw-line deltas; null = no
   * counter-backed sample contributed, distinct from a real 0).
   */
  requests_source?: RequestsSource;
  engine_tokens_in?: number | null;
  engine_tokens_out?: number | null;
}

export interface LeaseHourLine {
  ts: number;
  kind: 'lease_hour';
  project: string;
  leases: number;
  finished: number;
  revoked: number;
  tokens_out: number;
  tokens_in: number;
}

export interface SessionHourLine {
  ts: number;
  kind: 'session_hour';
  token: string;
  samples: number;
  reqs_per_min_max: number;
}

export type MetricsLine =
  | EngineSampleLine
  | LeaseOutcomeLine
  | SessionSampleLine
  | EngineHourLine
  | LeaseHourLine
  | SessionHourLine;

/** The series key dimension (D6: server_id / session token / project). */
export function seriesKeyOf(line: MetricsLine): string {
  switch (line.kind) {
    case 'engine':
    case 'engine_hour':
      return line.server_id;
    case 'lease':
    case 'lease_hour':
      return line.project;
    case 'session':
    case 'session_hour':
      return line.token;
  }
}

/** UTC day key for an epoch-ms timestamp: "2026-10-04". */
export function metricsUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Feed request delta (D3): the detector already fetches the activity feed
// every poll; the numeric entry `id` gives the delta. A llama-swap restart
// may reset ids — a backwards id reads as an UNKNOWN delta, never negative.

export class FeedDeltaTracker {
  /** url -> max id of the most recent successful feed poll. */
  private observed = new Map<string, number>();
  /** url -> max id at the previous sampled tick (the delta baseline). */
  private baseline = new Map<string, number>();

  /** Record one successful feed poll (called by the wrapped fetcher). */
  observe(url: string, entries: { id?: unknown }[]): void {
    let max: number | null = null;
    for (const e of entries) {
      const id = e?.id;
      if (typeof id === 'number' && Number.isFinite(id) && (max === null || id > max)) max = id;
    }
    // An empty feed page carries no id evidence — keep the previous value.
    if (max !== null) this.observed.set(url, max);
  }

  /**
   * Consume the delta for one engine since its previous sample. First
   * sample and backwards ids read as unknown (null), never negative.
   */
  delta(url: string): { req_delta: number | null; feed_last_id: number | null } {
    const cur = this.observed.get(url);
    if (cur === undefined) return { req_delta: null, feed_last_id: null };
    const prev = this.baseline.get(url);
    this.baseline.set(url, cur);
    if (prev === undefined) return { req_delta: null, feed_last_id: cur };
    if (cur < prev) return { req_delta: null, feed_last_id: cur }; // restart: unknown, rebase
    return { req_delta: cur - prev, feed_last_id: cur };
  }
}

// ---------------------------------------------------------------------------
// The store.

export interface MetricsStoreOpts {
  /** The state.json path — the metrics family lives in its directory. */
  stateFile: string;
  /** Raw-file window in hours (config `metrics_raw_window_hours`, default 48). */
  rawWindowHours: number;
  /** Hour-bucket retention in days (config `metrics_retention_days`, default 400). */
  retentionDays: number;
  /** Log sink for the never-throw posture (default console). */
  log?: (msg: string) => void;
}

export class MetricsStore {
  private readonly dir: string;
  private readonly rawWindowHours: number;
  private readonly retentionDays: number;
  private readonly log: (msg: string) => void;
  /** Per-engine grant/denial counters since the previous engine sample (D5). */
  private windows = new Map<string, { grants: number; denials: Record<string, number> }>();
  /** Lease ids whose end line was already appended, and how final it is. */
  private leaseEndSeen = new Map<string, 'provisional' | 'final'>();

  constructor(o: MetricsStoreOpts) {
    this.dir = dirname(o.stateFile) || '.';
    this.rawWindowHours = Number.isFinite(o.rawWindowHours) && o.rawWindowHours > 0 ? o.rawWindowHours : 48;
    this.retentionDays = Number.isFinite(o.retentionDays) && o.retentionDays > 0 ? o.retentionDays : 400;
    this.log = o.log ?? ((m) => console.error(m));
  }

  // --- append (never throws: a failed append drops one sample, D5) --------

  appendEngineSample(line: EngineSampleLine): void {
    this.appendLine(line);
  }

  appendLeaseOutcome(line: LeaseOutcomeLine): void {
    this.appendLine(line);
  }

  /**
   * Append one lease-end line, deduped by lease_id. Both wiring paths can
   * see the same end (the tick's `revoked` list for revoked/expired, the
   * finishLease wrapper for client-reported finishes), and a client may
   * re-send usage after the lease is terminal. One line per lease end (D2).
   *
   * `final` marks the line as written at a usage report (tokens are the
   * teardown truth). A provisional line (the tick saw the end; the client
   * has not reported yet) is REPLACED by a later final line — appended as a
   * fresh line, and the rollup keeps the LAST line per lease_id, exactly
   * like the reader's last-line-wins contract.
   */
  recordLeaseEnd(lease: {
    lease_id: string;
    project: string;
    server_id?: string;
    client_name: string;
    status: string;
    end_reason?: string;
    tokens_out: number;
    tokens_in: number;
    ended_at?: number;
  }, opts: { score?: number | null; final?: boolean; now?: number } = {}): void {
    if (!lease?.lease_id) return;
    const state = this.leaseEndSeen.get(lease.lease_id);
    if (state === 'final') return; // already recorded from a usage report
    if (state === 'provisional' && opts.final !== true) return; // tick saw it twice
    this.leaseEndSeen.set(lease.lease_id, opts.final ? 'final' : 'provisional');
    if (this.leaseEndSeen.size > 5000) {
      // Bound the dedup map: keep the newest half (a re-seen old id just
      // re-appends one line — a cosmetic risk, never a crash or a throw).
      this.leaseEndSeen = new Map([...this.leaseEndSeen].slice(-2500));
    }
    this.appendLeaseOutcome({
      ts: lease.ended_at ?? opts.now ?? Date.now(),
      kind: 'lease',
      lease_id: lease.lease_id,
      project: lease.project,
      server_id: lease.server_id ?? WATCHED_SERVER_ID,
      client: lease.client_name,
      status: lease.status,
      reason: lease.end_reason ?? null,
      tokens_out: Number.isFinite(lease.tokens_out) ? lease.tokens_out : 0,
      tokens_in: Number.isFinite(lease.tokens_in) ? lease.tokens_in : 0,
      score: opts.score ?? null,
    });
  }

  /**
   * Session append — the call #45's register-heartbeat block will use
   * ("the arbiter appends what the heartbeat carries", D2/D3). Nothing
   * calls it until #45 lands; the shape is defined here so #45's block is
   * a copy, not a transform.
   */
  appendSessionSample(line: SessionSampleLine): void {
    this.appendLine(line);
  }

  private appendLine(line: MetricsLine): void {
    if (!line || typeof line !== 'object' || !Number.isFinite(line.ts)) {
      this.log('[metrics] dropped a malformed metrics line');
      return;
    }
    const file = join(this.dir, `metrics-raw-${metricsUtcDay(line.ts)}.jsonl`);
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      appendFileSync(file, JSON.stringify(line) + '\n');
    } catch (err) {
      // D5: log and drop one sample; never throw into the tick / finish / register.
      this.log(`[metrics] append failed (sample dropped): ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- denial/grant window counters (D5: counters inside the sample) ------

  noteGrant(serverId: string): void {
    this.window(serverId).grants += 1;
  }

  noteDenial(serverId: string, reason: string): void {
    const w = this.window(serverId);
    w.denials[reason] = (w.denials[reason] ?? 0) + 1;
  }

  /** Read AND reset one engine's window (one engine sample per tick). */
  takeWindow(serverId: string): { grants: number; denials: Record<string, number> } {
    const w = this.windows.get(serverId) ?? { grants: 0, denials: {} };
    this.windows.delete(serverId);
    return w;
  }

  private window(serverId: string): { grants: number; denials: Record<string, number> } {
    let w = this.windows.get(serverId);
    if (!w) {
      w = { grants: 0, denials: {} };
      this.windows.set(serverId, w);
    }
    return w;
  }

  // --- rollup (D5: reads raw files, never an accumulator) -----------------

  /**
   * Aggregate one completed hour of raw lines into hour-bucket lines and
   * append them to the hour file. Idempotent by reader contract: a re-run
   * appends again, and the reader keeps the LAST line per (hour, key).
   * Also runs rotation (whole-file deletes only, D5).
   */
  rollupHour(hourStart: number, now: number = Date.now()): void {
    const end = hourStart + HOUR_MS;
    const raw = this.readJsonl(join(this.dir, `metrics-raw-${metricsUtcDay(hourStart)}.jsonl`));
    const inHour = raw.filter((l) => l.ts >= hourStart && l.ts < end);

    // engine_hour: per server_id, from engine lines + that hour's lease lines
    const engine = new Map<string, EngineHourLine>();
    for (const l of inHour) {
      if (l.kind !== 'engine') continue;
      const e = engine.get(l.server_id) ?? {
        ts: hourStart,
        kind: 'engine_hour' as const,
        server_id: l.server_id,
        samples: 0,
        req_total: 0,
        idle_samples: 0,
        grants: 0,
        revoked: 0,
        tokens_out: 0,
        tokens_in: 0,
        // #62: last source seen this hour (one row = one kind, so it is
        // stable); engine token truth sums the counter deltas, null until
        // a counter-backed sample lands (distinct from a real 0).
        requests_source: l.requests_source,
        engine_tokens_in: null,
        engine_tokens_out: null,
      };
      e.samples += 1;
      if (l.req_delta !== null) e.req_total += l.req_delta;
      if (l.idle) e.idle_samples += 1;
      e.grants += l.grants;
      if (l.requests_source !== undefined) e.requests_source = l.requests_source;
      if (typeof l.tokens_in_delta === 'number') e.engine_tokens_in = (e.engine_tokens_in ?? 0) + l.tokens_in_delta;
      if (typeof l.tokens_out_delta === 'number') e.engine_tokens_out = (e.engine_tokens_out ?? 0) + l.tokens_out_delta;
      engine.set(l.server_id, e);
    }
    for (const l of inHour) {
      if (l.kind !== 'lease') continue;
      const e = engine.get(l.server_id);
      if (!e) continue;
      if (l.status === 'revoked') e.revoked += 1;
      e.tokens_out += l.tokens_out;
      e.tokens_in += l.tokens_in;
    }

    // lease_hour: per project
    const lease = new Map<string, LeaseHourLine>();
    for (const l of inHour) {
      if (l.kind !== 'lease') continue;
      const e = lease.get(l.project) ?? {
        ts: hourStart,
        kind: 'lease_hour' as const,
        project: l.project,
        leases: 0,
        finished: 0,
        revoked: 0,
        tokens_out: 0,
        tokens_in: 0,
      };
      e.leases += 1;
      if (l.status === 'finished') e.finished += 1;
      if (l.status === 'revoked') e.revoked += 1;
      e.tokens_out += l.tokens_out;
      e.tokens_in += l.tokens_in;
      lease.set(l.project, e);
    }

    // session_hour: per token
    const session = new Map<string, SessionHourLine>();
    for (const l of inHour) {
      if (l.kind !== 'session') continue;
      const e = session.get(l.token) ?? {
        ts: hourStart,
        kind: 'session_hour' as const,
        token: l.token,
        samples: 0,
        reqs_per_min_max: 0,
      };
      e.samples += 1;
      if (l.reqs_per_min > e.reqs_per_min_max) e.reqs_per_min_max = l.reqs_per_min;
      session.set(l.token, e);
    }

    const buckets = [...engine.values(), ...lease.values(), ...session.values()];
    if (buckets.length > 0) {
      const file = join(this.dir, `metrics-hour-${metricsUtcDay(hourStart)}.jsonl`);
      try {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
        appendFileSync(file, buckets.map((b) => JSON.stringify(b) + '\n').join(''));
      } catch (err) {
        this.log(`[metrics] rollup append failed (hour ${hourStart} dropped): ${err instanceof Error ? err.message : err}`);
      }
    }
    this.rotate(now);
  }

  // --- rotation (D5: whole files only, no in-place rewrite) ---------------

  rotate(now: number = Date.now()): void {
    const rawHorizon = metricsUtcDay(now - this.rawWindowHours * HOUR_MS);
    const hourHorizon = metricsUtcDay(now - this.retentionDays * DAY_MS);
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = name.match(/^metrics-(raw|hour)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const kind = m[1]!;
      const day = m[2]!;
      const horizon = kind === 'raw' ? rawHorizon : hourHorizon;
      if (day >= horizon) continue; // ISO day keys sort lexicographically
      try {
        unlinkSync(join(this.dir, name));
      } catch {
        /* a vanished file is already rotated */
      }
    }
  }

  // --- range reader (D6) ---------------------------------------------------

  /**
   * Read one series over [from, to]. `bucket: 'hour'` reads the hour files
   * (deduped: LAST line per (hour, key) wins — the idempotence contract).
   * `bucket: 'raw'` answers only inside the raw window (from is clamped).
   * Unparseable lines are skipped; missing files are an empty series.
   */
  readRange(q: { series: MetricsSeries; key?: string; from: number; to: number; bucket: MetricsBucket; now?: number }): MetricsLine[] {
    const now = q.now ?? Date.now();
    let from = q.from;
    let to = q.to;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
    if (q.bucket === 'raw') {
      from = Math.max(from, now - this.rawWindowHours * HOUR_MS);
    }

    const wantKind = q.bucket === 'hour' ? `${q.series}_hour` : q.series;
    const lines: MetricsLine[] = [];
    // Walk whole UTC days from `from` to `to` (midnight-stepped, so a
    // mid-day `from` never skips a day file).
    const startDay = metricsUtcDay(from);
    const [sy, sm, sd] = startDay.split('-').map((x) => Number.parseInt(x, 10));
    let dayMs = Date.UTC(sy!, sm! - 1, sd!);
    for (let guard = 0; dayMs <= to && guard < 500; dayMs += DAY_MS, guard++) {
      const day = metricsUtcDay(dayMs);
      const file = join(this.dir, `metrics-${q.bucket}-${day}.jsonl`);
      for (const line of this.readJsonl(file)) {
        if (line.kind !== wantKind) continue;
        if (line.ts < from || line.ts > to) continue;
        if (q.key !== undefined && seriesKeyOf(line) !== q.key) continue;
        lines.push(line);
      }
    }

    // Hour buckets: LAST line per (hour, key) wins (re-run rollup idempotence).
    let out = lines;
    if (q.bucket === 'hour') {
      const byHourKey = new Map<string, MetricsLine>();
      for (const l of lines) byHourKey.set(`${l.kind}|${l.ts}|${seriesKeyOf(l)}`, l);
      out = [...byHourKey.values()];
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /** Parse one JSONL file; skip unparseable lines; missing file = empty. */
  private readJsonl(file: string): MetricsLine[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      return [];
    }
    const out: MetricsLine[] = [];
    for (const raw of text.split('\n')) {
      const s = raw.trim();
      if (s === '') continue;
      try {
        const obj = JSON.parse(s) as MetricsLine;
        if (obj && typeof obj === 'object' && typeof obj.kind === 'string' && Number.isFinite(obj.ts)) out.push(obj);
      } catch {
        /* corrupt line: one lost sample, skip it (D5) */
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Arbiter instrumentation (D5: denials ride as counters). arbiter.ts stays
// untouched: index.ts passes this wrapper to buildApi, and every
// requestLease outcome feeds the per-engine window the sample carries.

export function instrumentArbiterForMetrics(arbiter: Arbiter, metrics: MetricsStore): Arbiter {
  return new Proxy(arbiter, {
    get(target, prop, receiver) {
      if (prop === 'requestLease') {
        return (params: Parameters<Arbiter['requestLease']>[0]) => {
          const res = target.requestLease(params);
          const serverId = params?.server_id ?? WATCHED_SERVER_ID;
          if (res.ok) metrics.noteGrant(serverId);
          else if (res.reason) metrics.noteDenial(serverId, res.reason);
          return res;
        };
      }
      if (prop === 'finishLease') {
        return (params: Parameters<Arbiter['finishLease']>[0]) => {
          const res = target.finishLease(params);
          // One lease-outcome line per lease end (D2). The dedup lives in
          // the store, so the tick's revoked list and a duplicate usage
          // report never double-append.
          if (res.ok && res.lease) metrics.recordLeaseEnd(res.lease, { score: params?.score ?? null, final: true });
          return res;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

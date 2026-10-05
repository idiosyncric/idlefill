/**
 * Provider-kind metrics samplers (#62).
 *
 * Two kinds feed request/token truth from the ENGINE instead of from
 * feed-id deltas or lease reports:
 *
 *   strata  — its /metrics JSON carries `totals` (monotonic since-boot
 *             counters: requests, prompt_tokens, output_tokens). The
 *             strata fetcher observes them on every detector poll (no
 *             extra HTTP call), and CounterDeltaTracker diffs them per
 *             sample — exactly FeedDeltaTracker's posture: first sample
 *             and backwards counters read UNKNOWN (null), never negative.
 *   omlx    — no feed, no HTTP metrics endpoint. Its usage truth is the
 *             oMLX usage store: ~/.omlx/usage.sqlite3, table
 *             model_usage_hourly (requests, prompt_tokens,
 *             completion_tokens per hour+model; column names verified
 *             against the live store 2026-10-05). The tick reads the
 *             table's cumulative SUM and diffs it per sample.
 *
 * Co-located kinds declare co-location: the sqlite store only exists on
 * the machine running oMLX. An unreachable store contributes unknown
 * deltas — never zeros (a zero would be a lie about idle-engine usage).
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineCounters } from './types.js';

/** Default oMLX usage-store path (the oMLX app's own location). */
export function defaultOmlxUsageDb(): string {
  return join(homedir(), '.omlx', 'usage.sqlite3');
}

// ---------------------------------------------------------------------------
// Counter delta (shared by strata + omlx). Mirrors FeedDeltaTracker:
// url/key -> last observed cumulative counters; the delta between
// consecutive SAMPLES (not polls) is what rides the engine sample line.

export class CounterDeltaTracker {
  /** key -> newest counters observed (any successful poll). */
  private observed = new Map<string, EngineCounters>();
  /** key -> counters at the previous sampled tick (the delta baseline). */
  private baseline = new Map<string, EngineCounters>();

  /** Record one successful counter read for a key. */
  observe(key: string, c: EngineCounters): void {
    if (!c || !Number.isFinite(c.requests)) return;
    this.observed.set(key, { requests: c.requests, tokens_in: c.tokens_in, tokens_out: c.tokens_out });
  }

  /**
   * Consume the delta since this key's previous sample. First sample and
   * backwards counters (engine restart resets the counters) read as
   * unknown (null), never negative.
   */
  delta(key: string): {
    req_delta: number | null;
    tokens_in_delta: number | null;
    tokens_out_delta: number | null;
    last: EngineCounters | null;
  } {
    const cur = this.observed.get(key);
    if (!cur) return { req_delta: null, tokens_in_delta: null, tokens_out_delta: null, last: null };
    const prev = this.baseline.get(key);
    this.baseline.set(key, cur);
    if (!prev) return { req_delta: null, tokens_in_delta: null, tokens_out_delta: null, last: cur };
    const d = (a: number, b: number): number | null => (a >= b ? a - b : null);
    return {
      req_delta: d(cur.requests, prev.requests),
      tokens_in_delta: d(cur.tokens_in, prev.tokens_in),
      tokens_out_delta: d(cur.tokens_out, prev.tokens_out),
      last: cur,
    };
  }
}

// ---------------------------------------------------------------------------
// omlx: the sqlite usage store. Read-only by construction (query_only +
// SELECT-only). node:sqlite lands in the runtimes this project targets
// (Node 22.13+ unflagged; the container runs 22.23, the Mac 26) — the
// require is lazy and failure-tolerant: an unavailable module or a
// missing file reads as unknown, it never throws into the tick.

export type UsageRowSum = EngineCounters;

export interface OmlxUsageReader {
  /** Cumulative totals across every model_usage_hourly row; null = unreachable. */
  readTotals(): UsageRowSum | null;
  /** True when the underlying file exists. */
  available(): boolean;
}

export class SqliteOmlxUsageReader implements OmlxUsageReader {
  private readonly dbPath: string;
  private db: import('node:sqlite').DatabaseSync | null = null;
  private openFailed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  private open(): import('node:sqlite').DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openFailed) return null;
    try {
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
      const db = new DatabaseSync(this.dbPath);
      // Guard against any accidental write: this store belongs to oMLX.
      db.exec('PRAGMA query_only = ON');
      db.exec('PRAGMA busy_timeout = 1000');
      this.db = db;
      return db;
    } catch {
      this.openFailed = true;
      return null;
    }
  }

  /**
   * SUM over every hourly row = since-install truth. A missing table
   * (fresh install) or an unreachable store reads null — the sampler
   * then contributes unknown, never zero.
   */
  readTotals(): UsageRowSum | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          'SELECT COALESCE(SUM(requests),0) AS requests, ' +
            'COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, ' +
            'COALESCE(SUM(completion_tokens),0) AS completion_tokens ' +
            'FROM model_usage_hourly',
        )
        .get() as Record<string, number | bigint> | undefined;
      if (!row) return null;
      const n = (v: number | bigint | undefined): number => {
        const x = typeof v === 'bigint' ? Number(v) : Number(v);
        return Number.isFinite(x) && x >= 0 ? x : 0;
      };
      return { requests: n(row.requests), tokens_in: n(row.prompt_tokens), tokens_out: n(row.completion_tokens) };
    } catch {
      return null;
    }
  }
}

/**
 * One reader per 'omlx' server row, cached by path, with a one-time boot
 * warning when the declared store is missing (the honest posture: the row
 * watches idle via log mtime and contributes no usage until the store
 * appears — an oMLX install landing later needs no arbiter change).
 */
export class OmlxUsageReaders {
  private byPath = new Map<string, SqliteOmlxUsageReader>();
  private warned = new Set<string>();
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /** The reader for a row's store path (default when unset), warned once. */
  forPath(path: string | undefined): SqliteOmlxUsageReader {
    const p = path && path.trim() !== '' ? path.trim() : defaultOmlxUsageDb();
    let r = this.byPath.get(p);
    if (!r) {
      r = new SqliteOmlxUsageReader(p);
      this.byPath.set(p, r);
    }
    // Checked on every call (cheap existsSync): a fresh oMLX install
    // self-heals — the warning fires once while missing, and re-arms if
    // the store ever disappears again.
    if (!r.available()) {
      if (!this.warned.has(p)) {
        this.warned.add(p);
        this.log(`[metrics] omlx usage store missing at ${p} — that row contributes no usage until it appears`);
      }
    } else {
      this.warned.delete(p);
    }
    return r;
  }
}

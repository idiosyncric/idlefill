/**
 * IdleDetector — fuses two idle signals:
 *
 *   1. Activity feed: GET {llama_swap_url}{activity_path} → newest-first
 *      entries for ALL clients, ALL models. The newest NON-EXEMPT entry is
 *      `last_activity`.
 *   2. Log mtime: the newest-mtime file matching `log_glob` (NInfer writes
 *      `req-*.jsonl` throughput lines every 5s while decoding, so a request
 *      that has STARTED but not COMPLETED never appears in the feed — its
 *      log mtime is the second signal). Empty `log_glob` disables it.
 *
 *   idle_for = now - max(last_activity_ts, last_log_write)
 *   idle     = idle_for >= idle_seconds AND NOT degraded
 *
 * DEGRADED: a failed/timed-out fetch keeps the last-known signals and sets
 * `signal_degraded: true`. While degraded the arbiter must NOT grant leases
 * (we can't prove idle) and must NOT revoke on stale activity either — see
 * Arbiter.tick.
 *
 * SELF-TRAFFIC EXEMPTION (the critical invariant): an activity entry whose
 * `src` matches a registered client's IP is skipped from `last_activity`
 * IF AND ONLY IF that client currently holds an ACTIVE lease. Same entry
 * after the lease finishes counts against idle. The exempt set is fed in by
 * the arbiter — the detector stays a function of (entries, exemptIps, now),
 * which is what makes the tests honest.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { ActivityEntry, IdleSignal, LastActivity } from './types.js';

/** Fetch one page of the activity feed. Injectable for tests. */
export type ActivityFetcher = (url: string) => Promise<ActivityEntry[]>;

/** Read the newest mtime (ms) matching a glob, or null. Injectable for tests. */
export type LogMtimeSource = (glob: string) => number | null;

export interface IdleDetectorOpts {
  fetchActivity: ActivityFetcher;
  logMtime: LogMtimeSource;
  llama_swap_url: string;
  activity_path: string;
  log_glob: string;
  idle_seconds: number;
  /** Abort timeout for the feed fetch. */
  fetch_timeout_ms?: number;
}

export class IdleDetector {
  private readonly o: IdleDetectorOpts;
  private lastActivity: LastActivity | null = null;
  private lastLogWrite: number | null = null;
  private degraded = false;
  private degradedReason: string | null = null;
  /** True when the previous poll was degraded and this one recovered (or vice versa). */
  degradedChanged = false;

  constructor(o: IdleDetectorOpts) {
    this.o = o;
  }

  /**
   * One poll cycle. Fetches the feed (with timeout), updates the signals,
   * and returns the idle verdict at `now`.
   *
   * @param exemptIps keys (see {@link srcKey}) of srcs currently exempt
   *   because their owner holds an active lease.
   */
  async poll(now: number, exemptIps: Set<string>): Promise<IdleSignal> {
    // --- log-mtime signal (local, cheap; independent of feed health) ---
    this.lastLogWrite = this.o.log_glob ? this.o.logMtime(this.o.log_glob) : null;

    // --- activity feed signal ---
    const url = `${this.o.llama_swap_url.replace(/\/$/, '')}${this.o.activity_path}`;
    const entries = await this.fetchFeed(url);

    if (entries === null) {
      // Fetch failed: keep last-known activity, flag degraded. Do NOT reset
      // lastActivity — a single blip must not look like "no activity ever".
      if (!this.degraded) {
        this.degradedReason = this.degradedReason ?? 'activity fetch failed';
        this.degradedChanged = true;
      }
      this.degraded = true;
    } else {
      const prevDegraded = this.degraded;
      this.degraded = false;
      this.degradedReason = null;
      if (prevDegraded) this.degradedChanged = true;

      if (entries.length > 0) {
        // Newest-first; take the first entry that is NOT exempt. Exempt
        // entries are exactly the traffic of clients holding active leases.
        // If every entry is exempt, the feed shows only backfill traffic —
        // keep the previous lastActivity (conservative: we cannot prove
        // interactive idle from a feed full of our own traffic).
        const e = entries.find((x) => !exemptIps.has(srcKey(x.src)));
        if (e) {
          this.lastActivity = {
            ts: parseTs(e.timestamp, now),
            model: e.model,
            src: e.src,
          };
        }
      }
      // Empty feed: reachable, zero entries. Keep last-known lastActivity —
      // we do not treat an empty page as "no activity ever".
    }

    return this.signal(now);
  }

  /** Current verdict without polling (uses last-known signals). */
  signal(now: number): IdleSignal {
    const lastTs = Math.max(this.lastActivity?.ts ?? 0, this.lastLogWrite ?? 0);
    const idleFor = lastTs > 0 ? now - lastTs : null;
    const idle = !this.degraded && idleFor !== null && idleFor >= this.o.idle_seconds * 1000;
    return {
      now,
      idle,
      idle_for_s: idleFor === null ? null : Math.round(idleFor / 1000),
      last_activity: this.lastActivity,
      last_log_write: this.lastLogWrite,
      signal_degraded: this.degraded,
      degraded_reason: this.degradedReason,
    };
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  // ------------------------------------------------------------------

  /** Fetch the feed with an abort timeout; null on any failure. */
  private async fetchFeed(url: string): Promise<ActivityEntry[] | null> {
    const timeout = this.o.fetch_timeout_ms ?? 10000;
    try {
      const entries = await this.o.fetchActivity(url);
      return Array.isArray(entries) ? entries : null;
    } catch {
      return null;
    }
  }
}

/**
 * Normalize an activity `src` into the canonical key used for exemption
 * matching. The llama-swap feed uses `ip:<dotted-quad>`; the client may
 * report either `1.2.3.4` or `ip:1.2.3.4`. We match on the bare IP so the
 * two formats interoperate.
 */
export function srcKey(src: string): string {
  const s = String(src ?? '').trim();
  const m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return m ? m[1]! : s.toLowerCase();
}

/** Parse an ISO8601 UTC timestamp; fall back to `now` when unparseable. */
export function parseTs(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Build the exemption set from active leases. Leases past their `expires_at`
 * no longer count as active (their traffic breaks idle again).
 */
export function activeLeaseExemptIps(
  leases: { exempt_ip: string; status: string; expires_at: number }[],
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const l of leases) {
    if (l.status === 'active' && l.expires_at > now) out.add(srcKey(l.exempt_ip));
  }
  return out;
}

/** Default (real) activity fetcher used in production. */
export function makeRealActivityFetcher(): ActivityFetcher {
  return async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`activity feed HTTP ${res.status}`);
    const body = (await res.json()) as { data?: ActivityEntry[] };
    return Array.isArray(body.data) ? body.data : [];
  };
}

/**
 * Default (real) log-mtime source: stat the files in the glob's parent dir
 * and take the newest mtime matching the glob's base name. Dependency-free
 * (node:fs only) and forgiving: an unreadable dir returns null, which
 * simply disables the log signal.
 */
export function makeRealLogMtimeSource(): LogMtimeSource {
  return (glob) => {
    try {
      const dir = dirname(glob);
      const pat = basename(glob);
      const re = new RegExp(`^${escapeRe(pat).replace(/\\\*/g, '.*')}$`);
      const files = readdirSync(dir).filter((f) => re.test(f));
      let newest: number | null = null;
      for (const f of files) {
        const m = statSync(`${dir}/${f}`).mtimeMs;
        if (newest === null || m > newest) newest = m;
      }
      return newest;
    } catch {
      return null;
    }
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

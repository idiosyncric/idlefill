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
 * FEED-OFF (#60 A1): an EMPTY `activity_path` declares the server has NO
 * activity feed (oMLX and other key-gated engines expose none). The feed
 * signal is then DISABLED — the fetch never runs, the row is NOT degraded,
 * and log mtime alone carries the verdict. This is a DECLARATION, not a
 * failure: a provider with no feed is fully watchable via log_glob. A row
 * that carries a path keeps today's behavior exactly (back-compat).
 *
 * DEGRADED: a failed/timed-out fetch (only possible when a path is
 * declared) keeps the last-known signals and sets `signal_degraded: true`.
 * While degraded the arbiter must NOT grant leases (we can't prove idle)
 * and must NOT revoke on stale activity either — see Arbiter.tick.
 *
 * FAIL-CLOSED when NO signal resolves: feed off AND the log glob matches
 * nothing (or is unset) leaves `idle_for_s: null` — never idle, same
 * posture as a degraded feed.
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
import type { ActivityEntry, EngineCounters, IdleSignal, LastActivity, ServerProvider } from './types.js';
import { PROVIDER_KINDS } from './types.js';

/** Fetch one page of the activity feed. Injectable for tests. */
export type ActivityFetcher = (url: string, auth?: string) => Promise<ActivityEntry[]>;

/**
 * Parse strata's /metrics payload into activity-feed entries (#60 B: the
 * 'strata' provider kind). strata is not llama-swap — it has no
 * `/api/metrics/activity`; its `/metrics` carries `requests[]` (finished
 * jobs: `time` = start epoch-sec, `duration_s`, `finish`), `live` (the
 * in-flight generation) and `totals.requests` (a monotonic since-boot
 * counter).
 *
 * Entry ids ride `totals.requests` so the metrics FeedDeltaTracker's
 * max-id delta stays a real REQUEST COUNT (ms-based ids would make the
 * delta meaningless). A restart resets the counter; the tracker already
 * reads a backwards id as unknown, never negative.
 *
 * src is a fixed non-IP label: strata's /metrics does not attribute a
 * request to a client, so idlefill's own lease traffic cannot be exempted
 * here. That is the conservative direction — the engine reads busy while
 * our own jobs run, never falsely idle.
 */
export const STRATA_SRC = 'strata:engine';

export function parseStrataMetrics(body: unknown): ActivityEntry[] {
  const j = (body ?? {}) as Record<string, unknown>;
  const model = String((j.engine as Record<string, unknown> | undefined)?.model ?? 'strata');
  const reqs = Array.isArray(j.requests) ? j.requests : [];
  // Engine's own clock at snapshot (epoch seconds) — the anchor for the
  // in-flight generation entry.
  const engineNow = Number(j.time);
  const total = Number((j.totals as Record<string, unknown> | undefined)?.requests);
  // The counter — not the request window — decides the id basis: with
  // totals present, ids stay a real REQUEST COUNT even when the kept
  // window is currently empty (a live generation with an empty history).
  const monotonicallyCounted = Number.isFinite(total);

  const out: ActivityEntry[] = [];
  // Newest-first, matching the feed contract the detector consumes.
  const sorted = [...reqs].sort((a, b) => Number(b?.time ?? 0) - Number(a?.time ?? 0));
  sorted.forEach((r0, i) => {
    const start = Number((r0 as Record<string, unknown>)?.time);
    if (!Number.isFinite(start)) return;
    const dur = Number((r0 as Record<string, unknown>)?.duration_s) || 0;
    // Completion time: idle means "nothing FINISHED recently", and a long
    // job's start would otherwise look stale while it runs.
    const endMs = Math.round((start + dur) * 1000);
    // id: walk backwards from the since-boot counter (newest = total).
    const id = monotonicallyCounted ? Math.max(0, Math.round(total) - i) : Math.round(start * 1000);
    out.push({
      id,
      timestamp: new Date(endMs).toISOString(),
      src: STRATA_SRC,
      model,
      req_path: '/v1/chat/completions',
      resp_status_code: (r0 as Record<string, unknown>)?.finish === 'error' ? 500 : 200,
    });
  });

  // A generation in flight IS current activity: without this, a long job
  // (minutes) would age out of `requests[]` mid-run and read as idle.
  const live = (j.live ?? {}) as Record<string, unknown>;
  const state = String(live.state ?? '').toLowerCase();
  const generating = state !== '' && state !== 'idle' && state !== 'stopped' && state !== 'none';
  if (generating && Number.isFinite(engineNow)) {
    out.unshift({
      id: monotonicallyCounted ? Math.round(total) + 1 : Math.round(engineNow * 1000),
      timestamp: new Date(Math.round(engineNow * 1000)).toISOString(),
      src: STRATA_SRC,
      model,
      req_path: '/v1/chat/completions',
      resp_status_code: 200,
    });
  }
  return out;
}

/**
 * strata's /metrics totals counters (#62) — the ENGINE's own truth, read
 * from the same payload the feed adapter parses (no extra HTTP call).
 * Field names verified against the live strata 2026-10-05:
 * totals = {since, requests, prompt_tokens, reused, output_tokens, ...}.
 * Returns null when the payload carries no usable counter (the sampler
 * then contributes unknown, never zero).
 */
export function readStrataCounters(body: unknown): EngineCounters | null {
  const j = (body ?? {}) as Record<string, unknown>;
  const t = j.totals as Record<string, unknown> | undefined;
  if (!t) return null;
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  const requests = Number(t.requests);
  if (!Number.isFinite(requests)) return null;
  return { requests, tokens_in: n(t.prompt_tokens), tokens_out: n(t.output_tokens) };
}

/**
 * Shared transport: GET + parse JSON (the auth header only rides when a
 * credential exists). Kept separate from the shape-specific parsers so
 * every provider kind reuses it.
 */
async function fetchRawJson(url: string, auth?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = 'Bearer' + ' ' + auth;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return await res.json();
}

/**
 * The 'strata' fetcher: strata has no activity feed — its /metrics JSON is
 * adapted into feed entries by parseStrataMetrics. The SAME payload also
 * carries the engine's own `totals` counters: when a `counters` observer
 * is passed, it sees them on every successful poll (no extra HTTP call).
 */
export function makeStrataActivityFetcher(counters?: (c: EngineCounters) => void): ActivityFetcher {
  return async (url, auth) => {
    const body = await fetchRawJson(url, auth);
    if (counters) {
      const c = readStrataCounters(body);
      if (c) counters(c);
    }
    return parseStrataMetrics(body);
  };
}

/**
 * Pick the real fetcher by provider kind (#60 B). Absent = 'llama-swap':
 * every pre-#60-B row behaves exactly as before. The kind selects the
 * PARSE only — the transport and the credential header are shared, and
 * the IdleDetector stays kind-agnostic (injected fakes keep working).
 * 'omlx' has NO feed at all (verified: /metrics, /api/stats 404): it
 * declares feed-off, so this returns a fetcher that never runs (the
 * detector only calls it when a path is declared — a declared path with
 * the 'omlx' kind is the operator mis-setting the row; honest failure
 * beats a silent llama-swap guess).
 */
export function makeActivityFetcherFor(provider?: ServerProvider, counters?: (c: EngineCounters) => void): ActivityFetcher {
  if (provider === 'strata') return makeStrataActivityFetcher(counters);
  return makeRealActivityFetcher();
}

/**
 * The kind's default feed posture for a row that declares no explicit
 * activity_path (#62): the kind selects the shape, path included.
 * 'omlx' has no feed — feed-off (empty path). 'strata' polls /metrics.
 */
export function defaultActivityPathFor(provider?: ServerProvider): string {
  if (provider === 'omlx') return '';
  if (provider === 'strata') return '/metrics';
  return '/api/metrics/activity';
}

/**
 * Honest fail-closed reason when a row has NO signal that can resolve
 * (#62 acceptance): a feed-less row whose log glob matches nothing, on a
 * kind with no supported HTTP or local sampler. The kind gap is named —
 * "activity fetch failed" is a lie when nothing was ever fetched.
 */
export function kindGapReason(provider: ServerProvider | undefined, knownKinds: string[]): string {
  return `no idle signal for provider kind ${provider ?? 'unknown'} (supported: ${knownKinds.join(', ')})`;
}

/** Read the newest mtime (ms) matching a glob, or null. Injectable for tests. */
export type LogMtimeSource = (glob: string) => number | null;

export interface IdleDetectorOpts {
  fetchActivity: ActivityFetcher;
  logMtime: LogMtimeSource;
  llama_swap_url: string;
  /**
   * Activity-feed path. EMPTY = the server declares NO feed (#60 A1):
   * the feed signal is disabled, not degraded.
   */
  activity_path: string;
  log_glob: string;
  idle_seconds: number;
  /**
   * Per-server credential (#60 B): passed to the fetcher so the real one
   * sends `Authorization: Bearer <token>`. Absent/empty = no header.
   */
  auth_token?: string;
  /** Abort timeout for the feed fetch. */
  fetch_timeout_ms?: number;
  /**
   * Provider kind (#62): only used to NAME the fail-closed reason when no
   * signal resolves on a feed-off row. Absent = 'llama-swap'.
   */
  provider?: ServerProvider;
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
    // A row that declares NO feed (empty activity_path, #60 A1) skips the
    // fetch entirely: no feed = no feed signal, NOT a degraded one. The
    // degrade path is reserved for a declared feed that fails.
    if (!this.feedEnabled()) {
      return this.signal(now);
    }
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
    // Honest fail-closed (#62): a feed-off row whose log glob matches
    // nothing has NO signal at all. Name the kind gap — an operator who
    // picked a co-location kind for a remote engine sees WHY the row can
    // never resolve, not a fetch that never happened.
    const noSignal =
      idleFor === null && !this.degraded && !this.feedEnabled()
        ? kindGapReason(this.o.provider, PROVIDER_KINDS)
        : null;
    return {
      now,
      idle,
      idle_for_s: idleFor === null ? null : Math.round(idleFor / 1000),
      last_activity: this.lastActivity,
      last_log_write: this.lastLogWrite,
      signal_degraded: this.degraded,
      degraded_reason: this.degradedReason,
      feed_enabled: this.feedEnabled(),
      ...(noSignal ? { no_signal_reason: noSignal } : {}),
    };
  }

  /** True when the row declares an activity feed (non-empty path, #60 A1). */
  feedEnabled(): boolean {
    return this.o.activity_path.trim() !== '';
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  // ------------------------------------------------------------------

  /** Fetch the feed with an abort timeout; null on any failure. */
  private async fetchFeed(url: string): Promise<ActivityEntry[] | null> {
    const timeout = this.o.fetch_timeout_ms ?? 10000;
    try {
      const entries = await this.o.fetchActivity(url, this.o.auth_token);
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
  return async (url, auth) => {
    const headers: Record<string, string> = {};
    // Per-server credential (#60 B): key-gated engines (oMLX) 401 the feed
    // without it. Only ever present when the operator set a row token.
    if (auth) headers.authorization = `Bearer ${auth}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
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

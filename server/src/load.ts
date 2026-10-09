/**
 * Per-engine load collector (#52 slice 1 — DATA ONLY, no verdict change).
 *
 * Reads the engine's own load surface inside the EXISTING poll tick
 * (D1: a module of the fused arbiter, not a second process):
 *   - llama-swap: GET {url}/metrics → the Prometheus GPU gauges (the
 *     `/metrics` endpoint the probe found in 2026-10-09 that idlefill
 *     never fetched); the feed's newest-entry rate rides the SAME tick
 *     (the feed fetch is already in the tick — no extra HTTP call, D5);
 *   - oMLX: GET {url}/health → identity and pool residency (D8:
 *     `/health` is identity and residency, not load — no veto for this
 *     kind, ever, in this wave);
 *   - strata: GET {url}/metrics (the JSON the feed adapter already
 *     parses, #60 B) → the single in-flight generation state
 *     (`live.state`). The D4 predicate: `live.state` not in
 *     {idle, stopped, none} means busy — no number needed.
 *
 * The busy veto (#52 slice 3, D2/D4): the reading carries `load_busy`
 * PRESENT ONLY on a FRESH read (the `stale_window_ms` window, D3).
 * A stale or missing reading is UNKNOWN — `load_busy` is absent, the
 * verdict falls back to the feed and mtime basis, and the feed-degraded
 * fail-closed plane is untouched (D2 rules 2 and 3). The predicate is
 * per kind:
 *   - strata: `live.state` (ON, needs no number);
 *   - llama-swap: `gpu_util_percent` ABOVE the owner-set
 *     `metrics_llamaswap_busy_gpu_percent` (NO default — unset means
 *     the kind has no predicate, the key stays absent, the verdict
 *     reads byte-for-byte as pre-#52);
 *   - oMLX: none (the key is always absent).
 * HARD RULE (D2 rule 1): a busy read can only DELAY a grant. It can
 * never make a busy engine read idle — the veto applies to `idle`
 * only. Failure posture (mirrors the feed fetcher): a failed read —
 * 4xx/5xx, timeout, unreachable, malformed body — yields NO reading.
 * The last good reading stays; its age grows (`load_age_s`). Absent =
 * unset, never a fake zero. A dead /metrics endpoint never degrades
 * the verdict (D2 rule 3): the collector is a separate plane from the
 * feed-degraded fail-closed.
 */

import type { ActivityEntry, ServerProvider } from './types.js';

/**
 * One captured reading (ADD keys — absent = unset). `read_at` is the
 * internal age basis; the wire exposes it as `load_age_s`. `load_busy`
 * is computed at PUBLISH time (freshness is a function of `now`), so
 * the captured reading never carries it.
 */
export interface LoadReading {
  load_source?: string;
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
  tokens_per_second?: number;
  in_flight?: number;
  /** The strata `live.state` value, verbatim (lower-cased) — the D4 busy predicate input. */
  strata_live_state?: string;
  model_loaded?: string;
  /** Best-effort quant identity parsed from `model_loaded` (D5: absent when not parseable). */
  model_quant?: string;
  omlx_loaded_count?: number;
  read_at: number;
}

/**
 * The published view of a reading: the keys above (minus `read_at` and
 * the internal `strata_live_state` basis) plus `load_age_s` (whole
 * seconds since the last successful read) and, PRESENT ONLY ON A FRESH
 * READ, `load_busy` (the D4 predicate). These are exactly the ADD keys
 * the signal block and the engine sample line carry (design doc D5:
 * the same key names on both). A stale or missing reading publishes
 * `load_age_s` (or nothing) but NEVER `load_busy` — stale is unknown,
 * unknown is absent (D2 rule 2).
 */
export interface LoadSignalView {
  load_source?: string;
  /** The D4 busy predicate on this reading — present only on a FRESH read (the `stale_window_ms` window). Absent = unknown (stale, or the kind has no predicate, or the reading carries no predicate input). */
  load_busy?: boolean;
  load_age_s?: number;
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
  tokens_per_second?: number;
  in_flight?: number;
  model_loaded?: string;
  model_quant?: string;
  omlx_loaded_count?: number;
}

/** Minimal response shape the collectors need (a real fetch Response fits). */
export interface LoadResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** Injectable transport (tests swap in fakes; production uses global fetch). */
export type LoadTransport = (
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<LoadResponseLike>;

const defaultTransport: LoadTransport = (url, opts) => fetch(url, opts);

// ---------------------------------------------------------------------------
// Parsers (pure functions of the wire text — pinned against the captured
// fixtures in the tests; the bodies are the verbatim probe captures from
// docs/reports/ISSUE52-METRIC-INVENTORY.md).

/**
 * Parse Prometheus exposition text into metric name → values. Handles
 * the two line shapes the engines expose — `name 123` and
 * `name{label="v",...} 123`. `#` comment lines (HELP/TYPE) are skipped,
 * unparseable lines are skipped (never throw), and values that do not
 * parse to a finite number are dropped (never a fake zero).
 */
export function parsePrometheusGauges(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(.+)$/);
    if (!m) continue;
    const val = Number(m[2]!.trim());
    if (!Number.isFinite(val)) continue;
    const arr = out.get(m[1]!);
    if (arr) arr.push(val);
    else out.set(m[1]!, [val]);
  }
  return out;
}

/**
 * The llama-swap `/metrics` GPU gauges (the three the design doc D5
 * names). Metric names pinned against the live capture (probe 2026-10-09,
 * inventory doc): `llamaswap_gpu_util_percent`,
 * `llamaswap_gpu_memory_used_bytes`, `llamaswap_gpu_memory_total_bytes`.
 * Returns null when NONE of the three gauges is present — a 200 body
 * that carries no recognized gauge (an engine rebuild that renamed the
 * metrics) is a failed read, not a zero-filled one.
 */
export function parseLlamaSwapMetrics(text: string): {
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
} | null {
  const g = parsePrometheusGauges(text);
  const first = (name: string): number | undefined => g.get(name)?.[0];
  const util = first('llamaswap_gpu_util_percent');
  const used = first('llamaswap_gpu_memory_used_bytes');
  const total = first('llamaswap_gpu_memory_total_bytes');
  if (util === undefined && used === undefined && total === undefined) return null;
  return {
    ...(util !== undefined ? { gpu_util_percent: util } : {}),
    ...(used !== undefined ? { gpu_mem_used_bytes: used } : {}),
    ...(total !== undefined ? { gpu_mem_total_bytes: total } : {}),
  };
}

/**
 * Best-effort quant identity from a model name (design doc D5:
 * "Best-effort parse of the quant identity... Absent when not
 * parseable"). Matches a trailing quant token: `8bit` / `4bit`,
 * `q2_0`-style suffixes, `bf16` / `fp8` / `nvfp4`. Absent when the name
 * carries no recognizable quant.
 */
export function modelQuantFromName(name: string): string | undefined {
  const m = String(name ?? '').match(/[-_.](q\d+_\d+|\d+bit|bf16|fp8|nvfp4)$/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

/**
 * The oMLX `/health` identity + residency (D8: identity and residency,
 * NOT load). Field shape verified against the live payload (probe
 * 2026-10-09, inventory doc):
 * `{status, default_model, engine_pool:{model_count, loaded_count,
 * final_ceiling, current_model_memory}, mcp}`.
 *
 * `model_loaded` is the engine's only model NAME in the payload
 * (`default_model`), published only when a model is actually resident
 * (`loaded_count > 0`): with 0 resident the payload names no loaded
 * model (D5: omlx model_loaded ABSENT when the payload carries none),
 * and `model_quant` is derived from that name when parseable.
 * Returns null when the payload carries no usable identity or
 * residency at all.
 */
export function parseOmlxHealth(body: unknown): {
  model_loaded?: string;
  model_quant?: string;
  omlx_loaded_count?: number;
} | null {
  const j = (body ?? {}) as Record<string, unknown>;
  const defaultModel =
    typeof j.default_model === 'string' && j.default_model.trim() !== '' ? j.default_model.trim() : undefined;
  const pool = j.engine_pool as Record<string, unknown> | undefined;
  const loadedCount = pool?.loaded_count;
  const resident = typeof loadedCount === 'number' && Number.isFinite(loadedCount) && loadedCount > 0;
  const count =
    typeof loadedCount === 'number' && Number.isFinite(loadedCount) && loadedCount >= 0 ? loadedCount : undefined;
  const model = resident && defaultModel !== undefined ? defaultModel : undefined;
  const quant = model !== undefined ? modelQuantFromName(model) : undefined;
  if (model === undefined && count === undefined) return null;
  return {
    ...(model !== undefined ? { model_loaded: model } : {}),
    ...(quant !== undefined ? { model_quant: quant } : {}),
    ...(count !== undefined ? { omlx_loaded_count: count } : {}),
  };
}

/**
 * The newest feed entry's engine-reported rate (#52 slice 1: the
 * llama-swap feed carries a per-entry `tokens` block with
 * `tokens_per_second`; the feed arrives newest-first). null when no
 * entry carries a rate (never a fake zero).
 */
export function newestFeedTps(entries: ActivityEntry[]): number | null {
  for (const e of entries ?? []) {
    const tps = e?.tokens?.tokens_per_second;
    if (typeof tps === 'number' && Number.isFinite(tps)) return tps;
  }
  return null;
}

/**
 * The strata `live.state` from its /metrics payload (#52 slice 3, D4:
 * the single in-flight generation slot). The SAME payload the feed
 * adapter parses (`parseStrataMetrics` reads `live.state` for the
 * in-flight activity entry) — the load read rides the collector's own
 * /metrics fetch, no second HTTP call. Returns the state verbatim
 * (lower-cased, trimmed), or null when the payload carries no usable
 * `live` object. The D4 predicate is applied at publish time: not in
 * {idle, stopped, none} means busy.
 */
export function parseStrataLoadState(body: unknown): string | null {
  const j = (body ?? {}) as Record<string, unknown>;
  const live = j.live as Record<string, unknown> | undefined;
  if (!live || typeof live !== 'object') return null;
  const state = String(live.state ?? '').trim().toLowerCase();
  return state === '' ? null : state;
}

/**
 * The D4 busy predicate, per kind, on a CAPTURED reading. Returns:
 *   true  — a fresh read fired the predicate (the engine reads busy);
 *   false — a fresh read says not busy (the engine reads not busy);
 *   null  — UNKNOWN: no predicate for the kind (oMLX: none; llama-swap:
 *           the owner's `metrics_llamaswap_busy_gpu_percent` is unset),
 *           or the predicate input is missing (a llama-swap read with
 *           no `gpu_util_percent` gauge). Unknown NEVER vetoes and
 *           NEVER un-vetoes — `load_busy` is absent (D2 rules 1 and 2).
 * A busy result can only DELAY a grant (D2 rule 1); nothing in this
 * function can make a busy engine read idle.
 */
export function loadBusyFor(
  kind: ServerProvider | undefined,
  reading: LoadReading,
  threshold?: number,
): boolean | null {
  if (kind === 'strata') {
    const state = reading.strata_live_state;
    return state === undefined ? null : state !== 'idle' && state !== 'stopped' && state !== 'none';
  }
  if (kind === 'omlx') return null; // D4: oMLX has NO veto (identity/residency, not load)
  // llama-swap (default kind, #60 B): the threshold predicate.
  const util = reading.gpu_util_percent;
  if (typeof util !== 'number' || !Number.isFinite(util)) return null; // no gauge = unknown
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return null; // knob unset = NO predicate
  return util > threshold; // ABOVE the threshold (a reading AT the number is not busy)
}

// ---------------------------------------------------------------------------
// The collector.

export interface LoadCollectorOpts {
  /** The engine's base URL (the row's `url`). */
  url: string;
  /** Provider kind. Absent = 'llama-swap' (pre-#60-B rows). */
  provider?: ServerProvider;
  /** Row credential — rides the header only when set (same family as the feed fetchers). */
  auth_token?: string;
  /** Abort timeout for the load fetch (default 10 s, the feed fetcher's timeout). */
  fetch_timeout_ms?: number;
  /**
   * The D3 freshness window in milliseconds (`metrics_load_stale_s *
   * 1000` from config). A reading older than this is UNKNOWN —
   * `load_busy` is absent. Absent = no veto (the caller has not wired
   * the window; the view still publishes the data keys).
   */
  stale_window_ms?: number;
  /**
   * The owner-set llama-swap busy threshold
   * (`metrics_llamaswap_busy_gpu_percent`). UNSET BY DESIGN (no default):
   * absent means the kind has NO busy predicate — `load_busy` is
   * absent and the verdict reads byte-for-byte as pre-#52.
   */
  llama_swap_busy_gpu_percent?: number;
  /** Injectable transport (tests). Default: global fetch. */
  transport?: LoadTransport;
}

const LLAMASWAP_SOURCE = 'llamaswap-metrics';
const OMLX_SOURCE = 'omlx-health';
const STRATA_SOURCE = 'strata-metrics';

export class LoadCollector {
  private readonly o: LoadCollectorOpts;
  /** The last good reading; null = no reading since boot. A failed read never wipes it. */
  private reading: LoadReading | null = null;

  constructor(o: LoadCollectorOpts) {
    this.o = o;
  }

  /**
   * The kind's load surface, or null when no load collector is wired
   * for the kind. Absent = the row's signal block carries no load keys
   * at all (a pre-#52 row reads unchanged).
   */
  static specFor(provider?: ServerProvider): { path: string; source: string } | null {
    if (provider === 'omlx') return { path: '/health', source: OMLX_SOURCE };
    if (provider === 'strata') return { path: '/metrics', source: STRATA_SOURCE }; // the JSON the feed adapter already parses
    return { path: '/metrics', source: LLAMASWAP_SOURCE }; // llama-swap (default kind)
  }

  /**
   * One load read, run inside the existing poll tick. Resolves to the
   * captured reading, or null when the kind has no collector or the
   * read failed. NEVER throws: a load read's failure is an empty
   * reading — it must not disturb the tick, the verdict, or the
   * feed-degraded plane.
   *
   * `feedTps` is the feed's newest-entry rate from THIS tick's feed
   * fetch (the tick already made that HTTP call; riding it keeps the
   * llama-swap rate from costing a second fetch, D5).
   */
  async read(now: number, feedTps: number | null = null): Promise<LoadReading | null> {
    const spec = LoadCollector.specFor(this.o.provider);
    if (!spec) return null; // no collector for this kind in this slice
    const url = `${String(this.o.url ?? '').replace(/\/$/, '')}${spec.path}`;
    if (!/^https?:\/\//.test(url)) return null; // a non-HTTP row cannot be probed
    const headers: Record<string, string> = {};
    if (this.o.auth_token) headers.authorization = 'Bearer ' + this.o.auth_token;
    const timeout = this.o.fetch_timeout_ms ?? 10_000;
    let res: LoadResponseLike;
    try {
      res = await (this.o.transport ?? defaultTransport)(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch {
      return null; // unreachable / timeout: no reading (the last good one stays)
    }
    if (!res.ok) return null; // 4xx/5xx: no reading
    let text: string;
    try {
      text = await res.text();
    } catch {
      return null;
    }
    let reading: LoadReading | null = null;
    try {
      if (this.o.provider === 'omlx') {
        const parsed = parseOmlxHealth(JSON.parse(text));
        if (parsed) {
          reading = { ...parsed, load_source: spec.source, read_at: now };
        }
      } else if (this.o.provider === 'strata') {
        // The strata /metrics JSON (the feed adapter's own payload): the
        // single in-flight generation state is the D4 busy input. `live`
        // absent or empty = the payload names no state → UNKNOWN (no
        // reading), never a fake idle.
        const state = parseStrataLoadState(JSON.parse(text));
        if (state !== null) {
          reading = {
            strata_live_state: state,
            // The single live slot (D5): 1 while generating, 0 otherwise.
            in_flight: state === 'idle' || state === 'stopped' || state === 'none' ? 0 : 1,
            load_source: spec.source,
            read_at: now,
          };
        }
      } else {
        const parsed = parseLlamaSwapMetrics(text);
        if (parsed) {
          reading = {
            ...parsed,
            ...(feedTps !== null ? { tokens_per_second: feedTps } : {}),
            load_source: spec.source,
            read_at: now,
          };
        } else if (feedTps !== null) {
          // The metrics endpoint answered but carried no recognized
          // gauge: the feed rate still rides (it came from the tick's
          // own successful feed fetch).
          reading = { tokens_per_second: feedTps, load_source: spec.source, read_at: now };
        }
      }
    } catch {
      return null; // malformed body: no reading, never a fake zero
    }
    if (reading) this.reading = reading;
    return reading;
  }

  /**
   * The last reading at `now`, or null = no reading since boot. The
   * age is `load_age_s` (whole seconds since the last successful read).
   *
   * The busy veto (D2/D3/D4): `load_busy` is present ONLY when the
   * reading is FRESH (age ≤ the `stale_window_ms` window, D3) AND the
   * kind's predicate answers. A stale reading is UNKNOWN — `load_busy`
   * is ABSENT (the data keys still ride, so the operator sees why), and
   * the verdict falls back to the feed and mtime basis. A reading whose
   * predicate is unknown (oMLX: no predicate; llama-swap: the knob is
   * unset; no gauge on the read) publishes NO `load_busy` either —
   * unknown never vetoes and never un-vetoes. A dead /metrics endpoint
   * never degrades the verdict (D2 rule 3): the load axis is a veto on
   * top of the feed, not part of it.
   */
  current(now: number): LoadSignalView | null {
    if (!this.reading) return null;
    const { read_at, strata_live_state, ...rest } = this.reading;
    const ageS = Math.max(0, Math.round((now - read_at) / 1000));
    const view: LoadSignalView = { ...rest, load_age_s: ageS };
    // Freshness (D3): within the window. No window configured → no veto
    // (the data keys still ride; only the arbiter wires the window).
    const windowMs = this.o.stale_window_ms;
    const fresh = typeof windowMs === 'number' && Number.isFinite(windowMs) && now - read_at <= windowMs;
    if (!fresh) return view;
    // The D4 predicate (per kind). Absent knob / no predicate input /
    // the kind has none → null → the key stays ABSENT.
    const busy = loadBusyFor(
      this.o.provider,
      this.reading,
      this.o.llama_swap_busy_gpu_percent,
    );
    if (busy !== null) view.load_busy = busy;
    return view;
  }
}

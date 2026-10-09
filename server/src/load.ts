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
 *   - strata: NO collector wired in this slice (its `live.state` veto is
 *     the D4 wave; the strata feed adapter already rides the detector's
 *     /metrics poll).
 *
 * HARD RULE: nothing here feeds the verdict. The IdleDetector's idle
 * decision is untouched, and the readings publish only as ADD keys on
 * the signal block (`/api/state` per-row `signal`) and the #51 engine
 * sample line — display and sample. D4 stays OFF: the llama-swap GPU
 * busy threshold has no owner-set number, so the gauges are captured,
 * not vetoed on.
 *
 * Failure posture (mirrors the feed fetcher): a failed read — 4xx/5xx,
 * timeout, unreachable, malformed body — yields NO reading. The last
 * good reading stays; its age grows (`load_age_s`, labelled against the
 * `metrics_load_stale_s` window — which in this wave labels age only,
 * it does not veto anything). Absent = unset, never a fake zero. A
 * dead /metrics endpoint never degrades the verdict (D2 rule 3): the
 * collector is a separate plane from the feed-degraded fail-closed.
 */

import type { ActivityEntry, ServerProvider } from './types.js';

/**
 * One captured reading (ADD keys — absent = unset). `read_at` is the
 * internal age basis; the wire exposes it as `load_age_s`.
 */
export interface LoadReading {
  load_source?: string;
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
  tokens_per_second?: number;
  in_flight?: number;
  model_loaded?: string;
  /** Best-effort quant identity parsed from `model_loaded` (D5: absent when not parseable). */
  model_quant?: string;
  omlx_loaded_count?: number;
  read_at: number;
}

/**
 * The published view of a reading: the keys above (minus `read_at`)
 * plus `load_age_s` (whole seconds since the last successful read).
 * These are exactly the ADD keys the signal block and the engine
 * sample line carry (design doc D5: the same key names on both).
 */
export interface LoadSignalView {
  load_source?: string;
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
  /** Injectable transport (tests). Default: global fetch. */
  transport?: LoadTransport;
}

const LLAMASWAP_SOURCE = 'llamaswap-metrics';
const OMLX_SOURCE = 'omlx-health';

export class LoadCollector {
  private readonly o: LoadCollectorOpts;
  /** The last good reading; null = no reading since boot. A failed read never wipes it. */
  private reading: LoadReading | null = null;

  constructor(o: LoadCollectorOpts) {
    this.o = o;
  }

  /**
   * The kind's load surface, or null when no load collector is wired
   * for the kind in this slice. Absent = the row's signal block carries
   * no load keys at all (a pre-#52 row and a strata row read unchanged).
   */
  static specFor(provider?: ServerProvider): { path: string; source: string } | null {
    if (provider === 'omlx') return { path: '/health', source: OMLX_SOURCE };
    if (provider === 'strata') return null; // the D4 wave wires strata's live.state
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
   * The last reading + its age in whole seconds at `now`; null = no
   * reading since boot. The age is LABELLED against the
   * `metrics_load_stale_s` window by the display/sample consumers —
   * in this wave it vetoes nothing (D3/D4: the veto wave builds the
   * busy predicate on top of this same reading).
   */
  current(now: number): LoadSignalView | null {
    if (!this.reading) return null;
    const { read_at, ...rest } = this.reading;
    return { ...rest, load_age_s: Math.max(0, Math.round((now - read_at) / 1000)) };
  }
}

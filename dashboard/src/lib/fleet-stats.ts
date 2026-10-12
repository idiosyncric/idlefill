// The Overview fleet stat tiles — the sparkDash concept (Fleet decode,
// Fleet power, Memory in use, Tokens today) rendered over idlefill's own
// data. Pure functions (no DOM, no fetch): the view polls /api/state for
// the load tiles and GET /api/metrics (bucket=raw) for the token tile and
// feeds the numbers in here.
//
// The repo's number discipline holds throughout (same as the LOAD axis):
// absent = unknown → the tile renders "—" with a named reason in `sub`,
// NEVER a fake zero. A stale load reading is UNKNOWN (the same
// `metrics_load_stale_s` window gates it) and never counts toward a
// fleet total. Partial coverage is named in `sub` ("2 of 3 engines"),
// never silently averaged.
import { LOAD_FRESHNESS_DEFAULT_S } from "./load-read.js";
import type { RawEngineLine, RawLeaseLine, ServerSignal, StateSnapshot } from "./api.js";

export type StatTile = {
  /** The tile value, pre-formatted; "—" when the fleet names no number. */
  value: string;
  /** The coverage/source line (why the number is what it is, or absent). */
  sub: string;
};

/** A load reading counts toward a fleet total only when it is fresh. */
function freshSignals(st: StateSnapshot): NonNullable<StateSnapshot["servers"][number]["signal"]>[] {
  const staleS = st.metrics_load_stale_s ?? LOAD_FRESHNESS_DEFAULT_S;
  const out = [];
  for (const row of st.servers ?? []) {
    const sig = row.signal;
    if (!sig || typeof sig.load_source !== "string" || sig.load_source === "") continue;
    if (typeof sig.load_age_s !== "number" || sig.load_age_s > staleS) continue;
    out.push(sig);
  }
  return out;
}

function coverage(n: number, total: number): string {
  return total === 0 ? "no inference servers" : `${n} of ${total} ${total === 1 ? "engine" : "engines"} reporting`;
}

/**
 * The three live load tiles (Fleet decode · Fleet power · Memory in use),
 * summed across the FRESH readings of the fleet's engine rows. Fixed
 * order: decode, power, memory.
 */
export function fleetLoadTiles(st: StateSnapshot): StatTile[] {
  const signals = freshSignals(st);
  const rows = (st.servers ?? []).length;

  const tps = signals
    .map((s) => s.tokens_per_second)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const decode: StatTile = {
    value: tps.length > 0 ? `${Math.round(tps.reduce((a, b) => a + b, 0))} tok/s` : "—",
    sub: tps.length > 0 ? coverage(tps.length, rows) : "no engine reports a generation rate",
  };

  const watts = signals
    .map((s) => s.gpu_power_watts)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const power: StatTile = {
    value: watts.length > 0 ? `${Math.round(watts.reduce((a, b) => a + b, 0))} W` : "—",
    sub: watts.length > 0 ? coverage(watts.length, rows) : "no engine reports GPU power draw",
  };

  const memUsed = signals
    .map((s) => s.gpu_mem_used_bytes)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const memTotal = signals
    .map((s) => s.gpu_mem_total_bytes)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const memory: StatTile = {
    value: memUsed.length > 0 ? gibfmt(memUsed.reduce((a, b) => a + b, 0)) : "—",
    sub:
      memUsed.length > 0
        ? `${coverage(memUsed.length, rows)} · of ${memTotal.length > 0 ? gibfmt(memTotal.reduce((a, b) => a + b, 0)) : "unknown capacity"}`
        : "no engine reports GPU memory",
  };

  return [decode, power, memory];
}

/**
 * The Tokens today tile. Engine-reported counter deltas (the raw engine
 * lines' `tokens_out_delta`) win when the fleet's kinds publish them;
 * otherwise the lease-reported totals (finished lease lines + the live
 * tokens_out of the running leases). `fromTs` is the start of the local
 * day. Absent on both sources → "—", never a fake zero.
 */
export function tokensTodayTile(
  engineLines: RawEngineLine[],
  leaseLines: RawLeaseLine[],
  activeLeases: { tokens_out: number }[],
  fromTs: number,
): StatTile {
  const eng = engineLines.filter((l) => l.ts >= fromTs && typeof l.tokens_out_delta === "number");
  if (eng.length > 0) {
    const sum = eng.reduce((a, l) => a + (l.tokens_out_delta ?? 0), 0);
    return { value: compact(sum), sub: "engine-reported · since local midnight" };
  }
  const ended = leaseLines.filter((l) => l.ts >= fromTs);
  const live = activeLeases.reduce((a, l) => a + (typeof l.tokens_out === "number" ? l.tokens_out : 0), 0);
  const sum = ended.reduce((a, l) => a + (l.tokens_out || 0), 0) + live;
  if (ended.length === 0 && live === 0) {
    return { value: "—", sub: "no tokens recorded today" };
  }
  return { value: compact(sum), sub: "lease-reported · since local midnight" };
}

/**
 * The per-engine Overview card's gauges (the sparkDash per-host card).
 * The whole load reading is reported as-is — stale rows INCLUDED, flagged
 * via `stale` (unlike the fleet tiles, which drop stale readings from the
 * sum: the card shows the last-known truth, dimmed). No load axis at all
 * (no load_source) → null: the card renders the verdict word only.
 */
export type EngineGauges = {
  source: string;
  stale: boolean;
  ageS: number | null;
  util?: number;
  watts?: number;
  tps?: number;
  model?: string;
  quant?: string;
  memUsed?: number;
  memTotal?: number;
  failReason?: string;
};

export function engineGauges(sig: ServerSignal | null | undefined, staleS: number): EngineGauges | null {
  if (!sig || typeof sig.load_source !== "string" || sig.load_source === "") {
    // No reading, but a named auth/read failure is worth its line.
    return sig?.load_fail_reason ? { source: "", stale: false, ageS: null, failReason: sig.load_fail_reason } : null;
  }
  const ageS = typeof sig.load_age_s === "number" ? sig.load_age_s : null;
  const num = (v: number | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    source: sig.load_source,
    stale: ageS !== null && ageS > staleS,
    ageS,
    util: num(sig.gpu_util_percent),
    watts: num(sig.gpu_power_watts),
    tps: num(sig.tokens_per_second),
    ...(typeof sig.model_loaded === "string" && sig.model_loaded !== "" ? { model: sig.model_loaded } : {}),
    ...(typeof sig.model_quant === "string" && sig.model_quant !== "" ? { quant: sig.model_quant } : {}),
    memUsed: num(sig.gpu_mem_used_bytes),
    memTotal: num(sig.gpu_mem_total_bytes),
    ...(sig.load_fail_reason ? { failReason: sig.load_fail_reason } : {}),
  };
}

// 30.4 GiB (one decimal under 100, none above — the tile line stays one
// word).
export function gibfmt(bytes: number): string {
  const gi = bytes / 2 ** 30;
  return `${gi < 100 ? +gi.toFixed(1) : Math.round(gi)} GiB`;
}

// 1.2M / 847K — the tile value stays one word.
export function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

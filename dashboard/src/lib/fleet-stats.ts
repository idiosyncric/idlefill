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
 * The live load tiles (Fleet decode · Fleet power · Memory in use ·
 * System RAM), summed across the FRESH readings of the fleet's engine
 * rows. Fixed order: decode, power, GPU memory, host RAM. System RAM is
 * the engine HOST's own gauge (llama-swap `llamaswap_memory_*`, strata
 * `hardware.ram_*`) — host-level, never a per-process figure; oMLX
 * reports no host gauge (its model-pool RAM rides the per-engine card).
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

  const hostUsed = signals
    .map((s) => s.host_mem_used_bytes)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const hostTotal = signals
    .map((s) => s.host_mem_total_bytes)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const ram: StatTile = {
    value: hostUsed.length > 0 ? gibfmt(hostUsed.reduce((a, b) => a + b, 0)) : "—",
    sub:
      hostUsed.length > 0
        ? `${coverage(hostUsed.length, rows)} · of ${hostTotal.length > 0 ? gibfmt(hostTotal.reduce((a, b) => a + b, 0)) : "unknown capacity"}`
        : "no engine reports host RAM",
  };

  return [decode, power, memory, ram];
}

/**
 * The Tokens today tile — three figures in a fixed order: prompt
 * processed · cache-read · decoded (`tokens_in_delta`,
 * `tokens_cached_delta`, `tokens_out_delta`), absent axes simply drop
 * from the value and the `sub` names why. Engine-reported counter deltas
 * win when the fleet's kinds publish them; otherwise the lease-reported
 * totals (finished lease lines + the live counters of the running
 * leases) — the leases name no cache counter, so the cache axis drops on
 * that source. `fromTs` is the start of the local day. Absent on both
 * sources → "—", never a fake zero.
 */
export function tokensTodayTile(
  engineLines: RawEngineLine[],
  leaseLines: RawLeaseLine[],
  activeLeases: { tokens_out: number; tokens_in?: number }[],
  fromTs: number,
): StatTile {
  const eng = engineLines.filter((l) => l.ts >= fromTs && typeof l.tokens_out_delta === "number");
  if (eng.length > 0) {
    const sumOf = (pick: (l: RawEngineLine) => number | null | undefined): number | null => {
      const vals = eng.map(pick).filter((v): v is number => typeof v === "number");
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const prompt = sumOf((l) => l.tokens_in_delta);
    const cached = sumOf((l) => l.tokens_cached_delta);
    const decoded = sumOf((l) => l.tokens_out_delta) ?? 0;
    const figures = [prompt, cached, decoded].filter((v): v is number => v !== null);
    const legend = [prompt !== null ? "in" : null, cached !== null ? "cached" : null, "out"].filter(Boolean).join(" · ");
    return {
      value: figures.map(compact).join(" · "),
      sub:
        `engine-reported · ${legend} · since local midnight` +
        (cached === null ? " · cache reads not reported" : ""),
    };
  }
  const ended = leaseLines.filter((l) => l.ts >= fromTs);
  const sumLease = (pick: (l: RawLeaseLine) => number | null | undefined): number | null => {
    const vals = ended.map(pick).filter((v): v is number => typeof v === "number");
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const liveOut = activeLeases.reduce((a, l) => a + (typeof l.tokens_out === "number" ? l.tokens_out : 0), 0);
  const liveIn = activeLeases.reduce((a, l) => a + (typeof l.tokens_in === "number" ? l.tokens_in : 0), 0);
  const endedOut = sumLease((l) => l.tokens_out);
  const endedIn = sumLease((l) => l.tokens_in);
  const decoded = endedOut === null && liveOut === 0 ? null : (endedOut ?? 0) + liveOut;
  const prompt = endedIn === null && liveIn === 0 ? null : (endedIn ?? 0) + liveIn;
  const figures = [prompt, decoded].filter((v): v is number => v !== null);
  if (figures.length === 0) {
    return { value: "—", sub: "no tokens recorded today" };
  }
  const legend = [prompt !== null ? "in" : null, decoded !== null ? "out" : null].filter(Boolean).join(" · ");
  return {
    value: figures.map(compact).join(" · "),
    sub: `lease-reported · ${legend} · since local midnight · cache reads not reported`,
  };
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
  hostMemUsed?: number;
  hostMemTotal?: number;
  modelMemUsed?: number;
  modelMemMax?: number;
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
    hostMemUsed: num(sig.host_mem_used_bytes),
    hostMemTotal: num(sig.host_mem_total_bytes),
    modelMemUsed: num(sig.model_mem_used_bytes),
    modelMemMax: num(sig.model_mem_max_bytes),
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

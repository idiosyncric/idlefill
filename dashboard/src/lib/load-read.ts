// The engine load read (issue #52 slice 2 — the LOAD axis). A measurement,
// shown beside (never merged with) the idle verdict word on the
// InferenceServers cards. Two-axes pattern (engine-health-routing.md D5):
// the idle word is the verdict, the load read is the measurement.
//
// Exception-only: a read is present only when the arbiter names a source
// (`load_source`). Absent → this returns null → the view renders nothing.
// Never a fake zero, never "n/a" noise. A stale read (load_age_s above the
// configured freshness window) renders dimmed — the value still shows, it
// just ages.
import type { ServerSignal } from "./api";

export type LoadRead = {
  /** The source label (the value the arbiter set: llamaswap-metrics, …). */
  source: string;
  /** The measurement parts, present only when the key is present. */
  parts: string[];
  /** True when load_age_s exceeds the configured freshness window. */
  stale: boolean;
};

// Mirror of the arbiter's metrics_load_stale_s default (server/src/config.ts).
// The dashboard is static; when an older arbiter does not publish the window
// on /api/state, the view falls back to this.
export const LOAD_FRESHNESS_DEFAULT_S = 45;

/**
 * Build the compact load read from a row's signal, or null when the row has
 * no read (absent → render nothing). Pure — the view renders `null` as
 * "nothing" and a non-null result as the source label + its parts. Only the
 * keys that are present become parts (no fake zero, no "n/a" noise).
 */
export function loadRead(sig: ServerSignal | null | undefined, staleS: number): LoadRead | null {
  if (!sig) return null;
  const source = sig.load_source;
  if (typeof source !== "string" || source === "") return null; // absent → nothing
  const parts: string[] = [];
  if (typeof sig.gpu_util_percent === "number") parts.push(`gpu ${Math.round(sig.gpu_util_percent)}%`);
  if (typeof sig.tokens_per_second === "number") parts.push(`${Math.round(sig.tokens_per_second)} tok/s`);
  if (typeof sig.model_loaded === "string" && sig.model_loaded !== "") parts.push(sig.model_loaded);
  const age = typeof sig.load_age_s === "number" ? sig.load_age_s : null;
  const stale = age !== null && age > staleS;
  return { source, parts, stale };
}

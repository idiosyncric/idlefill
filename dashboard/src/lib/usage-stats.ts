// The Usage tab tiles — the sparkDash headline discipline over the metrics
// retention store: Requests · Tokens out · Idle share, all over the same
// window the charts draw (last 7 days). Pure (no DOM): the view feeds the
// two /api/metrics series sets in. Honesty rules as everywhere — a series
// set that is EMPTY is absent ("—" naming why), never a confident 0; a
// series that exists with all-zero points is a true 0. Token truth names
// its source: engine counters beat lease reports, and when the number came
// from leases the sub says so.
import { fmt } from "./format.js";
import type { StatTile } from "./fleet-stats.js";
import type { MetricsSeries } from "./api.js";

export type UsageTile = StatTile;

/** The three Usage tiles. Fixed order: requests, tokens out, idle share. */
export function usageTiles(engKeys: MetricsSeries, leaseKeys: MetricsSeries): StatTile[] {
  const engPoints = engKeys.flatMap((s) => s.points);
  const leasePoints = leaseKeys.flatMap((s) => s.points);

  const reqs = engPoints.reduce((a, p) => a + (p.req_total ?? 0), 0);
  const requestsTile: StatTile = {
    value: engPoints.length ? fmt(reqs) : "—",
    sub: engPoints.length ? "requests the engines served · 7 days" : "the metrics store has no engine series yet",
  };

  const engineTok = engPoints.reduce((a, p) => a + (p.engine_tokens_out ?? 0), 0);
  const leaseTok = leasePoints.reduce((a, p) => a + (p.tokens_out ?? 0), 0);
  const engineBacked = engPoints.some((p) => typeof p.engine_tokens_out === "number" && p.engine_tokens_out > 0);
  const tokensTile: StatTile = {
    value: engineBacked ? fmt(engineTok) : leaseTok > 0 ? fmt(leaseTok) : "—",
    sub: engineBacked
      ? "engine-reported output tokens · 7 days"
      : leaseTok > 0
        ? "lease-reported — the engines publish no token counters"
        : "no token counters in the last 7 days",
  };

  const sampled = engPoints.filter((p) => (p.samples ?? 0) > 0);
  const share = sampled.reduce((a, p) => a + (p.idle_samples ?? 0), 0) / (sampled.reduce((a, p) => a + (p.samples ?? 0), 0) || 1);
  const idleTile: StatTile = {
    value: sampled.length ? `${Math.round(share * 100)}%` : "—",
    sub: sampled.length ? "share of sampled time idle · 7 days" : "no idle samples in the last 7 days",
  };

  return [requestsTile, tokensTile, idleTile];
}

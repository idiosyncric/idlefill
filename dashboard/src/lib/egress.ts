/**
 * Egress self-diagnosis — pure render helpers for the `egress_failures`
 * block a client publishes about its OWN forwarding sockets (the
 * 2026-10-18 firewall-blindness fix: every dashboard tile stayed green
 * while the machine's outbound was silently denied, because engine rows
 * are green from the ENGINES' registrations and the client said nothing).
 *
 * Same discipline as mesh-stats.ts: pure functions, published data in,
 * StateWord out; nothing here fetches, derives beyond AGE, or guesses.
 */

import { ago, type StateWord } from "./format.js";

export type EgressFailure = {
  server_id: string;
  code: string;
  host: string;
  at: number;
};

/**
 * The badge word for one client's egress ledger: null = nothing to say
 * (no key, or every entry aged past the client's own 15-min window — the
 * client ages its ledger too, so a stale-in-state entry is not a live
 * exception). `err` when the freshest failure is inside 60 s (the client
 * is failing RIGHT NOW); `warn` beyond that (recent, possibly recovering —
 * the next successful forward clears the row at the client).
 */
export function egressWord(failures: EgressFailure[] | undefined, now: number): StateWord | null {
  const live = egressLive(failures, now);
  if (live.length === 0) return null;
  const freshest = Math.min(...live.map((f) => now - f.at));
  const label = "egress blocked";
  return {
    label,
    tone: freshest <= 60_000 ? "err" : "warn",
    note: `${live.length} ${live.length === 1 ? "engine row" : "engine rows"} unreachable FROM THIS MACHINE (the machine's own forwarding sockets, not the engines' reports): ${egressLine(live, now)} — a firewall or route problem local to this machine fits EACCES/EHOSTUNREACH; run the egress self-test (Settings) to confirm per row`,
  };
}

/** Live entries: aged to the client's publish window (EGRESS_FAILURE_TTL_MS
 *  client-side = 15 min). Entries older than that are the arbiter having
 *  missed the clear heartbeat — render nothing, not a stale alarm. */
export function egressLive(failures: EgressFailure[] | undefined, now: number): EgressFailure[] {
  if (!failures || failures.length === 0) return [];
  return failures.filter((f) => now - f.at <= 15 * 60_000);
}

/** The one-line per-row summary: `srv-x EHOSTUNREACH (12s ago) · srv-y …` */
export function egressLine(failures: EgressFailure[] | undefined, now: number): string {
  return egressLive(failures, now)
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((f) => `${f.server_id} ${f.code} (${ago(now - f.at)})`)
    .join(" · ");
}

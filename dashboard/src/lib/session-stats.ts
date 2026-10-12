// The Sessions tab tiles — the Overview/sparkDash discipline applied to
// the interactive sessions: Sessions · At the gate · Paused · Stale.
// Pure functions (no DOM): the view feeds /api/state's sessions rows in.
// The counting rules are the ROW rules from lib/format.ts (the 30s active
// window, the 90s heartbeat, the override precedence) — the tiles and the
// row words can never disagree. A count over REGISTERED rows is a direct
// truth (0 renders 0 — unlike the fleet tiles, there is no "absent" here:
// every row is a row). Absent of rows entirely = the sub names why.
import { minSec, sessStateWord, sessStale } from "./format.js";
import type { StatTile } from "./fleet-stats.js";
import type { SessionRow } from "./api.js";

/** The four Sessions tiles. Fixed order: registered, gate, override, liveness. */
export function sessionTiles(sessions: SessionRow[], now: number): StatTile[] {
  const n = sessions.length;
  let active = 0;
  let paused = 0;
  let queued = 0;
  let oldestHoldS: number | null = null;
  for (const s of sessions) {
    const w = sessStateWord(s, now);
    if (w.label === "Active") active += 1;
    if (w.label === "Paused") paused += 1;
    if (s.gate?.state === "queued") {
      queued += 1;
      if (s.gate.waitSince != null) {
        const held = Math.max(0, now - s.gate.waitSince);
        if (oldestHoldS === null || held > oldestHoldS) oldestHoldS = held;
      }
    }
  }
  const stale = sessions.filter((s) => sessStale(s, now)).length;

  const sessionsTile: StatTile = {
    value: String(n),
    sub:
      n === 0
        ? "no sessions registered — a router registers one on its first request"
        : `${active} active · ${n - paused - active} idle${stale > 0 ? ` · ${stale} stale` : ""}`,
  };

  const gate: StatTile = {
    value: String(queued),
    sub:
      queued > 0
        ? `held behind another session${oldestHoldS !== null ? ` · longest hold ${minSec(oldestHoldS / 1000)}` : ""}`
        : "no session held at the gate",
  };

  const pausedTile: StatTile = {
    value: String(paused),
    sub: paused > 0 ? "operator override — the router holds this traffic" : "no operator pauses",
  };

  const staleTile: StatTile = {
    value: String(stale),
    sub: stale > 0 ? "no heartbeat in 90 s — the router may have dropped the row" : "every row answered recently",
  };

  return [sessionsTile, gate, pausedTile, staleTile];
}

// The Projects tab tiles — the sparkDash headline row for the queue side:
// Queued · Running · Throttled · Finished today. Pure functions (no DOM):
// the view feeds /api/state in. These counts are DIRECT over arbiter
// truth (a queue depth the worker published, a lease the arbiter holds) —
// 0 renders 0, the sub names why. Coverage (workers online) rides the
// Queued sub: a deep queue behind zero online workers is not a working
// queue.
import { fmt } from "./format.js";
import type { StatTile } from "./fleet-stats.js";
import type { StateSnapshot } from "./api.js";

/** The four Projects tiles. Fixed order: queued, running, throttled, today. */
export function projectTiles(st: StateSnapshot): StatTile[] {
  const projects = st.projects ?? [];
  const workers = projects.flatMap((p) => p.workers ?? []);
  const queued = workers.reduce((a, w) => a + (w.queue_depth || 0), 0);
  const online = workers.filter((w) => w.online).length;

  const queuedTile: StatTile = {
    value: fmt(queued),
    sub:
      workers.length > 0
        ? `${online} of ${workers.length} ${workers.length === 1 ? "worker" : "workers"} online`
        : "no workers connected for any project",
  };

  const running = (st.active_leases ?? []).length;
  const runningTile: StatTile = {
    value: String(running),
    sub: running > 0 ? "leases running now" : "nothing running",
  };

  const throttled = (st.throttled_jobs ?? []).length;
  const throttledTile: StatTile = {
    value: String(throttled),
    sub: throttled > 0 ? "no new grants while throttled — unthrottle from the Overview" : "nothing throttled",
  };

  const finished = projects.reduce((a, p) => a + (p.today?.finished ?? 0), 0);
  const failed = projects.reduce((a, p) => a + (p.today?.failed ?? 0), 0);
  const today: StatTile = {
    value: fmt(finished),
    sub: failed > 0 ? `${failed} failed today` : "no failures today",
  };

  return [queuedTile, runningTile, throttledTile, today];
}

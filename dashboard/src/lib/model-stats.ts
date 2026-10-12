// The Models tab tiles — the sparkDash headline row over the PUBLISHED
// routing truth (the winner-only block of /api/state, no token needed):
// Aliases · Routing · Re-routed · Default. Pure functions (no DOM).
// The authoring rows (GET /api/aliases) are token-gated and may be empty
// while these published winners stand — the tiles read what the ROUTER
// answers, the same truth every agent sees. Re-routed is the exception
// axis: a dead pin or group block moved traffic to the next-best pair.
import type { StatTile } from "./fleet-stats.js";
import type { StateSnapshot } from "./api.js";

/** The four Models tiles. Fixed order: published, routing health, fallback, default. */
export function modelTiles(st: StateSnapshot): StatTile[] {
  const published = st.model_aliases ?? [];
  const n = published.length;

  const aliases: StatTile = {
    value: n > 0 ? String(n) : "—",
    sub: n > 0 ? "operator aliases with a resolved winner this tick" : "no alias resolves — bare model names route",
  };

  const probed = published.filter((m) => m.catalog_source === "probed").length;
  const routing: StatTile =
    n > 0
      ? { value: `${probed} of ${n}`, sub: "the winner's engine answered /v1/models this tick — the routing green" }
      : { value: "—", sub: aliases.sub };

  const rerouted = published.filter((m) => m.fallback === true).length;
  const fallback: StatTile = {
    value: String(rerouted),
    sub:
      rerouted > 0
        ? "a dead pin or group block moved traffic to the next-best pair"
        : "every winner is its stored pin (or the first pair)",
  };

  const first = published[0];
  const firstAlias = first ? first.name : null;
  const truncated = firstAlias !== null && firstAlias.length > 18 ? `${firstAlias.slice(0, 17)}…` : firstAlias;
  const def: StatTile = {
    value: truncated ?? "—",
    sub: first ? "the top alias — the name /v1/models leads with" : "no default advertised",
  };

  return [aliases, routing, fallback, def];
}

// The Agents tab tiles — the sparkDash headline row for the credential
// plane: Agent keys · Profiles adopted. Pure functions (no DOM): the view
// feeds its token-gated authoring reads in.
//
// The honesty rule here is the FETCH axis, not the number axis: the key
// list is token-gated, so before a token is pasted the count is UNKNOWN
// (null), and the tile renders "—" naming that — never the misleading 0
// of a list that was never fetched. The roster follows the card's rule:
// absent = no online client reported a Hermes home (the card hides, the
// tile says why), never an empty list pretending to be truth.
import type { StatTile } from "./fleet-stats.js";
import type { AgentKeyRow, AgentRosterRow } from "./api.js";

/**
 * @param keyCount minted key count, or null while the key list has never
 *   been fetched (no token yet on this page).
 * @param roster the local Hermes profile roster, or null when no online
 *   client reported one.
 */
export function agentTiles(keyCount: number | null, roster: AgentRosterRow[] | null): StatTile[] {
  const keys: StatTile =
    keyCount === null
      ? { value: "—", sub: "the key list is token-gated — paste the arbiter token" }
      : keyCount === 0
        ? { value: "0", sub: "none minted — the endpoint accepts any caller on this machine" }
        : { value: String(keyCount), sub: "agent-inference credentials for the aggregate endpoint" };

  const rows = roster ?? [];
  const adopted = rows.filter((r) => r.posture === "adopted").length;
  const profiles: StatTile =
    rows.length > 0
      ? { value: `${adopted} of ${rows.length}`, sub: "Hermes profiles on this machine routing through idlefill" }
      : { value: "—", sub: "no Hermes roster reported — an online client with a Hermes home fills this in" };

  return [keys, profiles];
}

/** The roster join the card already does (EXACT profile-name = key-label
 *  match, never fuzzy) — exposed pure so the tile test pins the same rule. */
export function mintedLabelSet(keys: AgentKeyRow[]): Set<string> {
  return new Set(keys.map((k) => k.label));
}

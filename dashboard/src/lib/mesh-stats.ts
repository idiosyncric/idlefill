// The Machines tab tiles — the Overview discipline (lib/fleet-stats.ts)
// applied to the mesh: the headline numbers across the configured peer
// instances (Peers online · Queued across mesh · Running across mesh ·
// Engines idle). Pure functions (no DOM): the view feeds /api/state's
// mesh.peers rows in.
//
// The freshness rule mirrors the arbiter's own: a peer snapshot counts
// toward a mesh total only while the peer is FRESH — its last successful
// pull inside the stale window (server/src/mesh.ts PEER_STALE_MS, mirrored
// as MESH_PEER_STALE_S). An offline peer's snapshot is the last-known
// truth: it dims its card, but never counts toward a total (same rule as a
// stale load reading on the fleet tiles). Absent = "—" with the reason
// named, partial coverage named ("2 of 3 peers reporting"), never a fake
// zero — a peer that never answered is not a machine with an empty queue.
import { ago, liveWord, type StateWord } from "./format.js";
import type { StatTile } from "./fleet-stats.js";
import type { MeshPeer, MeshPeerSnapshot } from "./api.js";

/** Mirror of the arbiter's PEER_STALE_MS (server/src/mesh.ts): the pull window that gates a snapshot. */
export const MESH_PEER_STALE_S = 90;

/** A peer snapshot counts toward a mesh total only while the peer is fresh (online inside the window). */
export function freshPeers(peers: MeshPeer[]): MeshPeer[] {
  return peers.filter((p) => p.online && p.snapshot !== null && p.snapshot !== undefined);
}

/**
 * The peer card's verdict word — the activity axis over the peer's own
 * engines and leases (the presence axis is the dot, shown separately,
 * exactly like the engine card's routing dot). A stale snapshot's word is
 * the last-known truth: the VIEW dims it and labels it, the word itself
 * never invents a state the peer never reported. No snapshot = no word.
 */
export function peerVerdict(snap: MeshPeerSnapshot | null): StateWord {
  if (!snap) {
    return { label: "no data", tone: "dim", note: "no snapshot yet — the first successful pull fills this in" };
  }
  return liveWord(
    {
      idle: snap.servers.every((s) => s.idle && !s.degraded),
      degraded: snap.servers.some((s) => s.degraded),
    },
    snap.active_leases > 0,
  );
}

/**
 * The four mesh tiles. Fixed order: presence, queue, running, engines.
 * Presence reads every configured peer (a failed pull is a fact about it);
 * the three count tiles sum the FRESH snapshots only and name the coverage.
 */
export function meshTiles(peers: MeshPeer[]): StatTile[] {
  const total = peers.length;
  const fresh = freshPeers(peers);
  const coverage = `${fresh.length} of ${total} ${total === 1 ? "peer" : "peers"} reporting`;
  const noSnapshot: StatTile = { value: "—", sub: "no fresh peer snapshot — offline or failing pulls" };

  const online = peers.filter((p) => p.online).length;
  const pulls = peers.map((p) => p.fetch_age_s).filter((x): x is number => typeof x === "number");
  const presence: StatTile = {
    value: `${online} of ${total}`,
    sub: pulls.length === 0 ? "no pull has succeeded yet" : `last pull ${ago(Math.min(...pulls) * 1000)}`,
  };

  const queue: StatTile =
    fresh.length > 0
      ? { value: fresh.reduce((a, p) => a + p.snapshot!.queue_depth, 0).toLocaleString(), sub: coverage }
      : noSnapshot;

  const running: StatTile =
    fresh.length > 0
      ? { value: String(fresh.reduce((a, p) => a + p.snapshot!.active_leases, 0)), sub: coverage }
      : noSnapshot;

  const engines = fresh.flatMap((p) => p.snapshot!.servers);
  const idleEngines = engines.filter((s) => s.idle && !s.degraded).length;
  const degradedEngines = engines.filter((s) => s.degraded).length;
  const enginesTile: StatTile =
    engines.length > 0
      ? {
          value: `${idleEngines} of ${engines.length}`,
          sub: `${coverage}${degradedEngines > 0 ? ` · ${degradedEngines} degraded` : ""}`,
        }
      : { value: "—", sub: fresh.length > 0 ? "no peer reports engines" : noSnapshot.sub };

  return [presence, queue, running, enginesTile];
}

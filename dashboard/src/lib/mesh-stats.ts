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
import type { HostStats, MeshPeer, MeshPeerSnapshot, UpdateIntent } from "./api.js";

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

/**
 * The coarse host line (the htop-equivalent slice): load 1m/5m · mem
 * used/total GiB · uptime — rendered ONLY from the keys the host actually
 * reported (per-key absent, per the server's collector). null = the block
 * names nothing renderable: the card shows NO line, never a fake zero and
 * never a bare "—". A peer's numbers are what THAT machine's arbiter
 * saw of its own host (host-wide even inside its container).
 */
export function hostLine(h: HostStats | null | undefined): string | null {
  if (!h) return null;
  const parts: string[] = [];
  const load = (v: number): string => (v >= 10 ? String(Math.round(v)) : String(+v.toFixed(1)));
  if (h.load1 !== undefined) {
    parts.push(`load ${h.load1 >= 10 ? Math.round(h.load1) : +h.load1.toFixed(1)}${h.load5 !== undefined ? `/${load(h.load5)}` : ""}`);
  }
  const gib = (b: number): string => {
    const gi = b / 2 ** 30;
    return gi < 100 ? gi.toFixed(1) : String(Math.round(gi));
  };
  if (h.mem_total_bytes !== undefined) {
    const used = h.mem_free_bytes !== undefined ? h.mem_total_bytes - h.mem_free_bytes : undefined;
    if (used !== undefined && used >= 0) parts.push(`mem ${gib(used)}/${gib(h.mem_total_bytes)} GiB`);
    else parts.push(`mem ${gib(h.mem_total_bytes)} GiB total`);
  }
  if (h.uptime_s !== undefined) {
    const d = Math.floor(h.uptime_s / 86_400);
    const hh = Math.floor((h.uptime_s % 86_400) / 3600);
    const mm = Math.floor((h.uptime_s % 3600) / 60);
    parts.push(d > 0 ? `up ${d}d ${hh}h` : hh > 0 ? `up ${hh}h ${mm}m` : `up ${mm}m`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------------------
// The machine-update plane (mesh-update.md D4) — the coarse state words for
// an update intent and for a relayed update answer. Pure: the view feeds in
// the /api/state block or the relay body and renders label + tone + note.
// The words never invent progress: an unclaimed intent says WHY it is stale,
// a named denial says exactly who refused and why.
// ---------------------------------------------------------------------------

/** The intent chip's word — the TARGET-side truth as this arbiter recorded it. */
export function intentWord(it: UpdateIntent, now: number): StateWord {
  const age = it.finished_at ? ago(now - it.finished_at) : ago(now - it.requested_at);
  const detail = it.detail ? ` — ${it.detail}` : "";
  switch (it.state) {
    case "queued":
      return {
        label: "update queued",
        tone: "warn",
        note: `requested ${ago(now - it.requested_at)} ago by ${it.source_instance_id} — waiting for this machine's host updater helper to claim it (without one it goes stale at the TTL and can never execute)`,
      };
    case "running":
      return { label: "update running", tone: "accent", note: `the host helper is running this machine's own update command (claimed ${ago(now - (it.started_at ?? it.requested_at))})` };
    case "done":
      return { label: "updated", tone: "ok", note: `the host helper reported success ${age} ago${detail}` };
    case "failed":
      return { label: "update failed", tone: "err", note: `the host helper reported failure ${age} ago${detail}` };
    case "stale":
      return {
        label: "update stale",
        tone: "warn",
        note: `requested ${ago(now - it.requested_at)} ago but no host updater claimed it within the TTL — it can never execute${detail}`,
      };
  }
}

/**
 * The word for a RELAYED update answer (the button's toast): the local
 * relay passed the PEER's own status/body through. 202 = the intent queued
 * there; 409 names the live intent; anything else is the peer's named denial
 * verbatim (never smoothed over).
 */
export function relayOutcome(relay: { status: number; target: { ok?: boolean; intent_id?: string; state?: string; error?: string; hint?: string } }): StateWord {
  if (relay.status === 202) {
    return {
      label: "update queued",
      tone: "ok",
      note: `the peer created intent ${relay.target.intent_id ?? "?"} — its host updater helper claims it; without one the intent goes stale at 300 s`,
    };
  }
  if (relay.status === 409) {
    return {
      label: "update in flight",
      tone: "warn",
      note: `the peer already has a live intent (${relay.target.intent_id ?? "?"}) — wait for it to finish or go stale`,
    };
  }
  const why = relay.target.error ?? `HTTP ${relay.status}`;
  return { label: why, tone: "err", note: relay.target.hint ?? "the peer refused the update — the answer is its own, named" };
}

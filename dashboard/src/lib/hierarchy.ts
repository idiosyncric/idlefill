// ---------------------------------------------------------------------------
// The resources hierarchy (owner ask 2026-10-12): machines host the
// inference engines, machines run the agents, agents own the sessions.
// Every join here is EXACT — a URL hostname equal to the character, a
// group label equal to the character, a provenance profile equal to the
// character. Nothing fuzzy, never a guess: an engine whose url and group
// name no machine stays UNHOSTED (rendered nowhere in the Machines tab,
// still whole on the Servers tab); a session whose ledger provenance is
// absent never nests under a profile.
//
// The three join rules for a server row's machine, in order:
//   1. loopback url (127.x / localhost / ::1)      → This Machine
//   2. url hostname === a mesh peer's url hostname → that peer (`url-host`)
//   3. server's engine group (id or label) EXACTLY equals a peer name
//      → that peer (`group-label`) — the same-host mutual-exclusion plane
//      already says which rows share a host; when its name matches a
//      machine's, that's an operator-declared hosting fact, not a hint
//   otherwise, if the arbiter declares NO peers at all: every row is this
//      machine's (one arbiter, one machine, no other candidate) — `local-only`
//   otherwise: no verdict — UNHOSTED (never guessed onto a card).
// ---------------------------------------------------------------------------

import type { ClientRow, MeshPeer, ServerRow, SessionRow, StateSnapshot } from "./api";

export const LOCAL_MACHINE = "This Machine";

/** The minimal structural state the joins read — a full StateSnapshot fits,
 *  and lean views (the Agents tab) can pass their narrower Pick. */
export type HierarchyState = Partial<
  Pick<StateSnapshot, "servers" | "clients" | "mesh" | "engine_groups" | "sessions">
>;

export type HostVia = "loopback" | "url-host" | "group-label" | "local-only";

export type HostVerdict = {
  /** The machine label (LOCAL_MACHINE or the peer's name). */
  machine: string;
  /** Which rule earned the verdict — rendered in the tooltip, naming the derivation. */
  via: HostVia;
};

/** Safe lowercase hostname of a URL (no port, no scheme). '' = unparseable. */
export function hostnameOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^\[(.*)\]$/, "$1"); // IPv6 literal, brackets off
  } catch {
    return "";
  }
}

/** The loopback family — the address the machine always holds. */
export function isLoopbackHost(h: string): boolean {
  return (
    h === "localhost" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h.startsWith("::ffff:127.")
  );
}

function peersOf(st: HierarchyState): MeshPeer[] {
  return st.mesh?.peers ?? [];
}

/** Rule set for one engine row (see the header). Null = no machine is NAMED
 *  by the row's own facts — the Machines tab never hosts it. */
export function hostOfServer(st: HierarchyState, s: ServerRow): HostVerdict | null {
  const host = hostnameOf(s.url);
  if (host && isLoopbackHost(host)) return { machine: LOCAL_MACHINE, via: "loopback" };
  const peers = peersOf(st);
  if (host) {
    for (const p of peers) {
      if (hostnameOf(p.url) !== "" && hostnameOf(p.url) === host) return { machine: p.name, via: "url-host" };
    }
  }
  if (s.group_id) {
    const g = (st.engine_groups ?? []).find((x) => x.group_id === s.group_id);
    const label = g?.name ?? s.group_id;
    if (label === LOCAL_MACHINE) return { machine: LOCAL_MACHINE, via: "group-label" };
    for (const p of peers) {
      if (p.name === s.group_id || p.name === label) return { machine: p.name, via: "group-label" };
    }
  }
  // One arbiter, no peers declared: every declared row rides this machine
  // (there is no other candidate this page knows of).
  if (peers.length === 0) return { machine: LOCAL_MACHINE, via: "local-only" };
  return null;
}

export const VIA_NOTE: Record<HostVia, string> = {
  loopback: "the row's url is loopback — it stands on the machine serving this page",
  "url-host": "the row's url hostname EXACTLY equals this machine's mesh url hostname",
  "group-label": "the row's engine-group id/label EXACTLY equals this machine's name (the operator-declared same-host plane)",
  "local-only": "this arbiter declares no mesh peers — every declared row rides this machine",
};

/** Every declared row bucketed by machine label; unhosted rows named separately. */
export function hostedServers(st: HierarchyState): { byMachine: Map<string, ServerRow[]>; unhosted: ServerRow[] } {
  const byMachine = new Map<string, ServerRow[]>();
  const unhosted: ServerRow[] = [];
  for (const s of st.servers ?? []) {
    const v = hostOfServer(st, s);
    if (!v) {
      unhosted.push(s);
      continue;
    }
    const list = byMachine.get(v.machine) ?? [];
    list.push(s);
    byMachine.set(v.machine, list);
  }
  return { byMachine, unhosted };
}

/** The machine a client daemon runs on (ip / observed_ip, EXACT host match). */
export function hostOfClient(st: HierarchyState, c: ClientRow): HostVerdict | null {
  const peers = peersOf(st);
  for (const ip of [c.ip, c.observed_ip]) {
    const h = (ip ?? "").toLowerCase();
    if (h && isLoopbackHost(h)) return { machine: LOCAL_MACHINE, via: "loopback" };
    if (h) {
      for (const p of peers) {
        if (hostnameOf(p.url) !== "" && hostnameOf(p.url) === h) return { machine: p.name, via: "url-host" };
      }
    }
  }
  if (peers.length === 0) return { machine: LOCAL_MACHINE, via: "local-only" };
  return null;
}

/** client_ids of the daemons running on THIS machine (the join the local
 *  roster uses — a session nests under a LOCAL profile only when its own
 *  client is local too). */
export function localClientIds(st: HierarchyState): string[] {
  return (st.clients ?? [])
    .filter((c) => hostOfClient(st, c)?.machine === LOCAL_MACHINE)
    .map((c) => c.client_id);
}

/** The daemons running on ONE machine (LOCAL_MACHINE or a peer name) — the
 *  hostOfClient exact join, collected. A client whose ip/observed_ip names no
 *  machine belongs to NONE of them (never distributed by guess). */
export function machineClients(st: HierarchyState, machine: string): ClientRow[] {
  return (st.clients ?? []).filter((c) => hostOfClient(st, c)?.machine === machine);
}

/**
 * Sessions grouped by their owning agent profile, EXACTLY:
 *   - the session row carries the connector's provenance stamp
 *     (`hermes_meta.profile` — which profile ledger the router read it from);
 *   - AND its `client_id` is one of the given machine's daemons.
 * A row missing either never nests — never attributed by name similarity,
 * never by the model it happens to use.
 */
export function sessionsByProfile(st: HierarchyState, clientIds: string[]): Map<string, SessionRow[]> {
  const ids = new Set(clientIds);
  const out = new Map<string, SessionRow[]>();
  for (const s of st.sessions ?? []) {
    const profile = s.hermes_meta?.profile;
    if (!profile || !s.client_id || !ids.has(s.client_id)) continue;
    const list = out.get(profile) ?? [];
    list.push(s);
    out.set(profile, list);
  }
  return out;
}

/** The Machines row's summary line — published counts only, every join EXACT.
 *  Unlike the tiles' "— with the reason" posture, a 0 HERE is the truth: the
 *  population is complete for this machine (declared rows bucketed by
 *  hostOfServer; THIS machine's clients' published rosters — rosters are what
 *  clients report, a client that publishes none contributes 0; session rows
 *  by client_id). Never a peer snapshot number — that is the peer's own
 *  report, rendered beside these in the view, never merged with them. */
export type MachineSummary = { engines: number; agents: number; sessions: number };

export function machineSummary(st: HierarchyState, machine: string): MachineSummary {
  const clients = machineClients(st, machine);
  const ids = new Set(clients.map((c) => c.client_id));
  return {
    engines: (hostedServers(st).byMachine.get(machine) ?? []).length,
    agents: clients.reduce((a, c) => a + (c.agent_roster?.length ?? 0), 0),
    sessions: (st.sessions ?? []).filter((s) => s.client_id !== undefined && ids.has(s.client_id)).length,
  };
}

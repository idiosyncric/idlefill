// ---------------------------------------------------------------------------
// mesh-graph.ts — the pure graph model behind the Mesh tab (React Flow).
// No DOM, no fetch, no React: the view maps these plain records onto
// nodes/edges; everything they need to LOOK right is decided here, from
// /api/state rows only.
//
// The hierarchy law (lib/hierarchy.ts, carried verbatim): machines host the
// engines, machines run the agents (clients), agents own the sessions.
// Every membership here is that module's EXACT join — a loopback/hostname/
// group-label verdict, never a guess. An engine row that names no machine
// stays UNHOSTED (counted in `unhosted`, rendered nowhere); a session whose
// client or engine row is absent yields NO flow edge (counted in
// `unflowed`, never anchored by name similarity).
//
// The honesty law (the load-read precedent): every field is a PUBLISHED
// fact or null/absent — never a fake zero. Peer snapshot numbers ride the
// frame ATTRIBUTED as the peer's own report (`reported`, `reportedEngines`),
// never merged with this arbiter's declared-row joins (`counts` — those
// zeros are the truth, the machineSummary rule).
//
// Flow edges reuse the Sessions flow vocabulary byte-for-byte: the engine
// edge is lib/session-edge.ts's, the pipe is lib/pipe-phases.ts's, the
// tooltip is the shared pipeTitle — the graph never says something the
// functional session row does not. Stale sessions (sessStale) are not
// flows: the graph shows LIVE traffic, the Sessions tab keeps the history.
// ---------------------------------------------------------------------------

import dagre from "@dagrejs/dagre";
import type { ClientRow, MeshPeer, ServerRow, StateSnapshot } from "./api";
import { LOCAL_MACHINE, hostedServers, machineClients, machineSummary, type MachineSummary } from "./hierarchy";
import { hostLine } from "./mesh-stats";
import { engineEdge, type EngineEdge } from "./session-edge";
import { pipeEdge, pipeTitle, type PipeEdge } from "./pipe-phases";
import { liveWord, sessStale, type StateWord } from "./format";
import { LOAD_FRESHNESS_DEFAULT_S } from "./load-read";

// --- node ids, spelled once (the view never invents its own) -------------
export const frameId = (machine: string): string => `mch:${machine}`;
export const engineNodeId = (serverId: string): string => `eng:${serverId}`;
export const agentNodeId = (clientId: string): string => `agt:${clientId}`;

// --- sizes the layout and the view share (fixed heights, no measuring) ---
export const FRAME_W = 330;
export const ENGINE_H = 100;
export const AGENT_H = 78;
export const SECTION_H = 20; // the "agents" / "engines" hairline labels
export const NODE_GAP = 12;
export const FRAME_PAD = 12;
/** The compact machine card a BROKEN-OUT machine shrinks to (its resources
 *  float as their own nodes; a dim hosts edge keeps the attribution). */
export const CHIP_W = 260;
/** The resource card width (a frame's inner width — identical whether the
 *  card rides inside its frame or floats free). */
export const CARD_W = FRAME_W - FRAME_PAD * 2;

export type MeshEngineSlot = {
  id: string;
  name: string;
  /** The machine label this row's EXACT join put it on (the card shows it
   *  as an "on <machine>" chip when the card floats free of the frame). */
  machine: string;
  word: StateWord;
  loadedModel: string | null;
  modelsTotal: number;
  modelsLoaded: number;
  /** The load axis, exception-only: null = the row never named the key. */
  gpuUtil: number | null;
  queueDepth: number | null;
  queueFresh: boolean;
  inFlight: number | null;
  tps: number | null;
  /** The load sample exceeded the freshness window — the slot dims, the value stands. */
  stale: boolean;
  watched: boolean;
};

export type MeshAgentSlot = {
  id: string;
  name: string;
  /** The machine label of the daemon's EXACT host join (see MeshEngineSlot). */
  machine: string;
  online: boolean;
  /** Sum of the client's published project queue depths (a true 0). */
  queueDepth: number;
  projects: number;
  /** Published Hermes roster size; null = the client published no roster. */
  agents: number | null;
  override: "pause" | "force" | null;
  behind: boolean;
};

export type MeshFrame = {
  id: string;
  /** The machine label: LOCAL_MACHINE or the peer's mesh name. */
  name: string;
  local: boolean;
  /** local: always true. peer: the arbiter's pull verdict. */
  online: boolean;
  /** The verdict word (peers: mesh-stats' peerVerdict posture). */
  word: StateWord;
  /** The host block: local `host` key or the peer snapshot's. */
  host: StateSnapshot["host"] | null;
  /** This arbiter's own exact joins for this machine (truth, zeros included). */
  counts: MachineSummary;
  /** The peer's own published counts, attributed, null for the local frame. */
  reported: { queued: number; sessions: number; leases: number } | null;
  /** Engines the peer REPORTS that this arbiter does not watch as a row —
   *  inventory text on the frame, never invented nodes (deduped by name
   *  against the frame's declared rows). */
  reportedEngines: { name: string; word: StateWord }[];
  version: string | null;
  /** The pull error / stale note (exception-only). */
  note: string | null;
  /** Names of the machines this one controls / is controlled by (the
   *  control EDGES ride `controls`, this is the frame's own glance line). */
  controls: string[];
  controlledBy: string[];
  engines: MeshEngineSlot[];
  agents: MeshAgentSlot[];
  /** The machine's own header block height: name row + the glance lines it
   *  actually renders (counts · host · peer-report · not-watched · control ·
   *  note). The frame places its children below it, and the BROKEN-OUT chip
   *  is exactly this tall — so the chip's bottom handle and the hosts edges
   *  line up with the real content instead of a fixed guess. */
  headerH: number;
};

export type MeshFlow = {
  id: string;
  /** agentNodeId(client) → engineNodeId(server). */
  from: string;
  to: string;
  token: string;
  shortToken: string;
  profile: string | null;
  model: string | null;
  engineName: string;
  pinned: boolean;
  /** true = the request crosses a machine boundary. */
  cross: boolean;
  edge: EngineEdge;
  pipe: PipeEdge;
  title: string;
  /** Bezier fan-out for parallel edges between the same pair. */
  curvature: number;
  offset: number;
};

export type MeshControl = {
  id: string;
  /** frameId of the CONTROLLER → frameId of the controlled (the pairing
   *  direction, `from controls to`, fleet.md D4 shape (b)). */
  from: string;
  to: string;
};

export type MeshGraph = {
  frames: MeshFrame[];
  flows: MeshFlow[];
  controls: MeshControl[];
  /** Sessions rendered as NO edge, named (never silently dropped). */
  unflowed: { noClient: number; noEngine: number; stale: number };
  /** Declared engine rows with no machine verdict (hierarchy's UNHOSTED). */
  unhosted: number;
};

const loadStaleS = (st: StateSnapshot): number => st.metrics_load_stale_s ?? LOAD_FRESHNESS_DEFAULT_S;

const nnum = (v: number | undefined | null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function engineSlot(st: StateSnapshot, s: ServerRow, machine: string): MeshEngineSlot {
  const sig = s.signal;
  const loadAge = nnum(sig?.load_age_s);
  const staleS = loadStaleS(st);
  const queueDepth = nnum(sig?.queue_depth);
  const loaded = s.models.find((m) => m.running);
  return {
    id: engineNodeId(s.id),
    name: s.name,
    machine,
    word: sig
      ? liveWord(
          { idle: !!sig.idle, degraded: !!sig.degraded },
          (nnum(sig.in_flight) ?? 0) > 0 || (queueDepth ?? 0) > 0 || s.models.some((m) => m.running),
        )
      : liveWord(null, false),
    loadedModel: loaded?.name ?? sig?.model_loaded ?? null,
    modelsTotal: s.models.length,
    modelsLoaded: s.models.filter((m) => m.running).length,
    gpuUtil: nnum(sig?.gpu_util_percent),
    queueDepth,
    queueFresh: queueDepth !== null && loadAge !== null && loadAge <= staleS,
    inFlight: nnum(sig?.in_flight),
    tps: nnum(sig?.tokens_per_second),
    stale: loadAge !== null && loadAge > staleS,
    watched: s.watched,
  };
}

function agentSlot(c: ClientRow, now: number, machine: string): MeshAgentSlot {
  return {
    id: agentNodeId(c.client_id),
    name: c.name,
    machine,
    online: now - c.last_seen < 90_000,
    queueDepth: c.projects.reduce((a, p) => a + (p.queue_depth || 0), 0),
    projects: c.projects.length,
    agents: c.agent_roster ? c.agent_roster.length : null,
    override: c.override?.override ?? null,
    behind: !!c.daemon_behind,
  };
}

function peerWord(p: MeshPeer, staleS: number): StateWord {
  if (!p.online) return { label: "offline", tone: "dim", note: "last pull failed or aged past the stale window" };
  const snap = p.snapshot;
  if (!snap) return { label: "no data", tone: "dim", note: "no snapshot yet — the first successful pull fills this in" };
  if (p.fetch_age_s !== null && p.fetch_age_s > staleS)
    return { label: "stale", tone: "warn", note: `last good pull ${Math.round(p.fetch_age_s)}s ago` };
  return liveWord(
    {
      idle: snap.servers.length > 0 && snap.servers.every((s) => s.idle && !s.degraded),
      degraded: snap.servers.some((s) => s.degraded),
    },
    snap.active_leases > 0,
  );
}

/** The full graph projection for one snapshot. Pure, deterministic. */
export function buildMeshGraph(st: StateSnapshot, now: number): MeshGraph {
  const peers = st.mesh?.peers ?? [];
  const { byMachine, unhosted } = hostedServers(st);
  const staleS = loadStaleS(st);

  const frames: MeshFrame[] = [];
  const machineNames: string[] = [LOCAL_MACHINE, ...peers.map((p) => p.name)];

  for (const machine of machineNames) {
    const peer = peers.find((p) => p.name === machine) ?? null;
    const engines = (byMachine.get(machine) ?? []).map((s) => engineSlot(st, s, machine));
    const clients = machineClients(st, machine).map((c) => agentSlot(c, now, machine));
    const declaredNames = new Set(engines.map((e) => e.name));
    const snap = peer?.snapshot ?? null;
    frames.push({
      id: frameId(machine),
      name: machine,
      local: machine === LOCAL_MACHINE,
      online: peer ? peer.online : true,
      word: peer ? peerWord(peer, staleS) : { label: "online", tone: "ok", note: "the machine serving this page" },
      host: machine === LOCAL_MACHINE ? st.host ?? null : snap?.host ?? null,
      counts: machineSummary(st, machine),
      reported: snap ? { queued: snap.queue_depth, sessions: snap.sessions, leases: snap.active_leases } : null,
      reportedEngines: (snap?.servers ?? [])
        .filter((s) => !declaredNames.has(s.name))
        .map((s) => ({
          name: s.name,
          word: liveWord({ idle: s.idle, degraded: s.degraded }, false),
        })),
      // The local arbiter's version is not a /api/state key — the frame
      // renders no version line for This Machine, never a borrowed peer one.
      version: snap?.version ?? null,
      note: peer && peer.error ? peer.error : null,
      controls: [],
      controlledBy: [],
      engines,
      agents: clients,
      // Filled by the header pass below (needs the control lines first).
      headerH: 0,
    });
  }

  // Control edges: the LOCAL edge store's roles (mesh-update.md D4 ADD keys).
  // from controls to — the pairing direction; the arrow reads controller→controlled.
  const controls: MeshControl[] = [];
  const localFrame = frameId(LOCAL_MACHINE);
  for (const p of peers) {
    if (p.i_control) controls.push({ id: `ctl:${localFrame}>${frameId(p.name)}`, from: localFrame, to: frameId(p.name) });
    if (p.controls_me) controls.push({ id: `ctl:${frameId(p.name)}>${localFrame}`, from: frameId(p.name), to: localFrame });
  }
  const frameOf = new Map(frames.map((f) => [f.id, f]));
  for (const c of controls) {
    const src = frameOf.get(c.from);
    const dst = frameOf.get(c.to);
    if (src && dst) {
      src.controls.push(dst.name);
      dst.controlledBy.push(src.name);
    }
  }

  // The header block height, computed from the lines this frame actually
  // renders (see MeshFrame.headerH). Computed AFTER the control pass above,
  // so the controls / controlled-by lines count.
  for (const f of frames) {
    let lines = 1; // the counts row always renders
    if (hostLine(f.host)) lines++;
    if (f.reported) lines++;
    if (f.reportedEngines.length > 0) lines++;
    if (f.controls.length > 0) lines++;
    if (f.controlledBy.length > 0) lines++;
    if (f.note) lines++;
    f.headerH = 39 + lines * 18;
  }

  // Flow edges: session → engine, the EXACT joins only.
  const serverById = new Map(st.servers.map((s) => [s.id, s]));
  const machineOfEngine = new Map<string, string>();
  for (const [machine, rows] of byMachine) for (const s of rows) machineOfEngine.set(s.id, machine);
  const machineOfClient = new Map<string, string>();
  for (const f of frames) for (const a of f.agents) machineOfClient.set(a.id, f.name);
  const agentSeen = new Set<string>();
  for (const f of frames) for (const a of f.agents) agentSeen.add(a.id);
  const signalOf = new Map(st.servers.map((s) => [s.id, s.signal]));

  const flows: MeshFlow[] = [];
  const unflowed = { noClient: 0, noEngine: 0, stale: 0 };
  for (const s of st.sessions ?? []) {
    if (sessStale(s, now)) {
      unflowed.stale++;
      continue;
    }
    const target = s.engine_pin?.server_id ?? s.server_id;
    const row = target ? serverById.get(target) : undefined;
    if (!row) {
      unflowed.noEngine++;
      continue;
    }
    const from = s.client_id ? agentNodeId(s.client_id) : null;
    if (!from || !agentSeen.has(from)) {
      unflowed.noClient++;
      continue;
    }
    const to = engineNodeId(row.id);
    const edge = engineEdge(s, signalOf.get(row.id));
    const pipe = pipeEdge(s, edge, now);
    const shortToken = s.token.slice(0, 6);
    const machine = machineOfEngine.get(row.id) ?? null;
    flows.push({
      id: `flow:${s.token}`,
      from,
      to,
      token: s.token,
      shortToken,
      profile: s.hermes_meta?.profile ?? null,
      model: s.hermes_meta?.model ?? s.engine_pin?.engine_model ?? null,
      engineName: row.name,
      pinned: s.engine_pin != null,
      cross: machine !== null && machineOfClient.get(from) !== undefined && machine !== machineOfClient.get(from),
      edge,
      pipe,
      title: pipeTitle(shortToken, row.name, edge, pipe),
      curvature: 0.25,
      offset: 0,
    });
  }
  // Fan-out: parallel edges between the same pair curve apart, centered.
  const byPair = new Map<string, MeshFlow[]>();
  for (const f of flows) {
    const k = `${f.from}→${f.to}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(f);
  }
  for (const group of byPair.values()) {
    group.forEach((f, i) => {
      f.curvature = 0.25;
      f.offset = group.length > 1 ? (i - (group.length - 1) / 2) * 28 : 0;
    });
  }

  return { frames, flows, controls, unflowed, unhosted: unhosted.length };
}

// --- layout ---------------------------------------------------------------

export type MeshLayoutMode = "rank" | "row";

/** Every resource node id a frame owns (agents first, then engines) — the
 *  vocabulary the DETACHED set is spelled in. */
export function frameResourceIds(f: MeshFrame): string[] {
  return [...f.agents.map((a) => a.id), ...f.engines.map((e) => e.id)];
}

/** How a machine RENDERS given the detached-resource set: "chip" only when
 *  it HAS resources and every one of them floats free (containment is gone
 *  entirely); "frame" otherwise — a fully framed machine, or a partially
 *  broken-out one (its remaining children still stack inside, the floaters
 *  carry hosts edges back to it). */
export function machineShape(f: MeshFrame, detached: ReadonlySet<string>): "frame" | "chip" {
  const ids = frameResourceIds(f);
  if (ids.length === 0) return "frame";
  return ids.every((id) => detached.has(id)) ? "chip" : "frame";
}

/** The dim "hosts" edges that attribute a BROKEN-OUT resource back to its
 *  machine: machine box (frame or chip, keyed by machine id) → the floating
 *  agent/engine card. Empty while every resource stays framed (containment
 *  already says it). `detached` holds RESOURCE node ids (per-card break-out,
 *  the ⌘-drag gesture's vocabulary). Pure + exported so the view and the
 *  tests share one definition. */
export function hostEdgesFor(
  graph: MeshGraph,
  detached: ReadonlySet<string>,
): { id: string; from: string; to: string; machine: string; label: string }[] {
  const edges: { id: string; from: string; to: string; machine: string; label: string }[] = [];
  if (detached.size === 0) return edges;
  for (const f of graph.frames) {
    for (const a of f.agents)
      if (detached.has(a.id))
        edges.push({ id: `host:${f.id}>${a.id}`, from: f.id, to: a.id, machine: f.name, label: `hosts ${a.name}` });
    for (const e of f.engines)
      if (detached.has(e.id))
        edges.push({ id: `host:${f.id}>${e.id}`, from: f.id, to: e.id, machine: f.name, label: `hosts ${e.name}` });
  }
  return edges;
}

export function meshFrameSize(f: MeshFrame, detached: ReadonlySet<string> = EMPTY_DETACHED): { w: number; h: number } {
  const na = f.agents.filter((a) => !detached.has(a.id)).length;
  const ne = f.engines.filter((e) => !detached.has(e.id)).length;
  const agentsH = na > 0 ? SECTION_H + na * AGENT_H + (na - 1) * NODE_GAP : 0;
  const enginesH = ne > 0 ? SECTION_H + ne * ENGINE_H + (ne - 1) * NODE_GAP : 0;
  const seam = agentsH > 0 && enginesH > 0 ? NODE_GAP : 0;
  return { w: FRAME_W, h: FRAME_PAD + f.headerH + agentsH + seam + enginesH + FRAME_PAD };
}

const EMPTY_DETACHED: ReadonlySet<string> = new Set();

/** Children's positions RELATIVE to the frame (agents stacked, then engines).
 *  Detached resources are NOT in the map — they are their own boxes (see
 *  layoutMesh) and the framed stack closes the gap they left. */
export function meshChildOffsets(f: MeshFrame, detached: ReadonlySet<string> = EMPTY_DETACHED): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const agents = f.agents.filter((a) => !detached.has(a.id));
  const engines = f.engines.filter((e) => !detached.has(e.id));
  let y = FRAME_PAD + f.headerH;
  if (agents.length > 0) {
    y += SECTION_H;
    for (const a of agents) {
      out.set(a.id, { x: FRAME_PAD, y });
      y += AGENT_H + NODE_GAP;
    }
  }
  if (engines.length > 0) {
    y += SECTION_H;
    for (const e of engines) {
      out.set(e.id, { x: FRAME_PAD, y });
      y += ENGINE_H + NODE_GAP;
    }
  }
  return out;
}

/** Frame positions for one layout mode, honoring which RESOURCES are broken
 *  OUT (a set of resource node ids — per-card granularity, the ⌘-drag
 *  gesture's vocabulary). A machine whose resources all stayed framed is one
 *  box (its frame; the view places the child cards inside via
 *  meshChildOffsets). A machine with FLOATING cards contributes its machine
 *  box — the compact chip once EVERY card is out, otherwise the frame sized
 *  to its remaining children — plus one box per floating card, each keyed by
 *  that resource's node id. The returned map covers EVERY top-level node
 *  (frames, chips, floating cards); children that stayed inside a frame are
 *  NOT in it (they are offset in-view).
 *  "rank" = dagre layered left→right along control + aggregated cross-machine
 *  flow edges (a machine whose agents feed engines elsewhere ranks upstream);
 *  a machine box keeps a weak pull to its own cards so they don't scatter.
 *  "row" = one row grouped by machine (local first, a machine's box followed
 *  by its cards), no edges read. */
export function layoutMesh(
  graph: MeshGraph,
  mode: MeshLayoutMode,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();

  // Each machine contributes a group of boxes. `rep` is the machine's own box
  // (frame, or chip once every card is out) — the control edges attach to it.
  // Members are the resource boxes that floated free of it.
  type Box = { id: string; w: number; h: number };
  type Group = { rep: Box; members: Box[]; machine: string };
  const groups: Group[] = [];
  // node id (agent/engine) → the box id it occupies (its own when floating).
  const boxOf = new Map<string, string>();

  for (const f of graph.frames) {
    const framedAgents = f.agents.filter((a) => !detached.has(a.id));
    const framedEngines = f.engines.filter((e) => !detached.has(e.id));
    const outAgents = f.agents.filter((a) => detached.has(a.id));
    const outEngines = f.engines.filter((e) => detached.has(e.id));
    const isChip = machineShape(f, detached) === "chip";
    const rep: Box = isChip
      ? { id: f.id, w: CHIP_W, h: f.headerH } // rep keyed by machine id
      : { id: f.id, ...meshFrameSize(f, detached) };
    const members: Box[] = [];
    for (const a of framedAgents) boxOf.set(a.id, f.id);
    for (const e of framedEngines) boxOf.set(e.id, f.id);
    for (const a of outAgents) {
      members.push({ id: a.id, w: CARD_W, h: AGENT_H });
      boxOf.set(a.id, a.id);
    }
    for (const e of outEngines) {
      members.push({ id: e.id, w: CARD_W, h: ENGINE_H });
      boxOf.set(e.id, e.id);
    }
    groups.push({ rep, members, machine: f.name });
  }

  if (mode === "row") {
    let x = 0;
    for (const g of groups) {
      // A machine column: the rep (frame or chip) on top, then its floating
      // cards stacked below it. Column width = the widest box; next machine
      // advances by that. Children of a grouped frame are offset in-view, so
      // only the frame box is placed here.
      const colW = Math.max(g.rep.w, ...g.members.map((m) => m.w));
      out.set(g.rep.id, { x, y: 0 });
      let y = g.rep.h + (g.members.length > 0 ? NODE_GAP : 0);
      for (const m of g.members) {
        out.set(m.id, { x, y });
        y += m.h + NODE_GAP;
      }
      x += colW + 70;
    }
    return out;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 55, ranksep: 150, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const allBoxes = groups.flatMap((grp) => [grp.rep, ...grp.members]);
  for (const b of allBoxes) g.setNode(b.id, { width: b.w, height: b.h });

  // Ranking edges. Control edges (weight 3) run machine-box → machine-box; the
  // machine box is the frame whenever a child stays inside, the chip once the
  // whole machine floated out (same id).
  for (const c of graph.controls) {
    if (g.hasNode(c.from) && g.hasNode(c.to) && c.from !== c.to) g.setEdge(c.from, c.to, { weight: 3 });
  }
  // Flow edges (agent→engine): to the box each endpoint lives in. Aggregated
  // per box-pair so a busy machine pulls its neighbours upstream. Self-loops
  // (an agent feeding an engine in the SAME box — same machine, or both of a
  // machine's cards floating in the same break-out) never rank.
  const pairW = new Map<string, number>();
  for (const fl of graph.flows) {
    const src = boxOf.get(fl.from);
    const dst = boxOf.get(fl.to);
    if (!src || !dst || src === dst) continue;
    const k = `${src}|${dst}`;
    pairW.set(k, (pairW.get(k) ?? 0) + 2);
  }
  for (const [k, weight] of pairW) {
    const [from, to] = k.split("|");
    if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to, { weight });
  }
  // Weak pull (weight 1) from a machine's box to each of its floating cards,
  // so a broken-out machine stays visually a cluster rather than scattering.
  for (const grp of groups) {
    for (const m of grp.members) if (g.hasNode(grp.rep.id) && g.hasNode(m.id)) g.setEdge(grp.rep.id, m.id, { weight: 1 });
  }

  dagre.layout(g);
  let minX = Infinity;
  let minY = Infinity;
  const raw = new Map<string, { x: number; y: number }>();
  for (const b of allBoxes) {
    const n = g.node(b.id);
    if (!n) continue;
    raw.set(b.id, { x: n.x - n.width / 2, y: n.y - n.height / 2 });
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }
  for (const b of allBoxes) {
    const p = raw.get(b.id) ?? { x: 0, y: 0 };
    out.set(b.id, { x: p.x - minX, y: p.y - minY });
  }
  return out;
}

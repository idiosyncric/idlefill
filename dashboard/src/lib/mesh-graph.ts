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
// The PROFILE law (owner ask 2026-10-19): the agents section is not one card
// per daemon shared by every Hermes profile — EACH published roster profile
// gets its OWN card listing its live sessions under it, and the session's
// pipe starts there. The join is the Agents tab's, verbatim: the client's
// published `agent_roster` names the profile EXACTLY and the session's
// gateway-ledger provenance stamp (`hermes_meta.profile`) on that same
// client names the card. A session with no stamp, or a stamp no roster row
// matches, keeps riding its DAEMON card — LISTED there in the same session
// lines (counted as `unprofiled`, the card growing to fit them), never a
// guessed profile and never an invisible count.
//
// The GATEWAY law (owner ask 2026-10-21): the daemon card IS the machine's
// "hermes gateway" — the roster, the profile cards and the ledger stamps are
// all HERMES' own disclosure, so the view titles the card that way and the
// glance counts "profiles N", never "agents" (the published client name
// stays in `name`; the machine never loses its own label on the frame). The
// gateway card FOLDS: folding hides the profile cards DOCKED under it — a
// broken-out profile card is its own box and stays out — and the docked
// profile's pipes re-anchor onto the gateway card that contains it
// (foldReanchorFor). The fold hides CARDS, never sessions or counts: the
// glance still reads "profiles N" while folded.
//
// The PROJECT law (owner ask 2026-10-21): the queued jobs are a fleet-side
// story of their own — the Projects section is one card per arbiter project
// row in a single stack, the queue depth a DIRECT count (workers' queue
// depths summed; 0 renders 0, the Projects tab's discipline). Which machines
// drain a queue is the EXACT join worker.client_id → client row → frame; a
// worker with no client_id names no machine, never a guess. The section
// belongs to no machine: it rides the layout as one fleet-side box
// (PROJECTS_BOX_ID), upstream of the machines it queues on.
//
// The DRAIN law (owner ask 2026-10-21): a project that is NOT paused and is
// running jobs must SHOW its routing and progress the way an agent session
// does — one connection per running job (the arbiter's active lease: the
// grant it holds RIGHT NOW, the Projects tab's own "N running" discipline).
// The chain is project card ⇢ the gateway card of the worker running the job
// (the EXACT join lease.client_id → client row; no client_id names no card,
// never a guess) ⇢ the engine card the lease's server_id names (exact row;
// no row = the chain STOPS at the gateway and the tooltip says so). The pipe
// rides the Sessions vocabulary: the engine-side facts decide
// (engineEdge/pipeEdge + a fresh live-load sample animates it; degraded/
// absent signal is the honest muted posture; a lease that names no engine
// row is muted with "engine not named"). The running jobs are also LISTED on
// the project card (the profile-card row discipline: phase dot + chain + the
// shared tooltip, capped, the card grows, the Projects tab stays the full
// surface). A PAUSED project lists its running jobs (a published fact) but
// draws NO pipes — the owner gated the connections on the unpaused state,
// and every undrawn job is COUNTED and NAMED (undrained), never a silent gap.
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
//
// The MODEL-hop law (owner ask 2026-10-19): a pipe spells the whole published
// connection — session → abstraction → engine. The model NAME is the session
// row's own, first-named-wins (gateway-ledger stamp → operator pin → router
// sniff, the source RECORDED, never inferred); idlefill's abstraction joins
// EXACTLY: a model_aliases winner whose server_id IS the pipe's engine row
// AND whose engine_model IS that name. A unique winner names the alias on
// the pipe; zero or ambiguous winners name nothing (the raw model stays).
// ---------------------------------------------------------------------------

import dagre from "@dagrejs/dagre";
import type { ClientRow, MeshPeer, ServerRow, StateSnapshot } from "./api";
import { LOCAL_MACHINE, hostedServers, machineClients, machineSummary, type MachineSummary } from "./hierarchy";
import { hostLine } from "./mesh-stats";
import { engineEdge, EDGE_SAMPLE_STALE_S, type EngineEdge } from "./session-edge";
import { pipeEdge, pipeTitle, type PipeEdge, type PipePhase } from "./pipe-phases";
import { durFmt, liveWord, minSec, sessStale, sessWorking, type StateWord } from "./format";
import { compact } from "./fleet-stats";
import { LOAD_FRESHNESS_DEFAULT_S } from "./load-read";

// --- node ids, spelled once (the view never invents its own) -------------
export const frameId = (machine: string): string => `mch:${machine}`;
export const engineNodeId = (serverId: string): string => `eng:${serverId}`;
export const agentNodeId = (clientId: string): string => `agt:${clientId}`;
/** A roster profile's card node: the daemon it is published under + the
 *  EXACT roster profile name (the same join the Agents tab nests on). */
export const profileNodeId = (clientId: string, profile: string): string => `agt:${clientId}#${profile}`;
/** The fleet-side Projects stack's box: not a machine, so it spells its own
 *  id (owner ask 2026-10-21 — the queue story moved out of the gateway card). */
export const PROJECTS_BOX_ID = "prjs:fleet";
/** A project card node: the arbiter project row's own name, EXACT. */
export const projectNodeId = (name: string): string => `prj:${name}`;

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

/** A profile card: the header row plus ONE row per live session it lists,
 *  capped (the "+N more" line keeps the card bounded — the Sessions tab
 *  stays the surface for the full list). The view renders exactly this
 *  many rows, the layout reserves exactly this height. */
export const PROFILE_H_BASE = 40;
export const PROFILE_ROW_H = 15;
export const PROFILE_ROWS_MAX = 5;
export const profileCardH = (sessions: number): number =>
  PROFILE_H_BASE + Math.min(sessions, PROFILE_ROWS_MAX) * PROFILE_ROW_H + (sessions > PROFILE_ROWS_MAX ? PROFILE_ROW_H : 0);

/** The fleet-side Projects stack (owner ask 2026-10-21): one fixed-height
 *  card per arbiter project row under a machine-style header that IS the
 *  "Projects" label (name row + one glance line, the machine's 39 + 18 rule).
 *  A card GROWS by one row per running job it lists (projectCardH), exactly
 *  the profile-card posture — the layout reserves what the view renders. */
export const PROJECT_H = 46;
export const PROJECTS_HEADER_H = 57;
export const projectCardH = (running: number): number =>
  PROJECT_H + Math.min(running, PROFILE_ROWS_MAX) * PROFILE_ROW_H + (running > PROFILE_ROWS_MAX ? PROFILE_ROW_H : 0);

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

/** Where a flow's model NAME came from (row facts only, first-named-wins). */
export type MeshModelSource = "ledger" | "pin" | "sniffed";
export const MODEL_SOURCE_NOTE: Record<MeshModelSource, string> = {
  ledger: "stamped by the gateway ledger",
  pin: "named by the operator pin",
  sniffed: "the model the router last sniffed",
};

/** One live session LISTED on its profile card — the same facts the flow
 *  edge carries (shared pipe + tooltip), never more than the edge says. */
export type MeshProfileSession = {
  flowId: string;
  shortToken: string;
  /** The model / idlefill alias to spell as the card's middle hop (null =
   *  the row names none — the line reads session ⇢ engine, no invented hop). */
  model: string | null;
  alias: string | null;
  engineName: string;
  /** The shared pipe tooltip (pipeTitle + the model clause) — card and edge
   *  never disagree. */
  title: string;
  phase: PipePhase;
  animated: boolean;
  muted: boolean;
  cross: boolean;
  /** Owner ask 2026-10-21: a FRESH Hermes turn lease on this row — the
   *  agent is mid-turn RIGHT NOW (tool or local work; the pipe stays
   *  honest: the engine link is quiet, so the EDGE never claims a stream).
   *  The dot and the profile-card word read this, never a guess. */
  working: boolean;
};

/** One Hermes profile (the daemon's published roster row) as its OWN card,
 *  its live sessions listed underneath. */
export type MeshProfileSlot = {
  id: string;
  /** The roster row's profile name, EXACT. */
  name: string;
  /** The published roster posture (adopted routes through idlefill). */
  posture: "adopted" | "external" | "unset";
  machine: string;
  /** The daemon card this one nests under (agentNodeId). */
  daemon: string;
  /** The live sessions whose provenance stamp names this profile EXACTLY. */
  sessions: MeshProfileSession[];
  /** The card height (profileCardH over the session count) — the layout
   *  and the view share it (fixed heights, no measuring). */
  h: number;
};

export type MeshAgentSlot = {
  id: string;
  name: string;
  /** The machine label of the daemon's EXACT host join (see MeshEngineSlot). */
  machine: string;
  online: boolean;
  /** Sum of the client's published project queue depths (a true 0). The
   *  per-project breakdown rides the Projects stack, not this card. */
  queueDepth: number;
  /** Published Hermes roster size; null = the client published no roster. */
  agents: number | null;
  override: "pause" | "force" | null;
  behind: boolean;
  /** The published roster rendered as per-profile cards (nested under this
   *  daemon card — containment, the hierarchy's own join). */
  profiles: MeshProfileSlot[];
  /** Live sessions this daemon runs that anchor HERE instead of a profile
   *  card: no provenance stamp, or a stamp no roster row matches. LISTED on
   *  the card (same lines a profile card shows), never silently absorbed. */
  unprofiled: number;
  unprofiledSessions: MeshProfileSession[];
  /** The card height: AGENT_H plus one row per LISTED unprofiled session
   *  (capped) — the layout and the view share it, like the profile cards. */
  h: number;
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
  /** The machine's client daemons; each carries its published roster
   *  profiles as nested cards (`profiles`). */
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
  /** The model NAME the session row carries, first-named-wins (see the
   *  MODEL-hop law); null = no row fact names one ("model not named"). */
  model: string | null;
  /** Which row fact named it — the tooltip words the source honestly. */
  modelSource: MeshModelSource | null;
  /** idlefill's abstraction: the EXACT model_aliases winner for this
   *  (engine row, model) pair; null = none names it, or the names are not
   *  unique (never picked by similarity). */
  alias: string | null;
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

/** One running job (an active lease) LISTED on its project card — the same
 *  facts the drain pipe carries (shared phase + tooltip), never more than
 *  the pipe says. The chain line: job ⇢ machine ⇢ engine. */
export type MeshDrainLine = {
  drainId: string;
  /** The lease row's own job_id, EXACT (the Projects tab names the same). */
  job: string;
  /** The gateway card's machine label (the exact lease.client_id join). */
  machine: string;
  /** The engine card name the lease's server_id names; null = none named
   *  (the line reads job ⇢ machine, the tooltip says "engine not named"). */
  engine: string | null;
  /** The shared pipe tooltip — card line and pipe never disagree. */
  title: string;
  phase: PipePhase;
  animated: boolean;
  muted: boolean;
  cross: boolean;
};

/** One running job drawn as a CONNECTION (the DRAIN law): the project card →
 *  the gateway card of the worker running the job, and on to the engine card
 *  the lease names. The view draws it as two segments sharing one pipe. */
export type MeshDrain = {
  id: string;
  /** projectNodeId(project) → agentNodeId(worker's client). */
  from: string;
  to: string;
  /** agentNodeId → engineNodeId(server); null = the lease names no engine
   *  row — the chain STOPS at the gateway (named, never a guessed engine). */
  engineTo: string | null;
  job: string;
  /** The project row's own name, EXACT (the tree row + tooltip). */
  project: string;
  /** The gateway's machine label (the exact join, not the lease's text). */
  machine: string;
  engineName: string | null;
  pipe: PipeEdge;
  title: string;
  /** true = the job's engine sits on another machine than its gateway. */
  cross: boolean;
  /** Bezier fan-out for parallel chains between the same endpoints. */
  curvature: number;
  offset: number;
};

/** One arbiter project row as its OWN card in the fleet-side Projects stack
 *  (owner ask 2026-10-21 — the queue story moved out of the gateway card).
 *  Every field is the row's own DIRECT count: 0 renders 0. */
export type MeshProjectSlot = {
  id: string;
  /** The project row's own name, EXACT. */
  name: string;
  /** Sum of the project's worker queue depths (the Projects tab's count). */
  queued: number;
  /** Worker rows the project names; online = how many of them are online. */
  workers: number;
  online: number;
  paused: boolean;
  finishedToday: number;
  failedToday: number;
  /** The machine frame ids whose gateways drain this queue — the EXACT join
   *  worker.client_id → client row → frame, deduped. A worker with no
   *  client_id names no machine (never a similarity guess). */
  machines: string[];
  /** The jobs running NOW (the arbiter's active leases for this project),
   *  listed on the card; pipes ride `MeshGraph.drains` (paused projects
   *  list, never pipe — the undrained count names what draws no chain). */
  running: MeshDrainLine[];
  /** The card height (projectCardH over the listed count) — layout and
   *  view share it (fixed heights, no measuring). */
  h: number;
};

export type MeshGraph = {
  frames: MeshFrame[];
  flows: MeshFlow[];
  controls: MeshControl[];
  /** Sessions rendered as NO edge, named (never silently dropped). */
  unflowed: { noClient: number; noEngine: number; stale: number };
  /** Declared engine rows with no machine verdict (hierarchy's UNHOSTED). */
  unhosted: number;
  /** The fleet-side Projects stack (one slot per arbiter project row). */
  projects: MeshProjectSlot[];
  /** The running-job connections (the DRAIN law): one per active lease of a
   *  NON-paused project whose worker joins a gateway card exactly. */
  drains: MeshDrain[];
  /** Running jobs drawing no pipe, named (the DRAIN law's honesty count):
   *  no project row to start from, no gateway join to land on, or the
   *  project is paused (listed on its card, gated off the canvas). */
  undrained: { noProject: number; noGateway: number; paused: number };
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
  // The published roster, deduped by profile name (first row wins) — a
  // roster with a repeated name is a malformed publish, never two cards.
  const seen = new Set<string>();
  const profiles: MeshProfileSlot[] = [];
  for (const r of c.agent_roster ?? []) {
    if (seen.has(r.profile)) continue;
    seen.add(r.profile);
    profiles.push({
      id: profileNodeId(c.client_id, r.profile),
      name: r.profile,
      posture: r.posture,
      machine,
      daemon: agentNodeId(c.client_id),
      sessions: [],
      h: profileCardH(0),
    });
  }
  return {
    id: agentNodeId(c.client_id),
    name: c.name,
    machine,
    online: now - c.last_seen < 90_000,
    queueDepth: c.projects.reduce((a, p) => a + (p.queue_depth || 0), 0),
    agents: c.agent_roster ? c.agent_roster.length : null,
    override: c.override?.override ?? null,
    behind: !!c.daemon_behind,
    profiles,
    unprofiled: 0,
    unprofiledSessions: [],
    h: AGENT_H,
  };
}

/** The pipe for a running job's chain (the DRAIN law). No lease-side phase
 *  exists to read — the ENGINE side's published facts decide, on the exact
 *  Sessions rules (engineEdge's posture + pipeEdge's engine clauses, the
 *  same attribution posture as a session pipe's "engine queue depth N"):
 *  a fresh live-load sample (in flight / tokens-per-second) streams blue,
 *  a fresh queue depth warns dashed, degraded/absent signal is the honest
 *  muted no-signal posture. A lease that names no engine row mutes with
 *  "engine not named" — never an invented chain. */
function drainPipe(engineRow: ServerRow | undefined, now: number): PipeEdge {
  if (!engineRow) return { phase: "base", dashed: false, animated: false, muted: true, reason: "engine not named" };
  const edge = engineEdge({ server_id: engineRow.id }, engineRow.signal ?? null);
  const pipe = pipeEdge({ gate: undefined, phase: undefined }, edge, now);
  // The live-load upgrade: the engine row says traffic is moving RIGHT NOW
  // (fresh sample, work in flight) — the running job's pipe animates on it.
  if (!pipe.dashed && !pipe.muted && !pipe.animated) {
    const inFlight = nnum(engineRow.signal?.in_flight);
    const tps = nnum(engineRow.signal?.tokens_per_second);
    const fresh = edge.sampleAgeS !== null && edge.sampleAgeS <= EDGE_SAMPLE_STALE_S;
    if (fresh && ((inFlight ?? 0) > 0 || (tps ?? 0) > 0))
      return { phase: "output", dashed: false, animated: true, muted: false, reason: "engine streaming" };
  }
  return pipe;
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
  // client row → its machine's frame id — the machineClients join spelled once,
  // reused by the Projects pass below to name which gateways drain each queue.
  const frameOfClient = new Map<string, string>();

  for (const machine of machineNames) {
    const peer = peers.find((p) => p.name === machine) ?? null;
    const engines = (byMachine.get(machine) ?? []).map((s) => engineSlot(st, s, machine));
    const hosted = machineClients(st, machine);
    const clients = hosted.map((c) => agentSlot(c, now, machine));
    for (const c of hosted) frameOfClient.set(c.client_id, frameId(machine));
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
  // The abstraction indexes (both directions, EXACT names only): an alias
  // winner names its (engine row, engine_model) pair, and its own name
  // resolves to an engine_model there. Ambiguous pairs/names name nothing —
  // never an alias picked by similarity.
  const aliasByEnginePair = new Map<string, string[]>();
  const engineModelByAliasName = new Map<string, string[]>();
  for (const a of st.model_aliases ?? []) {
    if (!a.server_id || !a.engine_model) continue;
    const k = `${a.server_id}|${a.engine_model}`;
    (aliasByEnginePair.get(k) ?? aliasByEnginePair.set(k, []).get(k)!).push(a.name);
    const n = `${a.server_id}|${a.name}`;
    (engineModelByAliasName.get(n) ?? engineModelByAliasName.set(n, []).get(n)!).push(a.engine_model);
  }

  const flows: MeshFlow[] = [];
  const unflowed = { noClient: 0, noEngine: 0, stale: 0 };
  // Profile-card lookups for the re-anchor: the EXACT (daemon, profile) pair
  // only. A session never anchors on another daemon's same-named profile.
  const profileSlotOf = new Map<string, MeshProfileSlot>();
  const agentSlotOf = new Map<string, MeshAgentSlot>();
  for (const f of frames)
    for (const a of f.agents) {
      agentSlotOf.set(a.id, a);
      for (const p of a.profiles) profileSlotOf.set(`${a.id}#${p.name}`, p);
    }
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
    const daemon = s.client_id ? agentNodeId(s.client_id) : null;
    if (!daemon || !agentSeen.has(daemon)) {
      unflowed.noClient++;
      continue;
    }
    // The pipe starts at the profile card ONLY on the exact join (the
    // client's roster names the profile AND the session's stamp is it);
    // anything else rides the daemon card, counted as unprofiled there.
    const slot = s.hermes_meta?.profile ? profileSlotOf.get(`${daemon}#${s.hermes_meta.profile}`) : undefined;
    const from = slot ? slot.id : daemon;
    const to = engineNodeId(row.id);
    const edge = engineEdge(s, signalOf.get(row.id));
    const pipe = pipeEdge(s, edge, now);
    const shortToken = s.token.slice(0, 6);
    const machine = machineOfEngine.get(row.id) ?? null;
    // The model hop: the session row's own name, first-named-wins; then the
    // abstraction's EXACT joins on this engine row — the winner whose
    // engine_model IS the name (the name is then the abstraction), else the
    // winner whose NAME IS it (the row's name already IS the alias; the
    // tooltip names what it lands as). Unique joins only.
    const model = s.hermes_meta?.model ?? s.engine_pin?.engine_model ?? s.history?.model ?? null;
    const modelSource: MeshModelSource | null = s.hermes_meta?.model
      ? "ledger"
      : s.engine_pin?.engine_model
        ? "pin"
        : s.history?.model
          ? "sniffed"
          : null;
    const viaAlias = model ? (aliasByEnginePair.get(`${row.id}|${model}`)?.[0] ?? null) : null;
    const viaAliasCount = model ? (aliasByEnginePair.get(`${row.id}|${model}`)?.length ?? 0) : 0;
    const landsAs =
      model && viaAliasCount === 0 ? (engineModelByAliasName.get(`${row.id}|${model}`)?.[0] ?? null) : null;
    const landsAsCount = model ? (engineModelByAliasName.get(`${row.id}|${model}`)?.length ?? 0) : 0;
    const alias = viaAliasCount === 1 ? viaAlias : null;
    const landsAsModel = landsAsCount === 1 ? landsAs : null;
    // The shared pipe tooltip, extended with the model facts the ROW names
    // (the Sessions tab shows the same facts; the graph adds no claim).
    const title =
      pipeTitle(shortToken, row.name, edge, pipe) +
      (model ? ` · model ${model} (${MODEL_SOURCE_NOTE[modelSource!]})` : "") +
      (alias ? ` · via alias ${alias} on this engine` : "") +
      (landsAsModel ? ` · lands at this engine as ${landsAsModel}` : "");
    const flow: MeshFlow = {
      id: `flow:${s.token}`,
      from,
      to,
      token: s.token,
      shortToken,
      profile: s.hermes_meta?.profile ?? null,
      model,
      modelSource,
      alias,
      engineName: row.name,
      pinned: s.engine_pin != null,
      cross: machine !== null && machineOfClient.get(daemon) !== undefined && machine !== machineOfClient.get(daemon),
      edge,
      pipe,
      title,
      curvature: 0.25,
      offset: 0,
    };
    flows.push(flow);
    const line: MeshProfileSession = {
      flowId: flow.id,
      shortToken,
      model,
      alias,
      engineName: row.name,
      title: flow.title,
      phase: pipe.phase,
      animated: pipe.animated,
      muted: pipe.muted,
      cross: flow.cross,
      // Owner ask 2026-10-21: the row's own live lease fact (see the
      // type). The EDGE stays the pipe's honest stream truth; the CARD
      // line says what the row names. One shared freshness law
      // (sessWorking) — the row word and this dot can never disagree.
      working: sessWorking(s, now),
    };
    // The lease clause extends the LISTED line only (the card speaks the
    // session's state; the flow edge's tooltip is the pipe's truth — the
    // engine link really is quiet while a tool runs, so it never claims
    // it).
    if (line.working) line.title += " · hermes turn lease held — tool or local work, engine stream quiet";
    if (slot) slot.sessions.push(line);
    else {
      const ag = agentSlotOf.get(daemon)!;
      ag.unprofiled++;
      ag.unprofiledSessions.push(line);
    }
  }
  // The profile cards size to the sessions they now list; the daemon card
  // grows the same way over its LISTED unprofiled rows (a session whose
  // provenance names no profile still SPELLS its chain — daemon cards used
  // to count them invisibly).
  for (const p of profileSlotOf.values()) p.h = profileCardH(p.sessions.length);
  for (const f of frames)
    for (const a of f.agents)
      a.h = AGENT_H + Math.min(a.unprofiledSessions.length, PROFILE_ROWS_MAX) * PROFILE_ROW_H;
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

  // The Projects stack (owner ask 2026-10-21): one slot per arbiter project
  // row. The queue depth is the DIRECT count (workers' queue depths summed,
  // 0 renders 0 — the Projects tab's discipline). Which machines drain the
  // queue is the EXACT join worker.client_id → client row → frame; a worker
  // with no client_id names no machine, never a similarity guess.
  const projects: MeshProjectSlot[] = [];
  for (const p of st.projects ?? []) {
    const workers = p.workers ?? [];
    const machines: string[] = [];
    for (const w of workers) {
      const fr = w.client_id ? frameOfClient.get(w.client_id) : undefined;
      if (fr && !machines.includes(fr)) machines.push(fr);
    }
    projects.push({
      id: projectNodeId(p.name),
      name: p.name,
      queued: workers.reduce((a, w) => a + (w.queue_depth || 0), 0),
      workers: workers.length,
      online: workers.filter((w) => w.online).length,
      paused: p.paused,
      finishedToday: p.today?.finished ?? 0,
      failedToday: p.today?.failed ?? 0,
      machines,
      running: [],
      h: projectCardH(0),
    });
  }

  // The running-job connections (the DRAIN law, owner ask 2026-10-21): one
  // chain per ACTIVE lease — the grant the arbiter holds right now, the
  // Projects tab's own "N running" fact. Every hop is an EXACT join: the
  // lease's project names the card, its client_id names the gateway (no
  // join names NO pipe, counted), its server_id names the engine row or the
  // chain stops at the gateway (the tooltip says so). A paused project LISTS
  // its running jobs but draws no pipes (gated, counted, never silent).
  const drains: MeshDrain[] = [];
  const undrained = { noProject: 0, noGateway: 0, paused: 0 };
  const slotOfProject = new Map(projects.map((p) => [p.name, p]));
  for (const l of st.active_leases ?? []) {
    const slot = slotOfProject.get(l.project);
    if (!slot) {
      undrained.noProject++;
      continue;
    }
    const gateway = l.client_id ? agentNodeId(l.client_id) : null;
    if (!gateway || !agentSeen.has(gateway)) {
      undrained.noGateway++;
      continue;
    }
    // The gateway's machine label from the same hosted-clients join that put
    // the card there (never the lease's client_name as a label).
    const machine = frameOf.get(frameOfClient.get(l.client_id!) ?? "")?.name ?? l.client_name;
    const engineRow = l.server_id ? serverById.get(l.server_id) : undefined;
    const pipe = drainPipe(engineRow, now);
    const engineMachine = engineRow ? machineOfEngine.get(engineRow.id) ?? null : null;
    const cross = engineMachine !== null && engineMachine !== machine;
    const elapsedS = Math.max(0, Math.round((now - l.granted_at) / 1000));
    // The shared tooltip: the lease's own facts, worded — nothing the
    // Projects tab's running-job row would not say.
    const title =
      `job ${l.job_id} · ${l.client_name} on ${machine}` +
      ` · running ${minSec(elapsedS)}${l.estimated_seconds > 0 ? ` of ${durFmt(l.estimated_seconds)} estimate` : ""}` +
      ` · in ${compact(l.tokens_in)} / out ${compact(l.tokens_out)}` +
      (engineRow ? ` · engine ${engineRow.name}` : "") +
      (pipe.reason ? ` · ${pipe.reason}` : "");
    const drainId = `drain:${l.lease_id}`;
    slot.running.push({
      drainId,
      job: l.job_id,
      machine,
      engine: engineRow?.name ?? null,
      title,
      phase: pipe.phase,
      animated: pipe.animated,
      muted: pipe.muted,
      cross,
    });
    if (slot.paused) {
      undrained.paused++;
      continue;
    }
    drains.push({
      id: drainId,
      from: slot.id,
      to: gateway,
      engineTo: engineRow ? engineNodeId(engineRow.id) : null,
      job: l.job_id,
      project: slot.name,
      machine,
      engineName: engineRow?.name ?? null,
      pipe,
      title,
      cross,
      curvature: 0.25,
      offset: 0,
    });
  }
  // The project cards size to the running jobs they now list (the profile-
  // card posture: fixed computed height, layout and view share it).
  for (const p of projects) p.h = projectCardH(p.running.length);
  // Fan-out: whole chains sharing all three endpoints curve apart, centered.
  const dPair = new Map<string, MeshDrain[]>();
  for (const d of drains) {
    const k = `${d.from}→${d.to}→${d.engineTo ?? ""}`;
    (dPair.get(k) ?? dPair.set(k, []).get(k)!).push(d);
  }
  for (const group of dPair.values()) {
    group.forEach((d, i) => {
      d.offset = group.length > 1 ? (i - (group.length - 1) / 2) * 28 : 0;
    });
  }

  return { frames, flows, controls, unflowed, unhosted: unhosted.length, projects, drains, undrained };
}

// --- layout ---------------------------------------------------------------

export type MeshLayoutMode = "rank" | "row";

/** Every resource node id a frame owns (agent daemons with their profile
 *  cards, then engines) — the vocabulary the DETACHED set is spelled in. */
export function frameResourceIds(f: MeshFrame): string[] {
  return [...f.agents.flatMap((a) => [a.id, ...a.profiles.map((p) => p.id)]), ...f.engines.map((e) => e.id)];
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
    for (const a of f.agents) {
      if (detached.has(a.id))
        edges.push({ id: `host:${f.id}>${a.id}`, from: f.id, to: a.id, machine: f.name, label: `hosts ${a.name}` });
      for (const p of a.profiles)
        if (detached.has(p.id))
          edges.push({ id: `host:${f.id}>${p.id}`, from: f.id, to: p.id, machine: f.name, label: `hosts ${p.name} (${a.name})` });
    }
    for (const e of f.engines)
      if (detached.has(e.id))
        edges.push({ id: `host:${f.id}>${e.id}`, from: f.id, to: e.id, machine: f.name, label: `hosts ${e.name}` });
  }
  return edges;
}

/** The framed stack's cards, in render order: each daemon card followed by
 *  its profile cards. Detached cards are gone from the stack (they are their
 *  own boxes — see layoutMesh); every card carries its own height. A FOLDED
 *  gateway (owner ask 2026-10-21) contributes its daemon card but NOT its
 *  docked profile cards — broken-out ones were never part of the stack. */
export type MeshStackCard = { id: string; h: number };

export function framedAgentCards(
  f: MeshFrame,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
  collapsed: ReadonlySet<string> = EMPTY_DETACHED,
): MeshStackCard[] {
  const out: MeshStackCard[] = [];
  for (const a of f.agents) {
    if (!detached.has(a.id)) out.push({ id: a.id, h: a.h });
    if (collapsed.has(a.id)) continue; // folded: the docked profile cards are hidden
    for (const p of a.profiles) if (!detached.has(p.id)) out.push({ id: p.id, h: p.h });
  }
  return out;
}

/** The FOLD re-anchor (owner ask 2026-10-21): a folded gateway hides its
 *  DOCKED profile cards, and a pipe cannot start at a card that is not
 *  drawn — so those pipes start on the gateway card that CONTAINS them.
 *  Broken-out profile cards are their own boxes and keep their own pipes.
 *  The fold hides cards, never sessions. Pure + exported so the view and
 *  the tests share one definition (the same posture as hostEdgesFor). */
export function foldReanchorFor(
  graph: MeshGraph,
  collapsed: ReadonlySet<string>,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
): Map<string, string> {
  const out = new Map<string, string>();
  if (collapsed.size === 0) return out;
  for (const f of graph.frames)
    for (const a of f.agents)
      if (collapsed.has(a.id)) for (const p of a.profiles) if (!detached.has(p.id)) out.set(p.id, a.id);
  return out;
}

export function meshFrameSize(
  f: MeshFrame,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
  collapsed: ReadonlySet<string> = EMPTY_DETACHED,
): { w: number; h: number } {
  const aCards = framedAgentCards(f, detached, collapsed);
  const ne = f.engines.filter((e) => !detached.has(e.id)).length;
  const agentsH = aCards.length > 0 ? SECTION_H + aCards.reduce((s, c) => s + c.h, 0) + (aCards.length - 1) * NODE_GAP : 0;
  const enginesH = ne > 0 ? SECTION_H + ne * ENGINE_H + (ne - 1) * NODE_GAP : 0;
  const seam = agentsH > 0 && enginesH > 0 ? NODE_GAP : 0;
  return { w: FRAME_W, h: FRAME_PAD + f.headerH + agentsH + seam + enginesH + FRAME_PAD };
}

const EMPTY_DETACHED: ReadonlySet<string> = new Set();

/** Children's positions RELATIVE to the frame (the agent stack — daemons
 *  with their profile cards — then engines). Detached resources are NOT in
 *  the map — they are their own boxes (see layoutMesh) and the framed stack
 *  closes the gap they left. */
export function meshChildOffsets(
  f: MeshFrame,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
  collapsed: ReadonlySet<string> = EMPTY_DETACHED,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const agents = framedAgentCards(f, detached, collapsed);
  const engines = f.engines.filter((e) => !detached.has(e.id));
  let y = FRAME_PAD + f.headerH;
  if (agents.length > 0) {
    y += SECTION_H;
    for (const a of agents) {
      out.set(a.id, { x: FRAME_PAD, y });
      y += a.h + NODE_GAP;
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

/** The Projects stack's box (fixed math like every other box): the header
 *  IS the section label, then one card per project at its OWN computed
 *  height (running jobs listed, the DRAIN law), no measuring. */
export function projectsBoxSize(projects: MeshProjectSlot[]): { w: number; h: number } {
  const n = projects.length;
  const cards = n > 0 ? projects.reduce((a, p) => a + p.h, 0) + (n - 1) * NODE_GAP : 0;
  return { w: FRAME_W, h: FRAME_PAD + PROJECTS_HEADER_H + cards + FRAME_PAD };
}

/** Project cards' positions RELATIVE to the Projects box (the same in-view
 *  child posture the frame uses — the box is laid out, its cards offset). */
export function meshProjectOffsets(projects: MeshProjectSlot[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  let y = FRAME_PAD + PROJECTS_HEADER_H;
  for (const p of projects) {
    out.set(p.id, { x: FRAME_PAD, y });
    y += p.h + NODE_GAP;
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
 *  by its cards), no edges read.
 *  The fleet-side Projects box (owner ask 2026-10-21) is one more top-level
 *  box in both modes — rank places it upstream via its drain joins, row gives
 *  it the LAST column; folded gateways' hidden profile cards are no boxes at
 *  all (their pipes rank as the gateway's). */
export function layoutMesh(
  graph: MeshGraph,
  mode: MeshLayoutMode,
  detached: ReadonlySet<string> = EMPTY_DETACHED,
  collapsed: ReadonlySet<string> = EMPTY_DETACHED,
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
    const framedEngines = f.engines.filter((e) => !detached.has(e.id));
    const outAgents = f.agents.filter((a) => detached.has(a.id));
    const outEngines = f.engines.filter((e) => detached.has(e.id));
    const isChip = machineShape(f, detached) === "chip";
    const rep: Box = isChip
      ? { id: f.id, w: CHIP_W, h: f.headerH } // rep keyed by machine id
      : { id: f.id, ...meshFrameSize(f, detached, collapsed) };
    const members: Box[] = [];
    // Every card still framed (daemons AND their profile cards) rides the
    // machine's box; a floating card is its own box, sized to itself. A
    // folded gateway's DOCKED profile cards are hidden (folded out of the
    // box, not floated): they appear in neither the stack nor the members.
    for (const c of framedAgentCards(f, detached, collapsed)) boxOf.set(c.id, f.id);
    // A folded gateway's HIDDEN profile cards ride its box for ranking too:
    // their pipes re-anchor onto the gateway card (foldReanchorFor), so the
    // flow pulls rank exactly like the gateway's own pipes.
    for (const a of f.agents)
      if (collapsed.has(a.id)) for (const p of a.profiles) if (!detached.has(p.id)) boxOf.set(p.id, f.id);
    for (const e of framedEngines) boxOf.set(e.id, f.id);
    for (const a of outAgents) {
      members.push({ id: a.id, w: CARD_W, h: a.h });
      boxOf.set(a.id, a.id);
    }
    for (const a of f.agents)
      for (const p of a.profiles)
        if (detached.has(p.id)) {
          members.push({ id: p.id, w: CARD_W, h: p.h });
          boxOf.set(p.id, p.id);
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
    // The fleet-side Projects column reads LAST in the row (the row's promise
    // is machine order, This Machine first — the queue stack does not lead it).
    if (graph.projects.length > 0) out.set(PROJECTS_BOX_ID, { x, y: 0 });
    return out;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 55, ranksep: 150, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const allBoxes = groups.flatMap((grp) => [grp.rep, ...grp.members]);
  // The Projects stack rides rank mode as one fleet-side box: no machine owns
  // it, so it joins the ranking only through its drain joins (below) — a
  // stack with no named machine simply sits in the leftmost rank.
  if (graph.projects.length > 0) allBoxes.push({ id: PROJECTS_BOX_ID, ...projectsBoxSize(graph.projects) });
  for (const b of allBoxes) g.setNode(b.id, { width: b.w, height: b.h });

  // Ranking edges. Control edges (weight 3) run machine-box → machine-box; the
  // machine box is the frame whenever a child stays inside, the chip once the
  // whole machine floated out (same id).
  for (const c of graph.controls) {
    if (g.hasNode(c.from) && g.hasNode(c.to) && c.from !== c.to) g.setEdge(c.from, c.to, { weight: 3 });
  }
  // Projects pull (weight 1; weight 2 where a job is RUNNING — the DRAIN
  // law's chains): the stack ranks UPSTREAM of every machine whose gateway
  // drains its queue (the exact worker.client_id join) AND of every machine
  // actually running one of its leases (the lease's OWN client_id join — a
  // running job needs no worker-row join to name its machine). The queued-
  // only pulls are layout placement ONLY; a machine actually running the
  // queue also gets the drawn drain chains (project ⇢ gateway ⇢ engine),
  // which rank through these same weighted pairs.
  const runningFrames = new Set<string>();
  for (const d of graph.drains) for (const f of graph.frames) if (f.agents.some((a) => a.id === d.to)) runningFrames.add(f.id);
  const pullTargets = new Set<string>([...graph.projects.flatMap((p) => p.machines), ...runningFrames]);
  for (const t of pullTargets) if (g.hasNode(t)) g.setEdge(PROJECTS_BOX_ID, t, { weight: runningFrames.has(t) ? 2 : 1 });
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

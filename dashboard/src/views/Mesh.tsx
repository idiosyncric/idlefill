import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import type { StateWord } from "@/lib/format";
import { compact } from "@/lib/fleet-stats";
import { hostLine } from "@/lib/mesh-stats";
import { pipeClass, type PipeEdge } from "@/lib/pipe-phases";
import {
  AGENT_H,
  CARD_W,
  CHIP_W,
  ENGINE_H,
  FRAME_PAD,
  PROFILE_ROWS_MAX,
  SECTION_H,
  buildMeshGraph,
  framedAgentCards,
  frameResourceIds,
  hostEdgesFor,
  layoutMesh,
  machineShape,
  meshChildOffsets,
  meshFrameSize,
  MODEL_SOURCE_NOTE,
  type MeshAgentSlot,
  type MeshEngineSlot,
  type MeshFlow,
  type MeshFrame,
  type MeshGraph,
  type MeshProfileSession,
  type MeshProfileSlot,
} from "@/lib/mesh-graph";
import {
  MESH_LAYERS,
  applyMeshView,
  defaultMeshPrefs,
  emptyMeshTally,
  sanitizeMeshPrefs,
  sanitizeMeshViews,
  type MeshLayer,
  type MeshViewMode,
  type MeshViewPrefs,
  type SavedMeshView,
} from "@/lib/mesh-view";
import type { StateSnapshot } from "@/lib/api";

// ---------------------------------------------------------------------------
// Mesh — the whole fleet as one graph (React Flow). The hierarchy the
// operator reads off the page: MACHINES are the frames; inside each frame
// its AGENTS stack above the ENGINES it hosts (the lib/hierarchy.ts joins,
// exact, never guessed). The agent stack is per-profile since the owner ask
// 2026-10-19: each daemon card is followed by one card per published roster
// profile, its live sessions LISTED inside the card — and the session's
// pipe starts at the profile card when the gateway-ledger provenance stamp
// names it exactly (no stamp / no roster match → the pipe stays on the
// daemon card, counted there as "no profile named"). Edges:
//   · FLOW edges (agent/profile card → engine card) reuse the Sessions flow
//     vocabulary untouched — lib/pipe-phases.ts decides the color and motion
//     (queued warn · thinking green · output blue · tools purple · base
//     hairline, motion only on a live stream) and the tooltip is the SAME
//     pipeTitle the session row shows, extended ONLY with facts the row
//     itself names: the model (ledger stamp → operator pin → router sniff,
//     the source worded) and idlefill's alias when a model_aliases winner
//     joins this engine row + model name EXACTLY. Listed rows spell the
//     chain: session ⇢ alias/model ⇢ engine. A cross-machine session (an
//     agent here, an engine on another machine) is one visible arc between
//     frames.
//   · CONTROL edges (frame → frame) draw the pairing direction: the arrow
//     points AT the controlled machine (fleet.md D4, `from controls to`).
//
// Honesty, unchanged: engine slots show only published facts (absent keys
// render nothing), a stale load sample dims the slot and keeps the value,
// a session whose client or engine row names no node is NOT drawn (counted
// in the "not shown" line, never anchored by guess), a peer's own numbers
// ride its frame labelled as the peer's report, and unhosted engine rows
// stay out of the picture with the count named.
//
// Layout: Rank (dagre layered left→right — machines that feed engines
// elsewhere rank upstream), Row (one line, This Machine first), Free (drag
// frames anywhere; positions persist in this browser). And BREAKOUT, per
// CARD: a machine's agents and engines can each float free as their own
// nodes (each floating card carries its "on <machine>" chip, tied back by a
// dim hosts edge). Break them out all at once with the frame's "break out"
// button, one at a time with the ⌘-drag gesture: hold super and drag a card
// OUT of its machine to dock it free, or drag a floating card back ONTO its
// machine to tuck it home. A machine whose every card floats shrinks to its
// chip ("dock" brings them all back); a partially broken one stays a frame
// sized to the cards still inside. Mixed states are fine.
// The 5s poll refreshes the DATA; positions stay put, so nothing jumps
// while you work in the canvas. Layout/breakout/positions live in
// localStorage, same posture as the tab prefs.
//
// SIDEBAR (lib/mesh-view.ts does the filtering): LAYERS toggle whole
// element classes (agent cards, engine cards, flow pipes, control edges,
// hosts hairlines); the TREE is a Fusion-style OUTLINER of the nesting —
// fleet → machine → agents/engines → profile cards under their daemon →
// the running sessions listed on the card the pipe starts from (daemon-held
// sessions spelled as the hop: agent → engine) — with an eye
// per row (hide one machine / card / pipe) and an ISOLATE button (◎/◉)
// that keeps one element and its HOPS on the canvas (a session's isolate
// is exactly its daemon, its pipe and the engine it is routed to, across
// machines when it crosses). What the lens hides is NAMED, never a silent
// gap. Saved VIEWS store a lens (incl. the isolate) + a layout mode (posi-
// tions stay the browser's single map — a view picks the lens, not the
// coordinates). All of it rides localStorage like the layout pick.
// ---------------------------------------------------------------------------

const MODE_KEY = "idlefill.meshLayout";
const POS_KEY = "idlefill.meshPos";
const BROKEN_KEY = "idlefill.meshBroken";
const VIEW_KEY = "idlefill.meshView";
const VIEWS_KEY = "idlefill.meshViews";
type Mode = MeshViewMode;

const TONE: Record<StateWord["tone"], string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

// The pipe phase colors, resolved through the themeable --pipe-* vars
// (inline style so react-flow's own edge CSS never out-specifies them).
const PIPE_STROKE: Record<PipeEdge["phase"], string> = {
  base: "var(--pipe-base)",
  queued: "var(--pipe-queued)",
  thinking: "var(--pipe-thinking)",
  output: "var(--pipe-output)",
  tools: "var(--pipe-tools)",
};

type FrameData = { kind: "machine"; frame: MeshFrame; detached: ReadonlySet<string>; onAction: (name: string) => void };
type ChipData = { kind: "chip"; frame: MeshFrame; onAction: (name: string) => void };
type EngineData = { kind: "engine"; engine: MeshEngineSlot; detached: boolean };
type AgentData = { kind: "agent"; agent: MeshAgentSlot; detached: boolean };
type ProfileData = { kind: "profile"; profile: MeshProfileSlot; detached: boolean };
type FlowData = { pipe: PipeEdge; title: string; curvature: number; offset: number };
type ControlData = { label: string };
type HostData = { label: string };

// --- node components -------------------------------------------------------

function PresenceDot({ word }: { word: StateWord }) {
  const bg =
    word.tone === "ok" ? "bg-ok" : word.tone === "warn" ? "bg-warn" : word.tone === "err" ? "bg-err" : "bg-dim/60";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${bg}`} title={word.note} />;
}

/** The machine's glance block — the name row and the exception-only lines.
 *  Rendered identically inside the frame and on the broken-out chip, so a
 *  machine says exactly the same thing in either state. */
function MachineInfo({ f, action }: { f: MeshFrame; action?: ReactNode }) {
  const host = hostLine(f.host);
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <PresenceDot word={f.word} />
        <span className="truncate font-mono text-[13px] font-semibold tracking-[0.5px]">{f.name}</span>
        <span className={`text-[11px] ${TONE[f.word.tone]}`}>{f.word.label}</span>
        {f.local && <span className="rounded-pill border border-border px-1.5 text-[10px] text-dim">this page</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {f.version && <span className="text-[10px] text-dim">v{f.version}</span>}
          {action}
        </span>
      </div>
      <div className="px-3 pt-1 text-[11px] leading-[1.6] text-dim">
        <div>
          {f.counts.engines} {f.counts.engines === 1 ? "engine" : "engines"} · {f.counts.agents}{" "}
          {f.counts.agents === 1 ? "agent" : "agents"} · {f.counts.sessions} sessions
        </div>
        {host && <div title="the machine's own host facts">{host}</div>}
        {f.reported && (
          <div title="the peer's own published counts — attributed, never merged with the joins above">
            peer reports: {f.reported.queued} queued · {f.reported.sessions} sessions · {f.reported.leases} leases
          </div>
        )}
        {f.reportedEngines.length > 0 && (
          <div title="engines that machine reports that this arbiter does not watch as a row">
            not watched here: {f.reportedEngines.map((e) => `${e.name} (${e.word.label})`).join(", ")}
          </div>
        )}
        {f.controls.length > 0 && <div className="text-accent/80">controls {f.controls.join(", ")}</div>}
        {f.controlledBy.length > 0 && <div className="text-accent/60">controlled by {f.controlledBy.join(", ")}</div>}
        {f.note && <div className="text-warn">{f.note}</div>}
      </div>
    </>
  );
}

function MachineNode({ data }: NodeProps) {
  const { frame: f, detached, onAction } = data as unknown as FrameData;
  // The section hairline labels sit exactly above the first card of each
  // framed section — the same offsets the layout used (detached cards are
  // gone from the stack), so they never drift.
  const offsets = meshChildOffsets(f, detached);
  // The agents section starts at the first card of the framed agent stack —
  // a daemon or, when the daemon floated out, its first profile card.
  const firstAgentCard = framedAgentCards(f, detached)[0];
  const agentOff = firstAgentCard ? offsets.get(firstAgentCard.id) : undefined;
  const engineOff = f.engines.map((e) => offsets.get(e.id)).find((o): o is { x: number; y: number } => !!o);
  const ids = frameResourceIds(f);
  const breakable = ids.length > 0;
  const nDetached = ids.filter((id) => detached.has(id)).length;
  return (
    <div className={`mesh-frame h-full w-full ${f.online ? "" : "opacity-55"}`}>
      <MachineInfo
        f={f}
        action={
          breakable ? (
            <button
              className="mesh-pop nodrag nopan"
              title={
                nDetached === 0
                  ? "break this machine's agents and engines out into their own nodes"
                  : "put every floating card of this machine back into the frame"
              }
              onClick={() => onAction(f.name)}
            >
              {nDetached === 0 ? "break out" : "dock all"}
            </button>
          ) : undefined
        }
      />
      {agentOff && (
        <div className="mesh-section" style={{ top: agentOff.y - SECTION_H + 4 }}>
          agents
        </div>
      )}
      {engineOff && (
        <div className="mesh-section" style={{ top: engineOff.y - SECTION_H + 4 }}>
          engines
        </div>
      )}
      {/* Control edges attach to the frame sides; a partially broken frame
          draws its hosts edges from the bottom, same as the chip. */}
      <Handle id="ctl-l" type="target" position={Position.Left} className="mesh-handle" />
      <Handle id="ctl-r" type="source" position={Position.Right} className="mesh-handle" />
      <Handle id="host-b" type="source" position={Position.Bottom} className="mesh-handle" />
    </div>
  );
}

/** A machine whose EVERY resource floats free: the same glance block, minus
 *  the containment. Its cards ride dim hosts edges back to this chip's
 *  bottom handle; a dock button tucks them all back in. */
function ChipNode({ data }: NodeProps) {
  const { frame: f, onAction } = data as unknown as ChipData;
  const breakable = f.agents.length + f.engines.length > 0;
  return (
    <div className={`mesh-card h-full w-full ${f.online ? "" : "opacity-55"}`}>
      <MachineInfo
        f={f}
        action={
          breakable ? (
            <button
              className="mesh-pop nodrag nopan"
              title="put this machine's agents and engines back into a frame"
              onClick={() => onAction(f.name)}
            >
              dock
            </button>
          ) : undefined
        }
      />
      <Handle id="ctl-l" type="target" position={Position.Left} className="mesh-handle" />
      <Handle id="ctl-r" type="source" position={Position.Right} className="mesh-handle" />
      <Handle id="host-b" type="source" position={Position.Bottom} className="mesh-handle" />
    </div>
  );
}

function EngineNode({ data }: NodeProps) {
  const { engine: e, detached } = data as unknown as EngineData;
  const util = e.gpuUtil;
  const barTone = util === null ? "" : util < 50 ? "bg-ok" : util < 80 ? "bg-warn" : "bg-err";
  const parts: string[] = [];
  if (e.inFlight !== null && e.inFlight > 0) parts.push(`${e.inFlight} in flight`);
  if (e.queueDepth !== null && e.queueFresh && e.queueDepth > 0) parts.push(`q ${e.queueDepth}`);
  if (e.tps !== null && e.tps > 0) parts.push(`${Math.round(e.tps)} tok/s`);
  if (util !== null) parts.push(`gpu ${Math.round(util)}%`);
  return (
    <div className={`mesh-card h-full w-full ${e.stale ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <PresenceDot word={e.word} />
        <span className="truncate font-mono text-[12px] font-semibold">{e.name}</span>
        {detached && (
          <span className="shrink-0 text-[10px] text-dim" title={`this engine is hosted on ${e.machine} (exact join)`}>
            on {e.machine.toLowerCase()}
          </span>
        )}
        <span className={`ml-auto shrink-0 text-[11px] ${TONE[e.word.tone]}`}>{e.word.label}</span>
      </div>
      {e.loadedModel && (
        <div className="truncate px-2.5 pt-0.5 text-[11px] text-accent" title="model loaded now">
          {e.loadedModel}
          {e.modelsLoaded > 1 ? ` +${e.modelsLoaded - 1}` : ""}
        </div>
      )}
      <div className="truncate px-2.5 pt-0.5 text-[11px] text-dim">
        {parts.length > 0 ? parts.join(" · ") : `${e.modelsTotal} models`}
        {e.stale && " · sample aging"}
        {!e.watched && " · not watched"}
      </div>
      {util !== null && (
        <div
          className="mx-2.5 mt-1.5 h-[3px] overflow-hidden rounded-pill bg-border/50"
          title={`gpu util ${Math.round(util)}%`}
        >
          <div className={`h-full ${barTone}`} style={{ width: `${Math.min(100, util)}%` }} />
        </div>
      )}
      <Handle id="eng-l" type="target" position={Position.Left} className="mesh-handle" />
      {detached && <Handle id="host-t" type="target" position={Position.Top} className="mesh-handle" />}
    </div>
  );
}

function AgentNode({ data }: NodeProps) {
  const { agent: a, detached } = data as unknown as AgentData;
  const word: StateWord = a.override
    ? {
        label: a.override === "pause" ? "paused" : "forced",
        tone: a.override === "pause" ? "warn" : "accent",
        note: "operator override",
      }
    : a.online
      ? { label: "online", tone: "ok", note: "heartbeat under 90s" }
      : { label: "offline", tone: "dim", note: "last heartbeat over 90s ago" };
  const parts: string[] = [];
  if (a.projects > 0) parts.push(`${a.projects} ${a.projects === 1 ? "project" : "projects"}`);
  if (a.queueDepth > 0) parts.push(`${compact(a.queueDepth)} queued`);
  if (a.agents !== null && a.agents > 0) parts.push(`${a.agents} agents`);
  return (
    <div className={`mesh-card h-full w-full ${a.online ? "" : "opacity-55"}`}>
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <PresenceDot word={word} />
        <span className="truncate font-mono text-[12px] font-semibold">{a.name}</span>
        {detached && (
          <span className="shrink-0 text-[10px] text-dim" title={`this daemon runs on ${a.machine} (exact join)`}>
            on {a.machine.toLowerCase()}
          </span>
        )}
        <span className={`ml-auto shrink-0 text-[11px] ${TONE[word.tone]}`}>{word.label}</span>
      </div>
      <div className="truncate px-2.5 pt-0.5 text-[11px] text-dim">
        {parts.length > 0 ? parts.join(" · ") : "idle"}
        {a.unprofiled > 0 && (
          <span title="live sessions this daemon runs whose gateway-ledger provenance names no roster profile — their pipes start here, not on a profile card">
            {" "}
            · {a.unprofiled} no profile named
          </span>
        )}
        {a.behind && <span className="text-warn"> · daemon behind</span>}
      </div>
      <Handle id="agt-r" type="source" position={Position.Right} className="mesh-handle" />
      {detached && <Handle id="host-t" type="target" position={Position.Top} className="mesh-handle" />}
    </div>
  );
}

/** One live session LISTED on its profile card — the same pipe facts the
 *  flow edge carries (dot color = the pipe phase, tooltip = the shared
 *  pipeTitle). Writes (gate, pin) stay on the Sessions tab. */
function ProfileSessionLine({ s }: { s: MeshProfileSession }) {
  const mid = s.alias ?? s.model; // the idlefill abstraction when it joins, else the row's model name
  return (
    <div
      className="flex h-[15px] items-center gap-1.5 overflow-hidden px-2.5 text-[10px]"
      title={`${s.title}${s.cross ? " · crosses machines" : ""} — nests here on the gateway ledger's provenance stamp`}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: PIPE_STROKE[s.phase], opacity: s.muted ? 0.45 : s.phase === "queued" ? 0.8 : 1 }}
      />
      <span className="shrink-0 font-mono text-dim">{s.shortToken}</span>
      {mid && (
        <>
          <span className="shrink-0 text-accent/70">⇢</span>
          <span className="min-w-0 shrink truncate text-accent/90" title={s.alias ? "idlefill alias — resolves on the engine" : undefined}>
            {mid}
          </span>
        </>
      )}
      <span className="shrink-0 text-accent/70">⇢</span>
      <span className="min-w-0 truncate font-mono">{s.engineName}</span>
    </div>
  );
}

/** One Hermes profile as its OWN card: the roster posture, and the live
 *  sessions whose provenance stamp names it listed underneath. */
function ProfileNode({ data }: NodeProps) {
  const { profile: p, detached } = data as unknown as ProfileData;
  const anyStream = p.sessions.some((s) => s.animated);
  const anyQueued = p.sessions.some((s) => s.phase === "queued");
  const word: StateWord =
    p.sessions.length === 0
      ? { label: "idle", tone: "dim", note: "no live session's provenance stamp names this profile" }
      : anyStream
        ? { label: "live", tone: "ok", note: "a session on this profile is streaming" }
        : anyQueued
          ? { label: "waiting", tone: "warn", note: "a session on this profile is held at the router" }
          : { label: "active", tone: "ok", note: "live session(s) on this profile (no fresh stream signal)" };
  const shown = p.sessions.slice(0, PROFILE_ROWS_MAX);
  const more = p.sessions.length - shown.length;
  const posture = p.posture === "adopted" ? "idlefill" : p.posture === "external" ? "elsewhere" : "no config";
  return (
    <div className="mesh-card h-full w-full">
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5">
        <PresenceDot word={word} />
        <span className="truncate font-mono text-[11px] font-semibold" title={`Hermes profile · published by the daemon above`}>
          {p.name}
        </span>
        {detached && (
          <span className="shrink-0 text-[10px] text-dim" title={`this profile's daemon runs on ${p.machine} (exact join)`}>
            on {p.machine.toLowerCase()}
          </span>
        )}
        <span
          className={`shrink-0 text-[9px] ${p.posture === "adopted" ? "text-accent" : "text-dim/70"}`}
          title={`roster posture: ${p.posture}${p.posture === "adopted" ? " — routes through idlefill" : ""}`}
        >
          {posture}
        </span>
        <span className={`ml-auto shrink-0 text-[10px] ${TONE[word.tone]}`} title={word.note}>
          {p.sessions.length > 0 ? `${p.sessions.length} ${p.sessions.length === 1 ? "session" : "sessions"}` : word.label}
        </span>
      </div>
      {shown.map((s) => (
        <ProfileSessionLine key={s.flowId} s={s} />
      ))}
      {more > 0 && <div className="h-[15px] px-2.5 text-[10px] text-dim/70">+{more} more (Sessions tab)</div>}
      <Handle id="agt-r" type="source" position={Position.Right} className="mesh-handle" />
      {detached && <Handle id="host-t" type="target" position={Position.Top} className="mesh-handle" />}
    </div>
  );
}

const nodeTypes = { machine: MachineNode, chip: ChipNode, engine: EngineNode, agent: AgentNode, profile: ProfileNode };

// --- edge components -------------------------------------------------------

function FlowEdgeView(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const d = data as unknown as FlowData;
  // Parallel sessions between the same pair share both endpoints, so the
  // fan-out shifts both ends equally — the curves stay parallel.
  const [path] = getBezierPath({
    sourceX,
    sourceY: sourceY + d.offset,
    sourcePosition: Position.Right,
    targetX,
    targetY: targetY + d.offset,
    targetPosition: Position.Left,
    curvature: d.curvature,
  });
  return (
    <>
      <BaseEdge
        path={path}
        interactionWidth={12}
        className={pipeClass(d.pipe)}
        style={{
          stroke: PIPE_STROKE[d.pipe.phase],
          strokeWidth: d.pipe.animated ? 2.2 : 1.6,
          strokeDasharray: d.pipe.dashed ? "5 4" : d.pipe.muted ? "2 3" : undefined,
          opacity: d.pipe.muted ? 0.5 : 1,
        }}
      />
      <title>{d.title}</title>
    </>
  );
}

function ControlEdgeView(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const d = data as unknown as ControlData;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
    borderRadius: 8,
    offset: 24,
  });
  return (
    <>
      <BaseEdge path={path} interactionWidth={12} style={{ stroke: "var(--accent)", strokeWidth: 1.2, opacity: 0.7 }} />
      {/* The arrow lands horizontal (it enters the target's left handle). */}
      <polygon
        points="0,-4 8,0 0,4"
        transform={`translate(${targetX - 8},${targetY})`}
        fill="var(--accent)"
        opacity={0.9}
      />
      <title>{`paired control — from controls to (${d.label})`}</title>
      <EdgeLabelRenderer>
        <div className="mesh-control-label nodrag nopan" style={{ left: labelX, top: labelY }}>
          {d.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** The dim hairline a machine draws to each of its floating cards: machine
 *  box (frame or chip) bottom → card top. Attribution, not traffic —
 *  deliberately quieter than every flow pipe. */
function HostEdgeView(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const d = data as unknown as HostData;
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Bottom,
    targetX,
    targetY,
    targetPosition: Position.Top,
    curvature: 0.4,
  });
  return (
    <>
      <BaseEdge
        path={path}
        interactionWidth={8}
        style={{ stroke: "var(--border)", strokeWidth: 1, strokeDasharray: "1 4", opacity: 0.9 }}
      />
      <title>{d.label}</title>
    </>
  );
}

const edgeTypes = { flow: FlowEdgeView, control: ControlEdgeView, host: HostEdgeView };

// --- persistence ------------------------------------------------------------

function readMode(): Mode {
  const raw = localStorage.getItem(MODE_KEY);
  return raw === "row" || raw === "free" || raw === "rank" ? raw : "rank";
}
function readPos(): Map<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, { x: number; y: number }>));
  } catch {
    return new Map();
  }
}
// A floating resource CARD id is "eng:<server>"/"agt:<client>"; legacy
// stored values were machine NAMES — the view expands those once the graph
// is drawn, and the first write persists the new spelling.
function readBroken(): Set<string> {
  try {
    const raw = localStorage.getItem(BROKEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}
// The sidebar lens (layers + hidden elements) and the saved views ride the
// same localStorage posture; BOTH sanitize on read — a hand-edited or stale
// entry yields the default lens, never a crash or a half-trusted shape.
function readPrefs(): MeshViewPrefs {
  try {
    return sanitizeMeshPrefs(JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null"));
  } catch {
    return defaultMeshPrefs();
  }
}
function writePrefs(prefs: MeshViewPrefs) {
  localStorage.setItem(VIEW_KEY, JSON.stringify(prefs));
}
function readViews(): SavedMeshView[] {
  try {
    return sanitizeMeshViews(JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "null"));
  } catch {
    return [];
  }
}
function writeViews(views: SavedMeshView[]) {
  localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
}

const LAYER_LABEL: Record<MeshLayer, string> = {
  agents: "agents",
  engines: "engines",
  flows: "flow pipes",
  controls: "control edges",
  hosts: "hosts hairlines",
};
const LAYER_HINT: Record<MeshLayer, string> = {
  agents: "show the client-daemon cards and their profile cards (their flow pipes drop with them)",
  engines: "show the inference-engine cards (their flow pipes drop with them)",
  flows: "show the session pipes between agents and engines",
  controls: "show the paired-control arrows between machines",
  hosts: 'show the dim hairlines tying broken-out cards back to their machine',
};

/** The outliner's ISOLATE button (◎ / ◉ when active): one element's
 *  subtree + hops on the canvas, everything else counted away. Clicking
 *  the active one clears the isolate. */
function IsoBtn({ active, title, onClick }: { active: boolean; title: string; onClick: () => void }) {
  return (
    <button
      className={`shrink-0 px-0.5 leading-none ${active ? "text-accent" : "text-dim/40 hover:text-text"}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {active ? "◉" : "◎"}
    </button>
  );
}

// --- the canvas (inside the provider: fitView on first draw + on layout
// picks only — the 5s data poll NEVER re-centers the view) -------------------

function Canvas({
  graph,
  mode,
  tick,
  detached,
  detachedKey,
  showHosts,
  isoKey,
  onMachineAction,
  onSetResource,
  onDragged,
}: {
  graph: MeshGraph | null;
  mode: Mode;
  tick: number;
  detached: ReadonlySet<string>;
  detachedKey: string;
  showHosts: boolean;
  isoKey: string;
  onMachineAction: (name: string) => void;
  onSetResource: (id: string, on: boolean) => void;
  onDragged: (id: string, pos: { x: number; y: number }) => Map<string, { x: number; y: number }>;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const rf = useReactFlow();
  const fitted = useRef(false);
  const dragPos = useRef<Map<string, { x: number; y: number }>>(readPos());
  // SUPER (⌘) held = the dock/undock gesture is armed: resource cards become
  // draggable (framed children leave their "parent" extent so they can be
  // pulled out). Releases are deferred while a drag is in flight so a
  // mid-drag key release never rebuilds the canvas under the pointer.
  const [superHeld, setSuperHeld] = useState(false);
  const draggingRef = useRef(false);
  const pendingSuper = useRef<boolean | null>(null);
  // Bumped to re-run the build after an inconclusive gesture (the dragged
  // card snaps back home instead of hanging where it was dropped).
  const [gesture, setGesture] = useState(0);

  useEffect(() => {
    const apply = (on: boolean) => {
      if (draggingRef.current) pendingSuper.current = on;
      else setSuperHeld(on);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta") apply(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta") apply(false);
    };
    const blur = () => apply(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    dragPos.current = readPos();
  }, [tick]);

  // resource node id → its machine's box id: the ONLY legal dock target (a
  // card belongs to its machine by the hierarchy's exact join — membership
  // never follows the drop).
  const machineOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of graph?.frames ?? []) for (const id of frameResourceIds(f)) m.set(id, f.id);
    return m;
  }, [graph]);

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const auto = layoutMesh(graph, mode === "free" ? "rank" : mode, detached);
    const next: Node[] = [];
    const resDraggable = mode === "free" || superHeld; // floating cards: free-move, or super-dock
    const childDraggable = superHeld; // framed cards: draggable ONLY for the gesture
    for (const f of graph.frames) {
      const isChip = machineShape(f, detached) === "chip";
      const pos = (mode === "free" ? dragPos.current.get(f.id) : undefined) ?? auto.get(f.id) ?? { x: 0, y: 0 };
      const size = isChip ? { w: CHIP_W, h: f.headerH } : meshFrameSize(f, detached);
      next.push({
        id: f.id,
        type: isChip ? "chip" : "machine",
        position: pos,
        width: size.w,
        height: size.h,
        draggable: mode === "free",
        selectable: false,
        data: isChip
          ? { kind: "chip", frame: f, onAction: onMachineAction } satisfies ChipData
          : { kind: "machine", frame: f, detached, onAction: onMachineAction } satisfies FrameData,
      });
      // Cards still inside the frame (never when the whole machine floats).
      if (!isChip) {
        const offsets = meshChildOffsets(f, detached);
        for (const a of f.agents) {
          if (!detached.has(a.id))
            next.push({
              id: a.id,
              type: "agent",
              position: offsets.get(a.id) ?? { x: FRAME_PAD, y: FRAME_PAD },
              parentId: f.id,
              extent: superHeld ? undefined : "parent",
              width: CARD_W,
              height: AGENT_H,
              draggable: childDraggable,
              selectable: false,
              data: { kind: "agent", agent: a, detached: false } satisfies AgentData,
            });
          // The daemon's roster profiles: each its own card, nested under
          // it in the same frame (containment — the exact roster join).
          for (const p of a.profiles)
            if (!detached.has(p.id))
              next.push({
                id: p.id,
                type: "profile",
                position: offsets.get(p.id) ?? { x: FRAME_PAD, y: FRAME_PAD },
                parentId: f.id,
                extent: superHeld ? undefined : "parent",
                width: CARD_W,
                height: p.h,
                draggable: childDraggable,
                selectable: false,
                data: { kind: "profile", profile: p, detached: false } satisfies ProfileData,
              });
        }
        for (const e of f.engines)
          if (!detached.has(e.id))
            next.push({
              id: e.id,
              type: "engine",
              position: offsets.get(e.id) ?? { x: FRAME_PAD, y: FRAME_PAD },
              parentId: f.id,
              extent: superHeld ? undefined : "parent",
              width: CARD_W,
              height: ENGINE_H,
              draggable: childDraggable,
              selectable: false,
              data: { kind: "engine", engine: e, detached: false } satisfies EngineData,
            });
      }
      // Cards floating free of their machine (all of them for a chip, some
      // of them for a partially broken-out frame).
      for (const a of f.agents) {
        if (detached.has(a.id))
          next.push({
            id: a.id,
            type: "agent",
            position: (mode === "free" ? dragPos.current.get(a.id) : undefined) ?? auto.get(a.id) ?? { x: 0, y: 0 },
            width: CARD_W,
            height: AGENT_H,
            draggable: resDraggable,
            selectable: false,
            data: { kind: "agent", agent: a, detached: true } satisfies AgentData,
          });
        for (const p of a.profiles)
          if (detached.has(p.id))
            next.push({
              id: p.id,
              type: "profile",
              position: (mode === "free" ? dragPos.current.get(p.id) : undefined) ?? auto.get(p.id) ?? { x: 0, y: 0 },
              width: CARD_W,
              height: p.h,
              draggable: resDraggable,
              selectable: false,
              data: { kind: "profile", profile: p, detached: true } satisfies ProfileData,
            });
      }
      for (const e of f.engines)
        if (detached.has(e.id))
          next.push({
            id: e.id,
            type: "engine",
            position: (mode === "free" ? dragPos.current.get(e.id) : undefined) ?? auto.get(e.id) ?? { x: 0, y: 0 },
            width: CARD_W,
            height: ENGINE_H,
            draggable: resDraggable,
            selectable: false,
            data: { kind: "engine", engine: e, detached: true } satisfies EngineData,
          });
    }
    const nextEdges: Edge[] = [];
    for (const c of graph.controls) {
      nextEdges.push({
        id: c.id,
        source: c.from,
        target: c.to,
        sourceHandle: "ctl-r",
        targetHandle: "ctl-l",
        type: "control",
        zIndex: 1,
        selectable: false,
        data: { label: "controls" } satisfies ControlData,
      });
    }
    for (const h of showHosts ? hostEdgesFor(graph, detached) : []) {
      nextEdges.push({
        id: h.id,
        source: h.from,
        target: h.to,
        sourceHandle: "host-b",
        targetHandle: "host-t",
        type: "host",
        zIndex: 0,
        selectable: false,
        data: { label: `${h.machine} hosts ${h.label.replace(/^hosts /, "")}` } satisfies HostData,
      });
    }
    for (const fl of graph.flows) {
      nextEdges.push({
        id: fl.id,
        source: fl.from,
        target: fl.to,
        sourceHandle: "agt-r",
        targetHandle: "eng-l",
        type: "flow",
        zIndex: 2,
        selectable: false,
        data: {
          pipe: fl.pipe,
          title: fl.cross ? `${fl.title} · crosses machines` : fl.title,
          curvature: fl.curvature,
          offset: fl.offset,
        } satisfies FlowData,
      });
    }
    setNodes(next);
    setEdges(nextEdges);
    if (!fitted.current && next.length > 0) {
      fitted.current = true;
      window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 300 }), 60);
    }
  }, [graph, mode, tick, detached, detachedKey, showHosts, superHeld, gesture, onMachineAction, setNodes, setEdges, rf]);

  // A layout pick, re-layout, a break/dock or an isolate change re-frames
  // the graph (a deliberate action).
  const framesLen = graph?.frames.length ?? 0;
  useEffect(() => {
    const id = window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 300 }), 60);
    return () => window.clearTimeout(id);
  }, [mode, tick, framesLen, detachedKey, isoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDrag = useCallback(
    (_: unknown, n: Node) => {
      if (n.parentId) return; // framed children never persist; top-level ones do
      dragPos.current = onDragged(n.id, n.position);
    },
    [onDragged],
  );

  const onDragStart = useCallback(() => {
    draggingRef.current = true;
  }, []);

  // Where the dragged card actually is in flow space (a framed child's
  // position is PARENT-relative — the parent is always top-level here).
  const absOf = useCallback(
    (n: Node) => {
      if (!n.parentId) return n.position;
      const p = rf.getNode(n.parentId);
      return p ? { x: p.position.x + n.position.x, y: p.position.y + n.position.y } : n.position;
    },
    [rf],
  );

  // The machine's box in flow space, from the same geometry the build used
  // (never from the DOM measure, which can lag the 5s data poll).
  const machineRect = useCallback(
    (machineId: string) => {
      const f = graph?.frames.find((fr) => fr.id === machineId);
      const n = rf.getNode(machineId);
      if (!f || !n) return null;
      const s = machineShape(f, detached) === "chip" ? { w: CHIP_W, h: f.headerH } : meshFrameSize(f, detached);
      return { x: n.position.x, y: n.position.y, w: s.w, h: s.h };
    },
    [graph, rf, detached],
  );

  const overBox = (cx: number, cy: number, b: { x: number; y: number; w: number; h: number }) =>
    cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;

  // The ⌘-gesture verdict on release: a framed card released OUTSIDE its
  // machine undocks; a floating card released over its OWN machine docks.
  // Membership never follows the drop — only the card's own machine accepts
  // it (the hierarchy's join, not a guess). Plain (no-super) releases never
  // change docking: free mode simply moves the card.
  const onDragStop = useCallback(
    (event: MouseEvent | TouchEvent, n: Node) => {
      draggingRef.current = false;
      saveDrag(event, n);
      const pending = pendingSuper.current;
      pendingSuper.current = null;
      if (pending !== null) setSuperHeld(pending);
      const meta = (event as MouseEvent).metaKey === true;
      if (!(meta || superHeld) || !graph) return;
      const abs = absOf(n);
      const cx = abs.x + CARD_W / 2;
      const cy = abs.y + (n.height ?? AGENT_H) / 2; // profile cards carry their own height
      if (n.parentId) {
        const box = machineRect(n.parentId);
        if (!box) return;
        if (overBox(cx, cy, box)) setGesture((g) => g + 1); // back home — snap to the framed stack
        else {
          dragPos.current = onDragged(n.id, abs); // remember where it was let go
          onSetResource(n.id, true);
        }
      } else {
        const machine = machineOf.get(n.id);
        const box = machine ? machineRect(machine) : null;
        if (box && overBox(cx, cy, box)) onSetResource(n.id, false);
        else if (mode !== "free") setGesture((g) => g + 1); // rank/row own the positions
      }
    },
    [graph, mode, superHeld, saveDrag, absOf, machineRect, machineOf, onDragged, onSetResource],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeDragStart={onDragStart}
      onNodeDrag={saveDrag}
      onNodeDragStop={onDragStop}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.12}
      maxZoom={1.8}
      fitView
      fitViewOptions={{ padding: 0.08 }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="var(--border)" />
      <MiniMap
        pannable
        zoomable
        maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
        nodeColor={(n) =>
          n.type === "machine" ? "#30363d" : n.type === "engine" ? "#58a6ff" : n.type === "profile" ? "#d29922" : "#3fb950"
        }
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// --- the view ---------------------------------------------------------------

export function Mesh({ st }: { st: StateSnapshot | null }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [tick, setTick] = useState(0);
  // BROKEN-OUT resource cards (per-card breakout, the ⌘-drag vocabulary):
  // agent/engine node ids floating as their own nodes instead of stacking
  // inside the frame. A view preference — persisted here in the browser,
  // like the layout pick. Legacy entries are machine NAMES; the memo below
  // expands them to that machine's resources once the graph exists, and the
  // first write persists the new spelling.
  const [brokenRaw, setBrokenRaw] = useState<Set<string>>(readBroken);
  // The SIDEBAR lens: layer visibility + individually hidden elements, and
  // the saved (named) views that store a lens + a layout mode. Persisted in
  // this browser like the layout pick; the sidebar reads/writes both.
  const [prefs, setPrefs] = useState<MeshViewPrefs>(readPrefs);
  const [views, setViews] = useState<SavedMeshView[]>(readViews);
  const [viewName, setViewName] = useState("");

  const graph: MeshGraph | null = useMemo(
    () => (st ? buildMeshGraph(st, st.now ?? Date.now()) : null),
    [st],
  );

  // The DRAWN graph. Everything downstream of here (layout, frames, edges,
  // the summary counts) reads the LENS-ed graph; the sidebar's element tree
  // reads the full `graph` so a hidden machine stays listed to be shown
  // again. What the lens dropped rides `tally`, named — never a silent gap.
  const lens = useMemo(() => (graph ? applyMeshView(graph, prefs) : null), [graph, prefs]);
  const viewGraph = lens?.graph ?? null;
  const tally = lens?.tally ?? emptyMeshTally();
  const isolatedLost = lens?.isolatedLost ?? false;

  const detached = useMemo(() => {
    const isResourceId = (t: string) => t.startsWith("eng:") || t.startsWith("agt:");
    if (!viewGraph || [...brokenRaw].every(isResourceId)) return brokenRaw;
    const out = new Set<string>();
    for (const t of brokenRaw) {
      if (isResourceId(t)) out.add(t);
      else {
        const f = viewGraph.frames.find((fr) => fr.name === t);
        if (f) for (const id of frameResourceIds(f)) out.add(id);
      }
    }
    return out;
  }, [brokenRaw, viewGraph]);
  const detachedKey = [...detached].sort().join("|");

  const setResources = useCallback(
    (ids: string[], on: boolean) => {
      const next = new Set(detached);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      localStorage.setItem(BROKEN_KEY, JSON.stringify([...next]));
      setBrokenRaw(next);
    },
    [detached],
  );
  // One card (the ⌘-drag gesture).
  const setResource = useCallback((id: string, on: boolean) => setResources([id], on), [setResources]);
  // A machine card's button: "break out" floats every resource, "dock"/
  // "dock all" brings every floating one home. Operates on the VISIBLE
  // graph: a hidden card cannot break out, and "dock all" never resurrects
  // one the operator hid.
  const machineAction = useCallback(
    (name: string) => {
      const f = viewGraph?.frames.find((fr) => fr.name === name);
      if (!f) return;
      const ids = frameResourceIds(f);
      setResources(ids, !ids.some((id) => detached.has(id)));
    },
    [viewGraph, detached, setResources],
  );

  // --- the sidebar lens -----------------------------------------------------
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs]);
  const toggleLayer = useCallback((l: MeshLayer) => {
    setPrefs((p) => {
      const next = { ...p, layers: { ...p.layers, [l]: !p.layers[l] } };
      writePrefs(next);
      return next;
    });
  }, []);
  const toggleHidden = useCallback((id: string) => {
    setPrefs((p) => {
      const next = {
        ...p,
        hidden: p.hidden.includes(id) ? p.hidden.filter((x) => x !== id) : [...p.hidden, id],
      };
      writePrefs(next);
      return next;
    });
  }, []);
  // ISOLATE (⊙, the outliner's command): set — or, clicking the isolated
  // row again, clear — the focus. Everything but the focus's subtree and
  // its hops drops out of the picture (and is counted, as always).
  const toggleIsolate = useCallback((id: string) => {
    setPrefs((p) => {
      const next = { ...p, isolated: p.isolated === id ? null : id };
      writePrefs(next);
      return next;
    });
  }, []);
  const showAll = useCallback(() => {
    const next = defaultMeshPrefs();
    writePrefs(next);
    setPrefs(next);
  }, []);
  const clearIsolate = useCallback(() => {
    setPrefs((p) => {
      const next = { ...p, isolated: null };
      writePrefs(next);
      return next;
    });
  }, []);
  const lensing =
    prefs.hidden.length > 0 || prefs.isolated !== null || !MESH_LAYERS.every((l) => prefs.layers[l]);
  // The isolate's NAME for the chip / summary line (read off the FULL
  // graph; null = the target is gone, which `isolatedLost` already names).
  const isolatedLabel = useMemo(() => {
    const id = prefs.isolated;
    if (!id || !graph) return null;
    const f = graph.frames.find((fr) => fr.id === id);
    if (f) return f.name;
    for (const fr of graph.frames) {
      const a = fr.agents.find((x) => x.id === id);
      if (a) return a.name;
      for (const ag of fr.agents) {
        const p = ag.profiles.find((x) => x.id === id);
        if (p) return `${p.name} → ${ag.name}`;
      }
      const e = fr.engines.find((x) => x.id === id);
      if (e) return e.name;
    }
    const fl = graph.flows.find((x) => x.id === id);
    if (fl) return `${fl.profile ?? fl.shortToken} → ${fl.engineName}`;
    return null;
  }, [prefs.isolated, graph]);
  // The outliner nests each session under the CARD the pipe starts from:
  // the profile card on the exact provenance join, otherwise the daemon
  // (the flow's OWN from-join — never a guessed grouping), and names the
  // engine's machine for the cross-machine hop note.
  const flowsByAgent = useMemo(() => {
    const m = new Map<string, MeshFlow[]>();
    for (const fl of graph?.flows ?? []) {
      const arr = m.get(fl.from);
      if (arr) arr.push(fl);
      else m.set(fl.from, [fl]);
    }
    return m;
  }, [graph]);
  const engineMachine = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of graph?.frames ?? []) for (const e of f.engines) m.set(e.id, f.name);
    return m;
  }, [graph]);
  // One outliner row for one session pipe — shared by the daemon's direct
  // children and by the profile cards (same hop vocabulary, same eye, same
  // isolate; `disabled` = an ancestor card is hidden).
  const flowLine = (fl: MeshFlow, disabled: boolean, label: ReactNode) => {
    const fhid = hiddenSet.has(fl.id);
    const em = engineMachine.get(fl.to);
    // The model clause reads exactly like the card row: the abstraction when
    // its winner join is unique, else the row's own model name, sourced.
    const modelText = fl.alias
      ? `alias ${fl.alias} → ${fl.model}`
      : fl.model
        ? `${fl.model} (${MODEL_SOURCE_NOTE[fl.modelSource!]})`
        : "model not named";
    return (
      <div key={fl.id} className="flex items-center gap-1 pl-7">
        <label
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[1px]"
          title={`${fl.shortToken} · ${modelText} → ${fl.engineName}${em ? ` on ${em}` : ""}${fl.cross ? " · crosses machines" : ""}`}
        >
          <input type="checkbox" checked={!fhid} disabled={disabled} onChange={() => toggleHidden(fl.id)} />
          <span className={`truncate font-mono text-[10px] ${fhid || disabled ? "text-dim line-through" : "text-dim"}`}>
            <span className="text-accent/70">⇢</span> {label}
          </span>
        </label>
        <IsoBtn
          active={prefs.isolated === fl.id}
          title="isolate — just this session's hop: its card, the pipe, the engine"
          onClick={() => toggleIsolate(fl.id)}
        />
      </div>
    );
  };

  // --- saved views ----------------------------------------------------------
  // A view stores the LENS (layers + hidden) and the layout MODE — not the
  // positions, which stay the browser's single stored map (a view picks the
  // lens, not the coordinates).
  const upsertView = useCallback(
    (name: string) => {
      const clean = name.trim().slice(0, 48);
      if (!clean) return;
      setViews((vs) => {
        const next = [...vs.filter((v) => v.name !== clean), { name: clean, mode, prefs }];
        writeViews(next);
        return next;
      });
    },
    [mode, prefs],
  );
  const saveView = useCallback(() => {
    upsertView(viewName);
    setViewName("");
  }, [upsertView, viewName]);
  const applyView = useCallback((v: SavedMeshView) => {
    setMode(v.mode);
    localStorage.setItem(MODE_KEY, v.mode);
    writePrefs(v.prefs);
    setPrefs(v.prefs);
  }, []);
  const deleteView = useCallback((name: string) => {
    setViews((vs) => {
      const next = vs.filter((v) => v.name !== name);
      writeViews(next);
      return next;
    });
  }, []);

  const onDragged = useCallback((id: string, pos: { x: number; y: number }) => {
    const map = readPos();
    map.set(id, pos);
    localStorage.setItem(POS_KEY, JSON.stringify(Object.fromEntries(map)));
    return map;
  }, []);

  const pickMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };
  const relayout = () => {
    localStorage.removeItem(POS_KEY);
    setTick((t) => t + 1);
  };

  // Counts read the DRAWN graph; what the lens hid is named separately
  // (honesty posture: a hidden element is accounted for, never absent).
  const engines = viewGraph?.frames.reduce((a, f) => a + f.engines.length, 0) ?? 0;
  const agents = viewGraph?.frames.reduce((a, f) => a + f.agents.length, 0) ?? 0;
  const profiles = viewGraph?.frames.reduce((a, f) => a + f.agents.reduce((x, ag) => x + ag.profiles.length, 0), 0) ?? 0;
  const brokenMachines = viewGraph?.frames.filter((f) => frameResourceIds(f).some((id) => detached.has(id))).length ?? 0;
  const liveFlows = viewGraph?.flows.length ?? 0;
  const held = viewGraph?.flows.filter((f) => f.pipe.phase === "queued").length ?? 0;
  const uf = viewGraph?.unflowed;
  const notShown = (uf?.noClient ?? 0) + (uf?.noEngine ?? 0) + (uf?.stale ?? 0);
  const hiddenElems = tally.machines + tally.agents + tally.engines;
  const hiddenEdges = tally.flows + tally.controls;

  const summary =
    `${viewGraph?.frames.length ?? 0} machines · ${engines} engines · ${agents} ${agents === 1 ? "daemon" : "daemons"} · ` +
    `${profiles} ${profiles === 1 ? "profile" : "profiles"} · ` +
    `${liveFlows} live ${liveFlows === 1 ? "flow" : "flows"}${held > 0 ? ` (${held} waiting)` : ""}` +
    (prefs.isolated !== null
      ? ` · ⊙ isolated: ${isolatedLost ? "element gone — showing all" : (isolatedLabel ?? "?")}`
      : "") +
    (hiddenElems > 0
      ? ` · ${hiddenElems} ${hiddenElems === 1 ? "element" : "elements"} hidden${
          hiddenEdges > 0 ? ` (${hiddenEdges} ${hiddenEdges === 1 ? "edge" : "edges"} dropped with them${prefs.layers.flows && prefs.layers.controls ? "" : ", layers off"})` : ""
        }`
      : "") +
    (notShown > 0
      ? ` · ${notShown} ${notShown === 1 ? "session" : "sessions"} not shown${
          uf ? ` (${uf.stale} quiet, ${uf.noClient} no machine named, ${uf.noEngine} no engine row)` : ""
        }`
      : "") +
    ((viewGraph?.unhosted ?? 0) > 0 ? ` · ${viewGraph!.unhosted} engines name no machine (whole on the Servers tab)` : "");

  return (
    <div className="flex h-[calc(100svh-190px)] min-h-[420px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex overflow-hidden rounded-md border border-border">
          {(["rank", "row", "free"] as const).map((m) => (
            <button
              key={m}
              onClick={() => pickMode(m)}
              title={
                m === "rank"
                  ? "layered left to right: machines that feed engines elsewhere rank upstream"
                  : m === "row"
                    ? "one row, This Machine first"
                    : "drag frames anywhere — positions are kept in this browser"
              }
              className={`px-2.5 py-1 font-mono text-[11px] ${
                mode === m ? "bg-panel text-text" : "bg-transparent text-dim hover:text-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <Button variant="outline" size="xs" onClick={relayout} title="drop stored positions and re-arrange">
          re-layout
        </Button>
        <span className="ml-auto text-[11px] text-dim">
          {st ? summary : "waiting for the arbiter state…"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-dim">
        <span>
          <span className="text-ok">━</span> thinking
        </span>
        <span>
          <span className="text-accent">━</span> output
        </span>
        <span>
          <span style={{ color: "var(--pipe-tools)" }}>━</span> tools
        </span>
        <span>
          <span className="text-warn">┅</span> waiting at the router
        </span>
        <span>
          <span className="text-dim">┅</span> no engine signal
        </span>
        <span>
          <span className="text-accent">→</span> paired control
        </span>
        {brokenMachines > 0 && (
          <span>
            <span className="text-dim">┈</span> hosts (broken out: {brokenMachines})
          </span>
        )}
        <span title="hold ⌘ and drag an agent/engine card out of its machine to float it — drop it back on the machine to dock it">
          <span className="text-accent">⌘</span> drag a card — dock / undock
        </span>
      </div>
      {st && !st.mesh && (
        <div className="text-[11px] text-dim">
          no mesh peers configured — add <code>mesh_peers</code> to the arbiter&apos;s config to bring the other machines
          into the picture. The frame below is this machine.
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="mesh-canvas relative min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-bg">
          <ReactFlowProvider>
            <Canvas
              graph={viewGraph}
              mode={mode}
              tick={tick}
              detached={detached}
              detachedKey={detachedKey}
              showHosts={prefs.layers.hosts}
              isoKey={`${prefs.isolated ?? ""}|${isolatedLost}`}
              onMachineAction={machineAction}
              onSetResource={setResource}
              onDragged={onDragged}
            />
          </ReactFlowProvider>
          {st && !viewGraph && <div className="absolute inset-0 grid place-items-center text-[12px] text-dim">nothing to draw yet</div>}
          {st && viewGraph && viewGraph.frames.length === 0 && (
            <div className="absolute inset-0 grid place-items-center text-[12px] text-dim">
              every machine is hidden — show one from the sidebar
            </div>
          )}
        </div>
        <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto rounded-md border border-border bg-bg p-3 text-[11px]" aria-label="mesh view controls">
          <section>
            <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-dim">layers</h3>
            {MESH_LAYERS.map((l) => (
              <label key={l} className="flex cursor-pointer items-center gap-2 py-[3px]" title={LAYER_HINT[l]}>
                <input type="checkbox" checked={prefs.layers[l]} onChange={() => toggleLayer(l)} />
                <span className={prefs.layers[l] ? "" : "text-dim line-through"}>{LAYER_LABEL[l]}</span>
              </label>
            ))}
          </section>
          <section>
            <div className="mb-1 flex items-center gap-1.5">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-dim">tree</h3>
              {lensing && (
                <button className="ml-auto text-dim hover:text-text" onClick={showAll} title="clear every hide, isolate and layer-off">
                  show all
                </button>
              )}
            </div>
            {isolatedLost && (
              <div className="mb-1 text-warn" title="the isolated element is gone from the mesh — the lens fell back to the full view">
                isolated element gone — showing all
              </div>
            )}
            <div className="mb-1 flex items-center gap-1">
              <span className="font-mono text-[10px] text-dim">fleet</span>
              {prefs.isolated !== null && (
                <span className="ml-auto flex min-w-0 items-center gap-1 text-accent">
                  <span className="truncate" title={`isolated: ${isolatedLabel ?? prefs.isolated}`}>⊙ {isolatedLabel ?? "?"}</span>
                  <button className="shrink-0 hover:text-text" onClick={clearIsolate} title="leave the isolate">✕</button>
                </span>
              )}
            </div>
            {graph && graph.frames.length === 0 && <div className="text-dim">nothing to draw yet</div>}
            {graph?.frames.map((f) => {
              const mHidden = hiddenSet.has(f.id);
              return (
                <div key={f.id} className="mb-2">
                  <div className="flex items-center gap-1">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={f.local ? "this machine" : "mesh peer"}>
                      <input type="checkbox" checked={!mHidden} onChange={() => toggleHidden(f.id)} />
                      <span className={`truncate font-mono font-semibold ${mHidden ? "text-dim line-through" : ""}`}>{f.name}</span>
                    </label>
                    <IsoBtn
                      active={prefs.isolated === f.id}
                      title="isolate — this machine's interior and the pipes BETWEEN its own cards"
                      onClick={() => toggleIsolate(f.id)}
                    />
                  </div>
                  {f.agents.length > 0 && (
                    <div className="mt-0.5 pl-4">
                      <div className={`text-[10px] ${prefs.layers.agents ? "text-dim" : "text-dim/50"}`}>agents</div>
                      {f.agents.map((a) => {
                        const hid = hiddenSet.has(a.id);
                        const flows = flowsByAgent.get(a.id) ?? [];
                        return (
                          <div key={a.id}>
                            <div className="flex items-center gap-1 py-[2px] pl-1">
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={`${a.machine} · client daemon`}>
                                <input type="checkbox" checked={!hid} disabled={mHidden} onChange={() => toggleHidden(a.id)} />
                                <span className={`truncate ${hid || mHidden ? "text-dim line-through" : ""}`}>{a.name}</span>
                              </label>
                              <IsoBtn
                                active={prefs.isolated === a.id}
                                title="isolate — this daemon, its profiles, every pipe it runs, and the engines (and machines) at the far ends"
                                onClick={() => toggleIsolate(a.id)}
                              />
                            </div>
                            {/* Profiles get their own rows (the published
                                roster); a session nests under its profile
                                card ONLY on the provenance stamp's exact
                                match — the rest stay under the daemon. */}
                            {a.profiles.map((p) => {
                              const phid = hiddenSet.has(p.id);
                              const pflows = flowsByAgent.get(p.id) ?? [];
                              return (
                                <div key={p.id}>
                                  <div className="flex items-center gap-1 py-[1px] pl-4">
                                    <label
                                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                                      title={`${p.machine} · Hermes profile (roster posture: ${p.posture})`}
                                    >
                                      <input type="checkbox" checked={!phid} disabled={mHidden || hid} onChange={() => toggleHidden(p.id)} />
                                      <span className={`truncate font-mono text-[10px] ${phid || mHidden || hid ? "text-dim line-through" : "text-dim"}`}>
                                        {p.name}
                                        {p.sessions.length > 0 ? ` · ${p.sessions.length}` : ""}
                                      </span>
                                    </label>
                                    <IsoBtn
                                      active={prefs.isolated === p.id}
                                      title="isolate — this profile, its session pipes, and the engines (and machines) at the far ends"
                                      onClick={() => toggleIsolate(p.id)}
                                    />
                                  </div>
                                  {pflows.map((fl) => flowLine(fl, mHidden || hid || phid, fl.shortToken))}
                                </div>
                              );
                            })}
                            {/* Sessions with no profile named nest under the
                                daemon that runs them (the flow's own join),
                                spelled as the hop: this agent → that engine. */}
                            {flows.map((fl) => flowLine(fl, mHidden || hid, `${fl.profile ?? fl.shortToken} → ${fl.engineName}`))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {f.engines.length > 0 && (
                    <div className="mt-0.5 pl-4">
                      <div className={`text-[10px] ${prefs.layers.engines ? "text-dim" : "text-dim/50"}`}>engines</div>
                      {f.engines.map((e) => {
                        const hid = hiddenSet.has(e.id);
                        return (
                          <div key={e.id} className="flex items-center gap-1 py-[2px] pl-1">
                            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={`${e.machine} · inference engine`}>
                              <input type="checkbox" checked={!hid} disabled={mHidden} onChange={() => toggleHidden(e.id)} />
                              <span className={`truncate ${hid || mHidden ? "text-dim line-through" : ""}`}>{e.name}</span>
                            </label>
                            <IsoBtn
                              active={prefs.isolated === e.id}
                              title="isolate — this engine and every session pipe feeding it, back to their daemons (and machines)"
                              onClick={() => toggleIsolate(e.id)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
          <section>
            <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-dim">views</h3>
            <div className="flex gap-1">
              <input
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveView()}
                placeholder="name this view"
                className="h-6 min-w-0 flex-1 rounded border border-border bg-panel px-1.5 text-[11px] text-text outline-none placeholder:text-dim"
              />
              <Button variant="outline" size="xs" onClick={saveView} disabled={!viewName.trim()} title="save the current mode + visibility under this name">
                save
              </Button>
            </div>
            {views.length === 0 && <div className="mt-1 text-dim">none saved</div>}
            {views.map((v) => (
              <div key={v.name} className="mt-0.5 flex items-center gap-1">
                <button
                  className="min-w-0 flex-1 truncate text-left font-mono hover:text-text"
                  title={`apply — ${v.mode} layout, ${v.prefs.hidden.length} hidden, layers ${MESH_LAYERS.filter((l) => v.prefs.layers[l]).join(",")}`}
                  onClick={() => applyView(v)}
                >
                  {v.name}
                </button>
                <button
                  className="text-dim hover:text-text"
                  title="update this view with the current mode + visibility"
                  onClick={() => upsertView(v.name)}
                >
                  ↺
                </button>
                <button className="text-dim hover:text-err" title="delete this view" onClick={() => deleteView(v.name)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
          {(hiddenElems > 0 || hiddenEdges > 0) && (
            <div className="mt-auto border-t border-border pt-2 text-[10px] text-dim">
              hidden: {tally.machines} machines · {tally.agents} agents · {tally.engines} engines · {tally.flows}{" "}
              {tally.flows === 1 ? "flow" : "flows"} · {tally.controls} controls
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

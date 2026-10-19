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
  SECTION_H,
  buildMeshGraph,
  frameResourceIds,
  hostEdgesFor,
  layoutMesh,
  machineShape,
  meshChildOffsets,
  meshFrameSize,
  type MeshAgentSlot,
  type MeshEngineSlot,
  type MeshFrame,
  type MeshGraph,
} from "@/lib/mesh-graph";
import type { StateSnapshot } from "@/lib/api";

// ---------------------------------------------------------------------------
// Mesh — the whole fleet as one graph (React Flow). The hierarchy the
// operator reads off the page: MACHINES are the frames; inside each frame
// its AGENTS (client daemons + rosters) stack above the ENGINES it hosts
// (the lib/hierarchy.ts joins, exact, never guessed). Edges:
//   · FLOW edges (agent card → engine card) reuse the Sessions flow
//     vocabulary untouched — lib/pipe-phases decides the color and motion
//     (queued warn · thinking green · output blue · tools purple · base
//     hairline, motion only on a live stream) and the tooltip is the SAME
//     pipeTitle the session row shows. A cross-machine session (an agent
//     here, an engine on another machine) is one visible arc between frames.
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
// ---------------------------------------------------------------------------

const MODE_KEY = "idlefill.meshLayout";
const POS_KEY = "idlefill.meshPos";
const BROKEN_KEY = "idlefill.meshBroken";
type Mode = "rank" | "row" | "free";

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
  const agentOff = f.agents.map((a) => offsets.get(a.id)).find((o): o is { x: number; y: number } => !!o);
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
        {a.behind && <span className="text-warn"> · daemon behind</span>}
      </div>
      <Handle id="agt-r" type="source" position={Position.Right} className="mesh-handle" />
      {detached && <Handle id="host-t" type="target" position={Position.Top} className="mesh-handle" />}
    </div>
  );
}

const nodeTypes = { machine: MachineNode, chip: ChipNode, engine: EngineNode, agent: AgentNode };

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

// --- the canvas (inside the provider: fitView on first draw + on layout
// picks only — the 5s data poll NEVER re-centers the view) -------------------

function Canvas({
  graph,
  mode,
  tick,
  detached,
  detachedKey,
  onMachineAction,
  onSetResource,
  onDragged,
}: {
  graph: MeshGraph | null;
  mode: Mode;
  tick: number;
  detached: ReadonlySet<string>;
  detachedKey: string;
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
        for (const a of f.agents)
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
      for (const a of f.agents)
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
    for (const h of hostEdgesFor(graph, detached)) {
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
  }, [graph, mode, tick, detached, detachedKey, superHeld, gesture, onMachineAction, setNodes, setEdges, rf]);

  // A layout pick, re-layout, or a break/dock re-frames the graph (a
  // deliberate action).
  const framesLen = graph?.frames.length ?? 0;
  useEffect(() => {
    const id = window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 300 }), 60);
    return () => window.clearTimeout(id);
  }, [mode, tick, framesLen, detachedKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const cy = abs.y + (n.type === "engine" ? ENGINE_H : AGENT_H) / 2;
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
        nodeColor={(n) => (n.type === "machine" ? "#30363d" : n.type === "engine" ? "#58a6ff" : "#3fb950")}
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

  const graph: MeshGraph | null = useMemo(
    () => (st ? buildMeshGraph(st, st.now ?? Date.now()) : null),
    [st],
  );

  const detached = useMemo(() => {
    const isResourceId = (t: string) => t.startsWith("eng:") || t.startsWith("agt:");
    if (!graph || [...brokenRaw].every(isResourceId)) return brokenRaw;
    const out = new Set<string>();
    for (const t of brokenRaw) {
      if (isResourceId(t)) out.add(t);
      else {
        const f = graph.frames.find((fr) => fr.name === t);
        if (f) for (const id of frameResourceIds(f)) out.add(id);
      }
    }
    return out;
  }, [brokenRaw, graph]);
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
  // "dock all" brings every floating one home.
  const machineAction = useCallback(
    (name: string) => {
      const f = graph?.frames.find((fr) => fr.name === name);
      if (!f) return;
      const ids = frameResourceIds(f);
      setResources(ids, !ids.some((id) => detached.has(id)));
    },
    [graph, detached, setResources],
  );

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

  const engines = graph?.frames.reduce((a, f) => a + f.engines.length, 0) ?? 0;
  const agents = graph?.frames.reduce((a, f) => a + f.agents.length, 0) ?? 0;
  const brokenMachines = graph?.frames.filter((f) => frameResourceIds(f).some((id) => detached.has(id))).length ?? 0;
  const liveFlows = graph?.flows.length ?? 0;
  const held = graph?.flows.filter((f) => f.pipe.phase === "queued").length ?? 0;
  const uf = graph?.unflowed;
  const notShown = (uf?.noClient ?? 0) + (uf?.noEngine ?? 0) + (uf?.stale ?? 0);

  const summary =
    `${graph?.frames.length ?? 0} machines · ${engines} engines · ${agents} agents · ` +
    `${liveFlows} live ${liveFlows === 1 ? "flow" : "flows"}${held > 0 ? ` (${held} waiting)` : ""}` +
    (notShown > 0
      ? ` · ${notShown} ${notShown === 1 ? "session" : "sessions"} not shown${
          uf ? ` (${uf.stale} quiet, ${uf.noClient} no machine named, ${uf.noEngine} no engine row)` : ""
        }`
      : "") +
    ((graph?.unhosted ?? 0) > 0 ? ` · ${graph!.unhosted} engines name no machine (whole on the Servers tab)` : "");

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
      <div className="mesh-canvas relative flex-1 overflow-hidden rounded-md border border-border bg-bg">
        <ReactFlowProvider>
          <Canvas
            graph={graph}
            mode={mode}
            tick={tick}
            detached={detached}
            detachedKey={detachedKey}
            onMachineAction={machineAction}
            onSetResource={setResource}
            onDragged={onDragged}
          />
        </ReactFlowProvider>
        {st && !graph && <div className="absolute inset-0 grid place-items-center text-[12px] text-dim">nothing to draw yet</div>}
      </div>
    </div>
  );
}

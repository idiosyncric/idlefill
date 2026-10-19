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
  hostEdgesFor,
  layoutMesh,
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
// machine: "break out" shrinks a frame to its chip and lets that machine's
// agents and engines float as their own nodes (each card then carries its
// "on <machine>" chip, tied back by a dim hosts edge; "dock" tucks them
// home). Mixed states are fine — some machines framed, some broken out.
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

type FrameData = { kind: "machine"; frame: MeshFrame; onToggle: (name: string) => void };
type ChipData = { kind: "chip"; frame: MeshFrame; onToggle: (name: string) => void };
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
  const { frame: f, onToggle } = data as unknown as FrameData;
  // The section hairline labels sit exactly above the first child of each
  // section — the same offsets the layout used, so they never drift.
  const offsets = meshChildOffsets(f);
  const firstAgent = f.agents[0] ? offsets.get(f.agents[0].id) : undefined;
  const firstEngine = f.engines[0] ? offsets.get(f.engines[0].id) : undefined;
  const breakable = f.agents.length + f.engines.length > 0;
  return (
    <div className={`mesh-frame h-full w-full ${f.online ? "" : "opacity-55"}`}>
      <MachineInfo
        f={f}
        action={
          breakable ? (
            <button
              className="mesh-pop nodrag nopan"
              title="break this machine's agents and engines out into their own nodes"
              onClick={() => onToggle(f.name)}
            >
              break out
            </button>
          ) : undefined
        }
      />
      {f.agents.length > 0 && firstAgent && (
        <div className="mesh-section" style={{ top: firstAgent.y - SECTION_H + 4 }}>
          agents
        </div>
      )}
      {f.engines.length > 0 && firstEngine && (
        <div className="mesh-section" style={{ top: firstEngine.y - SECTION_H + 4 }}>
          engines
        </div>
      )}
      {/* Control edges attach to the frame sides. */}
      <Handle id="ctl-l" type="target" position={Position.Left} className="mesh-handle" />
      <Handle id="ctl-r" type="source" position={Position.Right} className="mesh-handle" />
    </div>
  );
}

/** A BROKEN-OUT machine: the same glance block, minus the containment. Its
 *  resources float as their own nodes, tied back by a dim hosts edge from
 *  this chip's bottom handle; a dock button tucks them all back in. */
function ChipNode({ data }: NodeProps) {
  const { frame: f, onToggle } = data as unknown as ChipData;
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
              onClick={() => onToggle(f.name)}
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

/** The dim hairline a broken-out machine draws to each of its floating
 *  cards: chip bottom → card top. Attribution, not traffic — deliberately
 *  quieter than every flow pipe. */
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
  broken,
  brokenKey,
  onToggle,
  onDragged,
}: {
  graph: MeshGraph | null;
  mode: Mode;
  tick: number;
  broken: ReadonlySet<string>;
  brokenKey: string;
  onToggle: (name: string) => void;
  onDragged: (id: string, pos: { x: number; y: number }) => Map<string, { x: number; y: number }>;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const rf = useReactFlow();
  const fitted = useRef(false);
  const dragPos = useRef<Map<string, { x: number; y: number }>>(readPos());

  useEffect(() => {
    dragPos.current = readPos();
  }, [tick]);

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const auto = layoutMesh(graph, mode === "free" ? "rank" : mode, broken);
    const next: Node[] = [];
    for (const f of graph.frames) {
      const isBroken = broken.has(f.name);
      const pos = (mode === "free" ? dragPos.current.get(f.id) : undefined) ?? auto.get(f.id) ?? { x: 0, y: 0 };
      if (isBroken) {
        // The machine shrinks to its chip; its resources become top-level
        // nodes placed by the same layout pass.
        next.push({
          id: f.id,
          type: "chip",
          position: pos,
          width: CHIP_W,
          height: f.headerH,
          draggable: mode === "free",
          selectable: false,
          data: { kind: "chip", frame: f, onToggle } satisfies ChipData,
        });
        for (const a of f.agents) {
          next.push({
            id: a.id,
            type: "agent",
            position: (mode === "free" ? dragPos.current.get(a.id) : undefined) ?? auto.get(a.id) ?? { x: 0, y: 0 },
            width: CARD_W,
            height: AGENT_H,
            draggable: mode === "free",
            selectable: false,
            data: { kind: "agent", agent: a, detached: true } satisfies AgentData,
          });
        }
        for (const e of f.engines) {
          next.push({
            id: e.id,
            type: "engine",
            position: (mode === "free" ? dragPos.current.get(e.id) : undefined) ?? auto.get(e.id) ?? { x: 0, y: 0 },
            width: CARD_W,
            height: ENGINE_H,
            draggable: mode === "free",
            selectable: false,
            data: { kind: "engine", engine: e, detached: true } satisfies EngineData,
          });
        }
        continue;
      }
      const size = meshFrameSize(f);
      next.push({
        id: f.id,
        type: "machine",
        position: pos,
        width: size.w,
        height: size.h,
        draggable: mode === "free",
        selectable: false,
        data: { kind: "machine", frame: f, onToggle } satisfies FrameData,
      });
      const offsets = meshChildOffsets(f);
      for (const a of f.agents) {
        next.push({
          id: a.id,
          type: "agent",
          position: offsets.get(a.id) ?? { x: FRAME_PAD, y: FRAME_PAD },
          parentId: f.id,
          extent: "parent",
          width: CARD_W,
          height: AGENT_H,
          draggable: false,
          selectable: false,
          data: { kind: "agent", agent: a, detached: false } satisfies AgentData,
        });
      }
      for (const e of f.engines) {
        next.push({
          id: e.id,
          type: "engine",
          position: offsets.get(e.id) ?? { x: FRAME_PAD, y: FRAME_PAD },
          parentId: f.id,
          extent: "parent",
          width: CARD_W,
          height: ENGINE_H,
          draggable: false,
          selectable: false,
          data: { kind: "engine", engine: e, detached: false } satisfies EngineData,
        });
      }
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
    for (const h of hostEdgesFor(graph, broken)) {
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
  }, [graph, mode, tick, broken, brokenKey, onToggle, setNodes, setEdges, rf]);

  // A layout pick, re-layout, or a break/dock re-frames the graph (a
  // deliberate action).
  const framesLen = graph?.frames.length ?? 0;
  useEffect(() => {
    const id = window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 300 }), 60);
    return () => window.clearTimeout(id);
  }, [mode, tick, framesLen, brokenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDrag = useCallback(
    (_: unknown, n: Node) => {
      if (n.parentId) return; // framed children never drag; top-level ones persist
      dragPos.current = onDragged(n.id, n.position);
    },
    [onDragged],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeDrag={saveDrag}
      onNodeDragStop={saveDrag}
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
  // BROKEN-OUT machines (per-machine breakout): the names whose agents and
  // engines float as their own nodes instead of stacking inside the frame.
  // A view preference — persisted here in the browser, like the layout pick.
  const [broken, setBroken] = useState<Set<string>>(readBroken);
  const brokenKey = [...broken].sort().join("|");
  const toggleMachine = useCallback((name: string) => {
    setBroken((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem(BROKEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const graph: MeshGraph | null = useMemo(
    () => (st ? buildMeshGraph(st, st.now ?? Date.now()) : null),
    [st],
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
        {broken.size > 0 && (
          <span>
            <span className="text-dim">┈</span> hosts (broken out: {broken.size})
          </span>
        )}
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
            broken={broken}
            brokenKey={brokenKey}
            onToggle={toggleMachine}
            onDragged={onDragged}
          />
        </ReactFlowProvider>
        {st && !graph && <div className="absolute inset-0 grid place-items-center text-[12px] text-dim">nothing to draw yet</div>}
      </div>
    </div>
  );
}

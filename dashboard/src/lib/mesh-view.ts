// ---------------------------------------------------------------------------
// mesh-view.ts — the pure VISIBILITY model behind the Mesh tab's sidebar.
// mesh-graph.ts says what EXISTS (the exact joins); this module says what is
// DRAWN: layer toggles (agents / engines / flows / control edges / hosts
// edges) and per-element hides (machine / agent / engine node ids), plus the
// shape of a saved view. No DOM, no React, no localStorage: the view reads
// and writes its own browser storage and hands these functions plain values.
//
// The honesty law carries: filtering is the OPERATOR's deliberate lens, so
// what it drops is COUNTED (`tally`), never silently absent — the summary
// line and the sidebar both name the hidden count. A hidden machine takes
// its subtree with it (containment, not a guess); an edge whose endpoint is
// hidden cannot be drawn, so it drops and is counted. Frame glance lines
// (`controls` / `controlledBy`) and `headerH` are recomputed against the
// VISIBLE set, so a frame never names a control it can no longer draw.
// `counts` is left untouched: the machine's joins are truth whether or not
// the operator is showing the cards.
// ---------------------------------------------------------------------------

import type { MeshFrame, MeshGraph } from "./mesh-graph";
import { hostLine } from "./mesh-stats";

export const MESH_LAYERS = ["agents", "engines", "flows", "controls", "hosts"] as const;
export type MeshLayer = (typeof MESH_LAYERS)[number];

/** The layout modes, spelled once (the view's Mode is this). */
export type MeshViewMode = "rank" | "row" | "free";

export type MeshViewPrefs = {
  layers: Record<MeshLayer, boolean>;
  /** Hidden node ids: `mch:<machine>` hides the machine AND its subtree,
   *  `agt:<client>` / `eng:<server>` hide one card. */
  hidden: string[];
};

/** A saved view: a NAMED lens over the mesh — mode + visibility prefs.
 *  Positions are NOT part of a view (they stay the browser's single stored
 *  map, same posture as before: a view picks the lens, not the coordinates). */
export type SavedMeshView = { name: string; mode: MeshViewMode; prefs: MeshViewPrefs };

export const defaultMeshPrefs = (): MeshViewPrefs => ({
  layers: { agents: true, engines: true, flows: true, controls: true, hosts: true },
  hidden: [],
});

const isMode = (v: unknown): v is MeshViewMode => v === "rank" || v === "row" || v === "free";

/** Trust nothing read from storage (or a hand-edited file): a malformed
 *  shape yields the default, a partial layers map merges over defaults, a
 *  non-string hidden entry is dropped. Never throws. */
export function sanitizeMeshPrefs(raw: unknown): MeshViewPrefs {
  if (typeof raw !== "object" || raw === null) return defaultMeshPrefs();
  const r = raw as Record<string, unknown>;
  const layers = { ...defaultMeshPrefs().layers };
  if (typeof r.layers === "object" && r.layers !== null) {
    for (const l of MESH_LAYERS) {
      const v = (r.layers as Record<string, unknown>)[l];
      if (typeof v === "boolean") layers[l] = v;
    }
  }
  const hidden = Array.isArray(r.hidden) ? r.hidden.filter((x): x is string => typeof x === "string") : [];
  return { layers, hidden: [...new Set(hidden)] };
}

/** Same discipline for the saved-views list: junk entries drop, names must
 *  be non-empty strings, a repeated name keeps the LAST entry (storage wins
 *  in write order). */
export function sanitizeMeshViews(raw: unknown): SavedMeshView[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, SavedMeshView>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Record<string, unknown>;
    if (typeof it.name !== "string" || it.name.trim() === "") continue;
    if (!isMode(it.mode)) continue;
    byName.set(it.name.trim().slice(0, 48), { name: it.name.trim().slice(0, 48), mode: it.mode, prefs: sanitizeMeshPrefs(it.prefs) });
  }
  return [...byName.values()];
}

/** What the lens dropped, named (the honesty count — the view shows these
 *  numbers, never an unexplained gap). */
export type MeshViewTally = { machines: number; agents: number; engines: number; flows: number; controls: number };

export const emptyMeshTally = (): MeshViewTally => ({ machines: 0, agents: 0, engines: 0, flows: 0, controls: 0 });

/** Apply the lens to a graph. Deterministic and pure: frames hidden by id
 *  drop WITH their subtree; remaining frames keep only the visible agents/
 *  engines (layer off, or the card hidden by id); flows and control edges
 *  need BOTH endpoints visible (and their layer on). `unflowed` / `unhosted`
 *  are untouched — they count JOIN failures, not operator hides (those ride
 *  the tally). The graph is returned unchanged (same reference) when the
 *  lens is the default, so the 5s poll never rebuilds what nothing changed. */
export function applyMeshView(
  graph: MeshGraph,
  prefs: MeshViewPrefs,
): { graph: MeshGraph; tally: MeshViewTally } {
  const defaultLens =
    MESH_LAYERS.every((l) => prefs.layers[l]) && prefs.hidden.length === 0;
  if (defaultLens) return { graph, tally: emptyMeshTally() };

  const hidden = new Set(prefs.hidden);
  const tally = emptyMeshTally();
  const allAgents = graph.frames.reduce((a, f) => a + f.agents.length, 0);
  const allEngines = graph.frames.reduce((a, f) => a + f.engines.length, 0);

  const keep = graph.frames.filter((f) => !hidden.has(f.id));
  tally.machines = graph.frames.length - keep.length;

  const visibleFrames = new Set(keep.map((f) => f.name));
  const frames: MeshFrame[] = keep.map((f) => {
    const agents = prefs.layers.agents ? f.agents.filter((a) => !hidden.has(a.id)) : [];
    const engines = prefs.layers.engines ? f.engines.filter((e) => !hidden.has(e.id)) : [];
    // The glance lines name machines that are still DRAWN (a hidden peer
    // must not be named); the controls LAYER toggles the edge, not the fact.
    const controls = f.controls.filter((n) => visibleFrames.has(n));
    const controlledBy = f.controlledBy.filter((n) => visibleFrames.has(n));
    const out: MeshFrame = { ...f, agents, engines, controls, controlledBy };
    // The same header-height rule buildMeshGraph uses, recomputed against
    // the visible glance lines (never trust the stale number).
    let lines = 1; // the counts row always renders
    if (hostLine(out.host)) lines++;
    if (out.reported) lines++;
    if (out.reportedEngines.length > 0) lines++;
    if (out.controls.length > 0) lines++;
    if (out.controlledBy.length > 0) lines++;
    if (out.note) lines++;
    out.headerH = 39 + lines * 18;
    return out;
  });

  const agentSeen = new Set(frames.flatMap((f) => f.agents.map((a) => a.id)));
  const engineSeen = new Set(frames.flatMap((f) => f.engines.map((e) => e.id)));
  const frameIds = new Set(frames.map((f) => f.id));

  // A flow needs its agent AND its engine visible; the flows layer off drops
  // every one of them. Same endpoint rule for the control edges.
  const shownFlows = prefs.layers.flows ? graph.flows.filter((fl) => agentSeen.has(fl.from) && engineSeen.has(fl.to)) : [];
  const controls = prefs.layers.controls
    ? graph.controls.filter((c) => frameIds.has(c.from) && frameIds.has(c.to))
    : [];

  tally.agents = allAgents - agentSeen.size;
  tally.engines = allEngines - engineSeen.size;
  tally.flows = graph.flows.length - shownFlows.length;
  tally.controls = graph.controls.length - controls.length;

  return { graph: { ...graph, frames, flows: shownFlows, controls }, tally };
}

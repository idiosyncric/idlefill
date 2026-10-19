// ---------------------------------------------------------------------------
// mesh-view.ts — the pure VISIBILITY model behind the Mesh tab's sidebar.
// mesh-graph.ts says what EXISTS (the exact joins); this module says what is
// DRAWN: layer toggles (agents / engines / flows / control edges / hosts
// edges) and per-element hides (machine / daemon / profile-card / engine node
// ids), plus the shape of a saved view. No DOM, no React, no localStorage:
// the view reads and writes its own browser storage and hands these functions
// plain values.
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
   *  `agt:<client>` hides a daemon card AND its profile cards,
   *  `agt:<client>#<profile>` hides one profile card, `eng:<server>` hides
   *  one engine card, `flow:<token>` hides one session pipe. */
  hidden: string[];
  /** ISOLATE (the outliner's ⊙): when set, the canvas shows ONLY this
   *  element's subtree and its hops — `mch:` the machine's whole interior,
   *  `agt:`/`eng:` the card plus every pipe it touches plus the far ends
   *  and their machines, `flow:` just that session's pipe, its two cards
   *  and the two machines (the hop, spelled out). Layers still apply on
   *  top: isolate picks the subset, layers pick the kinds. A target that
   *  vanishes (a session that ended) degrades honestly to no-isolate and
   *  the view says so (`isolatedLost`). */
  isolated: string | null;
};

/** A saved view: a NAMED lens over the mesh — mode + visibility prefs.
 *  Positions are NOT part of a view (they stay the browser's single stored
 *  map, same posture as before: a view picks the lens, not the coordinates). */
export type SavedMeshView = { name: string; mode: MeshViewMode; prefs: MeshViewPrefs };

export const defaultMeshPrefs = (): MeshViewPrefs => ({
  layers: { agents: true, engines: true, flows: true, controls: true, hosts: true },
  hidden: [],
  isolated: null,
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
  const isolated = typeof r.isolated === "string" && r.isolated !== "" ? r.isolated : null;
  return { layers, hidden: [...new Set(hidden)], isolated };
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

export type MeshLens = { graph: MeshGraph; tally: MeshViewTally; /** true = an isolate named an element the graph no longer has (the session ended, the card went away) — the lens falls back to the full view and the sidebar SAYS so. */ isolatedLost: boolean };

/** The ISOLATE focus: which frame/card/flow ids an isolate keeps visible.
 *  The hop discipline: `flow:` keeps exactly the session's two cards, its
 *  two machines and the one pipe (the agent → engine hop, spelled out);
 *  `agt:` (a daemon OR its `#profile` card) / `eng:` keep the card plus
 *  every pipe it touches plus the far ends and their machines (all of
 *  THIS element's hops; a daemon's own profile cards ride its subtree);
 *  `mch:` keeps the machine's whole interior plus only the pipes BETWEEN
 *  its own cards.
 *  null = the isolate targets nothing in this graph (gone). */
export function focusOf(graph: MeshGraph, iso: string): { frames: Set<string>; cards: Set<string>; flows: Set<string> } | null {
  const machineOfCard = new Map<string, string>();
  for (const f of graph.frames)
    for (const c of [...f.agents, ...f.agents.flatMap((a) => a.profiles), ...f.engines]) machineOfCard.set(c.id, f.id);
  if (iso.startsWith("mch:")) {
    const fr = graph.frames.find((f) => f.id === iso);
    if (!fr) return null;
    const cards = new Set([
      ...fr.agents.map((a) => a.id),
      ...fr.agents.flatMap((a) => a.profiles.map((p) => p.id)),
      ...fr.engines.map((e) => e.id),
    ]);
    return {
      frames: new Set([fr.id]),
      cards,
      flows: new Set(graph.flows.filter((fl) => cards.has(fl.from) && cards.has(fl.to)).map((fl) => fl.id)),
    };
  }
  if (iso.startsWith("flow:")) {
    const fl = graph.flows.find((x) => x.id === iso);
    if (!fl) return null;
    const frames = new Set<string>();
    for (const c of [fl.from, fl.to]) {
      const m = machineOfCard.get(c);
      if (m) frames.add(m);
    }
    return { frames, cards: new Set([fl.from, fl.to]), flows: new Set([fl.id]) };
  }
  const machine = machineOfCard.get(iso);
  if (!machine) return null;
  const frames = new Set([machine]);
  const cards = new Set([iso]);
  const flows = new Set<string>();
  for (const fl of graph.flows) {
    if (fl.from !== iso && fl.to !== iso) continue;
    flows.add(fl.id);
    const far = fl.from === iso ? fl.to : fl.from;
    cards.add(far);
    const m = machineOfCard.get(far);
    if (m) frames.add(m);
  }
  return { frames, cards, flows };
}

/** Apply the lens to a graph. Deterministic and pure: the isolate focus
 *  first (when set), then layers, then per-element hides — isolate picks
 *  the subset, layers pick the kinds inside it, hides subtract. Frames
 *  outside drop WITH their subtree; flows need BOTH endpoints visible,
 *  their layer on, and no `flow:<token>` hide. `unflowed` / `unhosted`
 *  are untouched — they count JOIN failures, not operator hides (those
 *  ride the tally). The graph is returned unchanged (same reference) when
 *  the lens is the default, so the 5s poll never rebuilds what nothing
 *  changed. */
export function applyMeshView(graph: MeshGraph, prefs: MeshViewPrefs): MeshLens {
  const focus = prefs.isolated ? focusOf(graph, prefs.isolated) : null;
  const isolatedLost = prefs.isolated !== null && focus === null;
  const defaultLens =
    !focus && !isolatedLost && MESH_LAYERS.every((l) => prefs.layers[l]) && prefs.hidden.length === 0;
  if (defaultLens) return { graph, tally: emptyMeshTally(), isolatedLost: false };

  const hidden = new Set(prefs.hidden);
  const tally = emptyMeshTally();
  const allAgents = graph.frames.reduce((a, f) => a + f.agents.reduce((x, ag) => x + 1 + ag.profiles.length, 0), 0);
  const allEngines = graph.frames.reduce((a, f) => a + f.engines.length, 0);

  const keep = graph.frames.filter((f) => !hidden.has(f.id) && (!focus || focus.frames.has(f.id)));
  tally.machines = graph.frames.length - keep.length;

  const visibleFrames = new Set(keep.map((f) => f.name));
  const frames: MeshFrame[] = keep.map((f) => {
    const agents = prefs.layers.agents
      ? f.agents
          // A daemon stays if it is not hidden and the focus touches it or
          // one of its profile cards (a flow landing on a profile card
          // needs its host daemon drawn).
          .filter((a) => !hidden.has(a.id) && (!focus || focus.cards.has(a.id) || a.profiles.some((p) => focus.cards.has(p.id))))
          // Profile cards filter INSIDE their surviving daemon (containment:
          // a hidden daemon takes its profiles with it, like a machine).
          .map((a) => {
            const profiles = a.profiles.filter(
              (p) => !hidden.has(p.id) && (!focus || focus.cards.has(a.id) || focus.cards.has(p.id)),
            );
            return profiles.length === a.profiles.length ? a : { ...a, profiles };
          })
      : [];
    const engines = prefs.layers.engines ? f.engines.filter((e) => !hidden.has(e.id) && (!focus || focus.cards.has(e.id))) : [];
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

  const agentSeen = new Set(frames.flatMap((f) => f.agents.flatMap((a) => [a.id, ...a.profiles.map((p) => p.id)])));
  const engineSeen = new Set(frames.flatMap((f) => f.engines.map((e) => e.id)));
  const frameIds = new Set(frames.map((f) => f.id));

  // A flow needs its agent AND its engine visible; the flows layer off drops
  // every one of them; a `flow:<token>` hide drops one pipe. Same endpoint
  // rule for the control edges.
  const shownFlows = prefs.layers.flows
    ? graph.flows.filter(
        (fl) => !hidden.has(fl.id) && (!focus || focus.flows.has(fl.id)) && agentSeen.has(fl.from) && engineSeen.has(fl.to),
      )
    : [];
  const controls = prefs.layers.controls
    ? graph.controls.filter((c) => frameIds.has(c.from) && frameIds.has(c.to))
    : [];

  tally.agents = allAgents - agentSeen.size;
  tally.engines = allEngines - engineSeen.size;
  tally.flows = graph.flows.length - shownFlows.length;
  tally.controls = graph.controls.length - controls.length;

  return { graph: { ...graph, frames, flows: shownFlows, controls }, tally, isolatedLost };
}

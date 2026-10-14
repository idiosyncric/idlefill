// #74 — the pipe/phase layer of the Sessions flow view: the #67 pipe design
// ported onto the signals the modern plane ALREADY publishes. Pure: no DOM,
// no fetch, no state. The grid (rows mode) stays the functional surface —
// pins, re-route, exception annotations live there; this lib decides what a
// connector LOOKS like, and shares one tooltip text with the grid edge so the
// decorative SVG never contradicts the functional row.
//
// The mapping, exactly as #67 shipped on the legacy page:
//   queued    — the session's gate is held (or its engine row NAMES a fresh
//               queue depth): warn color, dashed.
//   thinking  — a fresh `phase` report of reasoning deltas: green.
//   output    — a fresh content-delta report: blue.
//   tools     — a fresh tool_calls report: purple.
//   base      — everything else. Where no signal exists the edge is honest:
//               neutral base, dimmed dotted when the engine row itself is
//               degraded / no-signal (the existing no-signal posture). Never
//               a guessed phase: a stale phase report or a stale load sample
//               renders base, not the last known color.
import type { SessionRow } from "./api";
import type { EngineEdge } from "./session-edge";

// #67's stalled-report honesty window, carried verbatim from the legacy page:
// a phase older than this is a stalled report — render idle.
export const PHASE_MAX_AGE_MS = 10_000;

export type PipePhase = "base" | "queued" | "thinking" | "output" | "tools";

export type PipeEdge = {
  phase: PipePhase;
  /** dashed warn — the queued posture. */
  dashed: boolean;
  /** animated dash flow, engine → session — only a live stream gets motion. */
  animated: boolean;
  /** honest no-signal posture: base color, dotted, dimmed. */
  muted: boolean;
  /** The clause shared into the edge tooltip; "" when there is nothing to say. */
  reason: string;
};

/** The response phase the router reported, if it is still fresh. */
export function pipePhaseNow(
  phase: SessionRow["phase"],
  now: number,
): "thinking" | "output" | "tools" | null {
  if (!phase || !phase.state) return null;
  if (!(now - phase.at < PHASE_MAX_AGE_MS)) return null;
  return phase.state;
}

export function pipeEdge(
  s: Pick<SessionRow, "gate" | "phase">,
  edge: Pick<EngineEdge, "posture" | "queueDepth" | "queueFresh">,
  now: number,
): PipeEdge {
  // A held gate outranks everything: the request is parked, whatever the
  // last stream said. (Same rule as the legacy page.)
  if (s.gate?.state === "queued") {
    return { phase: "queued", dashed: true, animated: false, muted: false, reason: "queued at the router" };
  }
  const phase = pipePhaseNow(s.phase, now);
  if (phase) {
    return { phase, dashed: false, animated: true, muted: false, reason: `answering: ${phase}` };
  }
  // Engine-side congestion IS a published fact when the row names a FRESH
  // queue depth — the pipe warns honestly. A stale sample is not a fact;
  // the edge stays base (the D4 annotation on the grid carries the stale
  // sample instead).
  if (edge.queueDepth !== null && edge.queueDepth > 0 && edge.queueFresh) {
    return { phase: "queued", dashed: true, animated: false, muted: false, reason: `engine queue depth ${edge.queueDepth}` };
  }
  // The engine row cannot speak: honest no-signal posture, never a phase.
  if (edge.posture === "degraded" || edge.posture === "no-signal") {
    return { phase: "base", dashed: false, animated: false, muted: true, reason: "no engine signal" };
  }
  return { phase: "base", dashed: false, animated: false, muted: false, reason: "" };
}

export function pipeClass(pipe: PipeEdge): string {
  const cls = ["pipe"];
  if (pipe.phase === "queued") cls.push("queued");
  else if (pipe.animated) cls.push("responding", pipe.phase);
  if (pipe.muted) cls.push("muted");
  return cls.join(" ");
}

/**
 * ONE tooltip text, used by the grid span AND the SVG edge — the decorative
 * connectors never say anything the functional row does not.
 */
export function pipeTitle(
  shortTok: string,
  engineName: string,
  edge: EngineEdge,
  pipe: PipeEdge,
): string {
  const parts = [`session ${shortTok} → engine ${engineName}`];
  if (edge.pinned) parts.push("operator pin — lands at release time");
  if (edge.slow) parts.push(`slow: ${edge.slowReasons.join("; ")} — re-route from the rows mode`);
  if (pipe.reason) parts.push(pipe.reason);
  return parts.join(" · ");
}

/** The orthogonal rounded connector: session right-edge → engine left-edge. */
export function flowPipePath(x1: number, y1: number, x2: number, y2: number, r = 10): string {
  r = Math.max(0, Math.min(r, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 2));
  if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`;
  const midX = (x1 + x2) / 2;
  const dir = y2 > y1 ? 1 : -1;
  return (
    `M${x1} ${y1} H${midX - r}` +
    ` Q${midX} ${y1} ${midX} ${y1 + r * dir}` +
    ` V${y2 - r * dir}` +
    ` Q${midX} ${y2} ${midX + r} ${y2}` +
    ` H${x2}`
  );
}

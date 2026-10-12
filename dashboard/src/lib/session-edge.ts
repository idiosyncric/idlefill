// The session→engine edge (alias-stability-and-slow-engines.md D4): every
// session row names the engine row it routes through (`server_id`, or the
// operator's `engine_pin` once one stands); this helper reads that edge's
// ENGINE STATE — posture + queue depth + load-sample age — and ships the
// display-only "slow" heuristic. Pure, no DOM.
//
// Honesty law (the load-read precedent): an annotation exists ONLY when the
// engine row names a fact (queue > 0, a stale sample, a degraded/no-signal
// posture). A healthy idle row renders NOTHING new, so an unpinned healthy
// session row stays byte-for-byte. The busy/idle word itself lives on the
// engine rows (Resources tab + the flow view's engine column, liveWord) —
// repeating it on every edge would be noise, and "active session on a busy
// healthy engine" is the normal state, never an alert.
//
// The slow heuristic AS SHIPPED: gate state `active` AND (fresh
// queue_depth > 0 on the edge's engine row, OR the row's load sample older
// than EDGE_SAMPLE_STALE_S, OR posture degraded/no-signal). Display only —
// it never reroutes anything by itself; it highlights the edge and surfaces
// the Re-route affordance, whose write is the EXISTING engine-pin API.
import type { ServerSignal, SessionRow } from "./api";

// D4's "~15s" honesty window, and the freshness stamp for queue_depth
// (queue_depth rides the load reading, so its age IS load_age_s).
export const EDGE_SAMPLE_STALE_S = 15;

export type EnginePosture = "busy" | "idle" | "degraded" | "no-signal";

export type EngineEdge = {
  /** The engine row this session routes through (pin wins once one stands). */
  target: string | null;
  pinned: boolean;
  posture: EnginePosture;
  /** The published queue count, or null when the row's kind names none. */
  queueDepth: number | null;
  queueFresh: boolean;
  sampleAgeS: number | null;
  sampleStale: boolean;
  /** The exception-only edge annotation, or null → the view renders nothing. */
  annotation: string | null;
  /** The D4 slow heuristic — ONLY true when the session's gate is `active`. */
  slow: boolean;
  /** Why it is slow, in operator words (empty when healthy). */
  slowReasons: string[];
};

export function engineEdge(
  s: Pick<SessionRow, "server_id" | "engine_pin" | "gate">,
  signal: ServerSignal | null | undefined,
): EngineEdge {
  const target = s.engine_pin?.server_id ?? s.server_id ?? null;
  const pinned = s.engine_pin != null;

  // No engine row named at all → there is NO edge: no annotation, no slow
  // word (the posture fields describe an edge that does not exist).
  if (target === null) {
    return {
      target: null,
      pinned,
      posture: "no-signal",
      queueDepth: null,
      queueFresh: false,
      sampleAgeS: null,
      sampleStale: false,
      annotation: null,
      slow: false,
      slowReasons: [],
    };
  }

  const queueDepth =
    typeof signal?.queue_depth === "number" && Number.isFinite(signal.queue_depth) ? signal.queue_depth : null;
  const sampleAgeS =
    typeof signal?.load_age_s === "number" && Number.isFinite(signal.load_age_s) ? signal.load_age_s : null;
  const sampleStale = sampleAgeS !== null && sampleAgeS > EDGE_SAMPLE_STALE_S;
  const queueFresh = queueDepth !== null && sampleAgeS !== null && sampleAgeS <= EDGE_SAMPLE_STALE_S;

  let posture: EnginePosture;
  if (!signal) posture = "no-signal"; // no idle detector for the row — nothing to prove
  else if (signal.degraded) posture = "degraded";
  else if (signal.no_signal_reason != null) posture = "no-signal"; // #62 honest fail-closed
  else posture = signal.idle ? "idle" : "busy";

  const slowReasons: string[] = [];
  if (queueDepth !== null && queueDepth > 0 && queueFresh && sampleAgeS !== null) {
    slowReasons.push(`queue depth ${queueDepth} fresh (${Math.round(sampleAgeS)}s)`);
  }
  if (sampleStale && sampleAgeS !== null) {
    slowReasons.push(`load sample ${Math.round(sampleAgeS)}s old (> ${EDGE_SAMPLE_STALE_S}s)`);
  }
  if (posture === "degraded" || posture === "no-signal") slowReasons.push(`engine posture: ${posture}`);
  const slow = s.gate?.state === "active" && slowReasons.length > 0;

  const parts: string[] = [];
  if (queueDepth !== null && queueDepth > 0) parts.push(`${queueDepth} queued`);
  if (sampleStale && sampleAgeS !== null) parts.push(`sample ${Math.round(sampleAgeS)}s old`);
  if (posture === "degraded" || posture === "no-signal") parts.push(posture);

  return {
    target,
    pinned,
    posture,
    queueDepth,
    queueFresh,
    sampleAgeS,
    sampleStale,
    annotation: parts.length > 0 ? parts.join(" · ") : null,
    slow,
    slowReasons,
  };
}

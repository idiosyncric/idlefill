// pipe-phases.test.ts — #74: the pipe/phase mapping for the Sessions flow
// view, pinned as PURE logic (the state→phase decision, the shared tooltip,
// the orthogonal path builder) plus the render invariants the owner decision
// demands: grid stays the functional surface, the SVG is decoration with the
// SAME tooltip text, zero new network calls, the pipe colors derive from the
// #68 palette (never a hardcoded legacy set), and the phase window is the #67
// 10s honesty window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flowPipePath, pipeClass, pipeEdge, pipePhaseNow, pipeTitle, PHASE_MAX_AGE_MS } from "../src/lib/pipe-phases.js";
import type { SessionRow, ServerSignal } from "../src/lib/api.js";
import { engineEdge } from "../src/lib/session-edge.js";
import { THEME_KEYS } from "../src/lib/theme.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_000_000_000_000;

type Sess = Pick<SessionRow, "gate" | "phase">;
type EdgeInput = Pick<SessionRow, "server_id" | "engine_pin" | "gate">;

function sig(patch: Partial<ServerSignal>): ServerSignal {
  return { idle: true, idle_for_s: 5, last_activity: null, last_log_write_age_s: null, degraded: false, ...patch } as ServerSignal;
}
function edgeFor(s: EdgeInput, signal: ServerSignal | null) {
  return engineEdge(s, signal);
}
const activeEdge = (signal: ServerSignal | null) =>
  edgeFor({ server_id: "srv-a", gate: { state: "active", waiting: 0 } }, signal);

test("the #67 honesty window is pinned at 10s (the legacy FLOW_PHASE_MAX_AGE_MS)", () => {
  assert.equal(PHASE_MAX_AGE_MS, 10_000);
});

test("held gate outranks everything: queued, dashed, never animated — even with a fresh phase report", () => {
  const s: Sess = { gate: { state: "queued", waiting: 2, position: 1 }, phase: { state: "thinking", at: NOW - 1000 } };
  const p = pipeEdge(s, activeEdge(sig({ load_age_s: 4, queue_depth: 1 })), NOW);
  assert.equal(p.phase, "queued");
  assert.equal(p.dashed, true);
  assert.equal(p.animated, false);
  assert.equal(p.reason, "queued at the router");
  assert.equal(pipeClass(p), "pipe queued");
});

test("fresh phase reports map to exactly the three stream colors, animated", () => {
  for (const state of ["thinking", "output", "tools"] as const) {
    const p = pipeEdge({ gate: { state: "active", waiting: 0 }, phase: { state, at: NOW - 9_999 } }, activeEdge(null), NOW);
    assert.equal(p.phase, state);
    assert.equal(p.dashed, false);
    assert.equal(p.animated, true);
    assert.equal(p.reason, `answering: ${state}`);
    assert.equal(pipeClass(p), `pipe responding ${state}`);
  }
});

test("a phase older than the window is a stalled report: base, never the last known color", () => {
  assert.equal(pipePhaseNow({ state: "output", at: NOW - 10_000 }, NOW), null); // boundary: exactly 10s = stale
  const p = pipeEdge({ gate: { state: "active", waiting: 0 }, phase: { state: "thinking", at: NOW - 12_000 } }, activeEdge(sig({ idle: true, load_age_s: 4, queue_depth: 0 })), NOW);
  assert.equal(p.phase, "base");
  assert.equal(pipeClass(p), "pipe");
});

test("no phase anywhere = honest base: an absent ADD-key is never a guessed phase", () => {
  assert.equal(pipePhaseNow(null, NOW), null);
  assert.equal(pipePhaseNow(undefined, NOW), null);
  const p = pipeEdge({ gate: null, phase: null }, activeEdge(sig({ idle: true, load_age_s: 4, queue_depth: 0 })), NOW);
  assert.equal(p.phase, "base");
  assert.equal(p.muted, false); // the engine row is healthy and quiet: calm base
  assert.equal(p.reason, "");
});

test("engine queue depth is a fact only when FRESH: fresh depth warns on the pipe, a stale sample does not", () => {
  const fresh = pipeEdge({ gate: { state: "active", waiting: 0 } }, activeEdge(sig({ idle: false, load_age_s: 4, queue_depth: 3 })), NOW);
  assert.equal(fresh.phase, "queued");
  assert.equal(fresh.dashed, true);
  assert.equal(fresh.animated, false); // engine-side congestion is not a stream
  assert.match(fresh.reason, /engine queue depth 3/);

  const stale = pipeEdge({ gate: { state: "active", waiting: 0 } }, activeEdge(sig({ idle: false, load_age_s: 40, queue_depth: 3 })), NOW);
  assert.equal(stale.phase, "base");
  assert.equal(stale.dashed, false);
  assert.equal(stale.reason, ""); // the stale-sample honesty lives on the grid annotation, not the pipe
});

test("a live stream beats engine-side congestion: a fresh output phase on a backed-up engine still flows blue", () => {
  const p = pipeEdge(
    { gate: { state: "active", waiting: 0 }, phase: { state: "output", at: NOW - 2000 } },
    activeEdge(sig({ idle: false, load_age_s: 4, queue_depth: 5 })),
    NOW,
  );
  assert.equal(p.phase, "output");
  assert.equal(p.animated, true);
});

test("degraded / no-signal engine rows render the honest no-signal posture, never a phase", () => {
  const degraded = pipeEdge({ gate: { state: "active", waiting: 0 } }, activeEdge(sig({ degraded: true, degraded_reason: "probe_failed" })), NOW);
  assert.equal(degraded.phase, "base");
  assert.equal(degraded.muted, true);
  assert.equal(pipeClass(degraded), "pipe muted");
  const noSignal = pipeEdge({ gate: { state: "active", waiting: 0 } }, activeEdge(sig({ no_signal_reason: "no activity source" })), NOW);
  assert.equal(noSignal.muted, true);
  const declared = pipeEdge({ gate: null }, edgeFor({ server_id: "srv-a" }, null), NOW);
  assert.equal(declared.phase, "base");
  assert.equal(declared.muted, true);
});

test("the pipe tooltip is the grid tooltip: same base text, pin clause, slow clause, phase clause", () => {
  const s: SessionRow = { token: "abcd-1234", server_id: "srv-a", engine_pin: { server_id: "srv-b", url: "u", set_at: 1 }, gate: { state: "active", waiting: 0 }, phase: { state: "tools", at: NOW - 1000 }, registered_at: 0, last_seen: NOW } as SessionRow;
  const edge = engineEdge(s, sig({ idle: false, load_age_s: 4, queue_depth: 2 }));
  const pipe = pipeEdge(s, edge, NOW);
  const title = pipeTitle("abcd-1234", "omlx-beta", edge, pipe);
  assert.match(title, /^session abcd-1234 → engine omlx-beta\b/);
  assert.ok(title.includes("operator pin — lands at release time"));
  assert.ok(title.includes("slow: queue depth 2 fresh"));
  assert.ok(title.includes("answering: tools"));
});

test("flowPipePath: same y is a straight line; different y is orthogonal with rounded corners; the radius clamps", () => {
  assert.equal(flowPipePath(10, 5, 80, 5), "M10 5 L80 5");
  const d = flowPipePath(10, 5, 80, 45, 10);
  assert.ok(d.includes("H35"));
  assert.ok(d.includes("Q45 5 45 15"));
  assert.ok(d.includes("V35"));
  assert.ok(d.includes("H80"));
  const clamped = flowPipePath(10, 5, 80, 9, 10); // dy 4 → r at most 2
  assert.ok(clamped.includes("Q45 5 45 7"));
  assert.ok(!clamped.includes("Q45 5 45 15"));
});

// ---------------------------------------------------------------------------
// Render invariants, pinned from the source (the repo's view-source pattern):
// the grid stays the functional surface, the SVG is decoration, and the
// flow view makes zero new network calls.

const sessionsSrc = readFileSync(join(here, "..", "src", "views", "Sessions.tsx"), "utf-8");
const flowStart = sessionsSrc.indexOf("function FlowView(");
const flowSrc = sessionsSrc.slice(flowStart, sessionsSrc.indexOf("// The session launcher"));

test("the flow SVG is decoration: aria-hidden, pointer-events none via .flow-pipes, per-edge <title> from the shared pipeTitle", () => {
  assert.ok(flowStart > 0);
  assert.ok(flowSrc.includes('aria-hidden="true"'));
  assert.ok(flowSrc.includes('className="flow-pipes"'));
  assert.ok(flowSrc.includes("pipeClass(n.pipe)"));
  assert.ok(flowSrc.includes("pipeTitle(n.short, n.engineName, n.edge, n.pipe)"));
  assert.ok(flowSrc.includes("<title>{p.title}</title>"));
});

test("zero new network calls in the flow view: geometry is DOM arithmetic on the polled snapshot", () => {
  assert.ok(!flowSrc.includes("fetch("));
  assert.ok(!flowSrc.includes("getAliases("));
  assert.ok(!flowSrc.includes("setSessionPin("));
  assert.ok(!flowSrc.includes("setSessionOverride("));
  assert.ok(!flowSrc.includes("getSessionTranscript("));
});

test("grid regressions intact: edge labels, exception annotations, load counts, the re-route hint, engine posture words all still render", () => {
  assert.ok(flowSrc.includes("s.edge.annotation ? ` · ${s.edge.annotation}`"));
  assert.ok(flowSrc.includes("s.edge.slow ? \"text-warn\" : \"text-dim\""));
  assert.ok(flowSrc.includes("act · "));
  assert.ok(flowSrc.includes("liveWord(sig ? { idle: sig.idle, degraded: sig.degraded } : null, l.active > 0)"));
  assert.ok(sessionsSrc.includes("the pin select on a row (rows mode) re-routes"));
});

test("the pipe tokens are theme-derived, not hardcoded: every --pipe-* references a palette var, the purple is a mix of accent+err, and motion honors prefers-reduced-motion", () => {
  const css = readFileSync(join(here, "..", "src", "index.css"), "utf-8");
  for (const [tok, parent] of [
    ["--pipe-base", "var(--border)"],
    ["--pipe-queued", "var(--warn)"],
    ["--pipe-thinking", "var(--ok)"],
    ["--pipe-output", "var(--accent)"],
  ]) {
    assert.ok(css.includes(`${tok}: ${parent}`), `${tok} must derive from ${parent}`);
  }
  assert.ok(css.includes("--pipe-tools: color-mix(in oklab, var(--accent), var(--err))"));
  const pipeBlock = css.slice(css.indexOf(".pipe {"));
  assert.ok(pipeBlock.includes("prefers-reduced-motion: no-preference"));
  assert.ok(pipeBlock.includes("stroke: var(--pipe-thinking)"));
});

test("no new theme surface: the #68 editable keys stay nine — pipe colors are derived, not configured", () => {
  assert.equal(THEME_KEYS.length, 9);
});

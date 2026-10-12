// session-edge.test.ts — the D4 session→engine edge + the slow heuristic
// (alias-stability-and-slow-engines.md D4, display only). The discipline
// under test: the slow word needs the session gate ACTIVE plus an engine row
// that NAMES a fact (fresh queue > 0, a stale load sample, a degraded /
// no-signal posture); a healthy row annotates NOTHING (the byte-for-byte
// guard — unpinned healthy sessions render unchanged); the pin wins the
// edge; queue freshness rides load_age_s, never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { engineEdge, EDGE_SAMPLE_STALE_S } from "../src/lib/session-edge.js";
import type { ServerSignal, SessionRow } from "../src/lib/api.js";

type Sess = Pick<SessionRow, "server_id" | "engine_pin" | "gate">;

const activeSess: Sess = { server_id: "srv-a", gate: { state: "active", waiting: 0 } };

function sig(patch: Partial<ServerSignal>): ServerSignal {
  return {
    idle: true,
    idle_for_s: 12,
    last_activity: null,
    last_log_write_age_s: null,
    degraded: false,
    ...patch,
  } as ServerSignal;
}

test("healthy idle edge: no annotation, not slow, unpinned target = server_id (byte-for-byte guard)", () => {
  const e = engineEdge(activeSess, sig({ idle: true, load_source: "omlx-status", load_age_s: 4, queue_depth: 0 }));
  assert.equal(e.target, "srv-a");
  assert.equal(e.pinned, false);
  assert.equal(e.posture, "idle");
  assert.equal(e.annotation, null);
  assert.equal(e.slow, false);
  assert.deepEqual(e.slowReasons, []);
});

test("fresh queue_depth > 0 on an ACTIVE session → slow, queue named in the reason", () => {
  const e = engineEdge(activeSess, sig({ idle: false, load_source: "omlx-status", load_age_s: 4, queue_depth: 2 }));
  assert.equal(e.slow, true);
  assert.equal(e.queueFresh, true);
  assert.match(e.slowReasons[0] ?? "", /queue depth 2 fresh/);
  assert.equal(e.annotation, "2 queued");
});

test("a load sample older than the window → slow even with no queue key; the queue rides the stale honesty", () => {
  const e = engineEdge(activeSess, sig({ idle: false, load_source: "llamaswap-metrics", load_age_s: 40, queue_depth: 1 }));
  assert.equal(e.sampleStale, true);
  assert.equal(e.queueFresh, false);
  assert.equal(e.slow, true);
  assert.match(e.slowReasons[0] ?? "", /load sample 40s old/);
  assert.equal(e.annotation, `1 queued · sample 40s old`);
  assert.ok(EDGE_SAMPLE_STALE_S === 15); // the D4 "~15s" window
});

test("the slow word needs the gate ACTIVE: a queued session on the same slow engine never highlights", () => {
  const e = engineEdge({ server_id: "srv-a", gate: { state: "queued", waiting: 2 } }, sig({ load_age_s: 40 }));
  assert.equal(e.slow, false);
  assert.equal(e.annotation, "sample 40s old"); // the fact still shows — the WORD does not
});

test("posture degraded / no-signal / no signal at all → slow when active, named posture", () => {
  const degraded = engineEdge(activeSess, sig({ degraded: true, degraded_reason: "feed gone" }));
  assert.equal(degraded.posture, "degraded");
  assert.equal(degraded.slow, true);
  assert.deepEqual(degraded.slowReasons, ["engine posture: degraded"]);
  assert.equal(degraded.annotation, "degraded");

  const noSignal = engineEdge(activeSess, sig({ no_signal_reason: "no feed, log glob matches nothing" }));
  assert.equal(noSignal.posture, "no-signal");
  assert.equal(noSignal.slow, true);

  const unwatched = engineEdge(activeSess, null);
  assert.equal(unwatched.posture, "no-signal");
  assert.equal(unwatched.slow, true);
  assert.equal(unwatched.annotation, "no-signal");
});

test("the pin wins the edge and marks it pinned", () => {
  const e = engineEdge(
    { server_id: "srv-a", engine_pin: { server_id: "srv-b", url: "https://b", set_at: 1 }, gate: { state: "active", waiting: 0 } },
    sig({ idle: false }),
  );
  assert.equal(e.target, "srv-b");
  assert.equal(e.pinned, true);
  assert.equal(e.slow, false); // busy on a fresh idle-detected row is the NORMAL state, never an alert
  assert.equal(e.annotation, null);
});

test("a row whose kind names no queue (no queue_depth key) never slow-fakes one", () => {
  const e = engineEdge(activeSess, sig({ idle: false, load_source: "llamaswap-metrics", load_age_s: 3 }));
  assert.equal(e.queueDepth, null);
  assert.equal(e.queueFresh, false);
  assert.equal(e.slow, false);
  assert.equal(e.annotation, null);
});

test("no server_id and no pin → no edge at all", () => {
  const e = engineEdge({ gate: { state: "active", waiting: 0 } }, null);
  assert.equal(e.target, null);
  assert.equal(e.annotation, null);
});

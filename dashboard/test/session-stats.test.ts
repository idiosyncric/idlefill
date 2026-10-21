// session-stats.test.ts — the Sessions tab tiles. The discipline under test:
// the tile counts follow the SAME row rules as format.ts (30s active
// window, 90s heartbeat, override precedence) so tiles and row words can
// never disagree; a count over registered rows is a direct truth (0
// renders 0); the gate tile names the longest hold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTiles } from "../src/lib/session-stats.js";
import type { SessionRow } from "../src/lib/api.js";

const NOW = 1_000_000_000_000;

function sess(over: Record<string, unknown> = {}): SessionRow {
  return {
    token: "t",
    registered_at: NOW - 10_000,
    last_seen: NOW - 1_000,
    last_activity: null,
    ...over,
  } as unknown as SessionRow;
}

// One active, one idle-queued (held), one paused, one stale: every tile
// reads its axis and the sub lines name the coverage.
test("session tiles split the registered rows by state, gate, override, liveness", () => {
  const sessions = [
    sess({ token: "a", last_activity: NOW - 5_000 }),
    sess({ token: "b", gate: { state: "queued", waitSince: NOW - 60_000 } }),
    sess({ token: "c", override: { override: "pause" } }),
    sess({ token: "d", last_seen: NOW - 120_000 }),
  ];
  const [sessionsTile, gate, paused, stale] = sessionTiles(sessions, NOW);
  assert.equal(sessionsTile.value, "4");
  assert.equal(sessionsTile.sub, "1 active · 2 idle · 1 stale");
  assert.equal(gate.value, "1");
  assert.equal(gate.sub, "held behind another session · longest hold 1m 0s");
  assert.equal(paused.value, "1");
  assert.equal(paused.sub, "operator override — the router holds this traffic");
  assert.equal(stale.value, "1");
  assert.equal(stale.sub, "no heartbeat in 90 s — the router may have dropped the row");
});

// No rows: the count is still a truth (0), and the sub names the
// registration rule — never an em-dash pretending the count is unknown.
test("empty session list is a direct zero with the registration reason", () => {
  const [sessionsTile, gate, paused, stale] = sessionTiles([], NOW);
  assert.deepEqual([sessionsTile.value, gate.value, paused.value, stale.value], ["0", "0", "0", "0"]);
  assert.equal(sessionsTile.sub, "no sessions registered — a router registers one on its first request");
  assert.equal(gate.sub, "no session held at the gate");
  assert.equal(paused.sub, "no operator pauses");
  assert.equal(stale.sub, "every row answered recently");
});

// The 30s window is a hard edge (strict <): a request at 29.999s ago is
// active, at exactly 30s it is idle — the same edge the row words use.
test("the active window matches the row rule (30 s edge)", () => {
  const sessions = [
    sess({ token: "a", last_activity: NOW - 29_999 }),
    sess({ token: "b", last_activity: NOW - 30_000 }),
  ];
  const [sessionsTile] = sessionTiles(sessions, NOW);
  assert.equal(sessionsTile.sub, "1 active · 1 idle");
});

// Owner ask 2026-10-21 — the turn-lease row word: a session whose Hermes
// turn lease is live is WORKING (tool or local execution), never counted
// idle; the row-word rule lives in format.ts and the tiles follow it.
test("a live turn lease reads working — its own segment, never folded into idle", () => {
  const sessions = [
    sess({ token: "a", last_activity: NOW - 5_000 }), // request seen ⇒ Active wins
    sess({ token: "b", turn: { at: NOW - 10_000, platform: "tui" } }), // quiet stream, held lease ⇒ Working
    sess({ token: "c" }), // plain idle
    sess({ token: "d", turn: { at: NOW - 300_000 } }), // stale report dims to idle
    sess({ token: "e", turn: { at: NOW - 10_000 }, last_seen: NOW - 120_000 }), // offline: no lease claim
  ];
  const [sessionsTile] = sessionTiles(sessions, NOW);
  assert.equal(sessionsTile.value, "5");
  assert.equal(sessionsTile.sub, "1 active · 1 working · 3 idle · 1 stale");
});

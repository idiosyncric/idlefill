// flow-cards.test.ts — the #91 card facts + the "outside idlefill"
// detection, pinned as PURE logic. The discipline under test: every field is
// either a PUBLISHED fact (gateway ledger counts, the engine's own status
// axis) or ABSENT — never inferred, never a fake zero. The foreign rule:
// only engines that NAME an in-flight count can produce a row; a parked
// (queued) session never counts as a held slot; foreign = engine in-flight
// minus the slots idlefill provably holds, and a row appears ONLY when
// there is a remainder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionCardFacts, foreignActivity } from "../src/lib/flow-cards.js";
import type { ServerRow, ServerSignal, SessionRow, StateSnapshot } from "../src/lib/api.js";

const NOW = 1_700_000_000_000;

function sess(patch: Partial<SessionRow>): SessionRow {
  return {
    token: "tok-12345678",
    registered_at: NOW - 38 * 60_000,
    last_seen: NOW - 5_000,
    last_activity: NOW - 5_000,
    ...patch,
  } as SessionRow;
}

function sig(patch: Partial<ServerSignal>): ServerSignal {
  return {
    idle: false,
    idle_for_s: null,
    last_activity: null,
    last_log_write_age_s: null,
    degraded: false,
    ...patch,
  };
}

test("sessionCardFacts: the published ledger facts ride verbatim; absent stays null", () => {
  const s = sess({
    hermes_meta: { profile: "mac-sam", input_tokens: 21439, message_count: 23 },
    history: { rpm: [], model: "qwen3.8-flash-next-q2_0", tokens: 1200, reported_at: NOW },
  });
  const f = sessionCardFacts(s, sig({ cache_efficiency: 0.85, avg_generation_tps: 123.4, avg_prefill_tps: 4000.2 }), NOW);
  assert.deepEqual(f, {
    profile: "mac-sam",
    ageS: 38 * 60,
    ctx: 21439,
    turns: 23,
    genTps: 123.4,
    prefillTps: 4000.2,
    cachePct: 85,
  });
});

test("sessionCardFacts: no meta, no engine axis → all nulls (never a fake zero)", () => {
  const f = sessionCardFacts(sess({}), null, NOW);
  assert.deepEqual(f, { profile: null, ageS: 38 * 60, ctx: null, turns: null, genTps: null, prefillTps: null, cachePct: null }, "age rides registered_at; everything unreported is null");
  const bad = sessionCardFacts(sess({ hermes_meta: { input_tokens: -3, message_count: "x" } as SessionRow["hermes_meta"] }), sig({ cache_efficiency: 1.7 }), NOW);
  assert.equal(bad.ctx, null, "negative garbage drops the KEY");
  assert.equal(bad.turns, null);
  assert.equal(bad.cachePct, null, "a ratio outside [0,1] never rides");
});

test("foreignActivity: only kinds that NAME an in-flight count can produce a row", () => {
  const engines: ServerRow[] = [
    { id: "e-omlx", name: "oMLX", url: "http://x", signal: sig({ idle: false, in_flight: 2 }), model_source: "probed", probed_at: null, models: [] },
    { id: "e-lswap", name: "llama-swap", url: "http://y", signal: sig({ idle: false }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = { now: NOW, sessions: [], servers: engines } as StateSnapshot;
  assert.deepEqual(foreignActivity(st, engines), [{ engineId: "e-omlx", inFlight: 2, idlefillSlots: 0, foreign: 2 }], "the strata/oMLX in-flight axis speaks; llama-swap (HTTP, no count) never does");
});

test("foreignActivity: held slots subtract; the remainder is the only row", () => {
  const engines: ServerRow[] = [
    { id: "e-1", name: "engine-1", url: "http://x", signal: sig({ idle: false, in_flight: 3 }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = {
    now: NOW,
    servers: engines,
    sessions: [
      sess({ token: "a", server_id: "e-1", gate: { state: "active", waiting: 0 } }),
      sess({ token: "b", server_id: "e-1", gate: { state: "queued", waiting: 2 } }), // parked at the client: not a slot
      sess({ token: "c", engine_pin: { server_id: "e-1", url: "http://x", set_at: NOW }, last_activity: NOW - 10_000 }), // gate-less but active within the window
    ],
  } as StateSnapshot;
  assert.deepEqual(foreignActivity(st, engines), [{ engineId: "e-1", inFlight: 3, idlefillSlots: 2, foreign: 1 }]);
  const balanced: ServerRow[] = [{ ...engines[0], signal: sig({ idle: false, in_flight: 2 }) }];
  assert.deepEqual(foreignActivity({ ...st, servers: balanced } as StateSnapshot, balanced), [], "no remainder → no card: everything the engine counts belongs to idlefill");
  const noSignal: ServerRow[] = [{ ...engines[0], signal: null }];
  assert.deepEqual(foreignActivity({ ...st, servers: noSignal } as StateSnapshot, noSignal), [], "no axis, no claim");
});

test("foreignActivity: an old gate-less row is not a held slot", () => {
  const engines: ServerRow[] = [
    { id: "e-1", name: "engine-1", url: "http://x", signal: sig({ idle: false, in_flight: 1 }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = { now: NOW, servers: engines, sessions: [sess({ server_id: "e-1", last_activity: NOW - 60_000 })] } as StateSnapshot;
  assert.deepEqual(foreignActivity(st, engines), [{ engineId: "e-1", inFlight: 1, idlefillSlots: 0, foreign: 1 }], "a row whose last request is 60s old holds no live slot — the engine's live count is someone else's conversation");
});

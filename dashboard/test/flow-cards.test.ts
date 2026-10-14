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

test("foreignActivity: parked conversation caches are the PRIMARY evidence (strata)", () => {
  const engines: ServerRow[] = [
    { id: "e-strata", name: "strata", url: "http://x", signal: sig({ idle: false, in_flight: 1, conv_cache_parked: 4, conv_cache_slots: 4 }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = {
    now: NOW,
    servers: engines,
    sessions: [sess({ server_id: "e-strata", gate: { state: "active", waiting: 0 } })],
  } as StateSnapshot;
  assert.deepEqual(
    foreignActivity(st, engines),
    [{ engineId: "e-strata", evidence: "conversation_cache", parkedConversations: 4, inFlight: 1, attributed: 1, foreign: 3 }],
    "the engine names 4 parked conversation caches; only one session is registered — three conversations are someone else's",
  );
  // Every parked cache attributable → no remainder, no card.
  const allMine = {
    ...st,
    sessions: [
      sess({ token: "tok-aaaa0001", server_id: "e-strata", gate: { state: "active", waiting: 0 } }),
      sess({ token: "tok-aaaa0002", server_id: "e-strata", last_activity: NOW - 10_000 }),
      sess({ token: "tok-aaaa0003", engine_pin: { server_id: "e-strata", url: "http://x", set_at: NOW }, last_activity: NOW - 400_000 }),
      sess({ token: "tok-aaaa0004", server_id: "e-strata", gate: { state: "queued", waiting: 1 } }),
    ],
  } as StateSnapshot;
  assert.deepEqual(foreignActivity(allMine, engines), [], "parked − sessions-on-engine = 0 → honest nothing");
});

test("foreignActivity: a never-used token has no conversation to subtract", () => {
  const engines: ServerRow[] = [
    { id: "e-1", name: "strata", url: "http://x", signal: sig({ idle: false, conv_cache_parked: 2 }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = {
    now: NOW,
    servers: engines,
    sessions: [{ token: "fresh-mint", registered_at: NOW, last_seen: NOW, last_activity: null, server_id: "e-1" } as SessionRow],
  } as StateSnapshot;
  assert.deepEqual(
    foreignActivity(st, engines),
    [{ engineId: "e-1", evidence: "conversation_cache", parkedConversations: 2, inFlight: null, attributed: 0, foreign: 2 }],
    "the minted-but-never-requested token carries no conversation on the engine — the parked caches are not its",
  );
  const noSignal: ServerRow[] = [{ id: "e-1", name: "x", url: "u", signal: null, model_source: "declared", probed_at: null, models: [] }];
  assert.deepEqual(foreignActivity({ now: NOW, sessions: [], servers: noSignal } as StateSnapshot, noSignal), [], "no axis, no claim");
});

test("foreignActivity: in-flight counts are the FALLBACK (oMLX), and held slots subtract", () => {
  const engines: ServerRow[] = [
    { id: "e-omlx", name: "oMLX", url: "http://x", signal: sig({ idle: false, in_flight: 2 }), model_source: "probed", probed_at: null, models: [] },
    { id: "e-lswap", name: "llama-swap", url: "http://y", signal: sig({ idle: false }), model_source: "probed", probed_at: null, models: [] },
  ];
  const st = { now: NOW, sessions: [], servers: engines } as StateSnapshot;
  assert.deepEqual(
    foreignActivity(st, engines),
    [{ engineId: "e-omlx", evidence: "in_flight", parkedConversations: null, inFlight: 2, attributed: 0, foreign: 2 }],
    "the in-flight axis speaks; llama-swap (HTTP, no count) never does",
  );
  const held: ServerRow[] = [{ id: "e-omlx", name: "oMLX", url: "http://x", signal: sig({ idle: false, in_flight: 3 }), model_source: "probed", probed_at: null, models: [] }];
  const st2 = {
    now: NOW,
    servers: held,
    sessions: [
      sess({ token: "tok-bbbb1111", server_id: "e-omlx", gate: { state: "active", waiting: 0 } }),
      sess({ token: "tok-bbbb2222", server_id: "e-omlx", gate: { state: "queued", waiting: 2 } }), // parked at the client: not a slot
      sess({ token: "tok-bbbb3333", engine_pin: { server_id: "e-omlx", url: "http://x", set_at: NOW }, last_activity: NOW - 10_000 }), // gate-less but active within the window
    ],
  } as StateSnapshot;
  assert.deepEqual(foreignActivity(st2, held), [{ engineId: "e-omlx", evidence: "in_flight", parkedConversations: null, inFlight: 3, attributed: 2, foreign: 1 }]);
  const oldRow = { ...st2, sessions: [...st2.sessions, sess({ token: "tok-bbbb4444", server_id: "e-omlx", last_activity: NOW - 60_000 })] } as StateSnapshot;
  assert.deepEqual(
    foreignActivity(oldRow, held),
    [{ engineId: "e-omlx", evidence: "in_flight", parkedConversations: null, inFlight: 3, attributed: 2, foreign: 1 }],
    "an old gate-less row holds no live slot — the engine's count still names someone else's conversation",
  );
});

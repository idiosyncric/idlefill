// agent-stats.test.ts — the Agents tab tiles. The honesty axis here is the
// FETCH axis, not the number axis: the key list is token-gated, so an
// un-fetched list is UNKNOWN ("—" naming the gate), while a fetched empty
// list is a TRUE 0 (the zero-config posture: the endpoint accepts any
// caller). The roster follows the card's rule: null/empty = no online
// client reported a Hermes home — named absence, never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTiles, mintedLabelSet } from "../src/lib/agent-stats.js";
import type { AgentKeyRow, AgentRosterRow } from "../src/lib/api.js";

// Never fetched (no token on this page): the key tile names the gate.
test("un-fetched key list is an em-dash naming the token gate, never a misleading 0", () => {
  const [keys] = agentTiles(null, null);
  assert.equal(keys.value, "—");
  assert.equal(keys.sub, "the key list is token-gated — paste the arbiter token");
});

// Fetched and empty: a true zero — the zero-config posture, named.
test("fetched empty key list is a true zero naming the zero-config posture", () => {
  const [keys] = agentTiles(0, []);
  assert.equal(keys.value, "0");
  assert.equal(keys.sub, "none minted — the endpoint accepts any caller on this machine");
});

// Fetched with keys + a real roster: counts over rows, coverage named.
test("minted keys and adopted profiles count over the rows", () => {
  const roster: AgentRosterRow[] = [
    { profile: "writer", posture: "adopted" },
    { profile: "planner", posture: "external" },
    { profile: "scout", posture: "adopted" },
  ];
  const [keys, profiles] = agentTiles(3, roster);
  assert.equal(keys.value, "3");
  assert.equal(keys.sub, "agent-inference credentials for the aggregate endpoint");
  assert.equal(profiles.value, "2 of 3");
  assert.equal(profiles.sub, "Hermes profiles on this machine routing through idlefill");
});

// No online client reported a roster (null or empty): named absence —
// the same hiding rule the roster card uses, never an empty list.
test("no roster reported = em-dash naming the missing Hermes home", () => {
  for (const roster of [null, []]) {
    const [, profiles] = agentTiles(1, roster);
    assert.equal(profiles.value, "—");
    assert.equal(profiles.sub, "no Hermes roster reported — an online client with a Hermes home fills this in");
  }
});

// The roster join is EXACT profile-name = key-label, never fuzzy.
test("the minted-label join is exact", () => {
  const keys: AgentKeyRow[] = [{ id: "1", label: "writer", created_at: 0 }];
  const set = mintedLabelSet(keys);
  assert.ok(set.has("writer"));
  assert.ok(!set.has("Writer"), "case-sensitive exact match — never fuzzy");
});

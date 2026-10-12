// model-stats.test.ts — the Models tab tiles over the PUBLISHED routing
// truth (model_aliases, the winner-only block). The discipline under test:
// no alias resolving = named absence ("—" — bare names route, which is a
// real posture, not an error); probed-vs-declared is the routing axis;
// fallback is the exception axis; the first alias names the advertised
// default and stays one word (truncated).

import { test } from "node:test";
import assert from "node:assert/strict";
import { modelTiles } from "../src/lib/model-stats.js";
import type { ModelAliasEntry, StateSnapshot } from "../src/lib/api.js";

function st(aliases: Partial<ModelAliasEntry>[]): StateSnapshot {
  return { model_aliases: aliases } as unknown as StateSnapshot;
}

// Two winners: one probed green, one declared + re-routed; the first
// alias is the advertised default.
test("model tiles read the published winners: probed routing, re-routed exception, first alias", () => {
  const tiles = modelTiles(
    st([
      { name: "big-model", server_id: "a", catalog_source: "probed" },
      { name: "fast-model", server_id: "b", catalog_source: "declared", fallback: true },
    ]),
  );
  const [aliases, routing, rerouted, first] = tiles;
  assert.equal(aliases.value, "2");
  assert.equal(aliases.sub, "operator aliases with a resolved winner this tick");
  assert.equal(routing.value, "1 of 2");
  assert.equal(rerouted.value, "1");
  assert.equal(rerouted.sub, "a dead pin or group block moved traffic to the next-best pair");
  assert.equal(first.value, "big-model");
  assert.equal(first.sub, "the top alias — the name /v1/models leads with");
});

// No alias resolves: named absence everywhere — bare model names routing
// is a real posture (the zero-config machine), never a fake count.
test("no published alias = named absence, never a zero", () => {
  const [aliases, routing, rerouted, first] = modelTiles(st([]));
  assert.deepEqual([aliases.value, routing.value, first.value], ["—", "—", "—"]);
  assert.equal(aliases.sub, "no alias resolves — bare model names route");
  assert.equal(routing.sub, aliases.sub);
  assert.equal(rerouted.value, "0", "the exception axis is a direct count over rows that exist");
  assert.equal(first.sub, "no default advertised");
});

// The first alias stays one word: 17 chars + ellipsis.
test("the first-alias value is truncated to one word", () => {
  const [, , , first] = modelTiles(st([{ name: "qwen3.8-flash-next-thinking-max", catalog_source: "probed" }]));
  assert.equal(first.value, "qwen3.8-flash-nex…");
  assert.equal(first.value.length, 18);
});

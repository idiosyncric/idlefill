// usage-stats.test.ts — the Usage tab tiles over the metrics retention
// store. The discipline under test: an EMPTY series set is absent ("—"
// naming why — the store has no rows yet), while a series that exists
// with all-zero points is a true 0. Token truth names its source:
// engine counters beat lease reports, and a lease-sourced figure says so
// in the sub. Idle share is sample-weighted, not a mean of per-hour per-
// centages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { usageTiles } from "../src/lib/usage-stats.js";
import type { MetricPoint, MetricsSeries } from "../src/lib/api.js";

function series(key: string, points: Partial<MetricPoint>[]): MetricsSeries {
  return [{ key, points: points.map((p) => ({ hour: "2026-10-12T00:00", req_total: 0, tokens_out: 0, ...p })) }];
}

// Engine series with counter-backed token samples: engine numbers win and
// the sub names the source. Idle share weights by sample count.
test("engine counters win the token tile and the idle share is sample-weighted", () => {
  const eng = series("srv-a", [
    { req_total: 100, engine_tokens_out: 4_000, idle_samples: 30, samples: 100 },
    { req_total: 20, engine_tokens_out: 1_000, idle_samples: 10, samples: 100 },
  ]);
  const lease = series("p1", [{ tokens_out: 90_000 }]);
  const [requests, tokens, idle] = usageTiles(eng, lease);
  assert.equal(requests.value, "120");
  assert.equal(requests.sub, "requests the engines served · 7 days");
  assert.equal(tokens.value, "5,000");
  assert.equal(tokens.sub, "engine-reported output tokens · 7 days");
  assert.equal(idle.value, "20%", "40 idle of 200 samples — weighted, not the hour-mean (25% + 5% / 2 = 17.5%)");
});

// No engine token counters (llama-swap era): the lease reports stand and
// the sub names the fallback source.
test("no engine counters → lease-sourced tokens, labelled as such", () => {
  const eng = series("srv-a", [{ req_total: 5 }]);
  const lease = series("p1", [{ tokens_out: 12_000 }]);
  const [, tokens, idle] = usageTiles(eng, lease);
  assert.equal(tokens.value, "12,000");
  assert.equal(tokens.sub, "lease-reported — the engines publish no token counters");
  assert.equal(idle.value, "—");
  assert.equal(idle.sub, "no idle samples in the last 7 days");
});

// Store empty (the 501/unwired shape): named absence on every tile,
// never a confident zero over a window nobody filled.
test("empty store = named absence on all three tiles", () => {
  const [requests, tokens, idle] = usageTiles([], []);
  assert.deepEqual([requests.value, tokens.value, idle.value], ["—", "—", "—"]);
  assert.equal(requests.sub, "the metrics store has no engine series yet");
  assert.equal(tokens.sub, "no token counters in the last 7 days");
  assert.equal(idle.sub, "no idle samples in the last 7 days");
});

// A series that EXISTS with all-zero points is a true 0 (a quiet week),
// not an absence.
test("a quiet week is a true zero, not an absence", () => {
  const eng = series("srv-a", [{ req_total: 0, idle_samples: 0, samples: 24 }]);
  const [requests, , idle] = usageTiles(eng, []);
  assert.equal(requests.value, "0");
  assert.equal(requests.sub, "requests the engines served · 7 days");
  assert.equal(idle.value, "0%");
});

// load-read.test.ts — the engine load read (issue #52 slice 2, the LOAD
// axis). Proves the absent-key case renders nothing (null) and the
// present-key case renders the expected strings. Pure logic (no DOM), run
// under node:test + tsx — the repo's test style. The view renders `null`
// as "nothing" and a non-null result as the source label + its parts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRead, LOAD_FRESHNESS_DEFAULT_S } from "../src/lib/load-read.js";
import type { ServerSignal } from "../src/lib/api.js";

// A bare (pre-#52) signal: verdict fields only, no load keys.
function baseSig(over: Partial<ServerSignal> = {}): ServerSignal {
  return {
    idle: true,
    idle_for_s: 100,
    last_activity: null,
    last_log_write_age_s: null,
    degraded: false,
    ...over,
  };
}

// The absent case: no load keys → the read is null → the view renders nothing.
test("absent load keys → the read renders nothing (null)", () => {
  assert.equal(loadRead(baseSig(), LOAD_FRESHNESS_DEFAULT_S), null);
  // A row with NO signal at all (not watched) also renders nothing.
  assert.equal(loadRead(null, LOAD_FRESHNESS_DEFAULT_S), null);
  // A named source with nothing else still shows the source label (exception
  // only: no fake zero, no "n/a").
  const srcOnly = baseSig({ load_source: "omlx-health", load_age_s: 10 });
  const r = loadRead(srcOnly, LOAD_FRESHNESS_DEFAULT_S);
  assert.ok(r);
  assert.equal(r.source, "omlx-health");
  assert.deepEqual(r.parts, []);
  assert.equal(r.stale, false);
});

// The present case: the expected strings (source, gpu, tps, model).
test("present load keys → the expected strings", () => {
  const sig = baseSig({
    idle: false,
    idle_for_s: 5,
    load_source: "llamaswap-metrics",
    load_age_s: 3,
    gpu_util_percent: 91,
    tokens_per_second: 141.4188,
    model_loaded: "Qwen3-32B",
  });
  const r = loadRead(sig, LOAD_FRESHNESS_DEFAULT_S);
  assert.ok(r);
  assert.equal(r.source, "llamaswap-metrics");
  assert.deepEqual(r.parts, ["gpu 91%", "141 tok/s", "Qwen3-32B"]);
  assert.equal(r.stale, false, "a fresh read (3s < 45s) is not stale");
});

// Stale: load_age_s above the configured freshness → flagged stale (dimmed).
test("stale read (load_age_s above the window) → flagged stale", () => {
  const sig = baseSig({
    load_source: "llamaswap-metrics",
    load_age_s: 120,
    gpu_util_percent: 12,
  });
  assert.equal(loadRead(sig, LOAD_FRESHNESS_DEFAULT_S)?.stale, true, "120s > 45s window → stale");
  // And it respects a custom configured window (120s is fresh within 120s).
  assert.equal(loadRead(sig, 120)?.stale, false, "within a 120s window it is fresh");
});

// Exception-only: a partial read shows only the keys that are present.
test("partial read → only the present keys, no fake zeros", () => {
  const sig = baseSig({
    load_source: "omlx-health",
    load_age_s: 10,
    // gpu_util_percent / tokens_per_second absent → omitted, never a zero.
    model_loaded: "Mistral-7B",
  });
  const r = loadRead(sig, LOAD_FRESHNESS_DEFAULT_S);
  assert.ok(r);
  assert.deepEqual(r.parts, ["Mistral-7B"], "no gpu / no tps → only the model name");
});

// fleet-stats.test.ts — the Overview fleet stat tiles (the sparkDash
// concept over idlefill's own data). Pure logic (no DOM), node:test + tsx.
// The discipline under test: fresh readings only, absent = "—" with the
// reason named, partial coverage named, engine-reported tokens win over
// lease-reported, never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetLoadTiles, tokensTodayTile, gibfmt, compact } from "../src/lib/fleet-stats.js";
import type { RawEngineLine, RawLeaseLine, StateSnapshot } from "../src/lib/api.js";

function sig(over: Record<string, unknown> = {}) {
  return {
    idle: true,
    idle_for_s: 100,
    last_activity: null,
    last_log_write_age_s: null,
    degraded: false,
    ...over,
  };
}

function st(servers: unknown[], staleS?: number): StateSnapshot {
  return {
    servers,
    ...(staleS !== undefined ? { metrics_load_stale_s: staleS } : {}),
  } as unknown as StateSnapshot;
}

// Fresh llama-swap-style readings on both rows: sums + coverage.
test("fleet tiles sum the FRESH readings and name the coverage", () => {
  const s = st([
    { id: "a", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 3, tokens_per_second: 141.4, gpu_power_watts: 448.69, gpu_mem_used_bytes: 3.27e10, gpu_mem_total_bytes: 3.42e10 }) },
    { id: "b", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 5, tokens_per_second: 58.6, gpu_power_watts: 120, gpu_mem_used_bytes: 1e10, gpu_mem_total_bytes: 2.4e10 }) },
  ]);
  const [decode, power, memory] = fleetLoadTiles(s);
  assert.equal(decode.value, "200 tok/s");
  assert.equal(decode.sub, "2 of 2 engines reporting");
  assert.equal(power.value, "569 W");
  assert.equal(memory.value, gibfmt(3.27e10 + 1e10));
  assert.equal(memory.sub, "2 of 2 engines reporting · of 54.2 GiB");
});

// A stale reading is UNKNOWN (the metrics_load_stale_s window) — it never
// counts toward a fleet total.
test("stale readings never count (the load axis window gates the tiles too)", () => {
  const s = st([
    { id: "a", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 3, tokens_per_second: 141, gpu_power_watts: 448 }) },
    { id: "b", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 300, tokens_per_second: 999, gpu_power_watts: 999 }) },
  ], 45);
  const [decode, power] = fleetLoadTiles(s);
  assert.equal(decode.value, "141 tok/s", "only the fresh reading sums");
  assert.equal(decode.sub, "1 of 2 engines reporting");
  assert.equal(power.value, "448 W");
});

// Absent keys → "—" with the reason named (never a fake zero). A row with
// NO load axis at all is coverage noise, not a zero.
test("absent load keys → em-dash tiles with named reasons, never a fake zero", () => {
  const s = st([{ id: "a", signal: sig() }]);
  const [decode, power, memory] = fleetLoadTiles(s);
  assert.deepEqual([decode.value, power.value, memory.value], ["—", "—", "—"]);
  assert.equal(decode.sub, "no engine reports a generation rate");
  assert.equal(power.sub, "no engine reports GPU power draw");
  assert.equal(memory.sub, "no engine reports GPU memory");
  const empty = fleetLoadTiles(st([]));
  assert.equal(empty[0].value, "—");
});

// Engine-reported token counters win when the kind publishes them.
test("tokens today: engine-reported deltas win over the lease numbers", () => {
  const eng: RawEngineLine[] = [
    { ts: 1000, kind: "engine", server_id: "a", tokens_out_delta: 500 },
    { ts: 2000, kind: "engine", server_id: "a", tokens_out_delta: null },
  ];
  const lease: RawLeaseLine[] = [{ ts: 2000, kind: "lease", project: "p", status: "finished", tokens_out: 90_000, tokens_in: 10 }];
  const tile = tokensTodayTile(eng, lease, [], 0);
  assert.equal(tile.value, "500");
  assert.equal(tile.sub, "engine-reported · since local midnight");
});

// No counter-backed kinds (llama-swap today): finished lease lines + the
// live counters of the RUNNING leases ride, labelled lease-reported.
test("tokens today: lease fallback = finished lines + running leases", () => {
  const lease: RawLeaseLine[] = [
    { ts: 1000, kind: "lease", project: "p", status: "finished", tokens_out: 40_000, tokens_in: 10 },
    { ts: 500, kind: "lease", project: "p", status: "finished", tokens_out: 70_000, tokens_in: 10 },
  ];
  const tile = tokensTodayTile([], lease, [{ tokens_out: 5_000 }], 800);
  assert.equal(tile.value, compact(45_000), "the pre-window line is excluded, the running lease counts");
  assert.equal(tile.sub, "lease-reported · since local midnight");
});

// Nothing recorded today → "—", not 0.
test("tokens today: nothing today is an em-dash, never a fake zero", () => {
  assert.deepEqual(tokensTodayTile([], [], [], 0), { value: "—", sub: "no tokens recorded today" });
});

test("formatters keep the tile value one word", () => {
  assert.equal(gibfmt(3.27e10), "30.5 GiB");
  assert.equal(gibfmt(3.42e11), "319 GiB");
  assert.equal(compact(1_234_567), "1.2M");
  assert.equal(compact(500), "500");
});

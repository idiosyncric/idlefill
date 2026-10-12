// fleet-stats.test.ts — the Overview fleet stat tiles (the sparkDash
// concept over idlefill's own data). Pure logic (no DOM), node:test + tsx.
// The discipline under test: fresh readings only, absent = "—" with the
// reason named, partial coverage named, engine-reported tokens win over
// lease-reported, never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetLoadTiles, tokensTodayTile, engineGauges, gibfmt, compact } from "../src/lib/fleet-stats.js";
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
    { id: "a", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 3, tokens_per_second: 141.4, gpu_power_watts: 448.69, gpu_mem_used_bytes: 3.27e10, gpu_mem_total_bytes: 3.42e10, host_mem_used_bytes: 5.04e10, host_mem_total_bytes: 1.01e11 }) },
    { id: "b", signal: sig({ load_source: "llamaswap-metrics", load_age_s: 5, tokens_per_second: 58.6, gpu_power_watts: 120, gpu_mem_used_bytes: 1e10, gpu_mem_total_bytes: 2.4e10, host_mem_used_bytes: 4.18e10, host_mem_total_bytes: 6.49e10 }) },
  ]);
  const [decode, power, memory, ram] = fleetLoadTiles(s);
  assert.equal(decode.value, "200 tok/s");
  assert.equal(decode.sub, "2 of 2 engines reporting");
  assert.equal(power.value, "569 W");
  assert.equal(memory.value, gibfmt(3.27e10 + 1e10));
  assert.equal(memory.sub, "2 of 2 engines reporting · of 54.2 GiB");
  assert.equal(ram.value, gibfmt(5.04e10 + 4.18e10));
  assert.equal(ram.sub, `2 of 2 engines reporting · of ${gibfmt(1.01e11 + 6.49e10)}`);
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
  const [decode, power, memory, ram] = fleetLoadTiles(s);
  assert.deepEqual([decode.value, power.value, memory.value, ram.value], ["—", "—", "—", "—"]);
  assert.equal(decode.sub, "no engine reports a generation rate");
  assert.equal(power.sub, "no engine reports GPU power draw");
  assert.equal(memory.sub, "no engine reports GPU memory");
  assert.equal(ram.sub, "no engine reports host RAM");
  const empty = fleetLoadTiles(st([]));
  assert.equal(empty[0].value, "—");
});

// Engine-reported token counters win when the kind publishes them — three
// figures, fixed order prompt · cached · decoded.
test("tokens today: engine-reported deltas win over the lease numbers", () => {
  const eng: RawEngineLine[] = [
    { ts: 1000, kind: "engine", server_id: "a", tokens_out_delta: 500, tokens_in_delta: 4000, tokens_cached_delta: 3000 },
    { ts: 2000, kind: "engine", server_id: "a", tokens_out_delta: null },
  ];
  const lease: RawLeaseLine[] = [{ ts: 2000, kind: "lease", project: "p", status: "finished", tokens_out: 90_000, tokens_in: 10 }];
  const tile = tokensTodayTile(eng, lease, [], 0);
  assert.equal(tile.value, `${compact(4000)} · ${compact(3000)} · 500`);
  assert.equal(tile.sub, "engine-reported · in · cached · out · since local midnight");
});

// A kind that names no reuse counter (a llama-swap-era line or an old
// oMLX store): the cache figure DROPS from the value and the sub says so
// — absent = unknown, never a fake zero.
test("tokens today: the cache axis drops with a named reason when no source reports it", () => {
  const eng: RawEngineLine[] = [
    { ts: 1000, kind: "engine", server_id: "a", tokens_out_delta: 500, tokens_in_delta: 4000 },
  ];
  const tile = tokensTodayTile(eng, [], [], 0);
  assert.equal(tile.value, `${compact(4000)} · 500`);
  assert.equal(tile.sub, "engine-reported · in · out · since local midnight · cache reads not reported");
});

// No counter-backed kinds (llama-swap today): finished lease lines + the
// live counters of the RUNNING leases ride, labelled lease-reported. The
// leases name no cache counter — the sub says so.
test("tokens today: lease fallback = finished lines + running leases", () => {
  const lease: RawLeaseLine[] = [
    { ts: 1000, kind: "lease", project: "p", status: "finished", tokens_out: 40_000, tokens_in: 10 },
    { ts: 500, kind: "lease", project: "p", status: "finished", tokens_out: 70_000, tokens_in: 10 },
  ];
  const tile = tokensTodayTile([], lease, [{ tokens_out: 5_000, tokens_in: 1_200 }], 800);
  assert.equal(tile.value, `${compact(1210)} · ${compact(45_000)}`, "the pre-window line is excluded, the running lease counts");
  assert.equal(tile.sub, "lease-reported · in · out · since local midnight · cache reads not reported");
});

// Nothing recorded today → "—", not 0.
test("tokens today: nothing today is an em-dash, never a fake zero", () => {
  assert.deepEqual(tokensTodayTile([], [], [], 0), { value: "—", sub: "no tokens recorded today" });
});

// The per-engine card gauges: the whole reading reported as-is (stale
// INCLUDED and flagged — the card shows the last-known truth, dimmed,
// unlike the fleet tiles which drop it). No load axis → null.
test("engineGauges: full reading rides; stale flagged, not dropped; absent axis is null", () => {
  const fresh = sig({
    load_source: "strata-metrics",
    load_age_s: 5,
    gpu_util_percent: 39,
    gpu_power_watts: 239.4,
    tokens_per_second: 113.9,
    gpu_mem_used_bytes: 33891942400,
    gpu_mem_total_bytes: 34190917632,
    host_mem_used_bytes: 92178898944,
    host_mem_total_bytes: 101148037120,
    model_loaded: "qwen3.8-flash-next-iq3_s",
    model_quant: "iq3_s",
  });
  const g = engineGauges(fresh, 45);
  assert.ok(g);
  assert.equal(g.stale, false);
  assert.deepEqual([g.util, g.watts, g.tps], [39, 239.4, 113.9]);
  assert.equal(g.model, "qwen3.8-flash-next-iq3_s");
  assert.equal(gibfmt(g.memUsed ?? 0), "31.6 GiB");
  assert.equal(gibfmt(g.hostMemUsed ?? 0), "85.8 GiB", "the host-RAM gauges ride the card (the RAM bar)");
  assert.equal(gibfmt(g.hostMemTotal ?? 0), "94.2 GiB");
  assert.equal(g.modelMemUsed, undefined, "strata names no model-pool figure — absent, not zero");
  const stale = engineGauges({ ...fresh, load_age_s: 300 }, 45);
  assert.ok(stale?.stale, "stale rides the card, flagged for dimming");
  assert.equal(stale?.util, 39, "stale values still show (last-known truth)");
  assert.equal(engineGauges(sig(), 45), null, "no load axis → null → the card shows the word only");
  const failOnly = engineGauges(sig({ load_fail_reason: "401 missing or wrong API key" }), 45);
  assert.equal(failOnly?.failReason, "401 missing or wrong API key", "a failed read still names its reason");
  assert.equal(failOnly?.source, "");
});

test("formatters keep the tile value one word", () => {  assert.equal(gibfmt(3.27e10), "30.5 GiB");
  assert.equal(gibfmt(3.42e11), "319 GiB");
  assert.equal(compact(1_234_567), "1.2M");
  assert.equal(compact(500), "500");
});

# Issue #52 slice 1 — capture report

Built 2026-10-09 on branch `issue-52-capture` (from main HEAD `60d7d6b`).
Companion: `docs/architecture/metrics-sidecar.md` (the design — D1–D8),
`ISSUE52-METRIC-INVENTORY.md` (the probe record). This slice is
**DATA ONLY**: it captures the engine load metrics idlefill already
receives — plus the two surfaces it never fetched — and stores them as
ADD keys. **The idle verdict is unchanged** (D4 is OFF: the owner has
not set the llama-swap GPU busy threshold, so nothing vetoes).

## What shipped

### 1. The llama-swap feed's `tokens` block + `duration_ms` kept (ADD, no renames)

`ActivityEntry` (`server/src/types.ts`) gains `tokens?`
(`cache_tokens`, `draft_tokens`, `draft_acc_tokens`, `input_tokens`,
`output_tokens`, `prompt_per_second`, `tokens_per_second`) and
`duration_ms?`. The wire carried all of it; the type dropped it. The
six existing fields are unchanged — backward compatible, additive only.
Pinned against the captured entry (id 69577, the inventory doc's
verbatim fixture) in `server/test/load-capture.test.ts`.

### 2. llama-swap `/metrics` fetched in the existing probe cycle (D5 keys, ADD)

New module `server/src/load.ts` (`LoadCollector`): one collector per
engine row (D1 — a module of the fused arbiter), read on the SAME poll
tick as the feed (`server/src/index.ts` `tickOnce`: feed poll → load
read, so the feed's newest-entry rate rides with no extra HTTP call).
The llama-swap collector GETs `{row.url}/metrics` and parses the
Prometheus text into the signal block ADD keys: `load_source`
(`llamaswap-metrics`), `gpu_util_percent`, `gpu_mem_used_bytes`,
`gpu_mem_total_bytes`, `tokens_per_second` (the newest feed entry's
rate, from the tick's own feed fetch), and `in_flight` — **absent**,
because no engine exposes an in-flight count today. `model_loaded` is
not wired in this slice (it comes from `/v1/models`, which the D4 wave
pairs with the veto). Metric names pinned against the verbatim probe
capture (2026-10-09, inventory doc): `llamaswap_gpu_util_percent`,
`llamaswap_gpu_memory_used_bytes`, `llamaswap_gpu_memory_total_bytes`.

The readings publish on both D5 surfaces — the `/api/state` per-row
`signal` block (via the `IdleSignal` ADD keys) and the #51 engine
sample line (`EngineSampleLine` ADD keys, the SAME key names, through
the existing `appendEngineSample` sink — D6: no new store).

**Absent = unset, never a fake zero.** A failed read — 404/502,
unreachable, timeout, malformed body, a 200 body with no recognized
gauge — yields NO reading: the keys stay absent (or the last good
reading stays, with a growing `load_age_s`). A failed load read never
wipes the last good reading, never throws into the tick, and **never
touches the feed-degraded fail-closed plane** (D2 rule 3: a dead
`/metrics` never degrades the verdict — the load axis is a separate
plane).

### 3. oMLX `/health` fetched for identity/residency (ADD keys, display/sample only)

The omlx collector GETs `{row.url}/health` and publishes `load_source`
(`omlx-health`), `omlx_loaded_count`, and — only when a model is
actually resident (`loaded_count > 0`) — `model_loaded` (the payload's
only model name, `default_model`) with a best-effort `model_quant`
(`8bit` / `qN_M` / `bf16` / `fp8` / `nvfp4` suffix parse; absent when
not parseable). At the captured probe state (`loaded_count: 0`) the
reading carries residency only — the payload names the default, not
the loaded (D8). **No veto for this kind** (`/health` is identity and
residency, not load).

### 4. Config: `metrics_load_stale_s` (default 45)

One new key (`server/src/config.ts` + `ServerConfig`). It is used ONLY
to label age — `load_age_s` rides with the reading and the display can
compare it against the window. It does **not** veto anything yet, and
no verdict code reads it (the D4 wave builds the busy predicate +
freshness rule on top of this same reading). Non-positive/garbage
falls back to 45 (the same guard posture as `metrics_raw_window_hours`).

### 5. strata: no collector wired in this slice

By design: strata's `live.state` busy read is the D4 experiment path
(veto + `in_flight`), and it is blocked at probe time by the 502
(open question 1/7 in the design doc). This slice captures nothing for
strata — its rows' signal blocks read exactly as before (no load keys
at all). No HTTP call is made for strata rows.

## Verdict unchanged — the proof

The hard constraint: do not change the idle verdict. How it's held and
proven:

1. **The detector is untouched by the load axis.** `IdleDetector.poll`
   / `signal()` (`server/src/idle.ts`) have no load input — the
   verdict is computed exactly as before from the feed + log mtime.
   The load reading is fetched by the tick AFTER the poll, and
   publishes only as ADD keys beside the verdict.
2. **Byte-identity tests** (`server/test/load-capture.test.ts`):
   the same detector, same feed, same clock — with a SUCCESSFUL load
   read (the captured Prometheus sample with `gpu_util_percent 91` —
   the busy-looking case) and with each FAILURE mode (404,
   unreachable, malformed body), in BOTH the fresh and the degraded
   feed state. The verdict-only view of the signal (`now`, `idle`,
   `idle_for_s`, `last_activity`, `last_log_write`,
   `signal_degraded`, `degraded_reason`, `feed_enabled`,
   `no_signal_reason` — the pre-#52 shape) is
   **byte-identical** (JSON string equality) to the no-collector
   baseline in every case. A fresh read at 91% GPU vetoes nothing
   while D4 is off; a dead `/metrics` never degrades.
3. **The existing idle tests pass unchanged** — the full suite
   (including `test/idle.test.ts`, the fail-closed and exemption
   tests) runs green on this branch (`NODE_ENV=test npm run test`,
   root). The degraded fail-closed logic was never edited.

## Test evidence

`NODE_ENV=test npm run test` (root) — full suite green, including the
new `test/load-capture.test.ts` (25 tests): the captured llama-swap
Prometheus sample pinned to the exact D5 gauges, the captured
activity entry's `tokens` block + `duration_ms`, the captured oMLX
`/health` payload, the three failure paths (404 / unreachable /
malformed body), the last-good-reading + growing-age behavior, and the
verdict byte-identity cases above. `NODE_ENV=test npx tsc --noEmit`
(server) — clean.

## What is still PROPOSED (not built in this slice)

- **D2/D4 the busy veto**: `load_busy` — the monotonic veto on the
  verdict (strata `live.state` ON; llama-swap `gpu_util_percent`
  threshold OFF until the owner sets a number, via the new
  `metrics_llamaswap_busy_gpu_percent` knob; oMLX none). This slice
  captures the inputs; the veto is the next wave.
- **strata `in_flight`** (the single `live.state` slot) — rides with
  the D4 wave (the strata experiment end to end is blocked by the
  502; re-run when the engine is back).
- **llama-swap `model_loaded` / `model_quant`** from the
  `/v1/models` entry with status `loaded` — the arbiter probes
  `/v1/models` every tick already; pairing it with the reading is the
  D4 wave's display work.
- **The dashboard load read** beside the idle word on the
  InferenceServers cards (the two-axes pattern) — the keys are on the
  wire now; the display is a separate ask.
- **`queue_depth`** — named in D5, no engine exposes it; the key
  exists so a future wave adds values without a shape change.
- **The hour-line question** (D5: whether hour buckets carry load
  keys — the rollup reader keeps the last line per (hour, key)) —
  open.
- **Owner decisions 1–6** in the design doc remain PROPOSED; this
  slice implements the data half of D3/D5/D6 and none of D2's veto.

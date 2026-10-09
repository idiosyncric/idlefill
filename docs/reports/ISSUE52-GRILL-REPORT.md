# Issue #52 (metrics sidecar) — grilling report

Decision document: `docs/architecture/metrics-sidecar.md`. This report
records what the grill verified and what it settled, including the live
re-probe that closed the issue's acceptance line. Companion:
`ISSUE52-METRIC-INVENTORY.md` (the probe record + the same-day re-probe
addendum with the verbatim captures). No code changed in this pass.

## What the grill verified against the code

- D1 shipped: one `LoadCollector` per row, keyed by provider kind, in
  the arbiter process (`server/src/load.ts`), read on the poll tick
  (`server/src/index.ts`), appended through the existing
  `appendEngineSample` sink (D6, `server/src/metrics.ts`).
- D2/D3/D4 shipped (slice 3): `loadBusyFor` + the freshness gate in
  `load.ts`; the veto + the named `load_busy` grant-gate reason in
  `arbiter.ts`; `serverSignal` reads the raw basis, so the mesh
  snapshot never sees the veto (D7). `busy-veto.test.ts` covers: no
  knob → byte-identical verdict; fresh strata busy vetoes; stale busy
  is unknown; llama-swap above/below the set knob; a busy read never
  reads idle; fresh `false` never forces idle; a dead `/metrics` never
  degrades. 349/349 server tests green at slice 3, 362/362 + 579/579
  at slice 4.
- D5 shipped as ADD keys on the signal block and the sample line, plus
  two the design table predates: `load_fail_reason` (slice 4) and
  `omlx_loaded_count` (slice 1). The design doc records both.
- Open question 6 closed against HEAD: the keys the live build carried
  beyond `f7d0a74` (`last_log_write_age_s`, `reidle_gated`,
  `session_last_activity_age_s`) are emitted at the API surface in
  HEAD (`server/src/api.ts`), and slices 1–4 built against that shape.

## What the re-probe settled (2026-10-09, later — verbatim in the inventory addendum)

- strata/urza BACK (was 502; `/health` 200, `qwen3.8-flash-next-iq3_s`;
  keyless `/metrics` 401 — the row credential rides with the arbiter's
  collector, the slice-4 proof).
- THE ACCEPTANCE EXPERIMENT OBSERVED LIVE, three arbiter ticks on the
  urza row: generating `in_flight:1, load_busy:true (load_age_s 9)` →
  finish `in_flight:0, load_busy:false (load_age_s 14, fresh)` → hold.
  The NInfer row on urza feeds a real load metric into the verdict and
  the veto lands. Issue acceptance line: MET.
- llama-swap and oMLX DOWN at re-probe (`000`); the llama-swap row
  degraded through the FEED with no load keys published — D2 rule 3 in
  the wild, no fake zero.
- strata `live.state` vocabulary: no enumeration needed — the adapter
  whitelist ({idle, stopped, none} = not busy) fails unknown states to
  the conservative side.

## Upstream research (settles open questions 2–4)

- llama-swap `/metrics`: documented and maintained (README;
  `internal/perf/prometheus.go` generates the exact `llamaswap_*` names
  from the capture, pinned by an upstream test; `docs/grafana/` bundles
  a dashboard). Our pin: verbatim capture + upstream source.
- llama-swap in-flight: v235/v240 added it WebSocket-only
  (`handleAPIEvents`, `InflightRequestEntry`); the HTTP feed answers
  finished rows only. Nothing to wait for.
- oMLX: the installed 0.7.0 (current stable) exposes `GET /api/status`
  (any API key): `loaded_models`, `active_requests`, `waiting_requests`,
  token/tps counters, model memory vs ceiling; `/admin/api/activity`
  (main key) adds per-model `queue_position` + `memory_pressure`. The
  05:55 probe hit `/health` and missed `/api/status` — the "oMLX
  exposes nothing" gap was a probe hole, not an engine gap.

## Decisions settled (owner, 2026-10-09)

D1 LOCKED (module form, shipped). D2 LOCKED (monotonic veto, shipped).
D3 LOCKED (45 s freshness knob, shipped). D4 LOCKED with the
llama-swap threshold UNSET BY CHOICE — veto off for that kind until a
number is set deliberately (the knob `metrics_llamaswap_busy_gpu_percent`
is the single switch). D5 LOCKED, hour buckets stay load-free (raw
sample line only). D6 LOCKED (shipped). D7 LOCKED (shipped). D8
AMENDED + LOCKED: oMLX does NOT stay mtime-only — the follow-up slice
re-points the omlx collector at `/api/status`: `load_source`
`omlx-status`, predicate `active_requests > 0`, real
`model_loaded`/`model_quant`, `in_flight` = `active_requests`,
`queue_depth` = `waiting_requests` (the first queue count in the
fleet). KV-cache posture LOCKED: ride the proxies, no KV key, no
upstream asks. Issue #52 CLOSED on this lock.

## Deliberate non-changes

- No file under `server/`, `client/`, or `dashboard/` touched. This is
  a research + lock pass.
- `/api/state` shape untouched (the shipped ADD keys stand). The mesh
  snapshot untouched. The verdict basis untouched.
- No config written: the llama-swap knob stays absent (unset).

## Follow-ups opened by the lock

1. The oMLX `/api/status` collector slice (D8 amendment) — re-verify
   the live payload when the local oMLX server is back, then wire.
2. llama-swap `model_loaded`/`model_quant` pairing with the `/v1/models`
   probe the tick already makes (left unwired by slice 1).
3. Optional: the llama-swap threshold number, when the owner wants the
   veto on for that kind.

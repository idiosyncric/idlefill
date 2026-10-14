# Metrics wave build report (#51/#52 plane, owner-approved 2026-10-14)

Built in the `agent/metrics-wave` worktree, main-advance style, one commit per
slice, nothing pushed to a remote. The authority is
[METRICS-WAVE-GRILL-REPORT.md](METRICS-WAVE-GRILL-REPORT.md) (all ten
recommendations accepted verbatim); the decision locks live in
[../architecture/metrics-history.md](../architecture/metrics-history.md) and
[../architecture/metrics-sidecar.md](../architecture/metrics-sidecar.md), which
were flipped to LOCKED first.

Every slice: ADD-keys only, absent = unset, a pre-existing line reads
byte-for-byte unchanged, no rename, no shape change, no verdict change, the mesh
snapshot and the #79 pull contract untouched, production (:8787 / :8800 / the
running daemons) never touched — every live proof ran on scratch loopback
arbiters on high ports.

## The commits

| Slice | Commit | One line |
| --- | --- | --- |
| docs | `24a61c3` | the ten grill decisions flipped to LOCKED in both architecture docs |
| S0 | `ced4c09` | the strata double-fetch folded: one `GET /metrics` per strata row per tick, not two |
| S1 | `a23dce4` | the hour bucket carries bounded load aggregates (peaks + counts, never means) |
| S2 | `9ed6840` | utilization rides the existing Usage rows; a raw-only 48 h drill on the engine card |
| S3 | `86741ac` | peer utilization rows through the existing pull, attributed, never merged |
| S4 | `eea08ee` | the session series producer is wired: one line per heartbeat that reports history |
| S5 | `8a85692` | the host series: one line per tick, raw only, never on the wire |
| S6 | — | DEFERRED, no code (the range control needs day buckets; see below) |

## S0 — one strata read per tick (`ced4c09`)

`idle.ts makeActivityFetcherFor` hands the raw `/metrics` body it already
fetched to a per-tick body observer; `load.ts read()` takes that shared body
when the URL matches the collector's own surface, with one `strataReading`
helper so the folded and unfolded parses are literally the same code. A URL
mismatch, a feed-off row, or a failed feed fetch shares nothing and reads its
own surface exactly as before. Zero wire change.

* Gate: +4 tests (byte-identical signal block folded vs unfolded, zero
  transport calls on the shared path, URL-mismatch still fetches, real-socket
  request-log count). repo 1130 → 1134, server 503 → 507.
* Live: scratch arbiter `:18905` against a fake strata engine `:18901` with a
  request log — HEAD served 10 `GET /metrics` across 5 ticks, the folded build
  served 5; the row's signal block byte-identical.
* Budget: one HTTP request per strata row per tick removed; no bytes added to
  any file.

## S1 — the bounded load rollup (`a23dce4`)

`metrics.ts` gains a pure `loadAggregate()` the rollup runs over that engine's
raw lines (the rollup still reads raw files, never an accumulator). ADD-keys on
the hour line: `load_reads`, `busy_reads`, `peak_in_flight`, `peak_queue_depth`,
`gpu_util_max`, `gpu_power_max`, `model_loaded_last`, `model_quant_last` — only
when the hour saw ≥1 successful load read. A stale read is a read but never a
busy; a peak is a max over present values only; an unreported gauge is not seen;
garbage drops per key and never poisons the hour; `model_loaded_last` is capped
(≤2 ids, ≤128 chars) before it rides a line. Idempotence untouched (the reader's
last-line-wins settles a re-run).

* Gate: +6 tests (byte-identity of a load-free hour against the exact pre-wave
  key set, the verbatim strata/oMLX/llama-swap shapes, stale-is-a-read,
  hostile input, the privacy cap, a pre-wave line round-tripping byte-identical,
  the byte budget pinned <200 B). repo 1134 → 1140, server 513.
* Live: scratch `:18906` with a seeded previous-hour raw file — the boot rollup
  wrote `{load_reads:3, busy_reads:1, peak_in_flight:1, gpu_util_max:100,
  gpu_power_max:90, model_loaded_last:q2_0}` and the range read served it; raw
  untouched.
* Byte math (measured, not estimated): load-free hour line 236 B, fully keyed
  hour line 395 B → **159 B/engine-hour** worst case = 3.8 kB/engine-day ≈
  1.5 MB/engine over the 400-day horizon, against the ~10 MB/box-day the raw
  window already writes.

## S2 — the local utilization read (`9ed6840`)

Dashboard only, zero wire change. `lib/utilization-stats.ts` is the pure
builder; `Usage.tsx`'s `buildRows()` returns `{ rows, absences }` so the
exception-only posture is structural: `busy %`, peak in-flight, peak queue, gpu
util max, power max — and an engine whose hour lines carry no `load_reads` key
gets no row, it gets a named absence line. The per-engine card gets a collapsed
"raw · 48h" affordance gated on the row's live signal actually carrying a load
axis; `getEngineRawSeries()` is the only new fetch, per-engine, on demand,
against the window the store already keeps.

* Gate: +7 tests (exception-only rows, peaks, named absence, raw drill).
  repo 1140 → 1147, dashboard 109 → 116.
* Live: scratch `:18907` — Usage rendered `busy 25% of 24 reads`, peak
  in-flight 1, peak queue 2, gpu util max 89%, power max 63 W for the row with a
  load axis, and "srv-noaxis — no load axis in this window: the store saw no
  load read for this engine" for the row without one.
* Budget: no stored bytes; one on-demand raw read per card open, capped by the
  store's 2,000-point reader.

## S3 — peer utilization rows (`86741ac`)

`buildRemoteRows()` runs the peer's own hour lines through the *same* builder.
No new server surface: the pull route already mirrors the local contract and
already serves whatever keys a peer's rollup wrote. Every peer row's title ends
with "the peer's own rollup, attributed to this peer (never merged across
peers)" plus the pull's `stale`/`truncated` state when the cache answered or the
cap trimmed. A peer on an older build (no `load_reads` key) renders the named
absence and nothing else — old-build tolerance, not an error.

* Gate: +3 tests, including the byte-identity case: an older-build peer line
  produces exactly the rows it produced before the wave. repo 1147 → 1150,
  dashboard 119.
* Live: two scratch arbiters (`:18908` pulling `:18907` through the mesh) — the
  peer expand rendered "live · pulled 6s ago" with the utilization rows for
  `srv-live` and the named absence for `srv-noaxis`.
* Budget: zero bytes on the wire; the #79 pull contract is byte-for-byte
  untouched.

## S4 — the session producer (`eea08ee`)

`MetricsStore.recordSessionHeartbeat()` is called from the existing
`instrumentArbiterForMetrics` proxy on `registerSession`: a heartbeat whose
sanitized `history` block survived `cleanReportedHistory` copies one raw session
line (`ts` = the heartbeat stamp, `reqs_per_min` = the newest minute the ring
reported, `model` only when the block names one). No block, empty `rpm`, or an
all-garbage block writes nothing. Caps are the store's, not the client's (token
≤128, model ≤128, rpm 0..1e6). No `arbiter.ts` change — the D5 wrapper pattern.
The existing `session_hour` rollup and the peer pull now have real data instead
of a permanently empty section.

* Gate: +3 tests (real-arbiter register → store-file assertion incl. the hour
  rollup, the no-block byte-identity, the caps). repo 1150 → 1153, server 516.
* Live: scratch `:18907` — the chatty heartbeat appended
  `{"ts":…,"kind":"session","token":"s-live-1","reqs_per_min":9,"model":"qwen3.8-flash-next-q2_0"}`
  and the history-less heartbeat appended nothing.
* Byte math: 107 B with a model, ~70 B without, bounded by the client's
  heartbeat cadence and the same 48 h raw rotation + 2,000-point read cap.

## S5 — the host series (`8a85692`)

`index.ts` ticks `collectHostStats()` into `metrics.appendHostSample()`: a
`kind:"host"` line carrying exactly the keys the platform can name (load1/5/15,
cpus, memory totals, uptime); an all-empty line is not written at all.
`readRange`/`seriesKeyOf` know the series (key `local`). `/api/metrics` accepts
`series=host` **only** with `bucket=raw` — there is no host hour bucket in this
wave, and the route says so in a 400. `/api/metrics/remote` keeps
engine|lease|session, so no host payload ever crosses the mesh. The This-Machine
card gets a collapsed "host history · raw 48h" affordance: load1 and mem-used
sparklines, exception-only, thinned to a 240-point render budget, with the
coverage line naming how much history is actually on screen. GPU truth stays on
the engine load axis — no second probe.

* Gate: +2 tests (the append posture, the local raw-only contract, and the
  remote route refusing `host`). repo 1153 → 1156, server 518, dashboard 120.
* Live: scratch `:18907` served `{"kind":"host","load1":4.45,"cpus":10,…}` for
  two ticks, and the card rendered `load 1m · raw 3.19` / `mem used · raw
  35.8 GiB` with "3 host samples spanning 1h — per tick, raw only".
* Byte math: 151 B/line at a 15 s cadence = ~36 kB/machine-hour ≈ 1.7 MB over
  the 48 h raw window. At that cadence the 2,000-point reader cap trims to the
  newest ~8 h — the UI names the trim rather than pretending 48 h was served.

## S6 — the range control: deferred, and why

The 7/30/90 control needs no wire change but needs a truth the store does not
have: 30 days of hour buckets × 3 engines = **2,160 points > the 2,000-point
cap**. A 30-day view would render the oldest 160 points silently trimmed and
still call itself 30 days. The honest version needs a day rollup, which this
wave does not build (and which the owner's D1/D2 amendment does not authorize
for load gauges). So S6 ships nothing; the deferral is recorded in
[../architecture/metrics-history.md](../architecture/metrics-history.md) ("Range
control (7/30/90): DEFERRED"). Revisit when a day bucket is decided.

## Final gates (HEAD `8a85692`)

* `npm run test` — **1156 pass, 0 fail** (server 518, client 295, cli 147,
  dashboard 120, and the remaining suites whole). Progression across the wave:
  1130 → 1134 → 1140 → 1147 → 1150 → 1153 → 1156.
* `npx tsc --noEmit -p server/tsconfig.json`, `-p dashboard/tsconfig.json` —
  clean.
* `npm run build` — green; `dashboard/dist` regenerated and committed at every
  dashboard change (S2, S3, S5).
* Rust/tauri: untouched, so the cargo gates were not in scope.
* Nothing pushed to either remote; production arbiters never touched.

## What is provably true, and what is not

Proven: the fold halves strata `GET /metrics`; the aggregates appear only for
hours that had a load read and never for a load-free engine or a pre-wave state
file; peer rows are attributed per peer and never merged; a history-less
heartbeat writes zero bytes; the host series answers locally raw-only and 400s
on the peer contract; every renderer draws an absence as a name, never a zero.

Not proven here (named so nobody reads more into it): no live production run of
the wave — every proof ran on scratch arbiters; the llama-swap load threshold is
still UNSET (D8, by decision); no cross-machine fleet merge exists (by design);
the session sparklines are only as good as the clients that send `history`.

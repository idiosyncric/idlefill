# Metrics history — issue #51 (grilling with locks, 2026-10-04)

Map: #50 (the mesh defines who publishes). Companion: `docs/architecture/mesh.md`
(locked). This doc settles the retention-store decisions. Decisions are LOCKED
where the trade-off is clear-cut for a single-operator personal fleet. The rest
were marked PROPOSED for the owner.

**Status (2026-10-14): every PROPOSED item in this doc is now LOCKED.** The
wave that followed it — the metrics wave over #51 + #52 — was grilled in
[../reports/METRICS-WAVE-GRILL-REPORT.md](../reports/METRICS-WAVE-GRILL-REPORT.md)
and signed off by the owner on 2026-10-14, all ten recommendations verbatim.
The amendments are recorded in "Metrics wave amendments" below; the build
evidence is [../reports/METRICS-WAVE-REPORT.md](../reports/METRICS-WAVE-REPORT.md).

## The gap, verified against the code

Nothing today can render a chart over days.

- `state.json` caps the lease history and the event log at 500 rows
  (`trim()`, `server/src/state.ts:119-127`). Result rows keep the last outcome
  per job, capped at 200 per project (`recordJobResult`,
  `server/src/arbiter.ts:948-977`).
- A session row is one timestamp deep: `last_activity` (`registerSession`,
  `server/src/arbiter.ts:671-712`).
- Token totals exist only as per-project UTC-day counters (`addBudget`,
  `server/src/arbiter.ts:1274-1279`). That map is the only surviving time
  series in the system.
- Server metrics do not exist anywhere.

## The rules this doc inherits

From `docs/architecture/mesh.md` (locked):

1. The store is per arbiter (per machine). Retention stays local. The mesh
   aggregates per-machine stores at read time. (mesh.md, "Consequences for
   the filed issues".)
2. State is published, never computed remotely. The coarse snapshot stays
   coarse.
3. The one-JSON-file posture stays: atomic writes, corrupt-tolerance, no
   database server. `docs/architecture/fleet-service.md` D6 recommends
   SQLite for a different service with relational query needs. That
   recommendation does not move here.

## D1 — Storage format: append-only JSONL (LOCKED)

Chosen: append-only JSONL files, one store-file family next to `state.json`.

Rejected: a SQLite file. Rejected: a database server (never in scope).

The trade-off that decided it: this store is time-ordered and append-only.
Every read is a range scan over one series. There is no relational join.
JSONL keeps the house posture. A corrupt line is one lost sample, and the
reader skips it. A truncated SQLite file is a lost database. The repo runs
dependency-free Node (`AGENTS.md`). SQLite would mean the experimental
`node:sqlite` module or a new dependency.

Contrast with #55, which chose SQLite for the fleet service: that service
answers relational lookups over instances, edges, and rotation history. This
store answers one question: "give me series X between A and B." Different
shape differs, so the answer differs. The mesh.md rule ("keep it one store-file family,
not a database server") is honored: daily files of one family, not a schema.

## D2 — What the store records (LOCKED)

Four series kinds. Three are in scope now. One is deferred.

1. **Engine samples** — one line per poll tick per engine: idle verdict,
   `idle_for_s`, degraded flag, request delta, lease grant count, lease
   denial count by reason, active lease count.
2. **Lease outcomes** — one line per lease end: project, `server_id`,
   client, status, end reason, `tokens_out`, `tokens_in`, score. The arbiter
   already holds all of it at `finishLease` (`server/src/arbiter.ts:800-881`)
   and `endLease` (`server/src/arbiter.ts:1281-1291`).
3. **Session activity** — depends on #45. The router's per-session ring
   buffer feeds requests-per-minute and the model through the existing
   register heartbeat. The arbiter appends what the heartbeat carries. Until
   #45 lands, the store records only the active-session count inside the
   engine sample. Do not build a second session history.
4. **Host metrics** — DEFERRED to #52. The boundary: #52 is the source (the
   exporter module co-located with each engine, per mesh.md). #51 is the sink
   and the query surface. #51 defines the append call the #52 module will use.
   #51 does not build a collector. *(Settled by the wave: the coarse host
   counters `server/src/host.ts` already reads for the This-Machine card append
   a `kind:"host"` line on the same tick — no new collector, no GPU, no daemon
   exec; engine-host RAM and power continue to ride the engine rows.)*

Token counts, stated honestly. The arbiter sees lease tokens: the client
reports them at `POST /api/leases/:id/usage` (`server/src/api.ts:403-431`).
The arbiter does NOT see interactive tokens. Verified: the activity feed
entry carries no token field (`ActivityEntry`, `server/src/types.ts:325-332`).
The `log_glob` path reads only file mtimes (`makeRealLogMtimeSource`,
`server/src/idle.ts:196-213`). It never parses the NInfer `req-*.jsonl`
content. So per-request token counts for interactive traffic need #52 (the
engine exporter) or #45 (the streamed usage chunk). This store records what
the arbiter actually sees, and nothing invented.

## D3 — Where the recorder lives: the arbiter (LOCKED)

Chosen: a module in `server/` (proposed file: `server/src/metrics.ts`),
wired into the existing tick loop (`tickOnce`, `server/src/index.ts:88-101`).

Rejected: client-side stores.

The trade-off: the arbiter already sees every grant, denial, lease end, and
idle verdict. The mesh rule says the store is per arbiter. A client-side
store would split one machine's series across processes, and clients that
leave the network would take their half of the history with them. The #45
ring buffer stays client-side (only the router sees the requests). Its
compact history rides the existing register heartbeat
(`server/src/api.ts:582-604`), and the arbiter appends it. No new wire
protocol.

Request counting: the detector already fetches the activity feed every poll
(`server/src/idle.ts:69-111`). The feed entry carries a numeric `id`
(`server/src/types.ts:326`). New ids since the last poll give the request
delta. Grill note: the id's behavior across a llama-swap restart is NOT
verified. The implementation must treat a backwards id as "unknown delta,"
never as a negative count.

## D4 — Sampling vs event-sourcing: hybrid (LOCKED)

Chosen: poll-tick samples for engine state, event appends for lease ends,
heartbeat-fed appends for sessions.

The cost math for a personal fleet (verified default `poll_ms` 15000,
`server/src/config.ts:32`):

- One engine: 4 samples per minute, 5,760 per day.
- One raw line is about 120 bytes. One engine-day is about 0.7 MB. A 48-hour
  raw window is about 1.4 MB per engine.
- Hour buckets: 24 lines per engine-day. One year is about 1 MB per engine.
- Lease ends: tens per day. Sessions: a handful. Denials: bounded by the
  client poll cadence, and they ride as counters, not lines (see D5).

Rejected: pure event-sourcing for engine state. The poll tick already
fetches the feed. A per-feed-entry append would duplicate the feed the
engine already keeps, at higher volume. Rejected: pure sampling for lease
outcomes. Lease ends are rare, and each carries facts a sample cannot hold
(tokens, score, end reason).

## D5 — Retention policy (LOCKED)

- **Raw window:** 48 hours (config knob `metrics_raw_window_hours`).
- **Downsample:** when the arbiter's clock crosses an hour boundary, it
  reads the previous hour's raw lines and appends one bucket line per series
  to the hour file. The rollup reads raw files, never an in-memory
  accumulator. A restart mid-hour loses nothing, because the raw lines are
  the source of truth.
- **Hour buckets:** kept 400 days (config knob `metrics_retention_days`).
  The acceptance bar is 30 days. 400 days costs about 1 MB per engine.
- **Rotation:** one raw file per UTC day, one hour file per UTC day.
  Compaction deletes whole files. There is no in-place rewrite.
- **Denials:** counted per engine per sample window, not one line per
  denial. A client re-asks every ~20 seconds while busy. Per-denial lines
  would flood the store.
- **Corrupt-tolerance, identical posture to `state.json`:** the reader skips
  unparseable lines. A missing file is an empty series. An append failure
  logs and drops one sample. It never throws into the tick (same
  containment as a poll error, `server/src/arbiter.ts:519-526`). Unlike
  `state.json`, a bad line never moves the whole file aside: JSONL degrades
  per line, so the rename-the-file recovery has no trigger here.

## D6 — Query surface: GET /api/metrics (LOCKED)

Shape:

```
GET /api/metrics?series=engine&key=<server_id>&from=<epoch_ms>&to=<epoch_ms>&bucket=hour|raw
```

- `series`: `engine` | `lease` | `session`. (S5 adds `host` on the LOCAL route
  — raw only; the peer serve/pull contract stays engine|lease|session, so no
  new payload crosses the mesh.)
- `key`: one `server_id` / session token / project. Optional filter.
- `from` / `to`: epoch-ms. Default: the last 7 days.
- `bucket`: `hour` (default) or `raw`. Raw answers only inside the raw
  window.
- Response: `{ series: [ { key, points: [...] } ], truncated: bool }`. A
  response caps at 2,000 points. The route trims the oldest and sets
  `truncated: true`.
- Bad params answer 400 with an error string. Same discipline as the
  settings routes in `server/src/api.ts`.

Auth: the anonymous exception of `/api/state` extends to this route.
Anonymous read is allowed, and a wrong token is still 401, exactly like
`server/src/api.ts:229-233`. The dashboard is anonymous today, and the
tailnet is the trust boundary. The `peer_token` does NOT unlock
`/api/metrics`. It stays scoped to `GET /api/mesh`
(`server/src/api.ts:234-238`).

Back-compat: `/api/state` does not change at all. Charts read
`/api/metrics`. If a summary key is wanted later, it is an ADD, never a
rename.

## D7 — Mesh aggregation: never in the snapshot (LOCKED)

Chosen: the coarse snapshot carries no time series. Aggregation happens at
read time, per the mesh.md rule.

Rejected: hour buckets inside `/api/mesh`.

The math: 720 hour buckets × 3 engines × about 150 bytes is about 324 KB
per snapshot, pulled every 15 seconds by every peer. The snapshot is
ephemeral and sanitized with hard caps (≤20 engine rows, `sanitizeSnapshot`,
`server/src/mesh.ts:191-224`). A series would blow the caps and the
posture. A 30-day series does not belong in a 15-second pull. mesh.md
already states the answer: "the store is per arbiter (per machine); the
mesh aggregates per-machine stores at read time. Retention stays local."

Cross-machine charts are PROPOSED and deferred: the dashboard queries each
peer's `/api/metrics` directly from the browser. That needs the operator's
token per peer. Options: reuse one `api_token` across instances, or add a
per-peer token field to the dashboard. The owner should weigh in. This wave
ships local-machine charts only. Every arbiter serves the dashboard (mesh.md
D3), so every machine charts itself today.

## D8 — Dashboard chart surface (LOCKED)

One section ("Usage"), exception-only like the other views of `dashboard/src/`.

- Per engine: requests per hour (last 7 days), idle share per hour, lease
  tokens per day.
- Inline SVG sparklines. No chart library.
- The 30-day acceptance bar is about the store, not the default view. A range
  control can come later.

The owner's chart set is settled by the wave below: utilization rides these
rows, plus a raw-only 48 h drill on the per-engine card; no new nav surface.

## Metrics wave amendments (owner sign-off, 2026-10-14) — LOCKED

The wave over #51 + #52 was grilled in
[METRICS-WAVE-GRILL-REPORT.md](../reports/METRICS-WAVE-GRILL-REPORT.md), which
numbered its either/or decisions D1–D10; the owner approved all ten verbatim.
The grill's numbers are carried here so the pointer resolves. Every one is an
ADD: no key renamed, no shape changed, no verdict moved, the mesh snapshot and
the #79 pull contract byte-for-byte.

- **D1 — the hour bucket may carry load.** D5's "hour buckets stay load-free"
  is amended: a bounded, aggregate-only set of load keys rides the engine hour
  line (S1). The cost the grill priced — ~1 KB per engine-hour — is noise
  against the ~10 MB per engine-day the raw window already writes.
- **D2 — peaks and counts, never means.** `load_reads`, `busy_reads`,
  `peak_in_flight`, `peak_queue_depth`, `gpu_util_max`, `gpu_power_max`,
  `model_loaded_last`, `model_quant_last`. A mean of a spiky gauge is a lie
  about the machine — the same reasoning that kept the llama-swap number out of
  the verdict. The keys appear only when the hour had ≥1 load read; an engine
  with no load axis writes the hour line exactly as before. A stale read counts
  as a read, never as busy; a peak of an empty set is undefined, not 0.
- **D3 — the raw window stays 48 h.** No widening. Raw is the drill-in, S1 is
  the history; a 7-day window buys a second copy of data the rollup already
  aggregated. The `metrics_raw_window_hours` knob exists and stays default.
- **D4 — retention stays 400 days.** Open question 3, answered by arithmetic:
  the whole 400-day hour series is ~1 MB per engine, ~5 MB with the new keys.
  Unbounded means rotation has no horizon and every `readRange` walks more files
  for no operator benefit; 90 days discards exactly the year-over-year view the
  owner asked for.
- **D5 — the standalone-sidecar hatch is PARKED.** Capture stays in-process on
  the fused arbiter (`metrics-sidecar.md` D1). Every machine in the fleet runs
  one; building the hatch adds a lifecycle, a port and a token plane for zero
  value. The pure-function boundary that would make it possible is kept, and
  recorded as unexercised.
- **D6 — no new nav surface.** Utilization rides the existing Usage rows, plus
  a raw-only 48 h sparkline on the per-engine card labelled `raw · last 48h`.
  A Utilization tab is a new surface with no new information.
- **D7 — cross-machine utilization is peer attribution.** Through the existing
  `GET /api/metrics/remote` pull (#79/#86), never a fleet-merged series: a
  peer's timestamps are its own clock, and "fleet peak GPU util" is a number
  nobody can audit. Remote lines stay ephemeral on the puller.
- **D8 — the llama-swap load threshold stays UNSET.** Display and sample only.
  If the owner wants that kind vetied, the honest move is to re-declare a
  llama-swap row and pick the number from a week of S1 samples.
- **D9 — the session producer is wired.** One line per register heartbeat that
  carries a `history` block, into the shape `metrics.ts` already defines — a
  copy, not a transform. Bounded: one line per heartbeat per token, caps
  mirroring `cleanReportedHistory`. Leaving the shape unwired made every peer
  expand's session section a permanently empty, i.e. fake, absence.
- **D10 — the load-read cadence stays every tick.** The strata row's double GET
  of the same URL is folded into the fetch the tick already makes (S0); S1–S5
  add no fetches. Revisit only if an engine objects to four reads a minute.
- **Host series (S5) joins the query contract.** `series=host` on the local
  route answers `bucket=raw` only — coarse counters (load averages, cpu count,
  memory totals, uptime), never GPU: the engine rows own GPU truth
  (`host.ts`). The peer serve/pull contract stays engine|lease|session, so no
  new payload crosses the mesh. A host hour rollup is deferred behind the same
  shape decision as S1; the day's peak load average is not stored.
- **Range control (7/30/90): DEFERRED.** Without day buckets, a 30-day
  three-engine query is 2,160 hour points against the 2,000 cap — the view
  would render the oldest 160 points silently trimmed and still call itself 30
  days. The honest version needs a day rollup, which this wave does not build.

## File family and line shapes

Files live next to `state.json` (the `state_file` directory):

| File | Content | Lifetime |
|---|---|---|
| `metrics-raw-YYYY-MM-DD.jsonl` | engine samples, lease outcomes, session lines, interleaved | deleted past the raw window |
| `metrics-hour-YYYY-MM-DD.jsonl` | hour buckets, one line per (hour, series) | deleted past the retention horizon |

Line shapes (one JSON object per line. Field names match the existing
state vocabulary):

```
{"ts":1759570000000,"kind":"engine","server_id":"srv-watched","idle":true,
 "idle_for_s":412,"degraded":false,"req_delta":3,"feed_last_id":1042,
 "grants":1,"denials":{"not_idle":4,"busy":0},"active_leases":1}

{"ts":1759564800000,"kind":"engine_hour","server_id":"srv-watched",
 "samples":240,"req_total":57,"idle_samples":180,"grants":6,"revoked":2,
 "tokens_out":120000,"tokens_in":30000}

{"ts":1759570100000,"kind":"lease","lease_id":"l-ab12cd34",
 "project":"career-ops","server_id":"srv-watched","client":"m1max",
 "status":"finished","reason":null,"tokens_out":4123,"tokens_in":980,
 "score":0.8}

{"ts":1759570110000,"kind":"session","token":"s-…","reqs_per_min":12,
 "model":"qwen3-27b"}

{"ts":1759570000000,"kind":"host","load1":2.4,"load5":1.9,"cpus":8,
 "mem_total_bytes":68719476736,"mem_free_bytes":21474836480,"uptime_s":864000}
```

The wave's ADD keys on the hour line (S1), present only when that hour had at
least one load read — otherwise the line is byte-for-byte the shape above:

```
{"ts":1759564800000,"kind":"engine_hour","server_id":"srv-f1c85327",
 "samples":240,"req_total":57,"idle_samples":180,"grants":6,"revoked":2,
 "tokens_out":120000,"tokens_in":30000,
 "load_reads":231,"busy_reads":12,"peak_in_flight":1,"peak_queue_depth":3,
 "gpu_util_max":99,"gpu_power_max":90.4,
 "model_loaded_last":"qwen3.8-flash-next-q2_0","model_quant_last":"q2_0"}
```

The `model_loaded_last` value is capped before it rides a line (≤2 ids, ≤128
chars each) — a comma-joined engine payload crossing into an hour bucket is a
disclosure the mesh privacy rule bounds. `model` on the session line is
optional: the heartbeat's block carries a model only when the router sniffed
one, and absence is not a zero. The host line carries only what
`collectHostStats()` can name (per-key tolerant, `host.ts`); a platform without
load averages simply has no `load1` key.

The reader keeps the LAST line per (hour, series key), so a re-run rollup is
idempotent without rewriting any file.

## What changes vs what stays untouched

Changes (the implementation wave):

1. New module `server/src/metrics.ts` — recorder, rollup, reader.
2. Tick wiring in `server/src/index.ts` — one append per tick, one rollup
   per hour boundary.
3. One route in `server/src/api.ts` — `GET /api/metrics`.
4. Two config knobs in `server/src/config.ts` — raw window, retention.
5. One dashboard view in `dashboard/src` (built into `dashboard/dist/`).
6. #45's register heartbeat gains one compact block. The arbiter appends it.

Untouched:

- `state.json` shape. No new keys. The 500-row caps stay.
- `/api/state`, `/api/mesh`, the snapshot shape, the sanitizer caps.
- The lease/gate/session core: grants, preemption, budgets, anti-thrash.
- The client wire protocol, except #45's own block.
- `docs/architecture/mesh.md` and `docs/architecture/fleet-service.md`.

## Consequences for the filed issues

- **#45 (session detail):** its ring buffer becomes the source of the
  session series. Build its heartbeat block with this store's session line
  shape in mind, so the arbiter append is a copy, not a transform.
- **#52 (exporter sidecar):** the exporter module appends host and
  engine-internal metrics through the same recorder. #51 defines the append
  call. #52 fills it. No separate store.
- **#50 (mesh):** nothing moves. The read plane stays coarse.
- **#55 (fleet service):** no dependency either way
  (`docs/architecture/fleet-service.md`, "Sequencing").

## Pitfalls for the implementation wave

- The feed `id` monotonicity across a llama-swap restart is unverified.
  Treat a backwards id as an unknown delta.
- The rollup must read raw files, not an accumulator. A restart mid-hour
  must not lose the hour.
- Denials ride as counters inside the engine sample. Never one line per
  denial.
- The append must never throw into its caller (tick, `finishLease`,
  register). Drop the sample and log.
- Do not rename a corrupt metrics file aside. Skip the bad line. The
  `state.json` rename-recovery has no place here.
- The dashboard reads `/api/metrics` on its own timer, not every
  `/api/state` poll. Charts over days do not need a 5-second refresh.

## Open questions

1. Does the llama-swap feed `id` restart at zero when llama-swap restarts?
   Measure on urza before the `req_delta` logic ships. *(Unanswered, and no
   longer blocking: `FeedDeltaTracker` already reads a backwards id as an
   unknown delta, and urza declares no llama-swap row today.)*
2. Interactive token counts: #52's exporter or #45's usage chunk? Pick one
   owner before either builds it. *(Settled by what shipped: #45's heartbeat
   carries the ring buffer, and the session producer copies exactly what the
   heartbeat reports. The store records no token key it cannot see.)*
3. ~~Hour-bucket horizon: is 400 days the right default, or should retention
   be unbounded for a personal fleet?~~ RESOLVED (owner, 2026-10-14): 400
   days, unchanged — see D4 above.
4. ~~Cross-machine charts: one shared `api_token` across instances, or
   per-peer tokens in the dashboard?~~ RESOLVED: neither. #79/#86 put the pull
   inside the arbiter — the dashboard asks its own instance, which hops to the
   peer with the fleet `peer_token` the dashboard never sees. No browser
   fan-out, no shared token.

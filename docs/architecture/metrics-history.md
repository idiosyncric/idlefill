# Metrics history — issue #51 (grilling with locks, 2026-10-04)

Map: #50 (the mesh defines who publishes). Companion: `docs/architecture/mesh.md`
(locked). This doc settles the retention-store decisions. Decisions are LOCKED
where the trade-off is clear-cut for a single-operator personal fleet. The rest
are marked PROPOSED for the owner. Nothing here is built.

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
   exporter module co-located with each engine, per mesh.md). #51 is the
   sink and the query surface. #51 defines the append call the #52 module
   will use. #51 does not build a collector.

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

- `series`: `engine` | `lease` | `session`.
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

## D8 — Dashboard chart surface (PROPOSED)

Minimal for a single operator: one new section ("Usage"), exception-only
like the other sections of `server/public/index.html`.

- Per engine: requests per hour (last 7 days), idle hours per day, lease
  tokens per day.
- Inline SVG sparklines. No chart library. The dashboard is hand-written
  single-file HTML with inline JS outside tsc.
- The 30-day acceptance bar is about the store, not the default view. A
  range control can come later.

The owner should pick the exact chart set before the build slice.

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
```

The reader keeps the LAST line per (hour, series key), so a re-run rollup is
idempotent without rewriting any file.

## What changes vs what stays untouched

Changes (the implementation wave):

1. New module `server/src/metrics.ts` — recorder, rollup, reader.
2. Tick wiring in `server/src/index.ts` — one append per tick, one rollup
   per hour boundary.
3. One route in `server/src/api.ts` — `GET /api/metrics`.
4. Two config knobs in `server/src/config.ts` — raw window, retention.
5. One dashboard section in `server/public/index.html`.
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
   Measure on urza before the `req_delta` logic ships.
2. Interactive token counts: #52's exporter or #45's usage chunk? Pick one
   owner before either builds it.
3. Hour-bucket horizon: is 400 days the right default, or should retention
   be unbounded for a personal fleet?
4. Cross-machine charts: one shared `api_token` across instances, or
   per-peer tokens in the dashboard?

# Metrics sidecar — issue #52 (research + design)

Map: #51 (the store. it is the sink), #50 (mesh. it sets co-location),
#62 (the kind adapters the collector reuses). Companions:
`docs/reports/ISSUE52-METRIC-INVENTORY.md` (the probe record, 2026-10-09,
with the same-day re-probe addendum. Every claim in the "what the probes
found" section carries its probe there), `docs/reports/ISSUE52-GRILL-
REPORT.md` (the grill, 2026-10-09: what it verified, what the owner
settled), and the slice reports ISSUE52-CAPTURE / -DISPLAY / -VETO /
-STRATA-AUTH (slices 1–4, all on main).

Status: LOCKED (the grill closed it 2026-10-09, owner answers on every
decision). D1/D2/D3/D6/D7 LOCKED as written — shipped and proven in
slices 1–4. D4 LOCKED with the llama-swap threshold UNSET by the owner
(the veto is live for strata — OBSERVED on the urza row — and inert for
llama-swap by choice). D5 LOCKED, hour buckets stay load-free. D8
AMENDED by the grill: the installed oMLX 0.7.0 exposes `/api/status`
with `active_requests` / `waiting_requests` / `loaded_models`; the
follow-up slice wires it. No wire key beyond the shipped ADD keys rides
from this doc.

## The ask

The idle verdict fuses an activity feed with a log mtime
(`server/src/idle.ts`). That is inference, not measurement. The owner's
framing: idle equals load and capacity, judged per connected engine from
real metrics. An engine that exposes nothing we need gets a sidecar. A
personal fleet of engines. The same model and quant are preferred. They
are not enforced.

The verdict must consume a per-engine load signal. The signal augments or
replaces the feed and mtime basis. The existing degraded semantics stay
fail-closed (grants stay fail-closed).

## What the probes found (summary)

Full record: `docs/reports/ISSUE52-METRIC-INVENTORY.md`.

- llama-swap (`100.105.225.1:11434`) exposes a Prometheus `/metrics`
  endpoint (host and GPU gauges. `gpu_util_percent` 91,
  `gpu_memory_util_percent` 95.5 at probe time) that idlefill never
  fetches. Its activity feed carries a per-request `tokens` block
  (`tokens_per_second`, `cache_tokens`, durations) that the
  `ActivityEntry` type drops. It exposes no queue depth and no
  in-flight count.
- strata (`https://strata.samwarth.com`, the NInfer deployment on urza)
  answered 502 on every path at probe time. The live arbiter row reads
  `degraded` true, "activity fetch failed" — the fail-closed semantics in
  production. Its payload (verified in code, live 2026-10-05) carries
  since-boot counters, a single in-flight generation state
  (`live.state`), and the model name.
- strata scanbot (`http://10.10.10.6:8080`) is healthy per the arbiter
  (probed, serving `qwen3.8-flash-next-q2_0`). Same payload shape.
- oMLX (`127.0.0.1:8000`) exposes `/health` (status, the default model
  name, pool residency: models loaded, model memory against a ceiling)
  and an hourly sqlite usage store. No feed, no rate, no in-flight
  count. It does not name the loaded model.
- No engine exposes queue depth or KV-cache occupancy. What they expose
  instead are proxies (per-request reuse counts, host GPU memory, model
  memory against a ceiling).
- Re-probe addendum (2026-10-09, later — in the inventory): strata/urza
  is BACK (502 cleared) and the #52 veto is OBSERVED live on the row
  (`in_flight` 1 → `load_busy` true → finish → 0/false fresh). llama-
  swap and oMLX were DOWN at re-probe (the 05:55 captures stand as the
  record). Upstream research: llama-swap `/metrics` is a documented
  surface (README, bundled Grafana dashboard), and oMLX 0.7.0
  `/api/status` carries `active_requests` / `waiting_requests` /
  `loaded_models` — the D8 amendment. The "no engine exposes queue
  depth" line holds for llama-swap and strata only.

## D1 — Form: a module of the fused arbiter, not a separate process

**LOCKED (2026-10-09 — shipped, `server/src/load.ts`, one `LoadCollector`
per row).** The sidecar is a collector module inside the fused app. One
collector per server row, selected by the provider kind (the #62
pattern). It runs on the engine host, in the arbiter tick, beside the
detector it feeds.

The issue title says "sidecar." The word means "co-located with the
engine." It does not mean "a second process." The mesh decision lock
already placed it: "co-located with each engine — in the fused shape it
is a module of the local arbiter, not a separate process"
(`docs/architecture/mesh.md`, consequences for #52). This doc confirms
the call with the trade-off on the record.

Rejected (a) — a separate process next to the engine. Costs: a second
lifecycle (ship, upgrade, and restart through a second channel in a
fleet where the upgrade channel is already per-machine). Then a
loopback port plus a token (a new auth plane for a value the owning
arbiter could read in-process). Then a new failure mode (the sidecar
down while the arbiter is up, a degraded source the verdict must learn
to handle). Then a duplicate of the kind dialects the arbiter already
has (#62 built the feed and counter adapters. `server/src/idle.ts`,
`server/src/omlx.ts`). The #51 sink is already a module in this process (`server/src/metrics.ts`, per
the mesh rule "the store is per arbiter"). Source and sink in one
process share no IPC, no port, and no file. A personal fleet of three
engines does not need a fourth moving part.

Rejected (b) — a push exporter (the engine host pushes readings to the
arbiter). A new push direction. The mesh rule is pull
(`docs/architecture/mesh.md` D1). The engine does not know the arbiter
exists.

Escape hatch (not built here): the collector is a pure function of
(kind, row config) producing a `LoadReading`. If a future engine host
cannot run the fused app, the same module runs standalone and appends to
the local #51 store. The boundary is what makes that possible. No code
for that case lands in this wave.

## D2 — The verdict contract: the load axis is a monotonic busy veto

**LOCKED (2026-10-09 — shipped, slice 3, `busy-veto.test.ts`; the grant
gate denies with a named `load_busy` reason).** Today:

```
idle_for = now - max(last_activity_ts, last_log_write)
idle     = not degraded and idle_for >= idle_seconds
```

The load signal AUGMENTS the basis. It does not replace it:

```
idle = (not degraded and idle_for >= idle_seconds) and not load_busy
```

Rules:

1. `load_busy` can only DELAY a grant. It can never make an engine read
   idle. The axis adds a veto. It removes no path to idle and never
   accelerates a verdict.
2. A load read that is not fresh is UNKNOWN. It never vetoes. It never
   supports. The verdict falls back to the feed and mtime basis with its
   existing fail-closed semantics.
3. The existing degraded semantics are UNCHANGED. A failed feed fetch
   still blocks grants (`signal_degraded` true, no grant, no revoke on
   stale activity. `server/src/idle.ts` poll). The load axis has no path
   into that flag. A flaky `/metrics` endpoint never degrades the
   verdict. The feed is the verdict's evidence. The load axis is a veto
   on top. A dead veto source is not a dead verdict.
4. A busy read while the feed says idle VETOES. That is the long job
   that has started and not finished. The case the log mtime signal
   exists to infer. It becomes direct.
5. Self-traffic: the load axis is engine-wide. It is not exempted by our
   leases. The engine reads busy while our own jobs run. It never reads
   falsely idle. That is the conservative direction the strata feed
   adapter already uses (a fixed non-IP src, no self-exemption.
   `STRATA_SRC`, `server/src/idle.ts:65`).
6. A busy read holds only while fresh (the D3 window). It does not
   persist past it. A dead metrics endpoint must not become a permanent
   grant lock-out. The row publishes `load_age_s`, so the operator sees
   why a veto is absent.

## D3 — Freshness

**LOCKED (2026-10-09 — shipped, `metrics_load_stale_s` default 45; a
strata read at `load_age_s` 14 vetoed nothing — a fresh `false` — while
one at 9 s with `live.state` generating did).** A load read is fresh for
`metrics_load_stale_s` (new config knob. Default 45, which is three
polls at the 15-second `poll_ms`). A read older than that is unknown (D2 rule 2). `load_age_s`
publishes per row. Absent means no read since boot.

## D4 — The busy predicate, per kind

**LOCKED (2026-10-09 — shipped, `loadBusyFor`; the strata path OBSERVED
live on the urza row).** The verdict input differs by kind. That is
honest. The kinds expose different truths.

- strata: `live.state` not in {idle, stopped, none} means busy. That is
  the direct signal. `in_flight` publishes 1 while generating, 0
  otherwise. This is the #52 experiment path: the NInfer row on urza
  emits a real load metric into the verdict. (Blocked at probe time: the
  row is 502 and degraded. Re-run when the engine is back.)
- llama-swap: LOCKED as a threshold on `gpu_util_percent` from `/metrics`
  (new config `metrics_llamaswap_busy_gpu_percent`, default UNSET, which
  turns the veto OFF for this kind). The grill settled it: the owner
  KEPT the knob UNSET — the number is a deliberate later call, and the
  kind publishes the gauges (display and sample only) and does not veto
  until one is set. A fixed number on a spiky gauge can cut both ways: a
  false veto holds the grant back for a full freshness window. A false
  idle lets a grant into a hot engine. The research closed the wait:
  llama-swap will NOT hand us an HTTP in-flight count to prefer instead
  — upstream in-flight lives on the WebSocket event plane only (v235
  "show inflight activity requests", v240 expands it,
  `InflightRequestEntry`), the HTTP feed answers finished rows only.
  The per-request feed rate and `cache_tokens` ride as display once the
  parse keeps them (no extra HTTP call for them. The feed fetch is
  already in the tick. Shipped in slice 1).
- oMLX: NO veto TODAY (shipped: `/health` is identity and residency, not
  load; `loaded_count` counts models resident in memory, not requests
  running; the collector publishes residency — display and sample only).
  AMENDED by the grill: the installed 0.7.0 exposes `/api/status` with
  a real `active_requests` count, so this kind GETS a predicate
  (`active_requests > 0`) in the D8 follow-up slice. See D8.

## D5 — Wire keys (ADD, absent = unset)

**LOCKED (2026-10-09 — shipped; the build carries two ADD keys this
table predates: `load_fail_reason` (slice 4: why the last load read
failed — names the missing-credential gap; cleared on the next good
read; display only) and `omlx_loaded_count` (slice 1: `/health` pool
residency). Both live on `/api/state` and the sample line).** The
server row `signal` block on `/api/state` gains:

| Key | Type | Kind | Meaning |
| --- | --- | --- | --- |
| `load_source` | string | all | `llamaswap-metrics` \| `strata-metrics` \| `omlx-health`. Absent = no load collector wired for the kind (pre-#52 rows read unchanged) |
| `load_busy` | boolean | strata, llama-swap (threshold set) | Present only on a FRESH read. true = the D4 predicate fired. false = the fresh read says not busy |
| `load_age_s` | number | all | Seconds since the last successful load read. Absent = no read since boot |
| `in_flight` | number | strata | 0 or 1 (the single `live` slot) |
| `gpu_util_percent` | number | llama-swap | from `/metrics` |
| `gpu_mem_used_bytes` | number | llama-swap | from `/metrics` |
| `gpu_mem_total_bytes` | number | llama-swap | from `/metrics` |
| `tokens_per_second` | number | strata, llama-swap | Engine-reported rate. strata: the `totals` delta between polls (the #62 sampler already diffs it). llama-swap: the newest feed entry's rate, once the parse keeps it. Display and sample. Never a veto input |
| `model_loaded` | string | llama-swap, strata | What the engine holds now, even when idle. llama-swap: the `/v1/models` entry with status `loaded` (the arbiter probes it every tick already). strata: `engine.model` from the `/metrics` read. omlx: ABSENT (the payload names the default, not the loaded) |
| `model_quant` | string | all | Best-effort parse of the quant identity. llama-swap: from the description text. strata: from the model id (`q2_0`). omlx: from the model name when one is loaded. Absent when not parseable |

Named, not filled (no engine exposes these today. The keys exist so a
build wave adds values without a shape change):

| Key | Type | Kind | Meaning |
| --- | --- | --- | --- |
| `queue_depth` | number | none shipped today | Absent on llama-swap and strata (the probe found no queue count there). oMLX 0.7.0 `/api/status` carries `waiting_requests` — the D8 amendment slice fills the key for oMLX |

The #51 engine sample line (`metrics-raw`, `EngineSampleLine`) carries
the SAME key names. The sample is where the series lives. The hour line
stays unchanged in this wave (the rollup reader keeps the last line per
(hour, key)). LOCKED at the grill: hour buckets stay load-free — the
load series live in the raw engine sample line only.

NO KV-cache pressure key. No engine exposes occupancy. What the engines
expose are proxies (per-request `cache_tokens`, `totals.reused`, host
GPU memory, model memory against a ceiling). A fabricated 0-to-1 scale
would be a lie about the machine. The proxies ride the keys above where
they exist.

Posture: every key is an ADD. Absent = unset. A pre-#52 row and a row
whose kind has no collector wired publish the signal block byte-for-byte
as today. No rename, no re-shape of an existing key.

## D6 — The sink: the existing append, no new store

**LOCKED (2026-10-09 — shipped; the readings append through
`appendEngineSample` with no new store).** The collector hands its
reading to the tick. The tick
appends it into the engine sample line through the existing
`appendEngineSample` (`server/src/metrics.ts`). This fills the #51 D2
item 4 ("host metrics — DEFERRED to #52": the exporter appends through
the same recorder. No separate store). No new file family. No new rollup
logic. The reader is unchanged.

## D7 — The mesh: the snapshot stays byte-for-byte

**LOCKED (2026-10-09 — shipped: `serverSignal` reads the raw basis, the
snapshot never sees the veto).** The 15-second `MeshSnapshot` stays coarse and
byte-for-byte (the #79 rule). The load axis is LOCAL. A peer arbiter
never grants against our engine (the mesh exclusive-ownership rule,
`docs/architecture/mesh.md` rule 1), so a peer never needs the busy
veto. If the dashboard mesh view wants a busy dot on a peer row later,
that is a display ask over the existing `/api/state` surface of the peer
itself, not a snapshot change. Deferred.

## D8 — The oMLX gap (named, not hidden) — AMENDED by the grill

**AMENDED + LOCKED (2026-10-09, grill).** This doc called oMLX "the hole
in this design" because the probe hit `/health` and never `/api/status`.
The grill's research closed the hole with the ALREADY INSTALLED version:
oMLX 0.7.0 (brew, the current stable — 0.7.1.dev1 is a pre-release)
exposes `GET /api/status`, guarded by `verify_api_key` — the row's API
key qualifies, unlike the admin surface which takes the main key only.
Its payload (verified in the v0.7.0 source, `omlx/server.py`):

- `active_requests` — aggregate across loaded engines. A REAL in-flight
  count.
- `waiting_requests` — the scheduler queue. The first queue depth in
  the fleet. Fills the named `queue_depth` key.
- `loaded_models` — the actual loaded model ids (identity, and the
  quant parses from them).
- `total_*` token/request counters, `avg_prefill_tps` /
  `avg_generation_tps`, `cache_efficiency`, `model_memory_used` against
  `model_memory_max`.

(`/admin/api/activity` adds per-model active/waiting with
`queue_position` and the memory-pressure block — main key only; named,
not needed for the predicate.)

The original options, settled: (1) is HERE, not pending — the release
exists and is installed. (2) log-parse is DEAD — no need. (3) mtime-only
is SUPERSEDED. LOCKED call: the follow-up slice re-points the omlx
collector at `/api/status` — `load_source` becomes `omlx-status`, the
D4 predicate `active_requests > 0` (the kind's first real veto), the
real `model_loaded` / `model_quant`, `in_flight` = `active_requests`,
`queue_depth` = `waiting_requests`. The mtime stays the fallback basis
until a fresh read lands. Caveat on the record: the local oMLX server
was DOWN at the grill re-probe (the 05:55 `/health` capture stands);
the slice re-verifies the live payload when the host is back.

## Rules (restated crisp)

1. The sidecar is a module of the fused arbiter. One collector per row,
   per kind, on the engine host.
2. The verdict equals (the feed and mtime basis, unchanged) AND NOT
   `load_busy`. The load axis vetoes only. A stale read is unknown. The
   feed-degraded fail-closed is untouched.
3. Fresh means within the D3 window (default 45 s, a knob). A busy read
   holds only while fresh.
4. Per-kind predicates: strata `live.state` (ON — observed live on the
   urza row). llama-swap GPU threshold (OFF — the owner kept the knob
   UNSET at the grill). oMLX none today (display and sample only); the
   D8 amendment slice turns it on with `active_requests > 0`.
5. Wire keys are ADD on the signal block and the #51 sample line.
   Absent = unset. `queue_depth` is named. There is no KV key.
6. The mesh snapshot is byte-for-byte. The load axis never rides the
   snapshot.

## What changes vs what stays untouched

Shipped (slices 1–4, main): the collector modules (`server/src/load.ts`
— the per-kind load read, the freshness window, `loadBusyFor`), the
tick wiring and the sample-line carry (`server/src/index.ts`), the
signal block and sample line ADD keys (`server/src/types.ts` —
`RequestsSource` gains nothing), the config knobs
(`metrics_load_stale_s`, `metrics_llamaswap_busy_gpu_percent`), the
llama-swap feed `tokens` block kept on `ActivityEntry`, the dashboard
load read beside the idle word (slice 2, the two-axes pattern of
`docs/architecture/engine-health-routing.md` D5), and the strata
collector credential fix (slice 4).

Follow-up slice (the D8 amendment, after the owner lock): re-point the
omlx collector at `/api/status` — `load_source` `omlx-status`, the
`active_requests > 0` predicate, real `model_loaded` / `model_quant`,
`in_flight`, `queue_depth` = `waiting_requests`; plus the llama-swap
`model_loaded` / `model_quant` pairing with the `/v1/models` probe the
tick already makes (the capture slice left it unwired). The owner's
llama-swap threshold number (if/when set) is a config value, not code.

Suite (the build wave proves each): a fresh busy read vetoes (feed idle,
engine busy, verdict not idle). A stale busy read expires to unknown
(the verdict stands on feed and mtime). A dead `/metrics` never degrades
(`signal_degraded` stays false. No grant block from the load axis). The
per-kind predicates (strata on, llama-swap off until the threshold
lands, oMLX display-only). The ADD keys absent on pre-#52 rows (byte
parity). The strata experiment end to end (`live.state` generating, the
veto lands, the grant is denied while the feed says idle).

Untouched (fenced):

- The feed and mtime basis of the verdict and its degraded semantics
  (grants fail closed, no revoke on stale activity).
- The #51 store files, the rollup, and the reader (this doc adds keys to
  a line, not files to a family).
- The mesh snapshot and the `/api/mesh` scope.
- The catalog probe, the alias plane, the engine groups, the session
  gate.
- The engine binaries. The sidecar reads. It never writes. (The oMLX
  sqlite read is already `query_only`.)

## Decisions (owner) — the grill closed them 2026-10-09

1. D1 — module form, not a separate process. **LOCKED** (as written,
   shipped).
2. D2 — the monotonic busy veto contract. **LOCKED** (as written,
   shipped).
3. D3 — the 45-second freshness window (a knob). **LOCKED** (as
   written, shipped).
4. D4 — the per-kind predicates. **LOCKED** with the llama-swap
   threshold **UNSET by owner choice**: the veto stays off for that
   kind until a number is set deliberately; no HTTP in-flight count
   exists upstream to wait for (WS-only).
5. D5 — the wire key set. **LOCKED**; hour buckets stay load-free (raw
   sample line only, owner call). The shipped key set also carries
   `load_fail_reason` and `omlx_loaded_count`.
6. D7 — mesh snapshot byte-for-byte. **LOCKED** (shipped).
7. D8 — **AMENDED + LOCKED**: oMLX does NOT stay mtime-only. The
   follow-up slice wires `/api/status` (busy predicate, real model
   identity, `in_flight`, `queue_depth`). Owner accepted.
8. KV-cache pressure: **LOCKED** — ride the proxies as-is (no KV key,
   no fabricated scale, no upstream feature asks).
9. Issue #52 closes on this lock; the oMLX `/api/status` slice and the
   (still optional) llama-swap threshold number are follow-ups.

## Open questions — all closed by the grill (2026-10-09)

1. ~~The strata `live.state` vocabulary~~ RESOLVED. urza is back (502
   cleared; `/health` names `qwen3.8-flash-next-iq3_s`). The full state
   list never needed enumerating: the adapter posture is a
   whitelist — anything NOT in {idle, stopped, none} reads busy
   (`server/src/idle.ts`), so an unknown state fails to the CONSERVATIVE
   side. Observed live: generating → veto, finish → fresh `false`.
   Enumerating the vocabulary is an ops nice-to-have, not a design gap.
2. ~~Is llama-swap `/metrics` stable/documented?~~ RESOLVED: YES. The
   README lists it ("system and GPU metrics for prometheus"), the gauge
   names live in `internal/perf/prometheus.go` and are pinned by the
   upstream's own test, and the repo bundles an example Grafana
   dashboard. Our names are pinned twice more: against the verbatim
   capture and against upstream source (grill report).
3. ~~The llama-swap busy threshold, or an in-flight count to wait
   for?~~ RESOLVED: there is NO HTTP in-flight count to wait for
   (in-flight = WebSocket events only, v235+). Owner call: leave the
   knob UNSET — llama-swap veto stays off; the gauges ride as display
   and sample until a number is chosen deliberately.
4. ~~Does any oMLX release name the loaded model / in-flight?~~
   RESOLVED: YES — the installed 0.7.0, `GET /api/status`
   (`active_requests`, `waiting_requests`, `loaded_models`; any API
   key). The probe hit `/health` and missed it. D8 amended.
5. ~~KV-cache pressure posture?~~ RESOLVED (owner): ride the proxies
   as-is. No KV key, no fabricated scale, no upstream asks. oMLX's
   `model_memory` against the ceiling and the admin `memory_pressure`
   block are noted for display only.
6. ~~Live build ahead of HEAD on the signal block?~~ RESOLVED: HEAD
   emits those keys at the API surface (`server/src/api.ts` —
   `last_log_write_age_s`, `reidle_gated`,
   `session_last_activity_age_s` computed at `/api/state`); slices 1–4
   built against that shape and the live signal matches.
7. ~~Acceptance experiment blocked by the 502.~~ RESOLVED — OBSERVED
   LIVE (2026-10-09, urza row, three arbiter ticks): generating
   `{"in_flight": 1, "load_source": "strata-metrics", "load_busy":
   true, "load_age_s": 9}` → finish `{"in_flight": 0, "load_busy":
   false, "load_age_s": 14}` → holds. The NInfer row on urza feeds a
   real load metric into the verdict and the veto lands. The issue's
   acceptance line is met.

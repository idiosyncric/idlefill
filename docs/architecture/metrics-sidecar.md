# Metrics sidecar — issue #52 (research + design)

Map: #51 (the store. it is the sink), #50 (mesh. it sets co-location),
#62 (the kind adapters the collector reuses). Companion:
`docs/reports/ISSUE52-METRIC-INVENTORY.md` (the probe record, 2026-10-09.
Every claim in the "what the probes found" section carries its probe
there).

Status: RESEARCH. The decisions below are PROPOSED for the owner. Nothing
here is built. No wire key ships from this doc alone.

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

## D1 — Form: a module of the fused arbiter, not a separate process

**PROPOSED.** The sidecar is a collector module inside the fused app. One
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

**PROPOSED.** Today:

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

**PROPOSED.** A load read is fresh for `metrics_load_stale_s` (new
config knob. Default 45, which is three polls at the 15-second
`poll_ms`). A read older than that is unknown (D2 rule 2). `load_age_s`
publishes per row. Absent means no read since boot.

## D4 — The busy predicate, per kind

**PROPOSED.** The verdict input differs by kind. That is honest. The
kinds expose different truths.

- strata: `live.state` not in {idle, stopped, none} means busy. That is
  the direct signal. `in_flight` publishes 1 while generating, 0
  otherwise. This is the #52 experiment path: the NInfer row on urza
  emits a real load metric into the verdict. (Blocked at probe time: the
  row is 502 and degraded. Re-run when the engine is back.)
- llama-swap: PROPOSED as a threshold on `gpu_util_percent` from
  `/metrics` (new config `metrics_llamaswap_busy_gpu_percent`, default
  UNSET, which turns the veto OFF for this kind). The threshold is an
  owner decision. A fixed number on a spiky gauge can cut both ways: a
  false veto holds the grant back for a full freshness window. A false
  idle lets a grant into a hot engine. Until the owner sets a number,
  the kind publishes the gauges (display and sample only) and does not
  veto. The per-request feed rate and `cache_tokens` ride as display
  once the parse keeps them (no extra HTTP call for them. The feed
  fetch is already in the tick).
- oMLX: NO veto. `/health` is identity and residency, not load.
  `loaded_count` counts models resident in memory, not requests
  running. The mtime signal stays the verdict. The collector publishes
  residency and model memory against the ceiling (display and sample
  only). See D8.

## D5 — Wire keys (ADD, absent = unset)

**PROPOSED.** The server row `signal` block on `/api/state` gains:

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
| `queue_depth` | number | none today | Absent on all three engines. The probe found no queue count anywhere |

The #51 engine sample line (`metrics-raw`, `EngineSampleLine`) carries
the SAME key names. The sample is where the series lives. The hour line
stays unchanged in this wave (the rollup reader keeps the last line per
(hour, key). Whether hour buckets should carry load keys is an open
question).

NO KV-cache pressure key. No engine exposes occupancy. What the engines
expose are proxies (per-request `cache_tokens`, `totals.reused`, host
GPU memory, model memory against a ceiling). A fabricated 0-to-1 scale
would be a lie about the machine. The proxies ride the keys above where
they exist.

Posture: every key is an ADD. Absent = unset. A pre-#52 row and a row
whose kind has no collector wired publish the signal block byte-for-byte
as today. No rename, no re-shape of an existing key.

## D6 — The sink: the existing append, no new store

**PROPOSED.** The collector hands its reading to the tick. The tick
appends it into the engine sample line through the existing
`appendEngineSample` (`server/src/metrics.ts`). This fills the #51 D2
item 4 ("host metrics — DEFERRED to #52": the exporter appends through
the same recorder. No separate store). No new file family. No new rollup
logic. The reader is unchanged.

## D7 — The mesh: the snapshot stays byte-for-byte

**PROPOSED.** The 15-second `MeshSnapshot` stays coarse and
byte-for-byte (the #79 rule). The load axis is LOCAL. A peer arbiter
never grants against our engine (the mesh exclusive-ownership rule,
`docs/architecture/mesh.md` rule 1), so a peer never needs the busy
veto. If the dashboard mesh view wants a busy dot on a peer row later,
that is a display ask over the existing `/api/state` surface of the peer
itself, not a snapshot change. Deferred.

## D8 — The oMLX gap (named, not hidden)

**PROPOSED, honestly.** oMLX is the hole in this design. `/health` gives
residency, not load. The mtime stays the verdict for this kind. Options,
in cost order:

1. Wait for an oMLX release that names the loaded model and the
   in-flight state. Unknown whether one exists (open question 4).
2. Parse the `server.log` the row already globs (the file exists on the
   host. Its content is unprobed in this wave. Reading it is the
   future-sidecar work).
3. Accept mtime-only for oMLX (today's behavior, unchanged).

The design does not block on this. The omlx collector ships with the
identity and residency keys only. Its `load_source` is `omlx-health` and
its `load_busy` is absent (the kind has no D4 predicate).

## Rules (restated crisp)

1. The sidecar is a module of the fused arbiter. One collector per row,
   per kind, on the engine host.
2. The verdict equals (the feed and mtime basis, unchanged) AND NOT
   `load_busy`. The load axis vetoes only. A stale read is unknown. The
   feed-degraded fail-closed is untouched.
3. Fresh means within the D3 window (default 45 s, a knob). A busy read
   holds only while fresh.
4. Per-kind predicates: strata `live.state` (ON). llama-swap GPU
   threshold (OFF until the owner sets a number). oMLX none (display and
   sample only).
5. Wire keys are ADD on the signal block and the #51 sample line.
   Absent = unset. `queue_depth` is named. There is no KV key.
6. The mesh snapshot is byte-for-byte. The load axis never rides the
   snapshot.

## What changes vs what stays untouched

Changes (the build wave, after the owner):

- `server/src/idle.ts` or a new `server/src/load.ts` (the build wave
  picks. The verdict contract is identical either way): the per-kind
  load read, the freshness window, and the veto in `signal()`.
- `server/src/index.ts`: wire the collector into the tick (one load read
  per row per tick) and carry the keys into the engine sample line.
- `server/src/types.ts`: the signal block keys and the sample line keys
  (ADD). `RequestsSource` gains nothing (the load axis is a separate
  plane from request counting).
- `server/src/config.ts`: `metrics_load_stale_s`,
  `metrics_llamaswap_busy_gpu_percent`.
- The llama-swap feed parse keeps the `tokens` block (`ActivityEntry`
  ADD keys), so the rate rides the feed fetch the tick already makes.
- Dashboard: the load read beside the idle word on the InferenceServers
  cards, in the two-axes-side-by-side pattern of
  `docs/architecture/engine-health-routing.md` D5 (the operator sees
  which axis a decision used).

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

## Decisions (owner)

All PROPOSED, none locked:

1. D1 — module form, not a separate process.
2. D2 — the monotonic busy veto contract.
3. D3 — the 45-second freshness window (a knob).
4. D4 — the per-kind predicates. In particular: the llama-swap threshold
   OFF until the owner sets a number.
5. D5 — the wire key set above.
6. D8 — oMLX stays mtime-only in this wave.

## Open questions

1. The strata `live.state` vocabulary. The engine is 502 today (probe
   2026-10-09). Verify the full state list when it is back up.
2. llama-swap: is `/metrics` a stable, documented surface? The probe saw
   Prometheus text with `llamaswap_`-prefixed names. Pin the metric
   names in a test against a captured sample (the body is in the
   inventory doc).
3. The llama-swap busy threshold: a number on `gpu_util_percent`, or
   does llama-swap expose an in-flight count we should wait for?
4. oMLX: does any release name the loaded model or expose an in-flight
   count? If not, option 2 of D8 (log parse) is the future sidecar work.
5. KV-cache pressure: chart the reuse proxies (`cache_tokens`,
   `totals.reused`) as-is, or ask the engines for a pool-occupancy
   gauge?
6. The live arbiter signal block carries keys the HEAD `IdleSignal`
   type does not list (`last_log_write_age_s`, `reidle_gated`,
   `session_last_activity_age_s`). The production build runs ahead of
   `f7d0a74`. The build wave re-verifies the type against the running
   build before adding the ADD keys.
7. The #52 acceptance experiment (the NInfer row on urza emits a real
   load metric into the verdict) is blocked by the 502. Re-run when the
   engine is back up.

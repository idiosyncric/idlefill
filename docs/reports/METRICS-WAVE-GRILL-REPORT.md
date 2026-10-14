# Metrics wave — grill report (the next build wave over #51 + #52)

Type: wayfinder:grilling, owner-asked wave "metrics (#52 sidecar /
metrics-history)". No code, config, or test file touched — this is the
plan + the decision list. Read-only probes only, 2026-10-14, from the
mac-sam box (`:8787`, instance `m-99fdd154dd20`); nothing was restarted,
written, or mutated.

Docs this grills against: `docs/architecture/metrics-sidecar.md`
(**LOCKED** — D1–D8 shipped and proven, slices 1–5),
`docs/architecture/metrics-history.md` (**LOCKED except D8 and its
open questions 1–4**), `docs/architecture/mesh-telemetry.md`
(**LOCKED** — it already superseded #51 D7's deferred cross-machine
answer), `docs/architecture/engine-health-routing.md` D5 (the two-axes
display rule). Prior grill/slice records: `ISSUE52-GRILL-REPORT.md`,
`ISSUE52-METRIC-INVENTORY.md`, `ISSUE52-CAPTURE/-DISPLAY/-VETO/-STRATA-AUTH`,
`ISSUE52-OMLX-STATUS-SLICE5`, `ISSUE86-REMOTE-METRICS-REPORT`,
`MESH-TELEMETRY-GRILL-REPORT`. Citations verified against HEAD `702b0fc`.

## 1. What already exists (verified today, not inferred)

**The load axis is real and live on every kind the fleet runs.** A
`LoadCollector` per row (`server/src/load.ts`), read inside the poll
tick, published as ADD keys on the `/api/state` row `signal` block AND
the #51 engine sample line, with the monotonic `load_busy` veto behind
it (`metrics_load_stale_s`, default 45 s).

Live signal blocks from the running arbiter (2026-10-14, verbatim,
truncated):

- `srv-watched` / oMLX `http://127.0.0.1:8000` — `load_source
  omlx-status`, `load_age_s 13`, `load_busy false`, `in_flight 0`,
  `queue_depth 0`, `model_loaded "Qwen3-VL-30B-A3B-Instruct-4bit,clef-4bit"`,
  `model_quant 4bit`, `omlx_loaded_count 2`, `model_mem_used 36.29 GB /
  model_mem_max 50.4 GB`.
- `srv-f1c85327` / strata `http://10.10.10.6:8080` — `load_source
  strata-metrics`, `in_flight 1`, `gpu_util 99%`, `gpu_mem 16.74/17.16 GB`,
  `gpu_power 90 W`, `host_mem 55.1/64.9 GB`, `tokens_per_second 33.9`,
  `load_age_s 13`, **`load_busy true`** — a live veto on a live row.
- `srv-73de04cd` / llama-swap `http://100.105.225.1:11434` — the row is
  **down**: `degraded true, "activity fetch failed"`, and NO load keys at
  all. That is D2 rule 3 in the wild: a dead engine degrades through the
  feed, the load axis publishes nothing, never a fake zero.

**The D8 "live proof pending" is closed.** oMLX is UP on this box (brew
`omlx 0.7.0`). Keyless `GET /api/status` answers `401 {"detail":"API key
required"}`; with the engine's own key (read from `~/.omlx/settings.json`,
never printed) it answers exactly the fixture field set the slice-5 test
pins against the installed source: `models_loaded 2`, `loaded_models` two
real ids, `active_requests 0`, `waiting_requests 0`, `total_requests 355`,
`total_prompt_tokens 1,171,575`, `total_completion_tokens 30,978`,
`total_cached_tokens 2,304`, `avg_prefill_tps 378.2`, `avg_generation_tps
43.4`, `model_memory_used 36,290,908,547` / `model_memory_max
50,503,571,100`. The extra fields (`status`, `version`, `uptime_seconds`,
`models_discovered`, `default_model`, `*_formatted`, `custom_kernels`,
`ane_prefill`) have no landing place — correct under D5, they must not be
invented into keys.

**Reachability, stated honestly (this Mac):** oMLX loopback UP; strata
scanbot `10.10.10.6:8080` UP (`/health` 200 names
`qwen3.8-flash-next-q2_0`; keyless `/metrics` 401 — the row credential
rides it); strata/urza `https://strata.samwarth.com` UP (`/health` names
`qwen3.8-flash-next-iq3_s`, keyless `/metrics` 401). llama-swap
`100.105.225.1:11434` answers `000` from here — **nothing on this wave
depends on us reaching it**: urza's own arbiter probes its own engines.
And urza's arbiter (`100.105.225.1:8787`, `m-d6d72403a67f`) today declares
exactly ONE engine row — a loopback strata container — whose load read
works (`gpu_util 0`, `gpu_mem 33.9/34.2 GB`, `gpu_power 27.561 W`,
`host_mem 97.2/101.1 GB`) while its feed is degraded. **There is no
llama-swap row on urza right now**, so the D4 llama-swap threshold is a
question with no live subject.

**The store exists and is filling.** On this box (UTC days, read-only):
raw files 21,872 / 22,252 / 13,365 lines ≈ 10.1 / 10.6 / 6.3 MB — ~460
bytes per line, ~22k lines/box-day across the three declared rows (~7.4k
per engine-day, i.e. one sample per 15 s tick, matching the #51 cost math);
hour files 24–132 lines/day, 4.4–36 KB/day, ten of them back to 2026-10-05. The raw engine line carries
the whole load reading (`load_source`, `load_age_s`, `load_busy`, the
gauges); the hour line does not:

```
{"ts":1791849600000,"kind":"engine_hour","server_id":"srv-watched","samples":213,
 "req_total":0,"idle_samples":213,"grants":0,"revoked":0,"tokens_out":0,"tokens_in":0,
 "requests_source":"sqlite","engine_tokens_in":0,"engine_tokens_out":0,"engine_tokens_cached":0}
```

Zero load keys — exactly as LOCKED at the #52 grill.

**The query surface works, locally and across the mesh.** `GET
/api/metrics` (anonymous, 2,000-point oldest-trim) and `GET
/api/metrics/remote` (serve = fleet `peer_token` only; pull = local admin
token, on-demand, 60 s ephemeral cache, remote lines never persisted). A
live pull of urza's raw engine series inside its own 48 h window returns
its strata row WITH the load keys riding (`in_flight 0`, `gpu_util 0`,
`gpu_power 27.561`, `load_source strata-metrics`); a pull of scanbot's
hour series returns token truth (#62) and no load keys. Dashboard side:
the Usage tab renders req/hr, engine tok in/out/hr, idle %, lease
tokens/hr; the Overview fleet tiles (decode, power, GPU memory, host RAM)
are **instantaneous sums over fresh readings**, with coverage named ("2 of
3 engines reporting"); the Machines peer-expand renders req/hr, tok/hr and
session peak-rpm sparklines.

## 2. What is genuinely missing

| # | Gap | Why it is a gap |
|---|---|---|
| G1 | **Utilization history beyond 48 hours.** Every load sample is raw-only; hour buckets are load-free by lock. "GPU util yesterday", "peak queue depth this week", "how many hours was this engine busy" cannot be answered today. This is the actual content of the "metrics-history" wave. |
| G2 | **No host series.** `server/src/host.ts` reads coarse host counters at read time for the This-Machine card; nothing is ever stored. The #51 D2 item 4 ("host metrics — DEFERRED to #52") is half-filled: engine-host RAM/power arrive through the engine rows, but there is no time series and no load-average history. |
| G3 | **The session series has a shape but no producer.** `appendSessionSample` is defined and never called (`server/src/metrics.ts:376`); zero session lines in the local store and zero session series on both peers. The #86 peer-expand session rows are permanently empty. |
| G4 | **No cross-machine utilization chart.** The pull route already serves a peer's raw load lines (≤48 h) and will serve load-bearing hour lines the moment they exist; `remote-metrics.ts` builds no load rows, and the fleet tiles have no time axis. |
| G5 | **llama-swap in-flight/queue.** Engine-side limitation, already researched: HTTP gives finished rows only; in-flight is WebSocket-only upstream. GPU util is the only proxy, and the veto needs the owner's number. |
| G6 | **KV-cache pressure.** Deliberately absent (owner call: ride the proxies, no fabricated scale). Not a gap to close, a fence to keep. |
| G7 | **Model-identity history.** Which model/quant served which hour exists only inside raw lines (48 h). No hour-level identity, so "the fleet ran q2_0 all week" is not answerable. |
| G8 | **No denial-reason history.** `denials` ride as counters in raw lines only; the grant gate's named reasons (including `load_busy`) are not rolled up, so "why were grants refused this week" is not chartable. |

One cadence finding worth naming: a **strata row is fetched twice per tick
against the same URL** — the feed adapter (`activity_path
`/metrics`) and the load collector (`specFor` → `/metrics`). Plus the
catalog `/v1/models` probe the tick already makes. Three GETs per strata
row per 15 s, where one response contains everything.

## 3. The plan (S1 → S6, each independently green-shipping)

Every slice: ADD keys only, absent = unset, a pre-existing line reads
byte-for-byte unchanged; no rename, no shape change; no verdict change;
the mesh snapshot and the #79 pull contract stay byte-for-byte; the
`load_busy`/`load_fail_reason` honesty posture extends to every new key
(unknown is absent, never zero).

**S0 — one strata read per tick (cleanup, ~1 file).** Fold the load parse
into the feed fetch the tick already makes for strata rows, exactly the
posture slice 1 used for `feedTps` ("no extra HTTP call"). Wire: nothing
changes — the keys are already on the wire. Gate: byte-identity test that
the signal block for a strata row is unchanged, plus a fetch-count test.
Lowest risk, first, because it is a pure subtraction.

**S1 — the load rollup (`server/src/metrics.ts` only).** Add bounded ADD
keys to `EngineHourLine`, computed from the raw lines of that hour:
`load_reads` (successful load reads), `busy_reads` (readings that published
`load_busy: true`), `peak_in_flight`, `peak_queue_depth`, `gpu_util_max`,
`gpu_power_max`, `model_loaded_last`, `model_quant_last`. Rules: the keys
appear only when the hour had ≥1 load read — an engine with no load axis
produces an hour line exactly as today; a stale reading counts as a read
but never as busy; `peak_*` is a max over present values only, no means;
absent gauges are simply not seen. Reader unchanged (last-line-per-(hour,
key) already makes a re-run idempotent). Gate: rollup over the verbatim
#52 fixtures, byte-identity for a load-free hour, hostile-input drop-don't-
poison cases.

**S2 — the local utilization read (dashboard only, zero wire change).** The
Usage tab gains exception-only rows from the S1 keys: `busy %`, `peak
in-flight`, `gpu util max`, `power max`. An engine whose hour lines carry no
`load_reads` key gets no row — the absence is named, not zeroed. Optionally
the per-engine card's sparkline drills `bucket=raw` inside the 48 h window,
labelled "raw · last 48h". Gate: pure builder tests + the existing
"absent renders nothing" suite.

**S3 — peer utilization rows (dashboard `lib/remote-metrics.ts` only).** No
new server surface: the pull route already mirrors the local contract and
already serves whatever keys a peer's rollup wrote. Add the same exception-
only rows for peers, labelled with `stale`/`truncated`, attribution-only —
never merged across peers (the #79 no-merge rule). A peer on an older build
renders the named absence; that is the old-build tolerance, not an error.
Gate: builder tests with old-shape peer lines (no load keys) proving
byte-identical output to today's rows.

**S4 — the session producer (`arbiter.ts` + `metrics.ts`).** Append one line
per register heartbeat that carries a `history` block, the shape already
defined in `metrics.ts` (`ts, kind:"session", token, reqs_per_min, model`) —
a copy, not a transform, per #51 D2/D3. Bounded: at most one line per
heartbeat per session token, key caps mirroring `cleanReportedHistory`.
This is what makes the #86 session sparklines real. Gate: real-app register
→ store-file assertions; byte-identity when the heartbeat carries no block.

**S5 — the host series (`metrics.ts` + `index.ts` + `api.ts` + Machines
card).** A `kind:"host"` line per tick from `collectHostStats()` (load
averages, cpu count, memory totals, uptime) — coarse by construction, per-key
tolerant exactly as `sanitizeHostStats` already is; rotation rides the
existing rules; `series=host` joins the query contract. The This-Machine
card gets a load1 and RAM sparkline. Deferred behind S1 (same rollup shape
decision applies: keep the hour bucket coarse, or store the day's peak load
average — S5 ships raw-only first).

**S6 — the range control (dashboard only, only if the owner wants it).** The
Usage view's fixed 7-day window becomes 7/30/90. Math to state in the UI:
30 days of hour buckets × 3 engines = 2,160 points > the 2,000 cap, so a 30-day
view must either bucket by day or name the truncation. No wire change.

Nothing in this plan touches: the verdict, the `signal_degraded` plane, the
snapshot shape, the client wire, the store's file family, the engine
binaries.

## 4. Decisions left PROPOSED — the owner's sign-off list

**D1. Amortize the load axis into the hour bucket, or keep hour buckets
load-free and hard-cap every utilization chart at 48 h.**
(a) Keep the lock: charts read `bucket=raw`, so utilization history is
impossible beyond the raw window. (b) Amend D5 with a bounded, aggregate-only
set of load keys on the hour line (S1). **Recommend (b).** Without it "real
utilization over time" is a 48-hr story; the cost is ~1 KB/engine-hour —
≈10 KB/engine-day, ≈4 MB/engine over the 400-day horizon, against the 10 MB
the raw window already writes per engine-day. The lock was made when the
load axis was brand new and only captured; it is now the load axis's only
ceiling.

**D2. The shape of the aggregates: peaks and counts, or means?**
(a) mean GPU util / mean power per hour. (b) `load_reads` + `busy_reads` +
`peak_*` only. **Recommend (b).** A mean of a spiky gauge is a lie about the
machine (the same reasoning that kept the llama-swap number out of the
verdict); counts give a truthful busy-% ratio, and a peak is the number an
operator actually asks for. No means, ever.

**D3. Raw window: keep 48 h, or widen it for load lines?**
(a) 48 h as today. (b) 7 days (≈70 MB/box on the current cadence). (c)
per-series windows. **Recommend (a), and say so in the UI.** S1/S2 make
history available; raw is the drill-in, and the growth is 10 MB/box-day at
three engines — widening it buys a second copy of data S1 already
aggregated. The knob exists if the owner wants it; do not default it.

**D4. Retention horizon: 400 days, unbounded, or 90?**
(a) keep the 400-day default. (b) unbounded for a personal fleet. (c) cut to
90. **Recommend (a) — no change.** #51 open question 3 is answered by
arithmetic: the whole 400-day hour series is ~1 MB/engine today, ~5 MB with
S1's keys. Unbounded means the rotation loop has no horizon and every
`readRange` walks more files for no operator benefit. 90 days throws away
exactly the year-over-year view the owner asked for.

**D5. Sidecar shape: module vs standalone process — re-open or park?**
(a) the LOCKED module (shipped, proven on three machines). (b) the D1
escape hatch: run the same collector standalone on a host that cannot run a
fused arbiter. **Recommend: park it explicitly.** Every machine in the fleet
runs a fused arbiter (mac, urza native systemd unit, scanbot); there is no
host today for which the hatch is needed, and building it adds a lifecycle,
a port and a token plane for zero value. Record "unexercised, boundary kept"
so the boundary stays real for whoever needs it later.

**D6. Chart surface: Usage rows, a new Utilization tab, or per-engine card
sparklines?**
(a) rows in the existing Usage view. (b) a dedicated view/tab. (c) a
48-h raw sparkline on the per-engine card only. **Recommend (a) + a limited
(c).** The Usage vocabulary already exists (Sparkline, exception-only rows,
tile/row colouring), the #79 pull feeds the same renderer, and a new tab is
a new nav surface with no new information — the two-axes rule says the
measurement belongs beside the engine, the history belongs in Usage.

**D7. Cross-machine charts: peer hour lines through the existing pull, a
browser fan-out, or a fleet-merged series?**
(a) per-peer attribution through `GET /api/metrics/remote` (already built).
(b) the superseded #51 D7 answer — the dashboard hits each peer origin
directly. (c) a fleet rollup merged on the puller. **Recommend (a),
attribution-only, and name it in the row label.** (b) is against mesh D3
(local-first surfaces) and the auth lock; (c) invents a hub that mesh D1
forbids and makes "fleet peak GPU util" a number nobody can audit.

**D8. llama-swap: set the threshold, or keep the knob unset?**
(a) set a number (the probe observed 91% while serving, 95.5% VRAM). (b) keep
it UNSET — display and sample only. **Recommend (b), unchanged.** The engine
is not currently declared on urza, and the D4 reasoning still holds: a fixed
number on a spiky gauge cuts both ways, and there is no HTTP in-flight count
to prefer. If the owner wants the veto for that kind, the honest move is to
re-declare a llama-swap row, watch its `gpu_util_percent` samples for a week
through S1/S2, then pick the number from data.

**D9. Session history: wire the producer (S4) or leave the shape dormant?**
(a) append per heartbeat. (b) keep the store shape, no producer. **Recommend
(a), with caps.** The dashboard already renders the rows and the mesh already
permits the series; leaving the shape unwired means every peer expand has a
permanently empty section, which is a fake absence rather than a named one.

**D10. Load-read cadence: every tick, or its own slower interval?**
(a) every poll tick (15 s) as today, with the strata double-fetch folded
away in S0. (b) a `metrics_load_poll_s` knob. **Recommend (a).** A slower
cadence makes the freshness window (45 s default) the thing that decides
whether the veto exists, and the engines are loopback/tailnet-local — the
cost is already paid by the feed fetch. Revisit only if the owner runs an
engine that objects to 4 reads a minute.

## 5. Risks and edge cases the plan must honor

- **Poll-cadence cost.** Measured shape today: 4 samples/engine-minute per
  engine row, and a strata row gets two GETs of the same URL per tick plus
  the catalog probe. S0 removes one; do not add more fetches in S1–S5.
- **Store growth.** ~10 MB/box-day raw at three engines; hour files ~25
  KB/day. S1 adds ~10 KB/engine-day — noise. The real growth risk is a
  widened raw window (D3) or a session producer that fires per request
  instead of per heartbeat (D9). Keep the "denials ride as counters, never
  one line per denial" rule for sessions too.
- **Peer privacy.** Load aggregates crossing the mesh are numbers, not
  payloads — consistent with mesh D1 and #79 D5. Two disclosures to bound:
  `model_loaded` (comma-joined ids) must be capped (≤2 ids, ≤128 chars each)
  before it rides an hour line, and host RAM totals stay host-level, never
  per-process. Raw load lines stay inside the peer's own 48 h window and
  stay ephemeral on the puller.
- **Old-build tolerance.** A peer whose rollup predates S1 publishes hour
  lines without the load keys; a peer whose build predates #52 publishes no
  load axis at all. Every renderer must render the named absence, never a
  zero — and `sanitizeRemoteMetrics` must drop unknown keys per key rather
  than reject an envelope that carries them (drop-don't-poison).
- **Degraded feed, healthy load.** Observed live on urza: `degraded true`
  from the feed while the load read is fresh. The rollup must count that as
  a `load_reads` sample and never as a degraded engine, exactly as the
  verdict already does (D2 rule 3).
- **Gauge absence is not zero.** A card-less engine, an engine without a
  power gauge, a queue the kind does not report: absent stays absent. The
  peak of an empty set is undefined, not 0.
- **Rollup idempotence.** S1 must not rewrite files: append another hour
  line and let the reader's last-line-wins contract settle it. Restart
  mid-hour still recovers from raw files — never an accumulator.
- **Clocks.** Cross-machine charts are per-peer, never merged; a peer's
  timestamps are its own clock. Attribution labels, no fleet sum.
- **The 2,000-point cap.** A 30-day, 3-engine hour-bucket query exceeds it;
  S6 must either day-bucket or report `truncated: true` honestly in the UI.

## 6. Deliberate non-decisions (fences, not gaps)

No KV-cache key and no fabricated pressure scale. No change to the idle
verdict or its fail-closed degraded semantics. No load keys in the mesh
snapshot. No auto-discovery of engine rows. No second secret for the
metrics plane. No chart library. Nothing in this wave restarts or touches an
engine binary — the sidecar reads, never writes.

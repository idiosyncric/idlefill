# #62 report — provider kinds: engine adapters, metrics from engine truth

Built and live-verified 2026-10-05. Closes #62 (brief: ISSUE62-BRIEF.md) and
#60 Slice C for the local case. Uncommitted WIP (found at session start,
matching the brief) was completed, gated, and landed direct-to-main.

## What shipped

One key — `provider` on the server row — selects the idle-signal
implementation AND the metrics sampler. Kinds: `llama-swap` (default,
unchanged), `strata`, `omlx`. Absent = `llama-swap`: every pre-existing
row behaves exactly as before.

| kind | idle signal | engine metrics | co-location |
|---|---|---|---|
| `llama-swap` | activity feed + optional `log_glob` | feed-id deltas (unchanged) | feed HTTP |
| `strata` | `/metrics` JSON → feed entries (`parseStrataMetrics`) | `totals` counters: requests + prompt/output tokens (HTTP only — remote OK) | none |
| `omlx` | log mtime (feed-off, #60 A1) | `~/.omlx/usage.sqlite3` `model_usage_hourly` SUM (`SqliteOmlxUsageReader`, read-only) | required |

Key pieces:

- `server/src/idle.ts` — `parseStrataMetrics` (completion-time entries,
  in-flight generation = current activity, ids ride `totals.requests`),
  `readStrataCounters`, `defaultActivityPathFor`, `kindGapReason`,
  `no_signal_reason` on the detector signal.
- `server/src/omlx.ts` — `CounterDeltaTracker` (FeedDeltaTracker posture:
  first sample + backwards counters read UNKNOWN, never negative),
  `SqliteOmlxUsageReader` (lazy `node:sqlite` require, `query_only` pragma,
  unreachable ≠ zero), `OmlxUsageReaders` (warn-once, self-heals).
- `server/src/arbiter.ts` — kind validation on create + patch, kind change
  re-derives the feed defaults (`strata` also normalizes the url to the
  service origin — the /v1 paste fix), detector rebuilt after patch.
- `server/src/config.ts` — `server_provider` (validated) + `omlx_usage_db`
  keys; the watched-row feed path defaults by kind.
- `server/src/index.ts` — per-row fetch wrapper observes the strata totals
  on the SAME poll (no extra HTTP call); the tick samples omlx via the
  usage store; per-kind `requests_source` on every engine sample.
- `server/src/metrics.ts` — ADD keys only: `requests_source`,
  `tokens_in_delta`/`tokens_out_delta` on engine lines;
  `requests_source`, `engine_tokens_in/out` on engine_hour lines. Existing
  fields never renamed; old files read unchanged.
- `server/public/index.html` — provider-kind select in add + edit forms
  (edit pre-selects the stored kind), plain-words co-location warning when
  `omlx` points at a remote url, `provider` source word + `NO SIGNAL
  <kind gap>` row in the signal block, Usage rows label engine-truth
  sources and render engine token charts when present.

## Field names verified against the live endpoints (the brief's caveat)

strata `/metrics` (both engines, authenticated 2026-10-05):
`requests[].{time,duration_s,finish}`, `live.state`, `time`,
`totals.{requests,prompt_tokens,output_tokens}`, `engine.model`. The
parser shipped matches these exactly. oMLX store table
`model_usage_hourly(timestamp_hour, model_id, requests, prompt_tokens,
completion_tokens, cached_tokens, prefill_seconds, generation_seconds,
request_seconds, timed_requests)` — SUM columns verified live.

## Live acceptance (Mac arbiter :8787, after one launchd kickstart)

- `strata` row: `provider=strata`, url normalized to
  `https://strata.samwarth.com` (origin), `activity_path=/metrics`,
  `degraded=false` (was: DEGRADED "activity fetch failed"), Busy with real
  `idle_for_s` and last activity `qwen3.8-flash-next-iq3_s · strata:engine`.
- `strata-scanbot` row: `provider=strata`, `http://10.10.10.241:8080`,
  `degraded=false`, **Idle 92m** with last activity
  `qwen3.8-flash-next-q2_0 · strata:engine` — the engine became
  judgeable; its queue is now reachable for #60 B2 fail-over chains.
- Engine truth in the raw metrics stream:
  `srv-45abb4e8 req_delta: 2, tok_in: 160656, tok_out: 1395, source:
  metrics-counter` (10 requests + tokens summed for the hour). oMLX row:
  `source: sqlite`, first sample unknown then real deltas (store idle —
  the engine ran nothing for 128m, zero is the truth).
- `srv-watched` set to `provider=omlx` live (log_glob + feed-off path kept
  through the kind change) — closes #60 Slice C for the local case.
- Dashboard (Orca embedded browser): all three cards healthy, provider
  words render, add/edit forms carry the kind select, no DEGRADED rows.
  Screenshot: `ISSUE62-servers.png`.
- The hour-bucket Usage chart shows strata counts once the next hour
  boundary rolls the raw stream up (rollup carries the new fields —
  unit-tested); raw bucket already answers them via /api/metrics.

## Gates (actual output)

- `npm run test` — **161 pass / 0 fail** (144 pre-existing + 17 new in
  `server/test/provider-kinds.test.ts`, registered in the package `test`
  script per the enumeration pitfall).
- `npm run build` — clean. Per-package `npx tsc --noEmit` (server, client)
  — clean.
- Inline dashboard JS syntax-checked (`new Function` over the extracted
  script).

## Notes

- Live state changes were made through the API (state.json backed up to
  `state.json.bak-62` first). The arbiter restart ran through
  `launchctl kickstart -k gui/501/com.sam.idlefill.server`.
- A Hermes-sandboxed node process gets EHOSTUNREACH to scanbot's LAN IP
  while the arbiter's own process reaches it — probe engines from the
  arbiter, not from agent sandboxes.
- urza still runs the pre-#62 image (`idlefill-server:786a414`). The
  urza arbiter has no strata/omlx rows, so its behavior is unchanged;
  it redeploys on the normal cadence.

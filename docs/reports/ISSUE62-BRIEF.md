# Provider kinds: engine adapters (llama.cpp + oMLX), metrics from engine truth

Owner-directed 2026-10-05, right after #60 Slice A went live. Diagnosed live:
strata is degraded and contributes ZERO usage metrics because the arbiter
speaks only llama-swap.

## Live facts (measured 2026-10-05 on the Mac arbiter, 127.0.0.1:8787)

- Row `strata` (https://strata.samwarth.com/v1): `activity_path=/api/metrics/activity`,
  `auth_set=true`, `degraded=true reason="activity fetch failed" idle=false`.
  Unauthenticated route shape: `/health` 200, `/props` 401, `/metrics` 401,
  `/api/metrics/activity` 404. That is the llama.cpp server family (props +
  metrics endpoints), NOT llama-swap. The key is stored and fine; the FEED
  DOES NOT EXIST on this provider.
- Row `strata-scanbot` (http://10.10.10.241:8080/v1, added via the GUI):
  identical degradation, same invented feed path — the add-server form seeds
  `/api/metrics/activity` for every row.
- Row `oMLX`: healthy via A1 feed-off (log mtime), but contributes no
  request/token metrics — the engine sampler is feed-id deltas only.
- Consequence: strata + strata-scanbot are permanently non-idle →
  fail-closed for grants → invisible in Usage. #60 B2 fail-over chains
  cannot reach them for the same reason.

## Structural diagnosis (where "every engine is llama-swap" is baked in)

1. `ServerConnection.activity_path` defaults to `/api/metrics/activity`
   (config DEFAULTS, `upsertServer` seeding, GUI placeholder).
2. `IdleDetector` parses exactly one feed shape: entries with
   `{id, timestamp, model, src}`.
3. Per-engine request metrics are feed-id deltas (`FeedDeltaTracker`,
   metrics.ts): no feed ⇒ no request counts, no token truth, period.
4. The only feed-free signal is log-mtime, which demands co-location with
   the engine — impossible for remote hosts like strata.

## Design: `provider_kind` on the server row

One key selects the idle-signal implementation AND the metrics sampler.
The seam already exists: `makeDetector(row)` in index.ts builds a detector
per row; a kind routes to per-kind detector + sampler implementations.

| kind | idle signal | engine metrics | co-location |
|---|---|---|---|
| `llama-swap` (default, unchanged) | activity feed + optional log_glob | feed-id deltas | feed HTTP; log needs co-location |
| `llama.cpp` | GET `/metrics` (Prometheus counters, bearer auth via the existing `auth_token`): running-request gauge + counter deltas | requests_total + token counters from the same poll; `/props` for model listing (feeds the row's models display) | HTTP only — remote OK |
| `omlx` | log mtime of `~/Library/Application Support/oMLX/logs/server.log` (A1 feed-off posture) | `~/.omlx/usage.sqlite3` `model_usage_hourly` rows | required (same machine) |

Rules:
- `provider_kind` absent = `llama-swap` (back-compat; existing rows unchanged).
- HTTP-based kinds may poll across the network with the stored per-server
  key (#60 B contract: write-only, never echoed). Log/sqlite kinds declare
  co-location; the GUI shows a plain-words warning when the kind cannot work
  against a remote url.
- Metrics series contract holds: same `series=engine|lease|session` names,
  ADD sample keys only (e.g. `requests_source: feed-delta|metrics-counter|sqlite`).
  Never rename existing sample fields.
- Dashboard: `provider_kind` row in the add + edit server forms (this IS the
  provider-kind control locked in #60 Slice B's remainder — merged scope),
  and the signal row renders the kind's source word so an operator can see
  WHY a row is idle or degraded.

## Sequencing

Do this BEFORE #60 B2 fail-over chains: chains are only useful over engines
that can actually be judged idle. strata/scanbot today never are.

## Acceptance

- strata + strata-scanbot rows: `degraded=false`, real `idle_for_s`, verdict
  derived from `/metrics` counters with the stored key (live check, both rows).
- Usage charts show strata request counts (+ token counters if the endpoint
  exposes them — verify against the live endpoint, do not assume field names).
- oMLX row gains request/token series from the sqlite store (closes #60
  Slice C for the local case).
- A feed-less, non-co-located engine with no supported kind still fails
  closed HONESTLY: degraded reason names the kind gap, not "activity fetch
  failed".
- Gates: `npm run test` (new adapter suite registered in the package test
  script), `npm run build`, per-package tsc. Live evidence in
  `docs/reports/ISSUE62-REPORT.md` + index.

Note on evidence depth: the diagnosis above is from unauthenticated route
shapes (404 vs 401) — the authenticated `/metrics` payload has NOT been read
yet (a probe attempt was blocked mid-session). Acceptance must verify the
real counter field names against the live strata before the parser ships.

Relates: #60 (B keys done; B2 chains come after this; Slice C metrics),
#52 (exporter stays for remote engines WITHOUT an HTTP metrics endpoint —
llama.cpp engines have one, so #52 is not on this path's critical chain),
#47/#44 (admission + queue surfaces assume grantable engines).

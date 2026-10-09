# #81 — Connector: page the session ledger past the 200-row window

**Status:** delivered on branch `issue-81` (base `main`). Not merged (owner gate).

## The gap (re-verified before building)

`fetchRound` fetched each profile ledger with a fixed `?limit=200` and ignored the list envelope's `has_more`/`offset` fields. 200 is the gateway's own hard maximum (`_handle_list_sessions` parses `limit` with `maximum=200`, v0.21.6), so one request can never see deeper. A profile whose recency window exceeds one page would silently enrich only the freshest 200 rows — and the connector's last-known-wins merge would keep publishing the stale tail with no signal it stopped refreshing.

## What was built

`client/src/hermes-gateway.ts` — `fetchRound` now pages per profile:

- `?limit=200&offset=<page*200>`, following `has_more === true` strictly (absent/false ⇒ last page).
- `LEDGER_MAX_PAGES = 5` caps one profile's round: a hostile or buggy always-true `has_more` can never make the round unbounded.
- Fail-quiet shape unchanged: a failed/401/non-200/malformed page ENDS that profile's round (`break`, not `continue`), the pages already merged stand, the rest of the round stands. The in-flight guard + poll cadence already bound the total.
- Same-round id de-dupe now also handles shifted-page overlap (two pages can repeat an id if the ledger rotates between fetches): the newer `last_active` wins, unchanged rule.

## Decisions honored

- No new config surface — page size and cap are constants (the operator's `poll_seconds`/`timeout_ms` knobs bound the cadence; pages are strictly per round).
- ADD-key discipline untouched: the connector's wire output is byte-for-byte unchanged; only the set of session ids it KNOWS grows.
- The #82 audit correction is recorded in the issue body: compression rotations are NOT a gap (the listing projects each chain TIP's fields — including `id` — onto the surfaced row, verified in `hermes_state_sessions.py` `_project_compression_tips`); `include_children=true` is explicitly NOT used (it would admit hidden internal children as first-class rows).

## Harness + build output

- `client/test/hermes-gateway.test.ts` — the fake gateway gained a real pagger (`paginateDefault`: honest per-page `has_more`, served by the request's own limit/offset) + `failDefaultPage` (page N 500s) + a recorded `query` per request. Three new tests: deep 450-row ledger enriches ALL rows across 3 pages (exact `?limit=200&offset=0/200/400` asserted); a mid-pagination page failure keeps page 1 merged and poisons nothing (reachable stands); a hostile always-true `has_more` is capped at exactly 5 rows.
- `tsx --test test/hermes-gateway.test.ts`: 17/17 pass.
- `npm test --workspace client`: 180/180 pass. `npx tsc --noEmit -p client/tsconfig.json`: clean.

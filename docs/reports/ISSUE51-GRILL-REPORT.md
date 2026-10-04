# Issue #51 (metrics + history) — grilling report

Decision document: `docs/architecture/metrics-history.md`. This report
records what the grill verified and what it settled. No code changed.

## What the grill verified against the code

- The 500-row caps and the atomic tmp+rename posture: `trim()` and `save()`
  in `server/src/state.ts:109-127`.
- Sessions are one timestamp deep: `last_activity` on the session row,
  `registerSession` in `server/src/arbiter.ts:671-712`.
- Token totals exist only per project per UTC day: `addBudget`,
  `server/src/arbiter.ts:1274-1279`.
- The arbiter does NOT see interactive token counts. The activity feed
  entry has no token field (`ActivityEntry`, `server/src/types.ts:325-332`).
  The `log_glob` path stats mtimes only (`makeRealLogMtimeSource`,
  `server/src/idle.ts:196-213`). The prompt's open question — "does the
  same log_glob give token counts?" — answers NO with today's code.
- The feed entry carries a numeric `id` (`server/src/types.ts:326`). A
  request delta is derivable, with one unverified assumption (id behavior
  across a llama-swap restart) recorded as an open question.
- The coarse snapshot is capped and ephemeral (`server/src/mesh.ts:191-224`
  + the mesh.md rules), so a time series cannot ride it.

## Decisions settled

D1 JSONL store-file family (LOCKED). D2 four series kinds, host metrics
deferred to #52 (LOCKED). D3 recorder lives in the arbiter (LOCKED).
D4 hybrid sampling + event appends, with the size math (LOCKED). D5 48 h
raw window, hour buckets kept 400 days, whole-file rotation (LOCKED).
D6 `GET /api/metrics` shape + auth (LOCKED). D7 no series in the mesh
snapshot; cross-machine read-time aggregation deferred (LOCKED, the
cross-machine surface PROPOSED). D8 minimal dashboard section (PROPOSED).

## Open questions left for the owner

1. llama-swap feed `id` behavior across a restart — measure on urza.
2. Interactive token counts: #52 or #45 owns them.
3. Hour-bucket horizon: 400 days vs unbounded.
4. Cross-machine chart auth: shared `api_token` vs per-peer tokens.

## Deliberate non-changes

- No file under `server/` or `client/` touched. No other doc touched.
- `/api/state` shape untouched. The mesh snapshot untouched.

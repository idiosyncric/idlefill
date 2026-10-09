# Build report — #86: cross-mesh telemetry build wave (#79 implementation)

Shipped on main: `4979d8d` (doc lock `d010ad2` preceded it). Decision doc:
`docs/architecture/mesh-telemetry.md` (LOCKED, #79). Contract detail:
`docs/reports/ISSUE79-GRILL-REPORT.md`. No source touched outside the doc's
"Changes" list.

## What landed, per the locked doc

- **`GET /api/metrics/remote` (D2, one route, two modes)** — `server/src/api.ts`.
  SERVE (no `peer` param): answers the local store to a pulling peer with the
  local `/api/metrics` param contract, 400 discipline, and the 2,000-point
  OLDEST-trim cap + `truncated` — plus the `peer` ADD key. PULL
  (`peer=<instance_id>`): the operator's dashboard surface; the arbiter hops
  to the peer on demand and answers `{ series, truncated }` + ADD keys
  `peer`, `pulled_at`, `stale`.
- **Auth (D4)** — the `onRequest` hook passes the route on EITHER credential
  and the route enforces the pairing: serve side = fleet `peer_token` ONLY
  (anonymous 401, wrong token 401, **local admin token 401** — the one route
  where admin does not work); pull side = local admin token ONLY (the
  dashboard's posture, the `peer_token` never leaves the arbiter). `GET
  /api/metrics` stays anonymous-read and peer_token-401, byte-for-byte.
- **On-demand pull + ephemeral cache (D3)** — `server/src/mesh.ts`:
  `MeshFederation.pullMetrics` + `sanitizeRemoteMetrics`. Never on the 15 s
  tick. Cache in memory only, one entry per (url, series, key, bucket, from,
  to), TTL `mesh_metrics_cache_s` (default 60, `0` = live). A TTL hit answers
  `stale: true` with the ORIGINAL fetch clock. A failed fetch DROPS the line
  (502 named gap, no fake zeros; the row renders offline under
  `PEER_STALE_MS`). Remote lines NEVER persist: nothing in `state.json`,
  nothing in the puller's `metrics-*.jsonl`.
- **Untrusted input (grill trust boundary)** — hard caps (64 keys,
  2,000 points/key, MAX_NAME key caps, 512-char string values), finite
  epoch-ms `ts` required, and the line `kind` must match the requested
  series+bucket. Garbage points drop individually; a malformed envelope is
  a 502, never a crash, never a poisoned cache.
- **`mesh_metrics_cache_s` (wire key #3)** — `server/src/config.ts` DEFAULTS
  60; `0` is legal (disable); garbage/negative fall back to 60.
- **`PeerView.metrics_cache` (wire key #2)** — ADD key, absent until the
  first successful pull; counts entries + `last_pulled_at`, never carries a
  line. `MeshSnapshot`, `sanitizeSnapshot` and the local route response: no
  new keys (fence test proves the snapshot key set).
- **Dashboard (D6)** — `dashboard/src/views/Machines.tsx`: ONE read-only
  expand per peer row (ADD-only; collapsed rows render exactly as before).
  On open it range-reads engine + session series (7 d, hour buckets)
  THROUGH the local arbiter and renders req/hr, engine-reported tok
  out/hr (exception-only — no fake-zero token row for feed-delta gaps), and
  session peak-rpm sparklines, reusing `Sparkline` + the #52/#57 Usage
  vocabulary (`dashboard/src/lib/remote-metrics.ts`, pure + tested).
  `stale`/`truncated` labels render; a failed pull is a named gap.

## Verification (HEAD 4979d8d)

- `server/test/metrics-remote.test.ts` — 16 new tests, real Fastify pair via
  `app.inject`: serve/pull auth matrix, 400s, OLDEST-trim cap, TTL stale
  semantics, `cache_s=0` live pulls, failure-drops-the-line (controlled
  clock past the TTL), malformed envelope 502, garbage-point drop, ephemeral
  guarantee (no store files, no remote line in `state.json`),
  `metrics_cache` absent-then-counted, and the fences (local `/api/metrics`
  anonymous 200 / peer_token 401; `/api/mesh` coarse key set unchanged).
- Live proof (`scripts/issue86-remote-metrics-live.mts`, real sockets, no
  mocks):

  ```
  [A] peer instance: m-7478ec23be86 (pulled over real HTTP from http://127.0.0.1:55720)
  [A] pull #1: HTTP 200 peer=m-7478ec23be86 stale=false series=srv-live-peer(6)
  [A] pull #2 (inside the 60 s TTL): stale=true pulled_at=<original clock> (kept)
  [A] auth: anonymous pull -> 401; peer_token on the peer's serve side -> 200
  [A] ephemeral: puller dir = [state.json]; state.json mentions remote lines: false
  [B] urza (tailnet, PRE-#86 build): peer_token on the serve side -> HTTP 401
      (the old hook 401s the peer_token before routing); puller answer:
      named gap, cache entries on the urza row: 0 — no fake zeros, nothing persisted
  PASS
  ```

  The Mac↔urza HAPPY path waits on the urza deploy (separate owner step,
  per the card): urza runs the pre-#86 build, so the serve side 401s the
  hop — exactly the failure branch the row renders offline under.

- Gates at HEAD: server 430/430 (414 + 16), client 195/195, dashboard 8/8
  (4 new builder tests + the 4 load-read), fleet + the rest green;
  `npx tsc --noEmit` clean for server, client, dashboard, fleet;
  `npm run build` clean.

## Owner step

Deploy #86 to urza (the serve side needs the route there), then expand
urza's row on the Mac dashboard: model-ish session keys + req/hr +
tokens/hr sparklines, labeled live/cached.

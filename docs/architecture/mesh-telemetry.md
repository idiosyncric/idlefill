# Cross-mesh telemetry: read-time peer metrics over the mesh (issue #79, grilling, 2026-10-09)

The owner ask (2026-10-08): every machine's engines must be visible across
the fleet. urza runs llama-swap and strata as containers. The owner wants
urza to advertise those engines and to federate their telemetry (request
rate, token throughput). The owner also asked to "federate the logs." This
doc grills the telemetry half. The log half is fenced in D5.

Map: #50 (`docs/architecture/mesh.md`, LOCKED — federation) · #51
(`docs/architecture/metrics-history.md`, LOCKED — the retention store) · #55
(`docs/architecture/fleet-service.md`, the auth upgrade this doc names but
does not build) · #63 (`docs/architecture/aggregate-endpoint.md`, LOCKED —
the write-only credential plane). Format model:
`docs/architecture/engine-health-routing.md`. Citations re-verified against
HEAD `4369a37` on 2026-10-09. Status: PROPOSED for the owner. Every D-block
is LOCKED in shape. The owner must settle the Open questions before the
build wave is filed. Nothing here is built.

## The gap, re-verified against the code

- The #51 retention store answers "give me series X between A and B" on one
  machine. `MetricsStore.readRange` reads the LOCAL files only
  (`server/src/metrics.ts:486-522`). The files are
  `metrics-raw-YYYY-MM-DD.jsonl` and `metrics-hour-YYYY-MM-DD.jsonl`, next to
  `state.json` (`server/src/metrics.ts:4`, `server/src/metrics.ts:311`,
  `server/src/metrics.ts:441`).
- Three series kinds: `engine`, `lease`, `session` (`server/src/metrics.ts:40`).
  The hour rollup keeps the LAST line per (hour, key)
  (`server/src/metrics.ts:513-519`). Raw window default 48 hours
  (`server/src/config.ts:45`), hour retention default 400 days
  (`server/src/config.ts:46`). The wire-up passes the same knobs
  (`server/src/index.ts:105-108`).
- `GET /api/metrics` is the #51 query surface (`server/src/api.ts:1112-1164`).
  Params: `series` (engine, lease, session), `key`, `from`/`to` (epoch-ms,
  default the last 7 days), `bucket` (hour, raw). A 2,000-point cap trims the
  OLDEST and sets `truncated: true` (`server/src/api.ts:1145-1148`). Auth:
  anonymous read (`server/src/api.ts:292-298`). A wrong token is 401
  (`server/src/api.ts:304-307`). The fleet `peer_token` does NOT unlock this
  route (`server/src/api.ts:296`, and re-proven live in the grill report).
- `GET /api/mesh` serves the coarse snapshot
  (`server/src/api.ts:1143-1156`). The shape is `MeshSnapshot`
  (`server/src/mesh.ts:37-59`): `instance_id`, `name`, `ts`, `version`
  (optional), `servers[]` with `name`, `idle`, `idle_for_s`, `degraded` only,
  plus `queue_depth`, `sessions`, `active_leases`. No models. No metrics. No
  tokens.
- `MeshFederation` pulls each peer's `/api/mesh` on the tick
  (`server/src/mesh.ts:116-137`, the production caller at
  `server/src/index.ts:272`). `sanitizeSnapshot` treats remote input as
  untrusted, with hard caps `MAX_SERVERS = 20` and `MAX_NAME = 64`
  (`server/src/mesh.ts:29-30`, `server/src/mesh.ts:191-224`). A peer renders
  offline past `PEER_STALE_MS = 90_000` (`server/src/mesh.ts:25`).
  Snapshots never enter `state.json`
  (`server/src/arbiter.ts:2488-2500`).
- Model identity is LOCAL today. `CatalogEntry` carries `name`,
  `server_id`, `url`, `auth_set`, `catalog_source`
  (`server/src/catalog.ts:23-34`). The per-row `/v1/models` probe is
  arbiter-side (`server/src/catalog.ts:44-153`). It feeds the router and the
  agent mint hand-off. It does not cross the mesh. The snapshot `servers[]`
  carries no models.
- No container auto-discovery exists. Engine rows are operator-declared
  (the `/api/servers` route plus the config seed). A grep for `docker`,
  `portScan`, and `scanPort` across `server/src`, `client/src`, and
  `dashboard/src` returns zero hits (verified 2026-10-09).
- Nothing in the repo pulls one machine's metrics store from another. A grep
  for `metrics-remote`, `peer_metrics`, and `remoteMetrics` across
  `server/src`, `client/src`, and `dashboard/src` returns zero hits
  (verified 2026-10-09). The #51 clause "the mesh aggregates per-machine
  stores at read time" (`docs/architecture/metrics-history.md:173-174`) has
  no wire behind it yet. That is the gap this doc fills.

## Inherited constraints and amendment discipline

From `docs/architecture/mesh.md` (LOCKED, #50):

1. **The snapshot is COARSE by construction.** Presence, per-engine idle
   signal, queue depths, session and lease counts. Never job ids, titles,
   URLs, or payloads (`docs/architecture/mesh.md:81-84`,
   `docs/architecture/mesh.md:185-186`).
2. **Federation moves snapshots, never decisions.** "State is published,
   never computed remotely" (`docs/architecture/mesh.md:35-36`).
3. **Peer snapshots are EPHEMERAL.** In memory only, never written to
   `state.json` (`docs/architecture/mesh.md:57-60`,
   `server/src/arbiter.ts:2488-2500`).
4. **The mesh read plane is the fleet `peer_token`, scoped to `GET /api/mesh`
   only** (`docs/architecture/mesh.md:76`, `server/src/api.ts:55-59`).

From `docs/architecture/metrics-history.md` (LOCKED, #51):

5. **The store is per arbiter (per machine). Retention stays local.** "The
   mesh aggregates per-machine stores at read time"
   (`docs/architecture/metrics-history.md:173-174`).
6. **The coarse snapshot carries no time series** (#51 D7, LOCKED).
7. **Cross-machine charts are PROPOSED and deferred.** #51 D7 names the
   follow-up: "the dashboard queries each peer's `/api/metrics` directly from
   the browser. That needs the operator's token per peer"
   (`docs/architecture/metrics-history.md:198-201`).

From `docs/architecture/aggregate-endpoint.md` (LOCKED, #63):

8. **Engine credentials are write-only. No read surface carries a token out**
   (`docs/architecture/aggregate-endpoint.md:114-118`). This plane carries
   none.

Amendment discipline. This doc SUPERSEDES exactly one clause: #51 D7's
deferred cross-machine answer (browser-side direct peer queries with the
operator's token per peer,
`docs/architecture/metrics-history.md:198-201`). The quoted follow-up knob
makes the supersession legitimate. The chosen answer is an ARBITER-MEDIATED
pull under the mesh read plane (D2, D4). Everything else in #51 stays
LOCKED and UNCHANGED: the file family, the retention knobs, the local
`GET /api/metrics` route and its anonymous scope, the D7 snapshot fence.
Everything else in mesh.md stays LOCKED and UNCHANGED: the `MeshSnapshot`
shape, the sanitizer caps, the ephemeral rule, the coarse lock. The #55
upgrade (per-instance ed25519, `docs/architecture/fleet-service.md:54-58`)
is NAMED in D4. This doc builds nothing for it.

## D1 — Coarse in the snapshot, detail on demand

**LOCKED.** The 15-second `MeshSnapshot` stays coarse and UNCHANGED
(`server/src/mesh.ts:37-59`). No model or metric key goes into `servers[]`.
The sanitizer caps stay (`server/src/mesh.ts:29-30`). Adding detail there
would make `/api/mesh` a second `/api/state`, which mesh.md forbids
(`docs/architecture/mesh.md:185-186`).

What crosses the mesh, per engine, and how:

- **Presence and the idle signal:** already on the snapshot, UNCHANGED and
  REUSED.
- **Queue depth:** already on the snapshot (`queue_depth`), UNCHANGED and
  REUSED.
- **Request rate and token throughput:** cross only on a read-time pull (D2),
  as the peer's own store lines. The engine series carries `req_delta` and
  the `#62` counter-backed token deltas (`server/src/metrics.ts:54-76`).
  The hour lines carry the summed totals (`server/src/metrics.ts:102-121`).
- **Model and quant identity:** model names already encode the quant
  (measured live: `qwen3.8-flash-next-q2_0`, `qwen3.8-flash-next-iq3_s` on
  the Mac arbiter's server rows, 2026-10-09). Two honest channels, both
  on-demand, both already built locally: the peer's session series carries
  `model` per line (`server/src/metrics.ts:94-100`), and the peer's own
  dashboard shows its catalog. The pull route serves the store only. It
  serves no catalog.

Rejected — enrich the snapshot with models or metrics: it holds remote
detail in memory on every poll, grows the privacy surface on every machine,
and breaks the sanitizer caps. Rejected — the dashboard reads the peer's
catalog origin directly: it fans a thin client out to a second origin
(against mesh D3, local-first surfaces) and it bypasses the auth plane this
doc locks.

## D2 — The transport: a mesh-scoped range read, arbiter to arbiter

**LOCKED.** One new arbiter route: `GET /api/metrics/remote`. It mirrors
the `GET /api/metrics` param contract and cap exactly: `series` (engine,
lease, session), `key`, `from`/`to` (epoch-ms, default the last 7 days),
`bucket` (hour, raw). Bad params answer 400, same as
`server/src/api.ts:1117-1134`. The 2,000-point cap trims the OLDEST and sets
`truncated: true`, same as `server/src/api.ts:1145-1148`. The raw window
clamps per peer, same as `server/src/metrics.ts:491-493`. The response
mirrors the local route's body: `{ series: [{ key, points }], truncated }`
plus the ADD keys named in the wire-keys section. The CALLING PEER's store
answers the PULLER (the dashboard's arbiter, on the operator's behalf, D3).

Rejected — fold it into `/api/mesh`: it breaks the coarse lock (D1).
Rejected — the fleet service relays it: `docs/architecture/fleet-service.md:40`
locks "It never carries the traffic." Rejected — a browser fan-out to each
peer origin: it is the superseded #51 D7 answer (operator token per peer,
client-side fan-out).

## D3 — Where the read-time aggregation happens: the puller's arbiter, on demand, short ephemeral cache

**LOCKED.** The PULLER is the dashboard's arbiter. It fetches on demand when
the operator expands a machine row (D6). The dashboard never talks to a
peer origin. It talks to its own arbiter, and its own arbiter talks to the
peer. No new push channel. No periodic background pull of metrics. The 15 s
tick keeps pulling only the coarse snapshot
(`server/src/index.ts:272`), UNCHANGED.

Cache: the puller holds the answer in memory for a short TTL, default 60 s
(config knob `mesh_metrics_cache_s`, 0 disables). A repeat expand within the
TTL serves the cache and sets `stale: true` on the response. The cache is
EPHEMERAL like a peer snapshot: it never touches `state.json` and it never
enters the puller's own metrics store. A failed peer fetch drops the cache
line. The peer row then renders offline under the existing `PEER_STALE_MS`
rule (`server/src/mesh.ts:25`).

**The puller never persists remote lines** (the issue's D3, LOCKED here as
the non-persistence clause). A remote range read is dropped after the
dashboard renders it. There is no cross-machine store merge. There is no
stale remote truth on disk. This is the mesh.md D1 ephemeral rule
(`docs/architecture/mesh.md:57-60`) applied to the metrics store.

Rejected — a periodic pull of peer stores: it is a background federation
write to the puller's truth, and it is the stale-remote-truth shape the
ephemeral rule exists to prevent. Rejected — a hub that merges fleet-wide
series: a relay, against mesh D1's no-hub lock
(`docs/architecture/mesh.md:38-47`).

## D4 — The auth plane: the fleet `peer_token`, scoped to this one route

**LOCKED.** `GET /api/metrics/remote` unlocks ONLY on the fleet `peer_token`
(`isPeerToken`, `server/src/api.ts:55-59`), in the same `onRequest` hook
shape as `/api/mesh` (`server/src/api.ts:299-303`). It is NOT anonymous. It
is NOT a local admin token route. A wrong token is 401, same as today
(`server/src/api.ts:304-307`). Same secret, same tailnet-only reach as
`/api/mesh`. Verified live (2026-10-09, this machine): the fleet
`peer_token` gets 401 on `GET /api/metrics` and 200 on `GET /api/mesh`
(grill report). The route stays out of the anonymous branch
(`server/src/api.ts:290-298`).

The dashboard holds no `peer_token` today (verified: no token surface in
`dashboard/src/lib/api.ts`). That is correct under this lock. The token
stays with the arbiter, the same posture as the pull token the mesh
federation already holds (`server/src/mesh.ts:118`). The operator's local
admin token keeps working on the puller's own routes, UNCHANGED.

Rejected — a second secret for the metrics plane now: a new secret plane for
a two-operator fleet, with its own rotation and config surface, and the #55
upgrade (`docs/architecture/fleet-service.md:54-58`) moves BOTH secrets to
per-instance ed25519 anyway. This doc names that upgrade and builds nothing
for it. Rejected — the anonymous scope: `GET /api/metrics/remote` is a
cross-machine read of a foreign machine's store, not a local dashboard
read. The anonymous exception of the local route is the wrong posture for a
peer surface.

Open: the owner may still choose the second secret (Open question 1). The
LOCKED statement is the scope posture, not the secret choice.

## D5 — Logs stay local (LOCKED)

**LOCKED.** The verified answer to "federate the logs" is no. Raw logs stay
local. Raw log content and raw `metrics-raw` lines never cross the mesh.

Why, stated against the locks:

- The mesh snapshot is COARSE by construction. It never carries payloads
  (`docs/architecture/mesh.md:81-84`, `docs/architecture/mesh.md:185-186`).
  Log lines ARE payloads: prompt content, model output, engine debug text.
  A log federation plane is a payload plane, not a snapshot plane.
- Peer data is EPHEMERAL (`docs/architecture/mesh.md:57-60`). A raw
  cross-machine log store is persisted remote truth on disk. It creates
  exactly the stale-remote-truth artifact the D1 lock prevents.
- Federation moves snapshots, never decisions
  (`docs/architecture/mesh.md:35-36`). Log lines are neither snapshots nor
  display projections. They are the raw record.

What the operator CAN see cross-machine instead — the sanctioned #51
pattern: each machine keeps its own store as ground truth, and the
dashboard PULLS AGGREGATES on demand (D2, D3):

- The coarse snapshot: presence, per-engine idle, queue depth, session and
  lease counts (UNCHANGED and REUSED).
- On-demand aggregates from the peer's retention store: engine request rate
  and token throughput (with `requests_source` honesty — a feed-delta engine
  shows a token gap, never a fake zero,
  `server/src/metrics.ts:64-76`), lease outcomes (project, status, tokens),
  session series (per-model rpm), idle hours.
- Model and quant identity: the model name (the quant suffix rides the
  name), per engine, through the channels D1 names.

What the operator CANNOT see cross-machine: raw log lines, log file
content, job payloads, titles, ids beyond the aggregate key, and engine
tokens (write-only, `docs/architecture/aggregate-endpoint.md:114-118`).
Raw log streaming is a separate, larger decision doc. It re-derives the
transport, retention, and privacy clauses from zero. This plane carries
aggregates only.

## D6 — The dashboard surface: one expand on a machine row

**LOCKED, shape.** The Machines view renders the peer rows
(`dashboard/src/views/Machines.tsx:30-125`, the `PeerCard` at
`dashboard/src/views/Machines.tsx:61-125`). Each row gains one read-only
expand. It pulls that peer's engine series (and the session series if the
owner allows it, Open question 2) through the local arbiter (D3) and renders
model names plus req/hr and tokens/hr sparklines. It reuses the #52/#57 Usage
sparkline vocabulary. The response mirrors the local `/api/metrics` shape
(D2), so the sparkline code serves local and remote points with one
renderer. The expand is ADD-only on the page. No new tab. No new page. The
coarse rows render exactly as today when nothing is expanded.

## D7 — "Advertise the containers" means declared rows, not auto-discovery

**LOCKED, boundary.** Presence already crosses at the coarse level: the
live probe shows urza publishing its `llama-swap` row on the snapshot
(grill report). Engine rows stay operator-declared: the `/api/servers` route
plus the config seed. This plane adds no docker-socket read and no port
scan. A grep for `docker`, `portScan`, and `scanPort` across all three
packages returns zero hits (verified 2026-10-09). Auto-discovery (minting a
row from a container) touches the #52 exporter co-location and the
fail-closed detector rule (a row with no detector is fail-closed for grants,
`docs/architecture/mesh.md:11-14`). It is a separate grilling issue.

## Wire keys a build wave would add (naming only, absent = unset)

This doc names the keys. It does not build them. ADD-key posture throughout:
absent means unset. Existing wire shapes keep every field byte-for-byte.

1. `GET /api/metrics/remote` response body (a new route, so a new shape,
   mirroring the local route's fields):
   - `series: [{ key, points }]` — same as `server/src/api.ts:1160-1163`.
   - `truncated: boolean` — same as `server/src/api.ts:1146-1162`.
   - `peer: string` — the peer's `instance_id` (ADD).
   - `pulled_at: number` — the puller's clock at fetch time, epoch-ms (ADD).
   - `stale: boolean` — true when the answer came from the puller's cache
     rather than a live fetch (ADD).
2. `PeerView` (`server/src/mesh.ts:62-75`): `metrics_cache?: {...}` — one
   ephemeral entry per (peer url, series, key, bucket, from, to), in memory
   only (ADD). Absent until the first pull. Dropped on fetch failure. Never
   written to `state.json`.
3. `server/src/config.ts` DEFAULTS: `mesh_metrics_cache_s` — the pull cache
   TTL in seconds, default 60, `0` = pull live every time (ADD, the
   `metrics_raw_window_hours` pattern at `server/src/config.ts:45`).
4. `MeshSnapshot`, `sanitizeSnapshot`, and the local `GET /api/metrics`
   response: NO new keys. UNCHANGED.

## Rules (restated crisp)

1. The snapshot stays coarse and byte-for-byte. Detail crosses only on a
   read-time pull.
2. One new route: `GET /api/metrics/remote`, peer-token only, the local
   route's param contract and cap.
3. The puller's arbiter fetches on demand, caches 60 s in memory, and never
   persists a remote line.
4. The fleet `peer_token` is the only key that opens the remote route. The
   #55 ed25519 upgrade is named, not built.
5. Raw logs stay local. Cross-machine history is aggregates only, the #51
   pattern.
6. Engine rows stay operator-declared. No auto-discovery.

## What changes vs what stays untouched

Changes (the build wave, after the owner settles the Open questions):

- `server/src/api.ts`: the `GET /api/metrics/remote` route plus its
  `onRequest` hook scope (peer-token only).
- `server/src/mesh.ts` (or a sibling module): the on-demand pull with the
  ephemeral TTL cache. The `PeerView` ADD key.
- `server/src/config.ts`: `mesh_metrics_cache_s`.
- `dashboard/src/views/Machines.tsx`: the peer-row expand and its sparkline
  rendering.

Untouched (fenced):

- `MeshSnapshot` and `sanitizeSnapshot` (shape and caps, byte-for-byte).
- The `/api/mesh` route and its auth scope.
- The local `GET /api/metrics` route, its anonymous scope, and the store
  itself (files, retention knobs, rollup, reader).
- Peer snapshots never enter `state.json` (`server/src/arbiter.ts:2488-2500`).
- The lease/gate/session core. The catalog and alias planes. The fleet
  service. The client wire.
- Tokens stay write-only. No read surface in this plane carries a token.

## Open questions (owner input)

1. Does the detail pull ride the existing fleet `peer_token` (D4 default), or
   does the owner want a second secret for the metrics plane now?
2. Which series cross on demand: engine only, or engine plus lease plus
   session?
3. Is the 48-hour raw window enough for a cross-machine view, or is the
   400-day hour horizon the only cross-mesh range?
4. Does an offline peer render its last-pulled aggregate (labeled stale via
   the `stale` ADD key), or nothing?
5. The session series carries a `token` field (a derived key, often a model
   name, `server/src/metrics.ts:94-100`). Is that fine to cross, or does the
   owner want the session series excluded from the remote route by default?
6. Is the 60-second pull cache TTL (`mesh_metrics_cache_s`) the right default?

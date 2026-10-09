# Grill report — issue #79: cross-mesh telemetry, remote view

Grilling, 2026-10-09, main HEAD 75e14f7. Companion: docs/architecture/mesh-telemetry.md (LOCKED in shape, PROPOSED to the owner). No source file changed by this grill.

## Framing check

The brief describes a push shape: a second instance POSTs its metrics to a fleet hub,
and the hub merges them with its own and serves a merged view with per-source
attribution. The LOCKED constraints reject that shape: mesh.md (LOCKED, #50) has no
hub, and state is published, never computed remotely. metrics-history.md (LOCKED,
#51) keeps the store per arbiter and aggregates per-machine stores at read time.
Peer data is EPHEMERAL (mesh.md D1), so a hub merge on disk is the stale remote
truth the rule prevents.
Ruling: the push-to-hub shape is REJECTED. The surviving form is a read-time pull:
the puller's arbiter fetches the peer's store on demand and renders the answer.
Blocking: the owner must accept the pull form, or order a re-grill that amends
mesh.md D1. That ruling gates every decision below.

## Endpoint contract

One new route: GET /api/metrics/remote (named, not built). It mirrors GET /api/metrics:
- Params: series (engine, lease, session), key, from/to (epoch-ms, default last 7
  days), bucket (hour, raw). Bad params answer 400.
- A 2,000-point cap trims the oldest and sets truncated: true. The raw window clamps
  per the peer's own retention (default 48h).
- Auth: the fleet peer_token only. Not anonymous, not a local admin token. A wrong
  token is 401. Same secret and tailnet-only reach as /api/mesh. The #55 per-instance
  ed25519 upgrade is named, not built.
- Body: { series: [{ key, points }], truncated } plus ADD keys: peer (the peer's
  instance_id), pulled_at (the fetch clock), stale (true from the puller's cache).

## Merge rules

No merge on disk. Each machine keeps its own store as ground truth. The puller's
arbiter fetches on demand (the operator expands a machine row) and holds the answer
in an ephemeral cache (default 60s, config mesh_metrics_cache_s, in-memory only).
The cache never touches state.json and never enters the puller's store. The peer key
labels every answer with the instance that owns the data.

## Conflict rule (two sources, the same key)

Two machines can advertise the same engine key. The rule: attribution, not
resolution. Both series are served separately, each labeled by its peer key. No
winner, no dedup, no cross-peer sum on the wire. A fleet total (a sum of req/hr,
for example) is a read-time projection in the puller, labeled with its source
peers, and it never feeds routing, the store, or a decision (mesh.md: federation
moves snapshots, never decisions). Key identity is the store key as the peer's
arbiter names it. The puller does not rename or map keys across machines.

## Trust boundary (what a remote source may and may not claim)

May claim: its own series points under its own keys. Its instance_id. Its coarse
snapshot (presence, idle, queue depth, session and lease counts), already on
/api/mesh and unchanged.
May not claim: catalog or model lists (models are a local plane, D1). Tokens or
credentials (write-only, #63; no read surface carries one). Raw log lines or
payloads (logs stay local, D5, LOCKED). Decisions (routing, leases, gates are
computed locally only). Writes on the puller (this plane is read-only). Hub status
(there is no hub).
The puller treats the response as untrusted input: hard caps (the 2,000-point cap,
the MAX_NAME 64 pattern), numeric range checks. Garbage lines are dropped. A bad
response is a render gap, not a crash and not a poisoned cache.

## Failure mode (the remote is unreachable)

A failed fetch (timeout, 5xx, tailnet drop, 401 after rotation) drops the cache
line. The row then renders offline under the existing PEER_STALE_MS rule (90s).
No data, no fake zeros. The coarse plane is unaffected: the 15s tick keeps pulling
the snapshot, and the puller's own metrics continue. Default: drop-and-offline;
the owner may allow the last successful answer, labeled stale (open decision 5).

## OPEN DECISIONS

1. Accept the pull form, or re-grill the push-to-hub shape with a mesh.md amendment? (blocking)
2. Does the pull ride the fleet peer_token, or a second secret for the metrics plane?
3. Which series cross on demand: engine only, or engine plus lease plus session?
4. Is the 48h raw window enough, or is the 400-day hour horizon the only range?
5. Does an offline peer render its last-pulled aggregate, labeled stale, or nothing?
6. Does the session series token field (often a model name) cross, or is the session series excluded?
7. Is the 60s pull cache TTL the right default?

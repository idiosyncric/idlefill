# Grill report — issue #79: cross-mesh telemetry, remote view

Grilling, 2026-10-09, main HEAD 75e14f7. Companion: docs/architecture/mesh-telemetry.md (LOCKED — owner settled every open decision 2026-10-09; build wave filed as issue #86). No source file changed by this grill.

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

## OPEN DECISIONS — resolved by the owner, 2026-10-09 (issue #79 final round)

1. Pull form ACCEPTED. Push-to-hub stays rejected by the mesh.md/#51 locks.
2. The pull rides the fleet peer_token. No second secret.
3. Engine, lease and session all cross on demand.
4. The range mirrors the local clamp: 48h raw window, 400-day hour horizon, 7-day default.
5. An offline peer renders nothing; stale labels a TTL cache hit only.
6. The session series crosses, token field included: a derived key, not a credential.
7. TTL default 60s (mesh_metrics_cache_s, 0 disables).

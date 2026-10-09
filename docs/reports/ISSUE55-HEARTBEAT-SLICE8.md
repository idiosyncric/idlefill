# Issue #55 slice 8 — the fleet heartbeat on the federation tick

**Scope:** the arbiter publishes its own live urls and coarse presence to the
fleet service. Nothing else. Pairing, rotation, and deployment stay open.

## The gap

`server/src/fleet-client.ts` already had a working `heartbeatOnce(urls, presence)`.
Its own header called heartbeats a "named TODO". No arbiter code ever called it.
A fleet roster row therefore carried an instance that enrolled but never
reported where it was reachable.

## What shipped

- `MeshFederation.sendHeartbeat(now)` in `server/src/mesh.ts`. It rides the
  existing poll tick in `server/src/index.ts`. No second network loop.
- The gate is an interval, not a per-poll call. At a 15 s poll and a 60 s
  cadence, four polls inside the window send nothing.
- `buildHeartbeatSender(cfg, identity)` builds the production sender. It
  enrolls once, reusing the sibling `fleet_enrollment.json` that the roster
  pull already writes. `ensureEnrolled` is idempotent, so the one-time token
  is spent exactly once across roster and heartbeat.
- Each heartbeat signs a fresh nonce with the #55 D1 ed25519 key. No shared
  fleet secret exists.

## New config keys

- `fleet_heartbeat_ms`, PROPOSED, default 60000. The D3 draft picked 60 s.
- `fleet_own_urls`, an array. The operator declares where this arbiter is
  reachable. Absent means the heartbeat publishes an empty `urls[]`.

Heartbeats require all three of `fleet_url`, `fleet_instance_id`, and
`fleet_enrollment_token`. Any one absent means no heartbeat, and the behavior
is byte-for-byte what it was before this slice.

## Failure posture

A failed heartbeat never throws and never touches the peer map. The interval
gate still advances on failure, so a downed fleet is retried on the next
interval rather than every poll.

## The bug the live proof exposed

`buildRosterFetcher` and `buildHeartbeatSender` each construct their own
`FleetClient` over the same `fleet_enrollment.json`. The roster pull runs
first and spends the single-use token. The heartbeat client was built before
that file existed, so its in-memory session stayed null. `ensureEnrolled`
then tried to enroll again, the service answered `token_used`, and the
heartbeat silently never happened.

The fix: `ensureEnrolled` re-reads the persisted credential before spending
the token. A test now covers it: the pull enrolls once, the heartbeat sender
sends without a second enroll.

## Tests

Seven cases in `server/test/mesh.test.ts`:

1. Missing fleet keys produce no heartbeat attempt and no enrollment file.
2. One heartbeat per interval, not one per poll.
3. A throwing transport is swallowed; the peer set stands byte-for-byte.
4. The urls sent are `fleet_own_urls`, not the inbound `mesh_peers`.
5. Absent `fleet_own_urls` publishes an empty array.
6. The production sender enrolls once and posts a real signed heartbeat to the
   stub fleet over real HTTP with real crypto.
7. The pull and the heartbeat sender share one enrollment file: the pull
   enrolls, the sender sends without a second enroll.

## Live proof

`scripts/issue55-heartbeat-live.mts` starts the real fleet entry on a loopback
port and the real arbiter entry as a child process, with its own poll tick
running. Cadence forced to 2000 ms so a beat lands inside the run. Result:

```
fleet DB rows after the arbiter tick:
[{ "instance_id": "m-64233d4c7ef15d52",
   "name": "home-arbiter",
   "urls": ["http://100.64.0.9:8787"],
   "presence": "online",
   "last_seen": 1791557933369 }]
single-use nonces consumed: 9
VERDICT: PASS — the roster row carries urls, presence, and last_seen
```

## What the operator must still do

Set `fleet_own_urls` to the arbiter's tailnet address. Without it the roster
row enrolls but stays unreachable.

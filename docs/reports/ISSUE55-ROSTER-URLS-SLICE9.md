# #55 slice 9 — roster urls make a peer pullable without `mesh_peers`

D3 in `docs/architecture/fleet-service.md`: when `fleet_url` is set, the
arbiter's `mesh_peers` config becomes OPTIONAL. This slice makes that true.

## What changed (`server/src/mesh.ts`, `pullRoster`)

- A roster row carrying at least one http(s) url becomes a peer. The refresh
  fetches that url's `/api/mesh` exactly like a configured peer.
- **Peer identity is the instance, not the url.** Slice 5 merged rows ADD-only,
  so a moved tailnet address left a dead peer forever. Now the row's url set is
  reconciled against that instance's roster-origin peers: a url the roster no
  longer reports is dropped, a newly reported url is added. One instance, one
  live url set.
- A url already held by another peer is never re-pointed. The first claim wins.
- An explicit `mesh_peers` entry still wins. Origin is judged by
  `rosterOrigin !== true`, never by the observed id, so a configured peer is
  never reconciled away by its own roster row.
- A row with no usable url adds nothing; `sanitizeRoster` already drops it, so
  those rows behave byte-for-byte as before.
- Self-exclusion: the roster returns EVERY instance, including this one. A row
  carrying this instance's ed25519 public key is skipped. `server/src/index.ts`
  wires `localPublicKey` from `arbiter.identity()`; absent = no detection.

No new config keys. No wire changes.

## Tests

`cd .wt/55i && NODE_ENV=test npm run test` → server 404/404 (398 shipped + 6
new), client 177, fleet 17, shell 2, ui 3, web 4, **0 fail**. `tsc --noEmit -p
server/tsconfig.json` exit 0.

New cases: no `fleet_url` = no roster touch; a row with urls enables the plane
with no `mesh_peers` and the refresh fetches it; empty/junk urls add nothing; a
configured entry beats a roster row; a moved `instance_id` url updates rather
than duplicates; two urls for one instance both land and a cross-claimed url is
not re-pointed; a pull returning no rows does not clear the set; the row with
this instance's key is skipped.

## Live proof (`scripts/issue55-roster-urls-live.mts`)

Real fleet service in-process on :8901, a real HTTP peer stub on :8902, and the
real `server/src/index.ts` entry as a child on :8900 with `fleet_url` +
`fleet_enrollment_token` and **no `mesh_peers` at all**. Both instances enroll
and heartbeat. The service roster:

```json
{"instances":[
  {"instance_id":"m-00ccc2e0388cd5a2","name":"home-arbiter","urls":["http://127.0.0.1:8900"]},
  {"instance_id":"m-ef737e3d078f1f8b","name":"laptop arbiter","urls":["http://127.0.0.1:8902"]}]}
```

`GET /api/state` on that entry:

```json
{"instance_id":"m-b6c6472ebf17","peers":[
  {"url":"http://127.0.0.1:8902","name":"laptop arbiter","instance_id":"m-laptop",
   "online":true,"fetch_age_s":0,
   "snapshot":{"instance_id":"m-laptop","queue_depth":3,"sessions":2,"active_leases":1}}]}
```

PASS: the peer came from the roster alone and the self row was skipped. Service
and stub closed; nothing on :8787 touched.

**Gotcha the proof caught:** `identityFileOf()` replaces the basename with
`identity.json`, so two instances seeded from one directory share one keypair.
Give each instance its own directory.

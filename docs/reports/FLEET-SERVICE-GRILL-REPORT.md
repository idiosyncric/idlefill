# GRILL REPORT — fleet service: identity, roster, pairing — all seven decisions locked

**Doc:** `docs/architecture/fleet-service.md` (updated. It was
all-PROPOSED). D1-D7 in the mesh.md format. D1, D2, D5, D6, D7 were
LOCKED at grill time with the trade-off that decided each; D3 and D4
stayed PROPOSED with the owner's choices named precisely — both closed
by the owner on 2026-10-09 (Decisions below). No src, config, or test
file touched at grill time. Type: wayfinder:grilling. Source: Forgejo
issue #55. Citations re-verified against HEAD `65767fa` on 2026-10-09.

## What landed

- Every PROPOSED decision in the original draft was grilled against the
  code read on disk at HEAD `65767fa`.
- New section "What breaks today when a tailnet address changes". It
  names the config key `mesh_peers` and the exact code path: the peer
  map is built once at construction, keyed by URL. A moved address is
  never discovered. The observed `instance_id` records identity per URL
  but has no path back to a current URL.
- New section "Enrollment and pairing wire contract" at the level a
  build wave could implement: endpoints, payloads, what each side
  stores. The wire keys are ADD-keys. Absent means unset.
- New section "Service down": seven behaviours that must survive the
  service being unreachable, each cited against `docs/architecture/mesh.md`.
- D1, D2, D5, D6, D7 LOCKED. D3, D4 stay PROPOSED. The alternatives are
  kept in the doc. A grill that pre-locks everything skips the owner's
  role.

## Verified citations (HEAD 65767fa)

- `mesh_peers` config key, shape `{ url, name }[]`:
  `server/src/types.ts:57`.
- Config defaulting for `mesh_peers` and `peer_token`:
  `server/src/config.ts:87-99`. `poll_ms` default 15000:
  `server/src/config.ts:35`.
- Peer map built once at construction, keyed by URL:
  `server/src/mesh.ts:97-103`.
- Tick pulls `${p.url}/api/mesh` per peer: `server/src/mesh.ts:116-137`.
  Production caller: `server/src/index.ts:272`.
- Shared `peer_token` auth header: `server/src/mesh.ts:118`.
  `isPeerToken` scoped to `GET /api/mesh`: `server/src/api.ts:55-59`.
- `PEER_STALE_MS = 90_000`: `server/src/mesh.ts:25`. Offline render at
  `server/src/mesh.ts:145`.
- Observed `instance_id` per URL: `server/src/mesh.ts:67`,
  `server/src/mesh.ts:129`.
- `instance_id` mint + persist: `server/src/arbiter.ts:2512-2517`.
- Atomic state write (tmp + rename, mode 0600):
  `server/src/state.ts:134-140`.
- #39's "secret rides every atomic save" concern:
  `docs/reports/ISSUE39-RESCOPE.md:53-57`.
- mesh.md lines cited in the doc: 27-32 (grants fail closed per
  engine), 35-36 (state published, never computed remotely), 38-47
  (D1 no hub), 49-52 (peer registry is config), 53-56 (fetch failure
  posture), 57-60 (snapshots ephemeral), 65-67 (merged view rides
  `/api/state`), 76 (peer_token scope), 88-89 (tailnet IPs move, the id
  is the identity).

## Live verification (actual output, 2026-10-09, node v26.10.0)

- ed25519 probe (`node:crypto` `generateKeyPairSync('ed25519')`):
  public key exports to 44 DER bytes (59 chars base64url). Private key
  exports to 48 DER bytes (64 chars base64url). Signature is 64 bytes.
  Verify round-trip returns true. This confirms the draft's D1 size
  claim verbatim.
- No live fleet probe: the fleet service does not exist. Nothing is
  built. The mesh read plane was live-probed in the #79 grill report
  (2026-10-09).

## Corrections and notes

1. The sibling doc `docs/architecture/mesh-telemetry.md` (merged
   2026-10-08, citations verified at HEAD `4369a37`) cites the
   `/api/mesh` route as `server/src/api.ts:1076-1095`. At HEAD
   `65767fa` the route sits at `server/src/api.ts:1143`. The #78 merge
   shifted line numbers. This doc cites `server/src/api.ts:55-59`
   (`isPeerToken`) and does not cite the route line, so no stale
   citation lands here. The substance (the route exists, peer-token
   scoped) is unchanged.
2. The draft's "What changes in idlefill when this lands" item 3 says
   the mesh fetch presents a signed request and the peer verifies
   against its own roster. Under the `Service down` lock, the signed
   request must fall back to the shared `peer_token` when the roster is
   unavailable. The doc states this in the Service down section (item
   5). No contradiction. The fallback keeps the read plane alive.

## Decisions (locked vs proposed)

LOCKED (the trade-off decided it):

- D1: per-instance ed25519 keypair, private key in `identity.json`
  (0600, atomic write), never in `state.json`. Decided by: #39 needs a
  per-instance secret to pair against, and the state file is the wrong
  home for a secret.
- D2: one-time enrollment token, client-generated keys. Decided by:
  the private key never transits the network, and the token is
  single-use with a 15 min TTL.
- D5: machine identity only, `fleet_id` seam recorded, no human login.
  Decided by: the SaaS phase is not real, and the standing rule is
  single operator until it is.
- D6: SQLite. Decided by: the service's whole job is relational
  lookups, and SQLite is a file, not a database server.
- D7: container on urza, `fleet.samwarth.com` behind
  `middleware-local-ip-range`, no published ports, tailnet-only reach.
  Decided by: urza already hosts the ingress and the LE cert.

PROPOSED at grill time, LOCKED by the owner 2026-10-09 (issue #55, each
recommendation accepted):

- D3: heartbeat cadence — 60 s (`fleet_heartbeat_ms`, shipped default).
  Control-action staleness ceiling — 24 h (`CONTROL_STALE_MS`, shipped).
  Roster pull cadence on the arbiter side — 15 s, the poll tick
  (`fleet_roster_pull_ms`, shipped default).
- D4: pairing shape — (b), the one-time code (the same owner lock that
  settled pairing.md, `0d2f07f`; built `0762372` + `7b80621`). Edge
  directionality — directional (unpair deletes exactly one direction).

Carried over (open questions 1-5 of the original draft — still open,
operational, not decision-gated):

1. Who can mint an enrollment token.
2. Key rotation: automatic or operator-triggered.
3. Replay window for signed requests (measure the tailnet clock skew
   first).
4. Does the service hold the update channel.
5. Name of the thing (`fleetlink` is a placeholder).

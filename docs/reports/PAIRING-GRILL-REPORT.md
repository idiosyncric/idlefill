# PAIRING GRILL REPORT — #39: cross-instance pairing ceremony + cross-client queue visibility

Map: #39 (the pairing + control gap) · #50 (the locked mesh topology — the
inherited constraint) · #38 (topology) · #55 (the fleet service — the
named upgrade path, now LOCKED at the substrate, commit `a59f700`, merge
`60d7d6b`) · #16 (the desktop app, the ceremony's surface) · Type:
wayfinder:grilling

Citation header: the original grill was read from branch `issue-39` pinned
at main HEAD `f7d0a74`. The 2026-10-09 reconciliation (below) is re-verified
at HEAD `60d7d6b`.

## What landed

The decision doc is `docs/architecture/pairing.md` — D1..D8 in the
mesh.md format (chosen option + rejected alternatives + deciding trade-off
per decision), the inherited-clause block, the single extended clause, a
crisp "what changes vs what stays untouched" section, the wire-key
posture, a dependency-order section, and the owner questions. No code,
config, or test file touched. This report and the README index line are
the only companions to the doc.

## Reconciliation with #55 (2026-10-09, HEAD 60d7d6b)

When this doc was written, #55 was open and its substrate was unbuilt, so
D1 proposed a self-contained manual one-time pairing code. #55 has now
LOCKED its substrate: per-instance ed25519 keypair in `identity.json` (D1),
one-time enrollment token (D2), and it records that #55 blocks #39's
pairing ceremony (its Sequencing section). This reconciliation updates
`pairing.md` against that locked substrate.

- **D1 is now LOCKED.** The manual shared 256-bit code is REJECTED. The
  per-edge credential is asymmetric: each instance signs its requests with
  its ed25519 private key (#55 D1); the target verifies the requester's
  signature against the public key stored in the edge record for that
  `instance_id` (the locally-cached roster key — the last-known-keys
  posture). The trade-off that decided it: reusing #55's locked keypair
  keeps exactly one identity substrate and one revocation story and cannot
  contradict #55; a shared secret would ship a second parallel identity
  plane and contradict #55's locked D1. The cost is that the #39 relay now
  needs #55 D1 (the local keypair) before it builds. That gate is small,
  not the full fleet service.
- **The edge-formation ceremony is #55 D4's.** The service-mediated
  one-time code (shape (b), directional edges) is the recommended form.
  `pairing.md` inherits #55 D4's shape and direction choices; it does not
  re-open them. `pairing.md` D5 (initiator = controller) aligns with #55
  D4's directional recommendation.
- **D2 edge record field changed.** The edge record now carries the peer's
  PUBLIC key (`peer_public_key`), not a shared `secret`. `mesh_edges.json`
  stays (sibling, 0600, atomic tmp+rename) and sits in the same
  "identity.json family" #55 D1 names. `identity.json` holds this
  instance's private key; `mesh_edges.json` holds the edges (peer public
  keys + direction). Not redundant.
- **`pairing.md`'s owned routes are now the relay.** `GET /api/mesh/detail`,
  `POST /api/mesh/control`, `POST /api/mesh/unpair` (immediate local
  denial). The old manual-code `pair`/`accept` routes are superseded by
  #55 D4's ceremony.
- **Dependency order added to `pairing.md`.** Wave 0: the mesh read plane
  (#50, built). Wave 1: #55 D1 (the keypair). Wave 2: #55 D4 (the edge
  ceremony). Wave 3: the #39 relay. The #55 fleet service ships
  independently and is not a gate for the relay.
- **Owner questions reduced from five to three.** Former Q1 (substrate) is
  closed by D1. Former Q4 (ceremony surface) is #55 D4's and is inherited.
  Remaining: the `detail` field set, the `reorder` wire shape, and edge
  lifetime vs key rotation (each with a recommended answer below).

Citation note (re-verified at HEAD `60d7d6b`): `instanceId` is at
`server/src/arbiter.ts:2512-2517`; `revokeClientKey` at
`server/src/arbiter.ts:2481`; the atomic state write (tmp + rename, mode
0600) at `server/src/state.ts:134-140`; `mintInstanceId` at
`server/src/mesh.ts:227`. #55's D1 is at `docs/architecture/fleet-service.md:110-136`,
D2 at `fleet-service.md:138-161`, D4 at `fleet-service.md:192-219`, and its
Sequencing at `fleet-service.md:555-563`.

## Replaces from mesh.md, stated as amendments

- ADD-key only: every wire change is additive. Three new owned routes
  (`unpair`, `detail`, `control`), one new file (`mesh_edges.json`), one
  event record ADD-key field (`source_instance_id`) plus one new event kind
  (`mesh_control`). Nothing renames an existing route, and `/api/state`
  gains no keys. The edge-formation ceremony is #55 D4's, not this doc's.
- LOCKED rules that stay byte-for-byte (re-affirmed in the fence):
  `GET /api/mesh` and its coarse response shape (D2 of mesh.md), the
  `peer_token` scope check (D2 of mesh.md), the anonymous reads of
  `/api/state` and `/api/metrics`, `instance_id` minting and persistence,
  the override routes, the client loopback proxy.
- The single SUPERSEDED clause: mesh.md D2's third plane — "Mesh control
  = per-edge secret from the #39 pairing ceremony (full peer visibility
  + relayed control actions, #39 builds this)." This doc fills in that
  deferred plane. It extends one clause and supersedes none. The read
  plane and the local admin plane are re-affirmed unchanged.

## Verified against the code

- The `peer_token` check is `isPeerToken`
  (`server/src/api.ts:55-59`) and the auth hook applies it on
  `GET /api/mesh` ONLY. A wrong token on any other `/api/*` path is a 401.
  The anonymous reads are `/api/state` and `/api/metrics`.
- `instance_id` is minted at first boot as `m-<hex>` and persisted in the
  state file (`server/src/arbiter.ts:2512-2517`,
  `mintInstanceId` at `server/src/mesh.ts:227`).
- The read plane is built and coarse: `GET /api/mesh` answers with
  `buildMeshSnapshot`. `MeshSnapshot` carries `instance_id`, `name`, `ts`,
  `version`, per-engine coarse signal, `queue_depth` (a number),
  `sessions`, `active_leases`. `sanitizeSnapshot` caps every remote field.
  `PEER_STALE_MS` is 90 s (`server/src/mesh.ts:25`).
- Queue DETAIL today is `queue_preview` rows: `job_id`, `title`,
  `company`, `score`, `attempts` (`server/src/types.ts`), sanitized to a
  100-row cap and no payloads (`cleanPreview`). This is exactly the
  projection the doc's D3 detail route reuses.
- The override routes the brief names as the precedent exist with that
  shape, backed by `setClientOverride` and `setSessionOverride`.
- The event log row today is `{ ts, kind, project?, lease_id?, detail? }`
  (`server/src/types.ts`). The doc's `source_instance_id` is an ADD-key
  field on that row.
- The revocation precedent is `revokeClientKey`
  (`server/src/arbiter.ts:2481`): immediate local row deletion plus an
  event log entry, no remote propagation.
- `registerClient` is idempotent by name (the observed IP wins, the row
  is reused).
- The client proxy binds 127.0.0.1 only (`client/src/proxy.ts:18`) — the
  "no new inbound port on client machines" acceptance holds by
  construction. The new routes live on the arbiter.
- The mesh config keys are `mesh_peers` (line 57), `peer_token` (line 63),
  and `mesh_name` (line 65) (`server/src/types.ts`).
- The ed25519 substrate is NOT yet built in `server/src`: a search for
  `ed25519` / `identity.json` / `generateKeyPair` matches only docs and
  scripts. #55 D1 is locked but unbuilt.

## Absence greps (both packages)

- Zero hits for a queue-reorder primitive: `reorder` matches only
  `reorderAliases` (the model-alias plane). The doc's D4 `reorder` control
  action is NEW code, not a reuse. This is a build item.
- Zero hits for any pairing, per-edge, or mesh-control route: no
  `mesh/pair`, `mesh/accept`, `mesh/unpair`, `mesh/detail`, or
  `mesh/control` route exists today. The per-edge credential has no
  storage yet. `mesh_edges.json` is NEW.

## Corrections to the brief

None. Every code claim in the issue body re-verified at the pinned HEADs.
One note for the record: the issue's comment (2026-10-04) says #55 "blocks
this issue's pairing slice" and names the one-time-code ceremony plus
per-instance ed25519. This doc settles the ceremony against that substrate
and defers the ed25519 substrate to #55 by name. As of the 2026-10-09
reconciliation, #55's substrate is LOCKED and the shared-code proposal is
REJECTED (D1). The owner confirms the split below.

## Live-verification note

No live probe ran: the acceptance criteria for the PAIRING slice
(two paired machines, relayed control, unpair denial) name behavior that
does not exist yet. The read-plane half (zero pairing: presence + queue
depths, no job detail) is already built (commit `71b4e5d`) and is
inherited, not re-verified here. The build wave proves the pairing
acceptance. The ed25519 keypair size was live-probed in the #55 grill
report (2026-10-09, node v26.10.0): public 44 DER / 59 base64url chars,
private 48 DER / 64 base64url, signature 64 bytes.

## Decision digest

- D1 handshake (LOCKED, reconciled 2026-10-09): the per-edge credential is
  asymmetric. Each instance signs with its ed25519 private key (#55 D1);
  the target verifies against the peer's public key stored in the edge
  record. The manual shared 256-bit code is REJECTED. No hub, no PKI.
  The edge-formation ceremony is #55 D4's (shape (b) one-time code,
  directional edges, recommended).
- D2 (LOCKED): the credential lives in `mesh_edges.json` (mode 0600, sibling
  of the state file), never in `state.json`. The edge record carries the
  peer's PUBLIC key, not a shared secret. Persistent across restarts.
  Sits in the same "identity.json family" as #55's `identity.json`.
- D3 (LOCKED): paired read is a separate `GET /api/mesh/detail` route on
  the per-edge credential. It carries the target's local queue detail
  (queue_preview rows), payload-free, target-local, no transitivity.
- D4 (LOCKED): paired control is `POST /api/mesh/control` on the
  per-edge credential. Actions: `pause`, `resume`, `force`, `clear`,
  `reorder`. The TARGET applies the action to its OWN rows. No lease
  grants cross. No destructive actions.
- D5 (LOCKED): pairing is directed. The initiator is the controller.
  `controls_me` is stored per side, read from the local perspective.
  Aligns with #55 D4's directional recommendation.
- D6 (LOCKED): unpairing deletes the edge on the controlled side. The
  next action is denied immediately (403, no edge match). Rotation =
  unpair plus re-pair. Precedent: `revokeClientKey`.
- D7 (LOCKED): audit is the TARGET's event log. New kind
  `mesh_control`, ADD-key `source_instance_id`.
- D8 (LOCKED): no pairing = fail-closed. The coarse read plane only.
  Detail and control both require the per-edge credential.

## Open questions (owner input)

The substrate question (former Q1) is closed by D1, and the ceremony
surface (former Q4) is #55 D4's and is inherited. Three questions remain,
each with a recommended answer.

1. Exact field set of `GET /api/mesh/detail`: queue projection only, or
   plus the target's session rows?
   Recommend: queue projection only. D3 already locks the boundary
   (payload-free, target-local, no transitivity); session rows drag in the
   #41-#48 session surface for no gain this wave.
2. `reorder` wire shape: a full queue order (a job-id list) or a
   promote/demote of one job?
   Recommend: promote/demote of one job. A bounded scheduling action that
   fits the "scheduling posture" blast-radius bound; a full-order rewrite
   is a bigger primitive for the same goal.
3. Edge lifetime and key rotation: permanent until unpaired (the default),
   or an expiry/rotation schedule? And is re-pairing the recovery when a
   peer's keypair rotates (#55)?
   Recommend: permanent until unpaired, operator-triggered key rotation,
   re-pair as the rotation recovery. Matches the single-operator posture
   and #55 D2's wiped-machine recovery.

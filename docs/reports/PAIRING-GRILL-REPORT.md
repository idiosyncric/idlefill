# PAIRING GRILL REPORT — #39: cross-instance pairing ceremony + cross-client queue visibility

Map: #39 (the pairing + control gap) · #50 (the locked mesh topology — the
inherited constraint) · #38 (topology) · #55 (the fleet service — the named
upgrade path, open, not built) · #16 (the desktop app, the ceremony's
surface) · Type: wayfinder:grilling

Citation header: every line number below is read from branch `issue-39`
pinned at main HEAD `f7d0a74`.

## What landed

The decision doc is `docs/architecture/pairing.md` — D1..D8 in the
mesh.md format (chosen option + rejected alternatives + deciding trade-off
per decision), the inherited-clause block, the single extended clause, a
crisp "what changes vs what stays untouched" section, the wire-key
posture, and five open owner questions. No code, config, or test file
touched. This report and the README index line are the only companions to
the doc.

## Replaces from mesh.md, stated as amendments

- ADD-key only: every wire change is additive. Five new routes
  (`pair`, `accept`, `unpair`, `detail`, `control`), one new file
  (`mesh_edges.json`), one event record ADD-key field
  (`source_instance_id`) plus one new event kind (`mesh_control`).
  Nothing renames an existing route, and `/api/state` gains no keys.
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

## Verified against the code (HEAD `f7d0a74`)

- The `peer_token` check is `isPeerToken`
  (`server/src/api.ts:55-59`) and the auth hook applies it on
  `GET /api/mesh` ONLY (`server/src/api.ts:280-308`, the mesh branch at
  line 302). A wrong token on any other `/api/*` path is a 401
  (`api.ts:304-306`). The anonymous reads are `/api/state`
  (`api.ts:290-291`) and `/api/metrics` (`api.ts:297-298`).
- `instance_id` is minted at first boot as `m-<hex>` and persisted in the
  state file (`server/src/arbiter.ts:2488-2500`,
  `mintInstanceId` at `server/src/mesh.ts:227-229`).
- The read plane is built and coarse: `GET /api/mesh`
  (`server/src/api.ts:1076-1094`) answers with `buildMeshSnapshot`.
  `MeshSnapshot` carries `instance_id`, `name`, `ts`, `version`, per-engine
  coarse signal, `queue_depth` (a number), `sessions`, `active_leases`
  (`server/src/mesh.ts:37-59`). `sanitizeSnapshot` caps every remote field
  (`mesh.ts:191-224`). `PEER_STALE_MS` is 90 s (`mesh.ts:25`).
- Queue DETAIL today is `queue_preview` rows: `job_id`, `title`,
  `company`, `score`, `attempts` (`server/src/types.ts:121-128`),
  sanitized to a 100-row cap and no payloads
  (`server/src/api.ts:334-351`, `cleanPreview`). This is exactly the
  projection the doc's D3 detail route reuses.
- The override routes the brief names as the precedent exist with that
  shape: `POST /api/clients/:ref/override` (`server/src/api.ts:480-491`)
  and `POST /api/sessions/:token/override` (`server/src/api.ts:1027-1043`),
  backed by `setClientOverride` (`server/src/arbiter.ts:663`) and
  `setSessionOverride` (`server/src/arbiter.ts:1666`).
- The event log row today is `{ ts, kind, project?, lease_id?, detail? }`
  (`server/src/types.ts:749-755`). The doc's `source_instance_id` is an
  ADD-key field on that row.
- The revocation precedent is `revokeClientKey`
  (`server/src/arbiter.ts:2462-2472`): immediate local row deletion plus an
  event log entry, no remote propagation.
- `registerClient` is idempotent by name (the observed IP wins, the row
  is reused) at `server/src/arbiter.ts:520-576`.
- The client proxy binds 127.0.0.1 only
  (`client/src/proxy.ts:18`) — the "no new inbound port on client
  machines" acceptance holds by construction. The new routes live on the
  arbiter.
- The mesh config keys are `mesh_peers` (line 57), `peer_token` (line 63),
  and `mesh_name` (line 65) (`server/src/types.ts`).

## Absence greps (HEAD `f7d0a74`, both packages)

- Zero hits for a queue-reorder primitive: `reorder` matches only
  `reorderAliases` (the model-alias plane) at
  `server/src/api.ts:915` and `server/src/arbiter.ts:1322-1541`. The
  doc's D4 `reorder` control action is NEW code, not a reuse. This is a
  build item.
- Zero hits for any pairing, per-edge, or mesh-control route: no
  `mesh/pair`, `mesh/accept`, `mesh/unpair`, `mesh/detail`, or
  `mesh/control` route exists today. The per-edge secret has no storage
  yet. `mesh_edges.json` is NEW.

## Corrections to the brief

None. Every code claim in the issue body re-verified at
`f7d0a74`: the override-route shapes, the 100-row sanitized queue
preview, `registerClient` idempotent by name, the loopback-only daemon
proxy, and the three-plane identity model. One note for the record: the
issue's comment (2026-10-04) says #55 "blocks this issue's pairing
slice" and names the one-time-code ceremony plus per-instance ed25519.
This doc settles the ceremony against the code and defers the ed25519
substrate to #55 by name. The owner must confirm that split (open
question 1 in the doc).

## Live-verification note

No live probe ran: the acceptance criteria for the PAIRING slice
(two paired machines, relayed control, unpair denial) name behavior that
does not exist yet. The read-plane half (zero pairing: presence + queue
depths, no job detail) is already built (commit `71b4e5d`) and is
inherited, not re-verified here. The build wave proves the pairing
acceptance.

## Decision digest

- D1 handshake (PROPOSED): a manual one-time pairing code carries the
  initiator's `instance_id` plus the 256-bit per-edge secret. No hub, no
  PKI. The operator is the trusted channel. Ed25519 (#55) is the named
  upgrade path.
- D2 (LOCKED): the secret lives in `mesh_edges.json` (mode 0600, sibling
  of the state file), never in `state.json`. Persistent across restarts.
- D3 (LOCKED): paired read is a separate `GET /api/mesh/detail` route on
  the per-edge secret. It carries the target's local queue detail
  (queue_preview rows), payload-free, target-local, no transitivity.
- D4 (LOCKED): paired control is `POST /api/mesh/control` on the
  per-edge secret. Actions: `pause`, `resume`, `force`, `clear`,
  `reorder`. The TARGET applies the action to its OWN rows. No lease
  grants cross. No destructive actions.
- D5 (LOCKED): pairing is directed. The initiator is the controller.
  `controls_me` is stored per side, read from the local perspective.
- D6 (LOCKED): unpairing deletes the edge on the controlled side. The
  next action is denied immediately (403, no edge match). Rotation =
  unpair plus re-pair. Precedent: `revokeClientKey`.
- D7 (LOCKED): audit is the TARGET's event log. New kind
  `mesh_control`, ADD-key `source_instance_id`.
- D8 (LOCKED): no pairing = fail-closed. The coarse read plane only.
  Detail and control both require the per-edge secret.

## Open questions (owner input)

1. Shared-secret handshake now (this doc's D1) or gate the pairing slice
   on #55's ed25519 substrate and roster? #55 is open and its comment on
   #39 says it blocks the pairing slice.
2. Exact field set of `GET /api/mesh/detail`: queue projection only, or
   plus the target's session rows?
3. `reorder` wire shape: a full queue order (a job-id list) or a
   promote/demote of one job?
4. Confirm the ceremony surface: the desktop app plus the dashboard,
   with the operator typing the code by hand.
5. Edge lifetime: permanent until unpaired (the doc's default) or an
   expiry or rotation schedule?

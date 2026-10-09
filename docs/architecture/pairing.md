# Pairing ceremony — issue #39 (cross-instance control + cross-client queue visibility)

This doc settles the part of #39 that `docs/architecture/mesh.md` left
deferred: the per-edge credential, the read a paired edge gets beyond the
coarse snapshot, the control a paired edge may relay, and the fail-closed
posture when no pairing exists. The discovery half (presence + queue
depths, zero pairing) is the #50 read plane and is already built
(commit `71b4e5d`). Do not re-litigate it here.

## Inherited from mesh.md (LOCKED, unchanged)

These clauses of `docs/architecture/mesh.md` stay byte-for-byte and are
cited as the inherited constraint, not re-derives:

- **D1 — transport.** Read-through pull, no hub, no gossip, no relay.
  Outbound HTTP, arbiter to arbiter, over the tailnet. Cross-instance
  control rides the same direction: the requesting arbiter POSTs to the
  target arbiter. UNCHANGED and REUSED.
- **D2 — identity (two of three planes).** Local admin = the existing
  `api_tokens`. Mesh read = one shared fleet `peer_token`, read-only,
  scoped to `GET /api/mesh` only. Instance identity = a stable
  `instance_id` minted at first boot and persisted in the state file
  (`server/src/arbiter.ts`, `instanceId`). UNCHANGED and REUSED.
- **D3 — surfaces.** Every arbiter serves the dashboard and `/api/state`.
  The desktop app points at the LOCAL arbiter and never fans out to
  peers. UNCHANGED.
- **D4 — work portability.** Deferred. This doc carries no payloads and
  prejudges nothing. UNCHANGED.
- **D5 — packaging.** One fused process per machine. Authority follows
  the engine. UNCHANGED.

### The single clause this doc extends

**D2 — identity (the third plane, "Mesh control").** mesh.md D2 names
three auth planes and defers the third: "Mesh control = per-edge secret
from the #39 pairing ceremony (full peer visibility + relayed control
actions, #39 builds this)." This doc fills in exactly that deferred
plane. It extends one clause and supersedes none. The read plane and the
local admin plane are re-affirmed unchanged.

## What this doc settles

The read plane already gives two unpaired arbiters presence, per-engine
idle signal, and queue DEPTHS with zero pairing. What it never gives is
queue DETAIL (job ids, titles) and any CONTROL. This doc defines the
pairing that unlocks both, on a per-edge basis, with the privacy still
enforced by endpoint scope.

## D1 — The handshake: ride #55's per-instance ed25519 keypair (LOCKED)

This doc used to propose a manual one-time pairing code. That proposal is
now REJECTED. The substrate it deferred to is now locked.
`docs/architecture/fleet-service.md` (#55) has LOCKED its identity
substrate (D1, `fleet-service.md:110-136`) and records that #55 blocks
this ceremony (its Sequencing section, `fleet-service.md:555-563`). This
doc rides that substrate instead of building a second one.

Locked: **the per-edge credential is asymmetric.** Each instance signs
its requests with its own ed25519 private key (#55 D1, stored in
`identity.json`, mode 0600). The target verifies the requester's
signature against the public key stored in the edge record for that
`instance_id`. The edge record carries the peer's PUBLIC key, not a
shared secret (D2).

The verification source is the edge record's stored public key. It is the
locally-cached copy of the roster key for that `instance_id`. This is the
last-known-keys posture #55 locks for the service-down case
(`fleet-service.md:472-523`). The full fleet service is not required for
this check to work.

Rejected:

1. **A manual one-time 256-bit shared code (this doc's former D1).** It
   is a shared symmetric secret keyed by `instance_id`. #55 D1 has now
   locked the identity substrate as per-instance ed25519 keys and found
   that the shared-secret approach "gives no per-instance identity, so
   there is nothing to pair" (`fleet-service.md:132-134`). A per-edge
   shared secret ships a second, parallel identity plane (a shared secret
   plus `mesh_edges.json`) next to #55's locked keypair and
   `identity.json`. Two identity planes, two revocation stories. It
   contradicts #55's locked D1.
2. **A second shared fleet-wide control token.** The same revocation flaw
   as `peer_token` (rotate it and every machine must change) and no
   per-edge identity. mesh.md D2 already rejected a shared secret for the
   read plane.
3. **TLS/mTLS between arbiters.** It needs a certificate authority,
   per-machine certificates, and renewal. The tailnet is already the
   transport trust boundary.

The trade-off that decided it: #55 has now LOCKED the per-instance
identity substrate (D1) and recorded that #55 blocks this ceremony ("there
is no key substrate until it exists"). Reusing the locked keypair keeps
exactly one identity substrate and one revocation story, and it cannot
contradict #55. A shared secret would keep this doc independent of #55,
but it would ship a parallel identity plane and contradict #55's locked
D1. The cost of the keypair is that this relay can no longer be built
independently of #55 D1. It needs the local per-instance keypair first.
That gate is small: a keypair mint at first boot plus `identity.json`. It
is not the full fleet service.

What this doc still needs from #55 (see the dependency order below):

- #55 D1 (LOCKED): the per-instance ed25519 keypair. The local substrate.
- #55 D4 (PROPOSED, `fleet-service.md:192-219`): the edge-formation
  ceremony. The one-time exchange of the peer's public key plus the edge
  direction. This doc does not re-open #55 D4's shape choice (a)
  request/approve vs (b) one-time code, or its directional vs symmetric
  edge choice. It inherits both. This doc's D5 (directional, the
  initiator is the controller) aligns with #55 D4's directional
  recommendation.

## D2 — Where the credential lives: a sibling edge file, never the state file (LOCKED)

Rejected: (1) Inside `state.json` — the state file is rewritten on every
state change (every lease grant, every heartbeat), so a control
credential in it rides every atomic save, and a state backup or export
would leak control identity. (2) Inside operator config — pairing is
runtime state, not operator config, and config often lives in version
control. (3) An OS keychain — the fused binary runs on Linux too, and the
arbiter has no keychain dependency today.

Locked: **the edge records live in a sibling file, `mesh_edges.json`,
mode 0600, next to `state.json`.** It is never inside `state.json`. It
uses the same atomic-write posture (write to a temp path, rename) as the
state file (`server/src/state.ts:134-140`) and as #55's `identity.json`
(#55 D1). Because it is a small separate file, revoking one edge rewrites
only this file, and the state file stays free of control identity.

This file is in the same "identity.json family" that #55 D1 names: a
sibling, mode 0600, atomic tmp+rename. `identity.json` holds this
instance's OWN private key and enrollment credential (#55).
`mesh_edges.json` holds the EDGES: for each peer, that peer's public key
(`peer_public_key`), the peer name, a `controls_me` flag (D5), and a
create timestamp. The private key never enters `mesh_edges.json`. The two
files are not redundant: one is "my identity," the other is "who may
control me, and whom I control."

The edge file is PERSISTENT. Unlike the ephemeral peer snapshot (which
never touches disk), a pairing must survive a restart.

## D3 — What a paired edge READS beyond the coarse snapshot (LOCKED)

The coarse plane is enforced by endpoint scope, not by a filter. A
paired edge does not loosen `GET /api/mesh`. It gets a separate route
that carries the detail projection, scoped by the per-edge credential.

Rejected: (1) Grant the peer the full `/api/state` — that is the local
surface and it carries the whole machine's state. A peer does not get a
local-admin read. (2) Add a `detail` field to `GET /api/mesh` gated by the
per-edge token — that makes the coarse route filter-gated, which
contradicts the endpoint-scope principle and risks a coarse reader
receiving detail. (3) Reuse `/api/state` with the per-edge token — the
`/api/state` auth hook answers only `api_tokens` or the anonymous read.
Adding the per-edge credential there would make `/api/state` answer to a
peer.

Locked: **a new route `GET /api/mesh/detail`, authenticated by the
per-edge credential, carries the detailed projection.** The detail is
exactly the queue detail a local dashboard reader already sees, bounded
by the same sanitizer:

- The target's LOCAL clients and their queue projections: each client's
  rows and, per project, the `queue_preview` rows (`job_id`, `title`,
  `company`, `score`, `attempts`). The preview is capped at 100 rows and
  carries no payloads (`server/src/api.ts`, `cleanPreview`).
- Whose rows: the TARGET instance's own clients. A paired with B sees B's
  local queue, not B's view of any other peer.
- No transitivity: A sees B's local queue. A never sees C through B.
- No payloads: the detail reuses the `queue_preview` sanitizer. It never
  carries job payloads, engine logs, or inference content.

The trade-off: a second read route is more surface to maintain and audit.
In return the coarse plane stays pure and the per-edge read boundary is
explicit and testable. The detail route is still payload-free, so a
paired peer never sees inference content — only the metadata the local
dashboard shows.

## D4 — What a paired edge CONTROLS (LOCKED)

The acceptance names the scope: after pairing A to B, A can pause,
resume, and reorder work B owns. The override routes are the precedent.

Locked: **a new route `POST /api/mesh/control`, authenticated by the
per-edge credential, relays a control action from the requester to the
target. The TARGET applies the action to its OWN client and session
rows, because it owns them.**

- Actions: `pause`, `resume`, `force`, `clear`, and `reorder`.
  `pause`/`resume`/`force`/`clear` reuse the existing override semantics
  (`setClientOverride`, `setSessionOverride`). `reorder` is a new
  relayed action that reorders the target's queue order.
- The requester never touches the target's state directly. It sends an
  intent and the target applies it. This keeps "each arbiter is the
  single source of truth for its own machine."
- A peer never grants a lease against the target's engine. The
  fail-closed rule holds: only the owning machine's arbiter grants leases
  for its engine, and a reference row carries no detector.
- No destructive actions in this wave: no job deletion, no client
  deregistration, no key revocation. Control is bounded to scheduling
  posture.

The trade-off: `reorder` needs a new arbiter primitive (reorder the queue
order), which is a build item. Bounding control to scheduling posture
keeps the blast radius of a compromised initiator small.

## D5 — Direction: a directed edge, the initiator is the controller (LOCKED)

The per-edge credential is asymmetric: the requester signs, the target
verifies. Direction is a policy on top of that, stored per side.

Locked: **pairing A to B makes A the controller of B. Each edge record
carries a `controls_me` flag, read from the LOCAL side's perspective
("this peer is authorized to control me").** A's record for B has
`controls_me` false. B's record for A has `controls_me` true.

- On the target, a control or detail request is authorized when the
  target's edge record for the requester has `controls_me` true.
- A control or detail request from B to A is denied on A, because A's
  record for B has `controls_me` false.
- If the operator wants the reverse direction, they pair B to A
  explicitly. Pairing is not bidirectional by default.

Rejected: bidirectional-by-default. Pairing A to B also letting B control
A silently widens the blast radius of a compromised initiator. The
operator's intent is "let me manage that machine from here." Explicit
per-direction pairing keeps the capability narrow. This doc's direction
aligns with #55 D4's directional recommendation.

## D6 — Revocation: immediate local deletion on the controlled side (LOCKED)

The acceptance requires unpairing to revoke immediately: the next action
is denied.

Locked: **to unpair, the operator removes the edge record. The
enforcement point is the controlled side. `POST /api/mesh/unpair` on the
target deletes the target's edge record for the controller. The next
control or detail request from the controller presents a signature for
the controller's `instance_id`, the target finds no matching edge, and
returns 403. Denial is immediate, with no propagation delay.**

- The controller also removes its own edge record so its surface shows
  the edge as unpaired.
- Rotation is unpair plus re-pair. A new one-time code is minted (the
  public key is unchanged unless the peer's keypair rotated, in which
  case the peer re-enrolls per #55 D2). There is no in-place rotation of
  a stored public key that preserves continuity.
- The precedent is `revokeClientKey` (`server/src/arbiter.ts:2481`):
  immediate local deletion of the key row plus an event log entry, with
  no remote propagation.

Rejected: a "revoke token" endpoint that the target calls on the
controller (a control action used to revoke is circular), and any
hub-mediated revocation (there is no hub).

## D7 — Audit: the target's event log, with the requester's identity (LOCKED)

The acceptance makes audit a criterion: every relayed action appears in
the target's event log with the requesting `instance_id`.

Locked: **when the target applies a relayed control action, the target
appends an event to its OWN log. A new event kind `mesh_control` records
the action, and the event carries the requesting `instance_id` as an
ADD-key field `source_instance_id` on the event record.**

- The audit lives in the TARGET's log, not the requester's. The target is
  the machine whose state changed.
- The event record today is `{ ts, kind, project, lease_id, detail }`
  (`server/src/types.ts`). `source_instance_id` is an ADD-key field, so
  existing records are unchanged.

## D8 — Fail-closed when no pairing exists (LOCKED)

Locked: **with no pairing, a peer is read-only on the coarse plane. It
cannot call `GET /api/mesh/detail` and it cannot send a control action.
Both require the per-edge credential, and its absence means denial.**

- Discovery and queue DEPTHS always work with zero pairing (the #50 read
  plane, already built).
- Queue DETAIL and CONTROL require pairing.
- The posture is fail-closed by construction: the detail route and the
  control route both check the per-edge credential, so an unpaired peer
  gets neither.

Rejected: pairing as an optional nicety where detail is best-effort. The
acceptance states that unpaired peers see no job ids or titles. Fail
closed.

## Wire keys (ADD-key posture, not built)

This doc names the wire keys a build wave would add. None is implemented
here. Every change is additive. No existing route is renamed, and
`/api/state` gains no keys.

- New routes (all ADD, owned by this doc):
  - `POST /api/mesh/unpair` (local admin). Removes the local edge.
    Immediate denial of the next control or detail request (D6).
  - `GET /api/mesh/detail` (per-edge credential, `controls_me`). The
    detailed projection (D3).
  - `POST /api/mesh/control` (per-edge credential, `controls_me`).
    Relays a control action (D4). Body carries `action`, and, by action,
    `client`, `session_token`, `until`, or `order`.
- The edge-formation ceremony (`pair`/`accept` in this doc's former D1)
  is owned by #55 D4. The service-mediated one-time code (shape (b)) is
  the recommended form. This doc does not re-open that choice.
- New file (not wire): `mesh_edges.json`, mode 0600. Edge records carry
  `peer_instance_id`, `peer_public_key`, `peer_name`, `controls_me`,
  `created_ts`. The private key never enters this file (it is in
  `identity.json`, #55 D1).
- Event record (ADD-key): `source_instance_id` on the event record, plus
  the new event kind `mesh_control` (D7).
- Config: zero new config keys. The credential is runtime state in the
  edge file, not operator config.
- Auth hook: gains a per-edge signature check for the two per-edge routes.
  It verifies the requester's ed25519 signature against the stored peer
  public key for that `instance_id`. The `peer_token` check on
  `GET /api/mesh` and the `api_tokens` checks on every other route are
  unchanged.

## What changes vs what stays untouched

Stays untouched, byte-for-byte:

- `GET /api/state` (the `mesh` key from #50 is the only addition, and it
  is already built).
- `GET /api/mesh` and its coarse response shape.
- `POST /api/clients/:ref/override` and `POST /api/sessions/:token/override`.
- The anonymous reads of `/api/state` and `/api/metrics`.
- The local admin `api_tokens` plane and the `peer_token` read plane.
- `instance_id` minting and persistence.
- The client loopback proxy (127.0.0.1 only).
- No new inbound listening port on any client machine. Arbiters already
  listen. The new routes are on the arbiter.

Changes (all additive, owned by this doc):

- Three new arbiter routes: `unpair`, `detail`, `control`. The
  edge-formation ceremony is #55 D4's, not this doc's.
- One new file: `mesh_edges.json` (edge records carry the peer's public
  key, not a shared secret).
- One ADD-key event field and one new event kind.
- The auth hook learns a per-edge signature check for the two per-edge
  routes.

## Dependency order (build waves)

What must exist before the pairing slice can be built, in build-wave
order:

- **Wave 0 — the mesh read plane (#50).** BUILT (commit `71b4e5d`).
  Presence and queue depths ride `GET /api/mesh` with zero pairing. The
  base.
- **Wave 1 — #55 D1 (LOCKED).** The per-instance ed25519 keypair in
  `identity.json` (0600, atomic tmp+rename). The local substrate. Small,
  per machine, no service. REQUIRED before any #39 relay route.
- **Wave 2 — #55 D4 (PROPOSED).** The edge-formation ceremony. The
  one-time exchange of the peer's public key plus the edge direction. It
  fills the local edge record (`mesh_edges.json`). The service-mediated
  one-time code (shape (b)) is the recommended form. The operator
  confirms shape (b) and directional edges.
- **Wave 3 — the #39 relay.** `GET /api/mesh/detail` (D3),
  `POST /api/mesh/control` (D4), the direction policy (D5),
  `POST /api/mesh/unpair` (D6), the `mesh_control` audit (D7), and the
  fail-closed posture (D8). Substrate-agnostic. It verifies the
  requester's signature against the stored peer public key.

What can ship independently:

- #55's fleet service (roster, enrollment, heartbeat) ships independently
  of the #39 relay. The mesh read plane keeps working under the shared
  `peer_token` fallback while the service is absent. The service upgrades
  the mesh from static `mesh_peers` config to a roster, and it carries
  the service-mediated ceremony. It is not a gate for the #39 relay.
- The #39 relay routes are substrate-agnostic. Once Wave 1 (the keypair)
  and Wave 2 (the edge record) exist, the relay builds and works against
  the locally-stored peer public key. No live roster pull is required
  (the last-known-keys posture).

## Open questions (owner input)

The substrate question (former Q1) is closed by this doc's D1: the
handshake rides #55's locked per-instance ed25519 keypair. The ceremony
surface (former Q4) is #55 D4's and is inherited, not re-opened here.
Three questions remain for the owner. Each carries a recommended answer.

1. Exact field set of `GET /api/mesh/detail`: the queue projection only,
   or the queue projection plus the target's session rows?
   Recommend: the queue projection only. Reason: D3 already locks the
   boundary (payload-free, target-local, no transitivity), and the queue
   projection is exactly what a local dashboard reader sees. Session rows
   drag in the #41-#48 session surface and widen the secret exposure for
   no gain in this wave.
2. `reorder` wire shape: a full queue order (a job-id list), or a
   promote or demote of one job?
   Recommend: a promote or demote of one job. Reason: it is a bounded
   scheduling action that fits D4's "scheduling posture" blast-radius
   bound and needs a small new primitive. A full-order rewrite is a
   bigger write and a bigger primitive for the same goal.
3. Edge lifetime and key rotation: is an edge permanent until unpaired
   (this doc's default), or does it carry an expiry or rotation schedule?
   And if the peer's keypair rotates (#55), is re-pairing the recovery
   path?
   Recommend: permanent until unpaired, with operator-triggered key
   rotation and re-pairing as the rotation recovery. Reason: the
   single-operator posture needs no automatic expiry, and D6 already
   makes unpair the revocation path. If a peer's keypair rotates, the
   stored public key is stale and re-pairing refreshes it. That is a
   one-command recovery, matching #55 D2's wiped-machine recovery.

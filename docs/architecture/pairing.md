# Pairing ceremony — issue #39 (cross-instance control + cross-client queue visibility)

This doc settles the part of #39 that `docs/architecture/mesh.md` left
deferred: the per-edge secret, the read a paired edge gets beyond the
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

## D1 — The handshake: a manual one-time pairing code, no hub, no PKI (PROPOSED)

Rejected: (1) a second shared fleet-wide control token — it has the same
revocation flaw as `peer_token` (rotating it means editing every machine)
and carries no per-edge identity. mesh.md D2 already rejected a shared
secret for the read plane, and this wave will not re-create it for
control. (2) An ed25519 keypair with signed challenges — the substrate
`docs/architecture/fleet-service.md` (#55) proposes. It is not built and
#55 is open. Building the asymmetric substrate now couples #39 to an
unbuilt service and a roster. (3) TLS/mTLS between arbiters — it needs a
certificate authority, per-machine certificates, and renewal. The tailnet
is already the transport trust boundary.

Proposed: **the operator exchanges a one-time pairing code by hand.**
The initiator generates a 256-bit per-edge secret and a single-line
pairing code that encodes the initiator's `instance_id` plus the secret.
The operator types the code into the target's dashboard. The target
parses the code, binds the secret to the initiator's `instance_id`, and
stores it. Both arbiters now hold the same per-edge secret.

- Initiation: `POST /api/mesh/pair` on the initiator (local admin). The
  operator selects the target peer from the read plane (the initiator
  already knows the target's `instance_id` from its snapshots). The route
  mints the secret, stores the initiator's edge record, and returns the
  code.
- Acceptance: `POST /api/mesh/accept` on the target (local admin). The
  operator pastes the code. The route parses the `instance_id` and the
  secret, verifies the initiator id against a known peer, and stores the
  target's edge record.
- The trusted channel is the operator, matching the existing tailnet plus
  single-operator trust model. The code is high entropy and single use.
- No arbiter ever needs to reach another arbiter to pair. Both sides act
  on their own local loopback surface and carry the result forward on the
  next control or detail request.

The trade-off: a shared static secret gives no forward secrecy. If one
side's edge file leaks, the exact secret on the other side is exposed.
Manual entry is operator friction. Both are acceptable for a single
operator fleet where the operator is the trust boundary. In return the
design needs no service, no key infrastructure, and revokes per edge.
Ed25519 (#55) is the named upgrade path. Quoting #55's own substrate is
what makes the deferral legitimate rather than a contradiction.

## D2 — Where the secret lives: a sibling edge file, never the state file (LOCKED)

Rejected: (1) Inside `state.json` — the state file is rewritten on every
state change (every lease grant, every heartbeat), so a control secret in
it rides every atomic save, and a state backup or export would leak
control secrets. (2) Inside operator config — pairing is runtime state,
not operator config, and config often lives in version control. (3) An OS
keychain — the fused binary runs on Linux too, and the arbiter has no
keychain dependency today.

Locked: **the per-edge secrets live in a sibling file, `mesh_edges.json`,
mode 0600, next to `state.json`.** It is never inside `state.json`. It
uses the same atomic-write posture (write to a temp path, rename).
Because it is a small separate file, revoking one edge rewrites only this
file, and the state file stays free of control secrets.

The edge file is PERSISTENT. Unlike the ephemeral peer snapshot (which
never touches disk), a pairing must survive a restart. The edge record
carries the peer `instance_id`, the peer name, a `controls_me` flag (see
D5), the secret, and a create timestamp.

## D3 — What a paired edge READS beyond the coarse snapshot (LOCKED)

The coarse plane is enforced by endpoint scope, not by a filter. A
paired edge does not loosen `GET /api/mesh`. It gets a separate route
that carries the detail projection, scoped by the per-edge secret.

Rejected: (1) Grant the peer the full `/api/state` — that is the local
surface and it carries the whole machine's state. A peer does not get a
local-admin read. (2) Add a `detail` field to `GET /api/mesh` gated by the
per-edge token — that makes the coarse route filter-gated, which
contradicts the endpoint-scope principle and risks a coarse reader
receiving detail. (3) Reuse `/api/state` with the per-edge token — the
`/api/state` auth hook answers only `api_tokens` or the anonymous read.
Adding the per-edge secret there would make `/api/state` answer to a
peer.

Locked: **a new route `GET /api/mesh/detail`, authenticated by the
per-edge secret, carries the detailed projection.** The detail is exactly
the queue detail a local dashboard reader already sees, bounded by the
same sanitizer:

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
per-edge secret, relays a control action from the requester to the
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

The per-edge secret is shared by both sides. Direction is a policy on
top of the secret, stored per side.

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
per-direction pairing keeps the capability narrow.

## D6 — Revocation: immediate local deletion on the controlled side (LOCKED)

The acceptance requires unpairing to revoke immediately: the next action
is denied.

Locked: **to unpair, the operator removes the edge record. The
enforcement point is the controlled side. `POST /api/mesh/unpair` on the
target deletes the target's edge record for the controller. The next
control or detail request from the controller presents the secret, the
target finds no matching edge, and returns 403. Denial is immediate, with
no propagation delay.**

- The controller also removes its own edge record so its surface shows
  the edge as unpaired.
- Rotation is unpair plus re-pair. A new code and a new secret are minted.
  There is no in-place rotation of a shared secret that preserves
  continuity.
- The precedent is `revokeClientKey` (`server/src/arbiter.ts`): immediate
  local deletion of the key row plus an event log entry, with no remote
  propagation.

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
Both require the per-edge secret, and its absence means denial.**

- Discovery and queue DEPTHS always work with zero pairing (the #50 read
  plane, already built).
- Queue DETAIL and CONTROL require pairing.
- The posture is fail-closed by construction: the detail route and the
  control route both check the per-edge secret, so an unpaired peer gets
  neither.

Rejected: pairing as an optional nicety where detail is best-effort. The
acceptance states that unpaired peers see no job ids or titles. Fail
closed.

## Wire keys (ADD-key posture, not built)

This doc names the wire keys a build wave would add. None is implemented
here. Every change is additive. No existing route is renamed, and
`/api/state` gains no keys.

- New routes (all ADD):
  - `POST /api/mesh/pair` (local admin). Initiates and returns the
    pairing code.
  - `POST /api/mesh/accept` (local admin). Accepts a code and stores the
    edge.
  - `POST /api/mesh/unpair` (local admin). Removes the local edge.
  - `GET /api/mesh/detail` (per-edge secret, `controls_me`). The detailed
    projection (D3).
  - `POST /api/mesh/control` (per-edge secret, `controls_me`). Relays a
    control action (D4). Body carries `action`, and, by action,
    `client`, `session_token`, `until`, or `order`.
- New file (not wire): `mesh_edges.json`, mode 0600. Edge records carry
  `peer_instance_id`, `peer_name`, `controls_me`, `secret`,
  `created_ts`.
- Event record (ADD-key): `source_instance_id` on the event record, plus
  the new event kind `mesh_control` (D7).
- Config: zero new config keys. The secret is runtime state in the edge
  file, not operator config.
- Auth hook: gains a per-edge-secret check for the two per-edge routes.
  The `peer_token` check on `GET /api/mesh` and the `api_tokens` checks
  on every other route are unchanged.

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

Changes (all additive):

- Five new arbiter routes: `pair`, `accept`, `unpair`, `detail`,
  `control`.
- One new file: `mesh_edges.json`.
- One ADD-key event field and one new event kind.
- The auth hook learns the per-edge secret for the two per-edge routes.

## Open questions (owner input)

1. Handshake substrate and sequencing: does the pairing slice land as the
   self-contained shared-secret mechanism (this doc's D1) independent of
   #55, or is it gated on #55's ed25519 substrate and roster? #55 is
   open and the issue says it blocks the pairing slice. The owner must
   pick: shared secret now, or wait for the service.
2. Exact field set of `GET /api/mesh/detail`: the queue projection only,
   or the queue projection plus the target's session rows? This doc locks
   the boundary (payload-free, target-local, no transitivity) but leaves
   the exact projection to the owner.
3. Reorder semantics on the wire: a full queue order (a list of job ids),
   or a promote or demote of one job? This doc names the `reorder` action
   but the owner defines the exact shape.
4. Pairing surface: confirm the ceremony lives in the desktop app (#16)
   and the dashboard, and that the operator types the code by hand rather
   than the two arbiters exchanging it automatically.
5. Edge lifetime: this doc locks that pairings persist across restarts in
   `mesh_edges.json`. Does the owner want any expiry or rotation schedule
   on an edge, or is an edge permanent until unpaired?

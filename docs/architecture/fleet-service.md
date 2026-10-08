# Fleet service — identity, roster, pairing (grilling, 2026-10-04)

Companion to `docs/architecture/mesh.md` (#50, locked). This doc is NOT a
lock: every decision below is marked PROPOSED with its alternative and
the trade-off. Nothing here is built.

## Why a separate service

The mesh read plane (#50 slice 1) shipped with two punts:

1. **Static `mesh_peers` config.** Tailnet addresses move. A laptop's
   arbiter is only reachable at whatever address it happens to hold, and
   every peer that wants to pull from it must be reconfigured.
2. **One shared `peer_token`.** Every instance holds the same read
   secret. Revocation means rotating it everywhere. There is no
   per-instance identity, so #39's pairing ceremony has nothing to pair.

A fleet service fixes both. It is also the seed of the SaaS control
plane (the future phase in `references/product-vision.md`): the same
service that knows which machines are yours is the service that knows
which tenant they belong to.

**Why outside this repo.** The service is generic fleet identity — it is
not idlefill-specific. Keeping it in its own project means: idlefill can
be open-sourced without dragging the operator's identity infrastructure
with it; the service can serve other apps (the update channel, future
projects); and the wire contract between them is explicit rather than an
internal import. Proposed repo name: `fleetlink` (bikeshed-able).

## The hard boundary: control plane, never a relay

#50 D1 rejected a relay — "a relay is a hub". This is not a relay.

| Plane | Path | Service involved? |
|---|---|---|
| Data (mesh snapshots, leases, sessions) | arbiter → arbiter, direct, tailnet | NO |
| Control (paired actions, #39) | arbiter → arbiter, direct | NO |
| Identity (keys, roster, pairing grants) | arbiter → fleet service | YES |

The service brokers who may talk to whom. It never carries the traffic.
Consequences that must stay true:

- The service is DOWN ⇒ the mesh keeps running. Peers keep pulling from
  last-known addresses with last-known keys. Grants are unaffected (they
  are local per-engine decisions). Only new enrollment and new pairing
  are unavailable.
- A machine leaves the network ⇒ it takes its engine, queue, sessions,
  and arbiter with it (#50 rule). The service learns it is offline by
  missed heartbeats; it never held its state.
- The service is compromised ⇒ the blast radius is the roster and the
  pairing grants, not the inference traffic. Keys are per-instance, so
  one stolen key is one machine, not the fleet.

## D1 — Instance identity: per-instance ed25519 keypair (PROPOSED)

Verified available in the runtime: `node:crypto` ed25519 signs and
verifies; a public key is 59 chars base64url, a private key 64. No new
dependency.

- At first boot the arbiter mints a keypair next to `instance_id` (which
  already persists in `state.json`). The private key lives in the state
  file family (same atomic-write posture) or a sibling 0600 file —
  grill: `state.json` is the only persistence today, but a secret riding
  every atomic save is exactly what #39 flagged. **Recommendation: a
  sibling `identity.json`, mode 0600, never inside `state.json`.**
- The public key is what the fleet publishes. A peer verifies a signed
  request against the roster's key for that `instance_id`.
- Alternative: keep the shared `peer_token`. Cheaper, no ceremony, but
  no revocation and no pairing substrate. It is what shipped in slice 1;
  this doc supersedes it once the service exists.

## D2 — Bootstrap: one-time enrollment token (PROPOSED)

1. The operator creates an enrollment token (CLI, or the fleet service's
   own page). High entropy, single-use, short TTL (recommend 15 min).
2. The new instance generates its keypair, POSTs the token + public key
   + display name, and receives a session credential bound to its key.
3. From then on it authenticates by signing a server nonce. No shared
   fleet secret ever exists.

Alternative: pre-generate the keypair server-side and hand it to the
machine. Simpler first run, worse key hygiene (the private key transits
the network). **Recommendation: client-generated keys.**

Grill: what does a wiped machine do? Re-enroll with a fresh token; the
operator deletes the stale instance row. That must be a one-command
recovery, not an incident.

## D3 — Roster and presence (PROPOSED)

- Each instance heartbeats its current URLs (tailnet IPv4/IPv6, any
  published route) + its coarse presence to the service on a cadence.
- The roster is a PULL: `GET /roster` returns
  `{instance_id, name, public_key, urls[], last_seen, edges[]}` per
  instance in the fleet.
- The arbiter's `mesh_peers` config becomes OPTIONAL: when `fleet_url`
  is set, the peer list comes from the roster. Static `mesh_peers` stays
  as the offline/no-service mode — idlefill must work with zero fleet
  service (also the open-source posture: no hard dependency).
- Grill: how stale may a roster be before you stop trusting it for
  CONTROL actions? Reads can tolerate staleness; a control action
  against a machine that left the fleet must fail. **Recommendation:
  reads tolerate any age (with the age surfaced), control actions refuse
  past a ceiling (propose 24 h).**

## D4 — Pairing ceremony (PROPOSED, the #39 dependency)

Two candidate shapes:

- **(a) Request/approve.** A asks the service for an edge to B. The
  service notifies B; B's operator approves (desktop app, CLI, or the
  fleet page). The service records the edge and publishes it in both
  rosters. Each side then talks directly, authenticated by signed
  requests.
- **(b) One-time code.** B's desktop app mints a short code; A redeems
  it at the service. Faster for the "two of my own machines" case, no
  approval UI needed.

**Recommendation: (b) for the personal fleet** — the operator is on both
ends, so an approval round-trip adds a notification path that does not
exist yet. (a) is the SaaS shape (approving someone else's machine);
record it as the future variant, do not build it now.

Edge semantics: an edge is directional or symmetric? #39's acceptance
says "after pairing A → B, A can pause/resume/reorder B's queue" and
"unpairing revokes immediately". **Recommendation: directional edges**
(A→B grants A control over B's work), so unpairing one direction does
not silently revoke the other.

## D5 — Human login: the seam, not the feature (PROPOSED)

The operator asked for a "login/connection service". Today the human
surface is: anonymous dashboard read + a pasted arbiter token (tailnet-only
reach, no published port — the retired compose plane's IP/basic-auth
middleware never shipped). A fleet service is the natural home for a real
operator login, and it is the SaaS lever: `instance` gains one column,
`fleet_id`, defaulting to `home`. That single column is the whole
multi-tenant seam.

**Recommendation now: machine identity only.** Record the seam, build
nothing human-facing. Do not preload accounts, sessions, or roles — the
standing rule is design for the single operator until the SaaS phase is
real.

## D6 — Storage (PROPOSED)

idlefill's posture is one JSON state file, atomic tmp+rename, corrupt-
tolerant. A registry with instances, edges, and rotation history has
real query needs.

- **Recommendation: SQLite** (a file, not a server — it does not violate
  "no database server", it violates only "one JSON file", for a service
  whose whole job is relational lookups).
- Alternative: JSON, matching idlefill exactly. Fine at 5 machines,
  awkward the moment edges and audit history exist.

## D7 — Deployment (PROPOSED)

- Container on urza (the public ingress box; `*.samwarth.com` LE cert
  already lives there). Route `fleet.samwarth.com` behind
  `middleware-local-ip-range` like the other private routes.
- Own compose file under `/mnt/docker/fleetlink/`, state on a named
  volume, same house conventions as `deploy/compose.yaml`.
- Dependency-free Node (fastify at most), matching the repo's posture.

## What changes in idlefill when this lands

Small, additive, and reversible:

1. Config: `fleet_url` + the identity file. `mesh_peers` stays valid.
2. `MeshFederation` pulls the roster and merges it with static peers.
3. The mesh fetch presents a signed request; the peer verifies against
   its own roster. The shared `peer_token` becomes the fallback mode.
4. `/api/state`'s `mesh` key gains roster provenance (where a peer row
   came from: static config or roster) — exception-only.

Nothing in the lease/gate/session core moves. Engine ownership stays
exclusive and fail-closed.

## Open questions to settle before code

1. Enrollment token: who can mint one? (Today: whoever holds the
   operator's shell. With a login: the account owner.)
2. Key rotation: automatic on a cadence, or operator-triggered only?
3. Replay window for signed requests: how much clock skew does the
   tailnet actually show? Measure before picking the number.
4. Does the service hold the update channel too (today: Forgejo
   releases), or does that stay where it is?
5. Name of the thing. `fleetlink` is a placeholder.

## Sequencing

- This issue BLOCKS #39's pairing ceremony (there is no key substrate
  until it exists) and unblocks a real multi-machine mesh (no static
  config per peer).
- It does NOT block #51 (metrics store, per-machine) or #53 (dev
  cycles, single machine).
- The read plane as built stays valid: it is the fallback mode and the
  transport this identity layer rides on.

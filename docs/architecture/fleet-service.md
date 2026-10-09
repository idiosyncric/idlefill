# Fleet service — identity, roster, pairing (grilling, 2026-10-04. Grill complete 2026-10-09)

Companion to `docs/architecture/mesh.md` (#50, locked). This doc grills the
original proposal against the code read on disk at HEAD `65767fa`.

Status: LOCKED — D1..D7 are all locked. The grill ran 2026-10-09 against
HEAD `65767fa`; the owner closed the last PROPOSED decisions (D3 cadences +
control staleness ceiling, D4 pairing shape + edge directionality) on
2026-10-09 (issue #55), accepting each recommendation. D4 was already
settled by the same owner decision that locked `docs/architecture/pairing.md`
(`0d2f07f`). Built since the grill: slices 1-11 on main — the arbiter
identity substrate, the `fleet/` service (enrollment, roster, heartbeat,
pairing), the roster pull and merge, arbiter enrollment, heartbeat, and
the arbiter-side edge fill. The remaining unbuilt step is the D7
deployment on urza. Original citations verified at HEAD `65767fa`; shipped
citations verified at `0d2f07f`.

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
with it. The service can serve other apps (the update channel, future
projects). The wire contract between them is explicit rather than an
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
  missed heartbeats. It never held its state.
- The service is compromised ⇒ the blast radius is the roster and the
  pairing grants, not the inference traffic. Keys are per-instance, so
  one stolen key is one machine, not the fleet.

## What breaks today when a tailnet address changes

Verified against the code at HEAD `65767fa`:

- The peer registry is the config key `mesh_peers`, an array of
  `{ url, name }` rows (`server/src/types.ts:57`). Config defaulting
  copies it through as-is (`server/src/config.ts:87-99`).
- `MeshFederation` builds its peer map ONCE, at construction, keyed by
  URL (`server/src/mesh.ts:97-103`). The constructor reads
  `cfg.mesh_peers` and never runs again.
- Each tick pulls `${p.url}/api/mesh` for every configured peer
  (`server/src/mesh.ts:116-137`. The production caller is
  `server/src/index.ts:272`).
- A failed fetch is not an error: the row keeps its last snapshot with a
  growing fetch age, and past `PEER_STALE_MS = 90_000` it renders offline
  (`server/src/mesh.ts:25`, `server/src/mesh.ts:145`).
- The auth header is the single shared `peer_token`
  (`server/src/mesh.ts:118`, `server/src/api.ts:55-59`).

So when a laptop's tailnet address moves:

1. Its old URL stops answering. Every peer that lists it in `mesh_peers`
   sees fetch failures, and after 90 s the row renders offline.
2. Nothing discovers the new address. The registry is static config,
   read once at boot. The new address reaches no peer until someone edits
   `mesh_peers` on every other machine and restarts each arbiter.
3. The observed `instance_id` does not help: `PeerView.instance_id` is
   recorded per URL (`server/src/mesh.ts:67`, `server/src/mesh.ts:129`),
   but there is no path from a known `instance_id` back to a current URL.
   The id tracks identity. It does not track location.

This is exactly the gap mesh.md anticipated: "tailnet IPs move"
(`docs/architecture/mesh.md:88-89`). The id is the identity. The id half is built.
The location half is not.

### How a roster fixes it without becoming a relay

Each instance heartbeats its current URLs to the service. Any arbiter
pulls `GET /roster` and learns the current URL for every `instance_id`.
The arbiter then pulls `/api/mesh` directly from that URL, over the
tailnet, with the same coarse snapshot and the same auth posture.

The service stores locations and keys. It never sits in the data path.
The pull still goes arbiter to arbiter. The roster answers "where is
instance X now". It does not carry the snapshot. This keeps #50 D1 intact:
no hub, no gossip, no relay. The roster is a directory, not a pipe.

The merge rule: static `mesh_peers` stays valid and is the offline mode.
When `fleet_url` is set, roster-derived peers join the peer map. A roster
row whose `instance_id` matches a static row replaces that row's URL. A
roster row with no static match is added. Static rows with no roster
match stay (they are the fallback). On a roster pull failure, the last
good roster stands and the static rows keep working.

## D1 — Instance identity: per-instance ed25519 keypair (LOCKED)

Verified available in the runtime (live probe, node v26.10.0, 2026-10-09):
`node:crypto` `generateKeyPairSync('ed25519')` signs and verifies. The
public key exports to 44 DER bytes (59 chars base64url). The private key
exports to 48 DER bytes (64 chars base64url). A signature is 64 bytes. No
new dependency.

Locked rules:

- At first boot the arbiter mints a keypair next to `instance_id` (which
  already persists in `state.json`, minted at `server/src/arbiter.ts:2512-2517`).
- The private key lives in a sibling `identity.json`, mode 0600, written
  with the same atomic tmp+rename posture as the state file
  (`server/src/state.ts:134-140`). It never enters `state.json`.
- The public key is what the fleet publishes. A peer verifies a signed
  request against the roster's key for that `instance_id`.

Rejected alternative: keep the shared `peer_token`. Cheaper, no ceremony,
but no revocation and no pairing substrate. It is what shipped in slice 1.
This doc supersedes it once the service exists.

The trade-off that decided it: #39's pairing ceremony needs a per-instance
secret to pair against. The shared token gives no per-instance identity, so
there is nothing to pair. The `identity.json` split avoids putting a secret
inside the state file, which would make it ride every atomic save — the
exact concern #39 flagged (`docs/reports/ISSUE39-RESCOPE.md:53-57`).

## D2 — Bootstrap: one-time enrollment token (LOCKED)

Locked procedure:

1. The operator creates an enrollment token (CLI, or the fleet service's
   own page). High entropy, single-use, short TTL (15 min).
2. The new instance generates its keypair locally, POSTs the token +
   public key + display name, and receives a session credential bound to
   its key.
3. From then on it authenticates by signing a server nonce. No shared
   fleet secret ever exists.

Wiped-machine recovery: re-enroll with a fresh token. The operator deletes
the stale instance row. That is a one-command recovery, not an incident.

Rejected alternative: pre-generate the keypair server-side and hand it to
the machine. Simpler first run, worse key hygiene (the private key transits
the network).

The trade-off that decided it: client-generated keys keep the private key
on the machine for its whole life. The server never sees it. The enrollment
token is single-use and short-TTL, so a leaked token expires before it is
abusable. Server-side generation would put the private key on the wire once
at setup, and it would live in the service's storage permanently.

## D3 — Roster and presence (LOCKED)

Mechanics (locked shape and values):

- Each instance heartbeats its current URLs (tailnet IPv4/IPv6, any
  published route) + its coarse presence to the service on a cadence.
- The roster is a PULL: `GET /roster` returns
  `{instance_id, name, public_key, urls[], last_seen, edges[]}` per
  instance in the fleet.
- The arbiter's `mesh_peers` config becomes OPTIONAL: when `fleet_url`
  is set, the peer list comes from the roster. Static `mesh_peers` stays
  as the offline/no-service mode — idlefill must work with zero fleet
  service (also the open-source posture: no hard dependency).

Decisions (owner, 2026-10-09, issue #55 — each recommendation accepted,
values shipped as defaults):

1. **Heartbeat cadence: 60 s.** Shipped as `fleet_heartbeat_ms` (default
   60000, `server/src/config.ts:77`), riding the existing poll tick behind
   an interval gate (`server/src/mesh.ts:757-763`, slice 8) — no second
   network loop. A live proof at HEAD `321ef7d` wrote a real roster row
   (`urls`, `presence`, `last_seen`) with nine single-use nonces consumed.
2. **Control-action staleness ceiling: 24 h.** Shipped as
   `CONTROL_STALE_MS` (`fleet/src/store.ts:49`). Reads tolerate any age
   with the age surfaced (`PEER_STALE_MS = 90_000` renders peers offline);
   a CONTROL action against an instance that has missed a day of
   heartbeats refuses. Enforcement rides the control plane as it lands
   (#39's write verbs).
3. **Roster pull cadence on the arbiter: 15 s.** Shipped as
   `fleet_roster_pull_ms` (default 15000, `server/src/config.ts:68`), the
   existing poll tick (`server/src/mesh.ts:607-610`, slice 5). A moved
   tailnet address is picked up within one tick, and slice 9 reconciles
   url sets per `instance_id` so the peer map follows the machine.

The trade-off that decided it: the read plane already bounds staleness at
`PEER_STALE_MS` (90 s), so a faster heartbeat buys nothing the mesh can
see; 60 s is the quietest cadence that still notices a moved address
inside a minute. Pulling the roster on the existing 15 s tick adds no
loop and no new failure surface. 24 h for control is the draft value —
generous enough that a laptop closed for a weekend is not an incident,
tight enough that a machine abandoned for a month cannot be controlled.

## D4 — Pairing ceremony (LOCKED, the #39 dependency — settled)

Two candidate shapes (the grill's record; the decision follows):

- **(a) Request/approve.** A asks the service for an edge to B. The
  service notifies B. The operator of B approves (desktop app, CLI, or the
  fleet page). The service records the edge and publishes it in both
  rosters. Each side then talks directly, authenticated by signed
  requests.
- **(b) One-time code.** The desktop app of B mints a short code. A
  redeems it at the service. Faster for the "two of my own machines" case, no
  approval UI needed.

Edge semantics: an edge is directional or symmetric? #39's acceptance
says "after pairing A → B, A can pause/resume/reorder B's queue" and
"unpairing revokes immediately". Directional edges mean unpairing one
direction does not silently revoke the other.

Decisions (owner, 2026-10-09 — the same decision that locked
`docs/architecture/pairing.md`, commit `0d2f07f`, issue #39):

1. **Shape (b): the one-time code.** B mints (`POST /pair/code`, binds to
   B's authenticated `instance_id`, hashed, single-use, 5 min TTL), A
   redeems (`POST /pair/redeem`, signer is the controller `from`, minter
   is the controlled end `to`). Shipped: fleet side in slice 6
   (`0762372`), ceremony refusals hardened in slice 11 (`55a6c1b`),
   arbiter-side redeem + local edge record in slice 10 (`7b80621`).
   (a) request/approve stays recorded as the SaaS variant — do not build
   it until the notification path exists.
2. **Directional edges.** `from` is the controller, `to` is the
   controlled end. `POST /pair/unpair` deletes exactly one direction,
   callable by either end; the other direction survives (slice 6, tested
   one-direction). Matches pairing.md D5/D6.

The trade-off that decided it: the operator is on both ends of a personal
fleet, so an approval round-trip would add a notification path that does
not exist — the code is paste-able in one step. Directional edges keep
unpairing honest: "unpairing revokes immediately" (#39 acceptance) holds
per direction, and revoking A's control over B never silently revokes
B's over A.

## D5 — Human login: the seam, not the feature (LOCKED)

The operator asked for a "login/connection service". Today the human
surface is: anonymous dashboard read + a pasted arbiter token (tailnet-only
reach, no published port — the retired compose plane's IP/basic-auth
middleware never shipped). A fleet service is the natural home for a real
operator login, and it is the SaaS lever: `instance` gains one column,
`fleet_id`, defaulting to `home`. That single column is the whole
multi-tenant seam.

Locked: machine identity only. Record the seam, build nothing human-facing.
Do not preload accounts, sessions, or roles — the standing rule is design
for the single operator until the SaaS phase is real.

The trade-off that decided it: the SaaS phase is not real. Building a login
now would add accounts, sessions, and roles for a single-operator fleet.
The `fleet_id` column is the seam. It costs one column and defers the rest.

## D6 — Storage (LOCKED)

idlefill's posture is one JSON state file, atomic tmp+rename, corrupt-
tolerant. A registry with instances, edges, and rotation history has
real query needs.

Locked: SQLite (a file, not a server — it does not violate "no database
server", it violates only "one JSON file", for a service whose whole job
is relational lookups).

Rejected alternative: JSON, matching idlefill exactly. Fine at 5 machines,
awkward the moment edges and audit history exist.

The trade-off that decided it: the service's whole job is relational
lookups (which instance, which edges, which rotation history). A JSON file
answers those with linear scans and manual merge logic. SQLite answers them
with queries. It is a file, so it does not add a database server to the
deployment.

## D7 — Deployment (LOCKED)

Locked:

- Container on urza (the public ingress box. The `*.samwarth.com` LE
  cert already lives there). Route `fleet.samwarth.com` behind
  `middleware-local-ip-range` like the other private routes.
- Own deploy dir under `/mnt/docker/fleetlink/`, state on a volume, same
  house conventions the urza deploys share: no published ports, tailnet-only
  reach.
- Dependency-free Node (fastify at most), matching the repo's posture.

The trade-off that decided it: urza already hosts the public ingress and
the LE cert. Putting the fleet service there reuses the existing route
pattern and the existing tailnet-only reach posture. A second box would add
a second ingress, a second cert, and a second deploy target for a service
that serves one operator.

## Enrollment and pairing wire contract

Level: a build wave could implement this. Wire keys are ADD-keys: absent
means unset. Existing wire shapes keep every field byte-for-byte.

### Endpoints (fleet service)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/enroll` | POST | enrollment token (single-use, 15 min TTL) | Register a new instance |
| `/roster` | GET | instance credential (signed nonce) | Pull the full roster |
| `/heartbeat` | POST | instance credential (signed nonce) | Update URLs + presence |
| `/pair/code` | POST | instance credential (signed nonce) | Mint a pairing code (shape b) |
| `/pair/redeem` | POST | instance credential (signed nonce) | Redeem a pairing code (shape b) |
| `/pair/unpair` | POST | instance credential (signed nonce) | Remove an edge |

### Enrollment payload and response

Request body (`POST /enroll`):

```json
{
  "token": "<enrollment-token>",
  "public_key": "<base64url-ed25519-spki>",
  "name": "<display-name>"
}
```

Response body (200):

```json
{
  "instance_id": "m-<hex>",
  "credential": "<opaque-session-credential-bound-to-key>"
}
```

What each side stores:

- **Service:** `instance_id`, `public_key`, `name`, `enrolled_at`,
  `urls[]` (empty until first heartbeat), `last_seen` (null until first
  heartbeat). The enrollment token is marked used and deleted.
- **Instance:** `instance_id` (already in `state.json`), the private key
  (in `identity.json`, 0600), the `credential` (in `identity.json`, 0600).
  The credential is the long-lived auth for all subsequent calls.

### Heartbeat payload and response

Request body (`POST /heartbeat`):

```json
{
  "urls": ["https://100.105.x.x:8787"],
  "presence": "online"
}
```

Response body (200):

```json
{
  "ok": true
}
```

What each side stores:

- **Service:** updates `urls[]` and `last_seen` for the calling instance.
- **Instance:** nothing. The heartbeat is fire-and-forget.

### Roster response

Response body (`GET /roster`):

```json
{
  "instances": [
    {
      "instance_id": "m-<hex>",
      "name": "<display-name>",
      "public_key": "<base64url-ed25519-spki>",
      "urls": ["https://100.105.x.x:8787"],
      "last_seen": 1728500000000,
      "edges": [
        { "from": "m-<hex-a>", "to": "m-<hex-b>" }
      ]
    }
  ]
}
```

What each side stores:

- **Service:** nothing new. The roster is computed from the stored rows.
- **Instance (puller):** the roster is EPHEMERAL. It is held in memory for
  the duration of the merge into the peer map. It is never written to
  `state.json`. On the next pull, the new roster replaces the old one.

### Pairing code (shape b)

Mint (`POST /pair/code`, called by B):

Request body:

```json
{
  "target_name": "<optional-hint-for-A>"
}
```

Response body (200):

```json
{
  "code": "<short-one-time-code>",
  "ttl_s": 300
}
```

Redeem (`POST /pair/redeem`, called by A):

Request body:

```json
{
  "code": "<short-one-time-code>"
}
```

Response body (200):

```json
{
  "edge": { "from": "m-<hex-a>", "to": "m-<hex-b>" },
  "peer_public_key": "<base64url-ed25519-spki>"
}
```

What each side stores:

- **Service:** the edge row (`from`, `to`, `created_at`). The code is
  marked used and deleted.
- **A (redeemer):** the edge (in its local edge store, `identity.json`
  family). The peer's public key (for verifying signed requests from B).
- **B (minter):** the edge appears in its next roster pull. It stores the
  edge locally when it sees it.

Unpair (`POST /pair/unpair`):

Request body:

```json
{
  "edge": { "from": "m-<hex-a>", "to": "m-<hex-b>" }
}
```

Response body (200):

```json
{
  "ok": true
}
```

What each side stores:

- **Service:** deletes the edge row.
- **Caller:** deletes the edge from its local edge store. The next roster
  pull confirms the edge is gone.

### Signed-request auth (all endpoints except `/enroll`)

The instance signs a server nonce with its ed25519 private key. The
request carries:

```json
{
  "instance_id": "m-<hex>",
  "nonce": "<server-issued-nonce>",
  "signature": "<base64url-ed25519-signature>"
}
```

The service verifies the signature against the stored `public_key` for
that `instance_id`. A wrong signature is 401. A replayed nonce is 401
(the nonce is single-use, consumed on first use).

### Wire keys (ADD-key posture)

All keys above are ADD-keys. Absent means unset. No existing wire shape
gains a renamed or removed field. The `MeshSnapshot` shape
(`server/src/mesh.ts:37-59`) is UNCHANGED. The `/api/mesh` route and its
auth scope are UNCHANGED. The `peer_token` remains the fallback auth for
the mesh read plane when the fleet service is unreachable.

## Service down

Every behaviour that must survive the service being unreachable, cited
against `docs/architecture/mesh.md`:

1. **Peers keep pulling from last-known addresses with last-known keys.**
   The static `mesh_peers` config stays valid. The `MeshFederation` peer
   map is built from config at boot (`server/src/mesh.ts:97-103`) and is
   independent of the fleet service. A roster pull failure drops the new
   roster. The last good roster stands. The static rows keep working.
   Cited: `docs/architecture/mesh.md:49-52` (the peer registry is arbiter
   config), `docs/architecture/mesh.md:53-56` (a peer fetch failure is not
   an error. The row keeps its last snapshot).

2. **Grants are unaffected.** They are local per-engine decisions. The
   lease/gate/session core does not touch the fleet service.
   Cited: `docs/architecture/mesh.md:27-32` (grants fail closed per
   engine. The owning arbiter is the single source of truth).

3. **Only new enrollment and new pairing are unavailable.** An instance
   that is already enrolled and paired keeps working. It cannot enroll a
   new machine or form a new edge while the service is down.
   Cited: `docs/architecture/fleet-service.md` (this doc, the hard
   boundary section).

4. **A machine leaving the network takes its state with it.** The service
   never held its state. The service learns it is offline by missed
   heartbeats. The peer rows render offline past `PEER_STALE_MS`.
   Cited: `docs/architecture/mesh.md:57-60` (snapshots are ephemeral.
   Restart gives an empty mesh view until the first fetch),
   `server/src/mesh.ts:25` (`PEER_STALE_MS = 90_000`).

5. **The mesh read plane keeps working under the shared `peer_token`.**
   The `peer_token` is the fallback auth. It is scoped to `GET /api/mesh`
   only (`server/src/api.ts:55-59`). The fleet service does not gate this
   route. When the service is down, the `peer_token` is the only auth
   that works, and it is sufficient for the read plane.
   Cited: `docs/architecture/mesh.md:76` (the mesh read plane is the fleet
   `peer_token`, read-only, `GET /api/mesh` only).

6. **No cross-arbiter write depends on the service.** Federation moves
   snapshots, never decisions. The service is not in the data path.
   Cited: `docs/architecture/mesh.md:35-36` (state is published, never
   computed remotely), `docs/architecture/mesh.md:38-47` (no hub, no
   gossip, no relay).

7. **The dashboard keeps rendering the mesh view.** The merged view rides
   `/api/state` under the `mesh` key. It is built from the local peer map,
   which is independent of the fleet service. A roster outage degrades the
   freshness of the peer rows (stale `fetch_age_s`), not their existence.
   Cited: `docs/architecture/mesh.md:65-67` (the merged view rides
   `/api/state` under the `mesh` key).

## What changes in idlefill when this lands

Small, additive, and reversible:

1. Config: `fleet_url` + the identity file. `mesh_peers` stays valid.
2. `MeshFederation` pulls the roster and merges it with static peers.
3. The mesh fetch presents a signed request. The peer verifies against
   its own roster. The shared `peer_token` becomes the fallback mode.
4. `/api/state`'s `mesh` key gains roster provenance (where a peer row
   came from: static config or roster) — exception-only.

Nothing in the lease/gate/session core moves. Engine ownership stays
exclusive and fail-closed.

## Open questions to settle before code

The grill is done: every decision is LOCKED. Questions 6-10 (the named
owner choices under D3 and D4) were closed by the owner on 2026-10-09,
issue #55. Questions 1-5 stay open as operational choices — none gates a
decision; they gate first deployment.

1. Enrollment token: who can mint one? (Today: whoever holds the
   operator's shell. With a login: the account owner.)
2. Key rotation: automatic on a cadence, or operator-triggered only?
   (pairing.md Q3, closed for the control plane 2026-10-09:
   operator-triggered, re-pairing as the rotation recovery.)
3. Replay window for signed requests: how much clock skew does the
   tailnet actually show? Measure before picking the number.
4. Does the service hold the update channel too (today: Forgejo
   releases), or does that stay where it is?
5. Name of the thing. `fleetlink` is a placeholder.
6. ~~D3 heartbeat cadence~~ — LOCKED by the owner: 60 s
   (`fleet_heartbeat_ms`, `server/src/config.ts:77`).
7. ~~D3 control-action staleness ceiling~~ — LOCKED by the owner: 24 h
   (`CONTROL_STALE_MS`, `fleet/src/store.ts:49`).
8. ~~D3 roster pull cadence on the arbiter side~~ — LOCKED by the owner:
   15 s (`fleet_roster_pull_ms`, `server/src/config.ts:68`).
9. ~~D4 pairing shape (a) or (b)~~ — LOCKED by the owner: (b), the
   one-time code (`0d2f07f`, shipped `0762372` + `7b80621`).
10. ~~D4 directional or symmetric edges~~ — LOCKED by the owner:
    directional (unpair deletes exactly one direction).

## Sequencing

- This issue BLOCKS #39's pairing ceremony (there is no key substrate
  until it exists) and unblocks a real multi-machine mesh (no static
  config per peer). SETTLED 2026-10-09: the ceremony is LOCKED
  (`docs/architecture/pairing.md`) and built on this substrate
  (#55 slices 1, 6, 10, 11).
- It does NOT block #51 (metrics store, per-machine) or #53 (dev
  cycles, single machine).
- The read plane as built stays valid: it is the fallback mode and the
  transport this identity layer rides on.

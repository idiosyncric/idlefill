Map: #50 (mesh — transport now LOCKED) · #38 (topology) · Type: wayfinder:grilling

## Re-scoped 2026-10-04 against the #50 mesh decision

The original proposal assumed a central arbiter as the rendezvous ("the
arbiter's client registry is the rendezvous — no new P2P mesh"). #50
superseded that: every machine runs its own arbiter, and the federation
read plane IS the discovery layer. The decision is locked in
`docs/architecture/mesh.md` (D1 transport, D2 identity). This body now
grills the parts that remain open.

## Gap (unchanged in substance)

Multiple machines and clients have no concept of each other, and
visibility is all-or-nothing. Per machine the arbiter already knows every
client (`registerClient` idempotent by name, 90 s liveness window, each
client publishes a sanitized queue preview ≤100 rows) — but every
`/api/state` reader sees every client's full projection, and there is no
cross-MACHINE notion at all. The client daemon still has no inbound
control surface: the loopback proxy binds 127.0.0.1 only, and the daemon's
only connections are outbound.

## Locked by #50 (do not re-litigate here)

- **Discovery:** the mesh read plane. Each arbiter pulls a coarse snapshot
  from each peer on the `poll_ms` cadence and publishes the merged view
  under a new `mesh` key on `/api/state`. Peer registry = arbiter config
  `mesh_peers: [{url, name}]` (NOT `server_peers` — that key means
  llama-swap backends). Presence + queue DEPTHS are visible with zero
  pairing, across machines, for free.
- **Transport:** outbound HTTP, arbiter → arbiter, over the tailnet. No
  new inbound surface on client machines — arbiters already listen,
  clients never do. Cross-instance CONTROL rides the same direction: the
  requesting arbiter POSTs to the target arbiter. No relay, no gossip, no
  hub.
- **Identity:** three planes. Local admin = existing `api_tokens`. Mesh
  read = one shared fleet `peer_token`, read-only, scoped to
  `GET /api/mesh`. Mesh control = per-edge secret from the pairing
  ceremony below. Instance identity = a stable `instance_id` minted at
  first boot and persisted in the state file (tailnet IPs move; the id is
  the identity).
- **Privacy by default:** enforced by ENDPOINT SCOPE, not by a filter.
  `/api/mesh` carries the coarse projection only — presence, per-engine
  idle signal, queue depths, session counts, active lease counts. Never
  job ids, titles, URLs, or payloads. `/api/state` keeps its anonymous
  dashboard read unchanged.
- **Work portability / job-stealing:** deferred by #50 D4. The read plane
  carries no payloads, so nothing here prejudges it.

## What this issue still has to settle

1. **The pairing ceremony.** One-time code or device key, initiated from
   the desktop app. It establishes the per-edge control secret between two
   `instance_id`s. Grill: where the secret lives (state file vs a separate
   credentials file — the state file is the only persistence today, and
   putting a secret in it means it rides every atomic save), how it
   rotates, and how unpairing revokes (immediate next-action denial).
2. **The control-action contract.** Pause/resume/reorder across instances.
   The override-route shape (`POST /api/clients/:ref/override`,
   `POST /api/sessions/:token/override`) is the precedent. Decide: does
   the target arbiter apply the action to its OWN client rows (it owns
   them), and is the requesting instance recorded in the target's event
   log for audit? Audit is an acceptance criterion — say how.
3. **The read-plane shape.** `/api/mesh` response schema, and the fetch
   age past which a peer renders offline. Snapshots are EPHEMERAL (never
   written to `state.json`) — keep it that way.
4. **Dashboard mesh view.** Local machine first-class, peers as read-only
   snapshot rows. The Swift menubar/desktop point at the LOCAL arbiter and
   inherit the view; they never fan out to peers themselves.

## Acceptance criteria

- Two machines' arbiters, zero pairing: each shows the other's presence +
  per-engine idle state + queue depths. Neither can see job ids, titles,
  URLs, or payloads.
- Neither arbiter can grant a lease against the other's engine (the
  reference row carries no detector — fail-closed by construction).
- After pairing A → B: A can pause/resume/reorder work B owns; every
  relayed action appears in B's arbiter event log with the requesting
  `instance_id`.
- Unpairing revokes immediately (next action denied).
- No new inbound listening port on any client machine (verify with
  `lsof -nP -iTCP -sTCP:LISTEN` before/after). Arbiters may listen — they
  already do.
- `/api/state` shape unchanged apart from the ADDED `mesh` key.

## Sequencing

Unblocked by #50 (transport + identity locked). Independent of the #41-#48
sessions chain. #54 (Linux peer) and the metrics issues ride the same read
plane.

## Related (not duplicates)

- #50 — mesh decision lock (parent; `docs/architecture/mesh.md`).
- #38 — topology lock (endpoint table + client router make "sharing an
  engine" a defined relation).
- #13 — adapter registry. #16 — desktop app (the pairing UI's home).

# Mesh topology — issue #50 (decision lock, 2026-10-04)

The vision spine. One idlefill instance per machine; each machine's arbiter
owns only its local engine; instances federate ("mesh"). A machine leaving
the network takes its engine, queue, sessions, and arbiter with it. Peers
keep running their own work on their own engines. This supersedes the
earlier "the desktop client becomes the arbiter" framing.

Why this is a split, not a rewrite (verified against the code):

- The arbiter is already sharded per engine. Detectors live in a Map keyed
  by `server_id` (`server/src/arbiter.ts`); the idle verdict, the reidle
  gate, the concurrency cap, and preemption are all evaluated per server.
  A server row with no detector is fail-closed for grants.
- The idle detector already demands co-location: the `log_glob` mtime
  signal (`server/src/idle.ts`) reads the engine's log file. Only a process
  on the inference host can read it. That is why the arbiter container
  already runs on urza.
- The arbiter is already multi-server: `ServerConnection` rows are seeded
  from config and operator-managed via `/api/servers`. Today exactly one
  row carries a detector.

## The three rules, restated for the mesh

Unchanged from #38, now scoped per machine:

1. **Grants fail closed per engine.** Engine ownership is EXCLUSIVE: only
   the owning machine's arbiter holds a detector for that engine and may
   grant leases against it. A non-owning arbiter may hold a reference row
   (display + routing target, `watched: false`) — it is fail-closed for
   grants by construction. No two arbiters ever decide admission for the
   same engine.
2. **The session gate fails open per machine.** It lives in the client
   router (loopback proxy), unchanged.
3. **State is published, never computed remotely.** Federation moves
   snapshots, never decisions.

## D1 — Federation transport: read-through pull, no hub, no gossip

Rejected: gossip (N² channels, a sync protocol, consistency machinery —
far past a personal fleet of a handful of machines) and relay (a relay is
a hub).

Locked: **each arbiter pulls a coarse snapshot from each peer on its poll
cadence and publishes the merged view.** Each arbiter stays the single
source of truth for its own machine. There is no state-sync protocol and
no cross-arbiter write in this wave.

- Peer registry: arbiter config `mesh_peers: [{ url, name }]`.
  **Naming note:** do NOT reuse `server_peers` — that key already means
  llama-swap `peer:` backends (display metadata). `mesh_peers` is the
  federation registry.
- Fetch cadence: the existing `poll_ms` tick (15 s today). A peer fetch
  failure is not an error: the peer row keeps its last snapshot with a
  growing fetch age; past a threshold it renders offline (exception-only,
  same posture as a stale client row).
- Snapshots are EPHEMERAL: held in memory (like detectors), never written
  to `state.json`. A peer snapshot is remote truth; persisting it would
  create stale remote truth on disk and bloat the state file. Restart =
  empty mesh view until the first fetch.
- Addressing: tailnet URLs (the fleet is already on the tailnet; urza's
  engine URL is a 100.105.x.x address). A laptop's arbiter is reachable at
  its tailnet address while online; offline = fetch fails = peers show it
  offline. "Leave the network, take your state with you" falls out.
- The merged view rides `/api/state` under a NEW key `mesh: { peers: [] }`
  (ADD keys, never rename — the back-compat rule). The dashboard renders
  the local machine first-class and peers as read-only snapshot rows.

## D2 — Identity and auth: fleet read token now, pairwise upgrade later

Three auth planes, locked:

| Plane | Who | Secret | Scope |
|---|---|---|---|
| Local admin | dashboard, menubar, desktop, MCP, the embedded client | existing `api_tokens` (per instance) | everything today; unchanged |
| Mesh read | peer arbiters | one shared fleet `peer_token` (read-only) | `GET /api/mesh` only |
| Mesh control | paired peers | per-edge secret from the #39 pairing ceremony | full peer visibility + relayed control actions (#39 builds this) |

- The anonymous `GET /api/state` dashboard read is UNCHANGED. The mesh
  read plane is a NEW scoped endpoint (`/api/mesh`), not raw `/api/state`:
  it carries the coarse projection only — presence, per-engine idle
  signal, queue DEPTHS, session counts, active lease counts. Never job
  ids, titles, URLs, or payloads. That is #39's privacy-by-default
  boundary, enforced by endpoint scope rather than by a filter.
- Instance identity: each arbiter mints a stable `instance_id` (random
  hex, persisted in its state file at first boot) + a config `name`. The
  snapshot carries both. Peer registry entries key on URL; the arbiter
  records the observed `instance_id` per URL (tailnet IPs move; the id is
  the identity — same posture as the client registry's observed-IP rule).
- Pairwise pairing (#39) stays the upgrade path for cross-instance
  CONTROL. The ceremony is out of scope here; the identity model it plugs
  into is locked above.

## D3 — Surfaces: every arbiter serves the dashboard; local-first

- Every arbiter serves the dashboard and `/api/state`. The mesh view is
  the same page: local machine first-class, peers as snapshot rows.
- The dashboard becomes the universal mesh surface — this is what makes
  Linux first-class (#54) without a native-UI rewrite.
- The Swift menubar/desktop apps point at the LOCAL arbiter (the machine's
  own fused instance) and inherit the mesh view. They stay thin clients of
  one origin; they never fan out to peers themselves.

## D4 — Work portability: explicitly DEFERRED

Every machine owns its own work (today's model). "Out-of-office" queued
work — a laptop's queue keeps getting worked by peers while the laptop is
gone — is a future feature: work-stealing over the federation channel.

The gate on it: a job is stealable only if its payload and executor run
on the stealing machine — same repo checkout, same adapter, same payload
vocabulary. That constraint decides whether the mesh needs a shared
project concept. Record: do NOT build it in this wave. The read plane
carries no job payloads (depths and counts only), so nothing built here
prejudges it.

## D5 — Packaging: one fused process per machine; authority follows the engine

Target shape: ONE idlefill process per machine = arbiter + client daemon +
gate + surfaces.

- The fused entry starts the arbiter (tick loop, HTTP, WS, dashboard) and
  an in-process client daemon. The daemon's register/heartbeat/WS path is
  UNCHANGED — it just talks to loopback instead of the tailnet. No new
  wire protocol.
- The rule that keeps admission honest: **a client daemon asks for leases
  from the arbiter that owns its engine.** On engine-host machines that is
  the local fused arbiter (`server_url` = loopback). On an engine-less
  machine the daemon's `server_url` stays the engine host's arbiter —
  today's Mac shape, unchanged behavior.
- Uniform packaging: the fused binary runs the arbiter everywhere. A
  machine with no local engine runs it with zero local server rows — a
  viewer arbiter (dashboard + mesh view + its own surfaces). `servers: []`
  is a valid, honest configuration, not a degraded one.
- Engine-less machines during migration may keep the client-only shape;
  the fused binary is the artifact either way.

### Migration path from today's split

1. **Read plane first (additive, zero lease behavior change):** add
   `mesh_peers` config, the peer fetcher, `GET /api/mesh`, and the
   `mesh` key on `/api/state` + a peer strip on the dashboard. urza's
   arbiter and any second arbiter see each other. Nothing about leases,
   gates, or sessions changes.
2. **Fuse on the engine host:** urza's container becomes the fused app
   (arbiter + embedded client; urza gets a client only if it queues work
   locally). The Mac clients keep registering to it — same wire, now
   loopback-capable.
3. **Flip a machine when it owns an engine:** a laptop that starts
   serving its own model flips its config to the fused shape (one local
   server row, `server_url` → loopback). Its old arbiter registration
   simply stops; no state handoff is needed because state never left.
4. **Engine-less Macs today:** unchanged. Their arbiter stays urza's.

## Endpoint / identity table (#38 style)

| Surface | Direction | Auth | Notes |
|---|---|---|---|
| `GET /api/mesh` | peer → peer (pull) | fleet `peer_token` (read-only) | NEW. Coarse snapshot: `instance_id`, `name`, per-engine signal, queue depths, session/lease counts. No job ids, titles, payloads. |
| `GET /api/state` | local surfaces | local `api_tokens`; anonymous read as today | UNCHANGED shape; ADDS `mesh: { peers: [] }` (ephemeral snapshots + fetch age). |
| `POST /api/*` (control) | local only | local `api_tokens` | UNCHANGED. Cross-instance control = #39 paired channel, deferred. |
| `WS /api/leases/events` | daemon ↔ owning arbiter | token as today | UNCHANGED. Loopback in the fused shape. |
| `POST /api/clients/register` etc. | daemon ↔ owning arbiter | token as today | UNCHANGED. "Owning" = the arbiter that owns the engine the daemon works against. |

## Consequences for the filed issues

- **#39 (peer discovery):** re-scoped. The rendezvous is the read plane —
  presence + coarse depth already ride every arbiter's mesh snapshot with
  zero pairing. The pairing ceremony + control relay ride a paired
  federation channel: outbound HTTP from the requesting arbiter to the
  target arbiter, authenticated per-edge. No new inbound surface on client
  machines — arbiters already listen; clients never do.
- **#51 (metrics/history):** the store is per arbiter (per machine); the
  mesh aggregates per-machine stores at read time. Retention stays local.
- **#52 (metrics exporter sidecar):** co-located with each engine — in the
  fused shape it is a module of the local arbiter, not a separate process.
- **#54 (Linux client):** a Linux machine runs the fused binary; the
  dashboard is its surface. First-class by construction, not by port.

## Pitfalls for the implementation wave

- `server_peers` ≠ `mesh_peers`. The former is llama-swap backend
  metadata; do not overload it.
- Peer snapshots never enter `state.json` (bloat + stale-remote-truth).
- `/api/mesh` must not become a second `/api/state`: coarse by default,
  enforced by endpoint scope.
- A reference row for a remote engine must carry no detector — the
  fail-closed rule is what keeps two arbiters from both granting one
  engine.

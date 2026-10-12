# container-ops — settings-gated Docker visibility: logs, exec, deploy (issue #87 grilling, 2026-10-12)

Status: **PROPOSED** — D1..D6 await the owner. Filed by
`docs/architecture/fleet-hierarchy.md` D5 ("deliberately NOT designed
here — filed for a future grilling"); this doc is that grilling.
The owner settled the vantage question during the grill (2026-10-12,
D1): **urza flips to a NATIVE install** — the fused idlefill process runs
on the host, once the CLI wave (`docs/architecture/cli.md`, #88–#92) is
complete — so the machine's own daemon carries the Docker vantage. No
container-specific host helper is built, and the earlier D5 sketch
(client daemon reports coarse rows) stands as written.

Verified against HEAD `aa2ddb8`. No container code exists anywhere yet
(no `ContainerRow`, no `containers` key in `server/src`) — the plane is
greenfield, so the mechanism is settled once.

## The vantage problem — transitional, and solved by shape, not by plumbing

While urza ran a containerized arbiter, no idlefill process on that
machine could see dockerd:

- urza's arbiter ran as a non-root docker container with **no git, no
  docker socket, no host write**; mounting the socket was considered and
  REFUSED — "root-equivalent host control inside the plane that gates
  background work" (`docs/architecture/mesh-update.md:10-13`).
- The fused client daemon lived inside that same container
  (`docs/architecture/mesh.md` D5 migration step 2).
- The `log_glob` precedent (`server/src/idle.ts:7`) demands co-location
  with the log FILE; a container log on the host's dockerd is not a file
  the in-container arbiter can open.

The owner's answer (2026-10-12) is the mesh.md D5 target shape taken
seriously: urza gets a **native install** — one host-level fused process
(arbiter + client daemon), the same shape the macOS LaunchAgents already
run. Docker access is then ordinary host-process access: the daemon
inherits the operator user's docker-group membership — the same class of
privilege it already exercises running executor commands and
`scheduled_rebuild.command` via the shell (`client/src/config.ts:23,96`).
The socket refusal stays correct for the container era and simply stops
binding: nothing new is granted INTO the plane that gates background
work; the plane itself moves onto the host where the operator's own
tools already live.

Consequences held:

- **The update plane is untouched.** `host-updater.mjs` (mesh-update D3)
  answers a different question — swapping the very arbiter running it —
  and stays exactly as locked; native urza just points its `command` at
  the macOS-style `./update.sh` shape instead of the image-swap script.
- **The transition posture is honest absence.** While urza is still
  containerized it reports no `containers` key — the card hides, the
  routes name their refusal (`helper_absent`-style absence, the existing
  old-build tolerance), and NO bridge is built for the gap. When urza
  flips native and the operator turns the gate ON, the plane opens.
  The flip itself is an operational step gated on the CLI wave's
  completion — not a container-ops code slice.

## D1 — The Docker vantage is the machine's own fused daemon; rows ride the register heartbeat — PROPOSED

The client daemon (in-process with the arbiter in the fused shape,
separate on today's split Mac shape — one mechanism either way) scans
`docker ps` and reports coarse rows
`{ name, image, state, ports? }` — the fleet-hierarchy D5 sketch,
restored whole: `ClientRecord.containers` as an **ADD key on the register
heartbeat**, exactly the `hermes_jobs` precedent
(`client/src/index.ts:1253-1276` build; `server/src/api.ts:570-575`
pass-through; `server/src/arbiter.ts:806,870` store-if-present).

- client == machine is already locked (fleet-hierarchy D3: agents render
  as machine children from the `ClientRecord`), so containers as a
  client-row child IS the machine-node child the tree wants.
- Sanitize at the POST boundary, per key, the `sanitizeHostStats` /
  `sanitizeSnapshot` discipline (`server/src/host.ts:68`,
  `server/src/mesh.ts:1018`): garbage drops the key, never the plane.
- The rows persist on the `ClientRecord` like `hermes_jobs` do — but the
  card renders ONLY from a FRESH client row (the 90 s `last_seen` rule,
  `server/src/api.ts:980`): a dead client's last rows never pose as live.
- Log tails are the exception: too much volume for `state.json` — they
  live in an ephemeral in-memory block on the arbiter (the mesh-snapshot
  posture: never written, empty after restart). See D3.

## D2 — The settings gate is a per-machine `containers` key in the client's config.json, default OFF — PROPOSED

The gate lives where the scan runs, in the machine's own client config
(the same file the #61 editor and the CLI write back to):

```json
"containers": {
  "enabled": true,
  "exec": true,
  "logs": { "tail": 200 },
  "deploys": [{ "name": "fleetlink", "dir": "/mnt/docker/fleetlink" }]
}
```

- Absent key (the default) = the daemon never shells `docker` at all,
  publishes nothing, and the whole plane stays closed — opt-in per
  machine, exactly the owner's 2026-10-12 review rule.
- `enabled` gates reporting + logs; **`exec` is a SECOND opt-in** —
  reporting ON does not imply exec ON (the issue's "exec-capable surface
  must be opt-in" rule).
- `deploys` is an allow-list of host-owned deployment dirs; an empty or
  absent list means deploy is never offered, whatever the UI asks.
- The heartbeat's `ops` sub-block advertises what this machine will do
  (`{ exec: true, deploys: ["fleetlink"] }` — names only); the dashboard
  renders buttons ONLY from it, and arbiter routes answer named refusals
  (`exec_disabled`, `deploy_not_allowed`, `containers_disabled`) rather
  than inventing policy. One truth, no server-config mirror.

## D3 — Logs: the daemon tails per heartbeat, the arbiter buffers (ephemeral, capped), surfaces poll — PROPOSED

1. While `enabled`, the daemon runs `docker logs --tail <tail> --since
   <last observed ts>` per opted-in container and attaches the chunk to
   the register heartbeat (the same authenticated channel — no new
   inbound surface anywhere).
2. The arbiter keeps a per-container ring buffer in memory — cap ~500
   lines / 64 KiB — ephemeral, NEVER in `state.json`, with the last-
   heartbeat age kept honest.
3. `GET /api/containers/:id/logs?tail=N` answers the tail + age from the
   buffer; the dashboard's log drawer polls while open. Tail freshness
   = the heartbeat cadence, LABELLED — a poll gap costs lines and the
   age says so (exception-only honesty).

Rejected: (a) SSE tail endpoint on the daemon — the dashboard is a thin
client of ONE origin (mesh.md D3); the daemon is not a surface.
(b) WS streaming (leases-events style) — real flow-control machinery for
a personal fleet's log peek; polling with a labelled age is the house
cadence posture (the mesh pull, the heartbeat itself).

## D4 — Exec: local admin plane ONLY; a command never crosses a machine boundary — PROPOSED

Chain: dashboard (local admin token) → `POST /api/containers/:id/exec`
(the local admin plane — mesh.md endpoint table: `POST /api/*` control,
"local only") → the arbiter queues an **ephemeral exec intent**
(in-memory, single-flight per container, TTL ~60 s) → the daemon claims
it on its next cycle (`GET /api/clients/:ref/container-intents?pending=1`
+ atomic claim + result report — the claim posture of
`/api/update-intents/:id/claim`, `server/src/api.ts:1705`, one mechanism
whether the daemon is loopback or fused in-process) → `docker exec
<container> <argv...>` via spawn with NO shell (argv array; the arbiter
never shell-interpolates) → `{ ok, exit_code, stdout_tail }`, 30 s
timeout, output capped ~64 KiB → the drawer renders it.

Why exec is local-only, settled hard:

- `docs/architecture/mesh-update.md` builds "NO general remote-exec
  surface" and locks "No route accepts a command, path or version from
  any peer, ever". The mesh action set is exactly
  `pause|resume|force|clear|reorder|update` (`server/src/api.ts:1521`)
  and the local relay admits `update` only (`server/src/api.ts:1658`).
  None of that widens here.
- mesh.md rule 3 ("state is published, never computed remotely")
  tolerates VERB-only actions under a paired edge because nothing
  executable rides the wire. Exec IS an arbitrary payload on the wire;
  extending `i_control` to it would need signed envelopes + a
  target-side command policy — #39 control-plane territory, recorded as
  the future path, NOT built or pre-approved here.
- The local honesty check: the local admin token already owns
  `config.json`, whose executor templates / `scheduled_rebuild.command`
  the daemon runs via the shell. A local exec route adds no NEW
  privilege class on that machine. What stays inviolable is the machine
  boundary, not the local one.

Exec intents are EPHEMERAL (in-memory), unlike deploy intents: a restart
must never resurrect a forgotten shell command, and an exec that missed
its daemon by 60 s is simply dead — the refusal is named, the UI never
shows fake progress.

Audit: each applied action appends a `logMeshControl`-style event
(`server/src/arbiter.ts:2120`) — `container_exec`, source `local`,
container NAME only, never the argv.

## D5 — Deploy: the compose file is host-owned; the verb carries a NAME from the machine's allow-list — PROPOSED

Deploy is the `update` verb's shape, exactly:

- A **persisted** intent — the `UpdateIntents` store gains a `kind`
  field (`'update' | 'deploy'`, schema bump, same 0600 atomic file,
  same TTL→stale + single-flight discipline, `server/src/update.ts`):
  `{ kind: 'deploy', name }`. Single-flight stays per-kind (an update
  and a deploy do not serialize against each other).
- `name` must match the machine's `deploys` allow-list (D2); the daemon
  refuses anything else, so a bug above the daemon still cannot touch a
  host dir the operator did not name. The arbiter pre-checks against
  the advertised names for a fast named refusal.
- The daemon runs `docker compose -f <dir> pull && docker compose -f
  <dir> up -d` — **pull policy is the compose file's own concern
  (host-owned)**; no compose content, image ref, tag, or path ever
  enters arbiter state or the wire. "Which plane owns the compose file":
  the HOST does — the same convention urza's deploys share
  (`/mnt/docker/<x>/`, fleet-service.md D7).
- Surfaces: the deploy action exists ONLY on an advertised name,
  two-step confirm like the update button (mesh-update D4); intent
  chips show queued/running/done/failed/stale with the daemon's named
  detail. Gate OFF = queued → stale, naming itself.

## D6 — Privacy: nothing about containers rides the mesh — PROPOSED

- `ContainerRow` stays `{ name, image, state, ports? }` — the D5 shape
  from fleet-hierarchy — sanitized on the heartbeat boundary. It rides
  `ClientRecord` (local registry) and **never** `MeshSnapshot`: the
  fleet-hierarchy D5 rule stands (cross-machine need is unproven; add
  it to the snapshot only when a consumer exists).
- Logs, exec output, deploy detail: local-only, ephemeral, capped, never
  persisted, never on `/api/mesh`. The coarse-by-construction boundary
  (#39) holds trivially because the ops plane never crosses a machine.
- If a future wave wants peer-side container ops over `i_control`, the
  gate is recorded in D4: signed envelope + target-side allow-list
  policy, #39 expansion territory — and this doc does not pre-approve
  it.

## Endpoint / wire table (all ADD; no new inbound surface)

| Route | Direction | Auth | Notes |
|---|---|---|---|
| `POST /api/clients/register` ADD keys `containers` (rows + `ops`) and `container_logs` (tails) | daemon → owning arbiter (loopback when fused; today's wire otherwise) | client token, as today | hermes_jobs precedent; sanitized per key; tails payload-capped |
| `GET /api/clients/:ref/container-intents?pending=1` + `.../claim` + `.../result` | daemon → arbiter | client token | ephemeral exec queue + persisted deploy intents; atomic claim |
| `GET /api/containers/:id/logs?tail=N` | surfaces | as `/api/state` today | tail + age from the ephemeral ring |
| `POST /api/containers/:id/exec` | surfaces | local `api_tokens` | `exec` sub-gate; ephemeral single-flight intent |
| `POST /api/containers/:id/deploy` | surfaces | local `api_tokens` | `{name}` from the advertised allow-list |
| `clients[].containers` on `/api/state` | surfaces | anonymous read as today | rendered ONLY from a FRESH client row (90 s rule); absent = closed |

Back-compat both directions: old arbiter + new daemon = the heartbeat's
new keys ignored (ADD-key tolerance, the register body already ignores
unknowns); new arbiter + old daemon = no key, card hidden, ops routes
name their refusal. `MeshSnapshot` untouched, byte-for-byte.

## Migration slices (each ships green on its own)

1. **C1 — reporting (implements S3 exactly as fleet-hierarchy sketched).**
   Gated daemon scan + heartbeat ADD keys + `ClientRecord` store +
   machine-node card. Zero ops surfaces.
2. **C2 — log plane.** Tail loop + ephemeral ring + logs route + drawer
   (polls while open).
3. **C3 — exec (local only).** Ephemeral intent queue + console in the
   drawer, `exec` sub-gate, audit events.
4. **C4 — deploy.** `kind` on the intent store + allow-list + button +
   chips.
5. **(operational, not a slice) urza's native flip** — gated on the CLI
   wave (#88–#92) completion per the owner (2026-10-12); until then
   urza honestly shows nothing.

## Explicitly out of scope / rejected

- A container-specific host helper — the answer to urza's missing
  vantage is the native install (owner, 2026-10-12), not extra plumbing;
  the mesh-update host-updater stays exactly as locked (its problem —
  swapping a running arbiter — is different and survives the flip).
- Docker socket into any container — the mesh-update refusal stays
  refused for the container era; the native shape makes it moot.
- Cross-machine exec/deploy/logs over `i_control` — no command ever
  crosses a wire; the future gate is recorded in D4/D6, not built.
- Arbiter-side compose authoring — host owns compose files; the gate and
  the allow-list live in the client config.
- A fleet containers registry — the fleet service stays identity-only
  (fleet-service.md hard boundary, unchanged).
- Streaming (SSE/WS) for logs — heartbeat-cadence polling with a
  labelled age.

## Owner choices left open

1. D2 numbers: log ring cap, tail size, exec timeout/output caps —
   recommendations inline, bikeshed-able.
2. D4: confirm exec stays LOCAL-only this wave (the recommendation is a
   hard no on mesh exec).
3. Sequencing: C1 may ship alongside the fleet-hierarchy S1/S3 wave
   (same mechanism, same surfaces); C2–C4 ride the ops plane.

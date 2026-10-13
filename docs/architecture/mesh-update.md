# mesh-update — dashboard-triggered machine updates (LOCKED 2026-10-12, owner decisions)

The Machines tab can ask ANOTHER machine to update its idlefill install.
This document locks the shape of that plane; it rides the #39 control
relay and the build-from-checkout lock, and it deliberately builds NO
general remote-exec surface.

## Why a helper (the context the owner chose against)

The target of an update is a MACHINE, not an arbiter row. On urza the
arbiter runs as a non-root docker container with no git, no docker
socket and no host write — it cannot swap itself, and mounting the
socket was considered and refused (root-equivalent host control inside
the plane that gates background work). The daemon and the arbiter carry
no updater (README "Updating": build from a checkout on every machine
that runs it). So the arbiter's role is strictly: **receive a signed
intent, record it, and hand it to the host** — the host's own updater
helper performs the documented build-from-checkout update. The arbiter
executes nothing.

## D1 — Authorization: paired edges only (LOCKED, owner choice)

An update request is admitted ONLY over a paired edge in the right
direction, with zero new credentials:

- The requester's LOCAL `mesh_edges.json` record for the target must be
  `direction: "i_control"`; the target admits only a `controls_me`
  request (the #39 D5 direction rule, unchanged). An unpaired machine
  gets the named `unknown_instance_id` denial; no edge is minted by any
  new route.
- Wire chain: dashboard (local admin token) → local admin-plane route
  `POST /api/mesh/control/:peer_instance_id` → the local arbiter signs
  the #39 envelope (its own identity key; path-bound ts + single-use
  nonce) → the target's existing `POST /api/mesh/control` guard chain
  (signature under the stored peer key, direction, freshness, replay) →
  the action. Exactly one new verb joins the action set: `update`. The
  local relay admits `update` ONLY — it is not a general control proxy.

## D2 — What lands on the target: an intent, never a command (LOCKED)

- `update` creates a persisted **update intent** (next to the state file
  as `update_intents.json`, 0600, capped at the last INTENTS_CAP
  entries): `{ id, source_instance_id, requested_at, state, ... }` with
  states `queued → running → done | failed`, plus `stale`.
- NOTHING executable crosses the wire. The verb is the entire payload;
  what "update" means is a per-machine constant owned by the host helper
  (its own 0600 config). No command, args, path, URL or version rides
  the request — a compromised controller cannot name what runs.
- Single-flight: at most ONE live (queued/running) intent at a time; a
  second request answers 409 `update_in_flight`. A queued intent that no
  helper claims within `UPDATE_INTENT_TTL_S` (default 300 s) flips to
  `stale` and can never execute — a forgotten click does not fire a
  deploy hours later. The operator sees the state (the dashboard chips;
  no helper = the intent names itself stale; never a fake progress).
- Audit (#39 D7 unchanged): the TARGET logs `mesh_control update` with
  the requester's `source_instance_id`, plus `update_started`,
  `update_done` / `update_failed` events as the helper reports. The
  requester logs `update_requested` locally.

## D3 — The host-side updater helper (LOCKED shape)

- One small per-machine helper (`scripts/host-updater.mjs`), a systemd
  USER unit on Linux (urza) / LaunchAgent on macOS — same install
  discipline as the client service (render → byte-verify → bootstrap).
- Loop: poll the LOCAL arbiter (`GET /api/update-intents?pending=1`)
  with the local admin token from its 0600 config; claim exactly one
  intent (`POST /api/update-intents/:id/claim` — the arbiter's
  single-flight makes claim atomic); run the machine's documented
  update command; report (`POST /api/update-intents/:id/result`).
- Commands, by machine: urza = `scripts/native-selfupdate.sh` since the
  native cutover (2026-10-13: fast-forward main in the checkout the units
  run from, `npm install` only when the lockfile moved, rebuild `cli/`,
  restart the arbiter + client units, healthcheck, roll the checkout back
  to the previous commit on failure). Before the flip urza ran
  `scripts/urza-selfupdate.sh` — that script stays as the CONTAINER path
  (fetch main, build the image from the committed tree exactly as
  scripts/deploy-server.sh builds it, swap the container, tailnet
  healthcheck, roll back to the previous image on failure) for any Linux
  box still deployed that way; macOS = `./update.sh`. The helper refuses
  to run if its command is unset — an unconfigured helper never executes
  anything.
- The helper talks to its OWN loopback arbiter only; the token never
  crosses the wire.

## D4 — Surfaces

- `/api/state` gains the ADD key `update_intents` (the last few intents:
  state + source + ages — coarse display words, no secrets) and each
  `mesh.peers[]` row gains `i_control` / `controls_me` booleans from the
  LOCAL edge store, so the dashboard can gate the button honestly.
- The Machines tab: the update button exists ONLY on a peer whose row
  carries `i_control`; it is a two-step confirm (one click arms
  "confirm?" for 3 s); the result is a named toast (queued /
  update_in_flight / not_paired / direction_denied / …). No local update
  button: This Machine updates by the operator's own command line.

## Consequences

- The update plane cannot be reached without pairing first; pairing
  stays #55's ceremony (or, while the fleet service is unwired, the
  operator's manual `EdgeStore` records on BOTH sides — one record
  `i_control` here, its mirror `controls_me` there).
- A machine without the helper installed shows up as exactly that:
  queued → stale. The button answers `queued`; the chip tells the truth.
- No route accepts a command, path or version from any peer, ever.

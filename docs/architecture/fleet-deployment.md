# Fleet service deployment (D7)

Companion to `docs/architecture/fleet-service.md`. D7 is LOCKED: the urza
host, tailnet-only reach, `fleet.samwarth.com`. This doc says how the
fleet service (`fleet/`, #55 slice 3) runs there. The templates and the
health check live in `fleet/deploy/`. Nothing here is live infra. The
live values stay on the host, out of git.

## Where it runs

- Host: urza (LOCKED, D7). The public ingress box. The `*.samwarth.com`
  LE cert lives there.
- Deploy dir: `/mnt/docker/fleetlink/` (PROPOSED). An own dir under the
  urza deploy root. State on a volume.
- Runtime: dependency-free Node (LOCKED, D7). `node:http` only. The
  service runs from a working-tree checkout, not a container image
  (PROPOSED): `npx tsx fleet/src/index.ts`. The client service uses the
  same pattern (`deploy/systemd/idlefill-client.service.template`).

## How it is reached

- Tailnet only (LOCKED, D7). No published port.
- Host name: `fleet.samwarth.com` (LOCKED, D7). Routed behind
  `middleware-local-ip-range` like the other private routes.
- Port: 8789 (PROPOSED). The default in `fleet/src/config.ts`.
- The service is a directory, not a pipe (D7). A peer pulls `GET /roster`,
  then pulls the arbiter directly over the tailnet.

## How it starts

- Linux (urza, the D7 primary host): the `fleetlink` systemd user unit
  (`fleet/deploy/fleetlink.service.template`). Render `@REPO@` and
  `@NPATH@`, copy to `~/.config/systemd/user/`, `daemon-reload`, `start`,
  then `loginctl enable-linger <user>`.
- macOS: the `com.sam.idlefill.fleet` LaunchAgent
  (`fleet/deploy/com.sam.idlefill.fleet.plist`). Copy it to
  `~/Library/LaunchAgents/`, then `launchctl bootstrap`.
- Config: `fleet/config.json` on the host (gitignored). Three keys:
  `listen` (PROPOSED 8789), `db_file` (PROPOSED
  `/mnt/docker/fleetlink/fleet.db`), `token_ttl_ms` (LOCKED default
  900000). Seed it from `fleet/deploy/config.example.json`.

## How it restarts

- Crash or signal death: `Restart=on-failure` (systemd) or `KeepAlive
  SuccessfulExit=false` (launchd). The SQLite file (D6) is durable state.
  A restart loses no roster row and no token.
- A clean `exit(0)`: no restart. The restart rule is on-failure, not
  always.
- Throttle: 30 s between restarts (`RestartSec=30` /
  `ThrottleInterval=30`).
- A code update is a `git pull` plus a unit or agent restart. The boot
  revision is `git rev-parse HEAD` in the checkout.

## How the SQLite file is backed up

- The db is one file (D6: a file, not a server). A backup is a file copy.
- Stop the service (or hold a read lock), copy the db file off-host, then
  resume (PROPOSED cadence: a full copy every 24 h, kept for 14 days).
- The file is small. A full copy is cheap. A partial copy is the only
  risk. Copy while the service is idle, or stop it first.
- The enrollment token is hashed at rest (sha256). A backup never
  reveals a live token.

## What the operator must provision

1. The urza host and the `fleetlink` deploy dir (PROPOSED
   `/mnt/docker/fleetlink/`).
2. The tailnet and the `fleet.samwarth.com` route behind
   `middleware-local-ip-range` (LOCKED D7. The host route itself is
   operator config).
3. The gitignored `fleet/config.json` (`listen`, `db_file`,
   `token_ttl_ms`).
4. The state dir and the db file, owned by the service user.
5. A repo checkout on the host. The service runs from the working tree.
6. A backup job for the db file (the PROPOSED cadence above).
7. An enrollment token when a new instance joins. Minted at runtime via
   `POST /token`. Never committed.

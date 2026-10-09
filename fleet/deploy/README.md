# fleet deployment templates (#55 slice 4, D7)

Token-free templates for the fleet service. They carry **no secret and no
live db path**. Copy them onto the host, substitute the host values, and
load. The repo's standing rule: infra is reproducible from the repo. Live
secrets and live configs stay on the host, out of git.

## Files

- `fleetlink.service.template` — systemd **user** unit (Linux, urza).
  Mirrors `deploy/systemd/idlefill-client.service.template`.
- `com.sam.idlefill.fleet.plist` — LaunchAgent (macOS). Mirrors
  `deploy/com.sam.idlefill.server.plist`.
- `config.example.json` — the three config keys with placeholder values.
- `health.sh` — a reachability health check (no key needed).

## urza (Linux, the D7 primary host)

1. Copy the template to the user's systemd dir:
   `cp fleet/deploy/fleetlink.service.template ~/.config/systemd/user/fleetlink.service`
2. Substitute the two placeholders (never ship `@`-tokens live):
   - `@REPO@` → the absolute repo checkout path (e.g. `$HOME/idlefill`).
   - `@NPATH@` → the dir holding `npx` (`$(dirname "$(command -v npx)")`).
3. Provision the gitignored host config from the example:
   `cp fleet/deploy/config.example.json fleet/config.json` and set `db_file`
   to the host state dir (PROPOSED: `/mnt/docker/fleetlink/fleet.db`). The
   state dir must exist and be owned by the service user.
4. `systemctl --user daemon-reload`
   `systemctl --user start fleetlink`
   `loginctl enable-linger <user>` (start at boot, survive logout)
5. Check: `fleet/deploy/health.sh 8789 urza` (over the tailnet) or
   `fleet/deploy/health.sh` locally.

## macOS

1. Copy the plist:
   `cp fleet/deploy/com.sam.idlefill.fleet.plist ~/Library/LaunchAgents/`
2. If the checkout is **not** `/Users/sam/Software/idlefill`, replace the
   two hard paths (`ProgramArguments` index path + `WorkingDirectory`) and
   the two log paths with your checkout's paths.
3. Provision `fleet/config.json` from the example (same as step 3 above).
4. `mkdir -p fleet/logs`
5. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sam.idlefill.fleet.plist`

## What to replace (both hosts)

| Value | Where | Replace with |
|---|---|---|
| `@REPO@` | systemd template | absolute checkout path |
| `@NPATH@` | systemd template | dir holding `npx` |
| checkout paths + label | plist (if not the main checkout) | this checkout's paths |
| `db_file` | `fleet/config.json` (host, gitignored) | host state dir (PROPOSED `/mnt/docker/fleetlink/`) |
| `listen` | `fleet/config.json` | PROPOSED 8789 (tailnet-only) |

## Do not

- Do not put a secret, a live token, or a real db path in any committed
  file. The committed templates carry placeholders only.
- Do not publish the port. Tailnet-only reach is enforced by the host
  (D7). `middleware-local-ip-range` gates the public host.

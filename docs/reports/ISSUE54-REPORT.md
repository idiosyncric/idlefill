# Issue #54 — Linux client service (systemd)

The daemon/gate/proxy are plain Node and already ran on Linux; only the
service plumbing was macOS-shaped. This slice adds the Linux path, makes
the daemon-side control portable, and fixes the real multi-client bug the
issue's "verify nothing breaks" clause exposed.

## What was built

**systemd user unit + installer (`deploy/systemd/`, `deploy/install-client-service.sh`)**
- `idlefill-client.service.template` mirrors the plist semantics:
  `KeepAlive{SuccessfulExit=false}` → `Restart=on-failure`;
  `ThrottleInterval=30` → `RestartSec=30`; RunAtLoad → WantedBy. Logs ride
  journald. No network targets: `network-online.target` is a SYSTEM target
  that does not exist in the user manager — the daemon's retry loop +
  fail-open gate make ordering moot. (Trap caught pre-ship: the first
  draft carried `Wants=network-online.target`.)
- USER unit, not a system unit: no sudo needed for the service itself,
  per-user checkout, boot-without-login via `loginctl enable-linger`
  (already on on urza). The installer refuses to render a system unit.
- Installer follows the repo's fail-closed install discipline
  (menubar/install.sh pattern): render to temp → byte-verify (a surviving
  `@REPO@`/`@NPATH@` placeholder or an ExecStart that does not match this
  checkout aborts) → `systemd-analyze --user verify` → only then move into
  place. Refuses while a non-systemd daemon for the same checkout runs
  (two daemons under one name fight over leases). Linger: enables via
  `sudo -n`, else prints the exact command — never hangs on a password.
- `--dry-run` (CI) and `--no-start` (staged deploys).

**Linux control path (`scripts/idlefill-menubar.mjs`, portable)**
- One daemon-side control script, not a fork: `ps` adapts (`-ax` BSD →
  `-eo` procps), the Swift-app subcommands and the app row are gated
  macOS-only, `start` falls back to `npx tsx` when the repo-local shim is
  missing (same command shape as plist + unit), and `status`/`diagnose`
  gain the `unit …` line + the boot `revision` from #49.
- `stop` refuses while the systemd unit is active and routes the operator
  to `systemctl --user stop` — a SIGINT under `Restart=on-failure` reads
  as a crash and relaunches in ~30s.
- `pids` subcommand (the installer's pre-flight probe).
- "me" row selection is now name-matched (config `client_name`) with the
  online-first guess demoted to fallback.

**Multi-client correctness (desktop, `IdlefillDesktop.swift`)**
- The poll picked "me" as `first(online) ?? first`. With a second online
  client — the whole point of #54 — that guess can read the WRONG
  machine's row: the #49 staleness flag would compare another box's boot
  commit against this checkout. Fixed: name-match against
  `client/config.json` `client_name` (registration is idempotent by
  name, #10), old heuristic kept only as fallback. The menubar already
  name-matched; the dashboard iterates rows; no other surface guessed.
- Harness proof (`desktop/staleness-test.sh` case 3, "fleet"): a second
  client (`urza-linux`) listed FIRST, online, at this checkout's HEAD,
  alongside my stale row → flag stays ON. Against the old heuristic that
  payload reads the Linux row and returns false — a silent wrong-machine
  read. 12/12 pass.

**Linux CI (`.gitea/workflows/test-linux.yml`)**
- ubuntu job: full node suites + tsc + build + the installer `--dry-run`
  rendering byte-check. Targets the weakstone Docker runner
  (`ubuntu-latest` label family). `forgejo-runner validate` passes.
  STATUS: the first pushes DISPATCHED on `weakstone-runner` (labels
  ubuntu-latest/22.04/20.04 — it claims idlefill jobs fine) and FAILED
  at checkout: `Could not resolve host: app` — act_runner puts job
  containers on a per-task bridge network that cannot resolve the
  compose service name (career-ops never noticed: its approve job skips
  checkout). Fixed on the host: `container.network: forgejo-net` added
  to the runner config (bind-mounted), runner restarted and
  re-declared. CI green result recorded below.

## Gates

- `npm test` all workspaces: 126 / 76 / 17 / 2 pass, 0 fail.
- `tsc --noEmit` server + client clean; `npm run build` clean.
- `swiftc -parse` desktop + menubar clean.
- `desktop/staleness-test.sh` 12/12 (incl. the new fleet contract case);
  `desktop/sessions-test.sh` green (projection unchanged);
  `menubar/staleness-test.sh` green.
- `node --check` control script, `bash -n` installer,
  `forgejo-runner validate --directory .gitea/workflows test-linux.yml`
  clean.

## Live acceptance (urza, Ubuntu 24.04, systemd 255, node 18.19.1)

- Fresh clone at `ad002fa`, `npm ci` (61 packages; tsx 4.23 on node 18.19
  works — engine floor `>=18`), config written on-box from the server's
  own config.json (token never crossed the wire twice; `client_name:
  urza`, `server_url` the tailnet IP so `observed_ip` registers
  meaningfully — loopback would collide with the arbiter host's
  self-traffic exemption).
- `install-client-service.sh` refused once with the fail-closed guard
  working exactly as designed (`systemd-analyze verify` rejected the
  rendered unit): verify parses the FILENAME as the unit name and the
  mktemp temp had no `.service` suffix. Fixed (render into a temp DIR
  under the real unit name), installed: unit **active + enabled**,
  linger already on, `journalctl` carries the daemon log.
- `scripts/idlefill-menubar.mjs status` on Linux: unit line
  `idlefill-client active/running pid=…`, arbiter `me` row by name,
  boot `revision` line — the macOS control surface, portable.
- Fleet view (`/api/state`): `mac-sam` (obs 100.94.165.102) and `urza`
  (obs 100.105.225.1) both online, both rev-matched to the checkout
  after `git pull && systemctl --user restart` — the #49 staleness
  cycle works on Linux unchanged.
- **Real bug the second client exposed** (fixed in `b4106ae`, test (h)
  11/11): the session gate adopted EVERY arbiter session row
  (`onStatePoll` → `ensure`), so urza registered + heartbeated
  mac-sam's sessions — last-writer-wins flipped attribution between
  daemons every 10s and the idle snapshot of one cleared the other's
  gate tags. Fix: rows naming another `client_name` are skipped
  entirely; ownerless rows keep the old adopt behavior. Live proof:
  after both daemons run the fix, real traffic through the mac router
  re-claims `probe` for `mac-sam` and attribution stays stable across
  6 polls (a stolen row self-heals on its next request; the 1h session
  sweep bounds the stale case).

# urza native cutover — the arbiter moves off Docker (2026-10-13)

Owner ask: "Cutover urza to the native install and add it to the mesh again."
The vantage decision is the owner's, already locked as container-ops.md **D1**
(2026-10-12): urza flips native once the operator-CLI wave (#88–#92) completes —
that wave landed (`0a19de2` #92 S5), so the gate was open. This report is the
operational record of the flip plus the mechanism it required.

## Before → after on urza

| | before | after |
| --- | --- | --- |
| arbiter | Docker container `idlefill`, image `idlefill-server:ea4ca03` (env `IDLEFILL_REVISION=2d469b0`), `--network host --user 1000:1000`, `--restart unless-stopped` | systemd **user** unit `idlefill-server` — `npx tsx <repo>/server/src/index.ts` from `/home/sam/Software/idlefill`, `Restart=always`, journald |
| checkout | two: `/home/sam/Software/idlefill` (client daemon, stale at `b4106ae`) and `/home/sam/idlefill/src` (the container-era build checkout) | one canonical: `/home/sam/Software/idlefill` at main; `~/idlefill/src` left in place, unused |
| state | `~/idlefill/data/state.json` (bind-mounted to `/data`) | SAME file, pinned by the unit (`IDLEFILL_STATE=`) — so `instance_id m-d6d72403a67f`, the pairing edge in `mesh_edges.json`, the lease/session history and the metrics family survived unchanged |
| config | `~/idlefill/config.json`, mounted `:ro` at `/app/config.json` | copied to `<repo>/server/config.json` (0600, gitignored) — the loader's entry-adjacent candidate; `~/idlefill/config.json` untouched as the container-rollback seed |
| client daemon | `idlefill-client.service` from the stale checkout, node 18, `server_url` = urza's own tailnet IP | same unit re-rendered from the canonical checkout at main, node 22, `server_url` = `http://127.0.0.1:8787` (the fused loopback shape, mesh.md D5) |
| updater helper | `idlefill-updater.service` pointing at `/home/sam/idlefill/src`, config `command = idlefill update` (a shim for the other checkout, not on the unit's PATH) | re-rendered from the canonical checkout, node 22; config `command = bash /home/sam/Software/idlefill/scripts/native-selfupdate.sh` (absolute — PATH-independent, and D2's "no command rides the wire" posture untouched) |
| `idlefill` CLI shim | `~/.local/bin/idlefill → /home/sam/idlefill/src` | re-installed → `/home/sam/Software/idlefill` |
| container | running (surveyed as image `idlefill-server:ea4ca03`, env `IDLEFILL_REVISION=2d469b0`) | `docker stop idlefill`, **not removed** — `docker start idlefill` is the one-line rollback. The kept container now reads image `idlefill-server:2d469b0` (created 00:18 UTC): a container-era deploy landed mid-session from a concurrent worker — main also gained `2d469b0`/`05778fe` while this cutover was in flight, so the rollback image is one commit-set behind the flipped arbiter, not the surveyed one |

## Mechanism landed in the repo (this was not doable without it)

- `deploy/systemd/idlefill-server.service.template` + `deploy/install-server-service.sh`
  — the Linux counterpart of the macOS arbiter LaunchAgent, same
  render → byte-verify → move discipline as `install-client-service.sh`.
  The installer refuses a group/world-readable `server/config.json`, a non-git
  checkout (the boot revision is git-derived), and — the cutover's own fence —
  **a port that answers `/api/state` while the unit is not active**. That fence
  fired for real before the flip: it refused to install while the container held
  :8787, which is exactly the shadowing it was written against.
- `scripts/native-selfupdate.sh` — the machine-update COMMAND for a native box
  (mesh-update.md D3). Lease preflight, fast-forward main (a dirty checkout is
  refused, never reset away — this checkout also owns the daemon and the shim),
  `npm install` only when `package.json`/`package-lock.json` moved (stamp under
  `node_modules/`), rebuild `cli/` (the shim execs `cli/dist` when present),
  restart the units, healthcheck with the `.json`-suffix mktemp lesson kept
  (2b1e119), roll the checkout back to the commit the run started from on
  failure, `~/.idlefill/native-last-known-good` makes a re-run an honest no-op.
- `cli/src/update.ts`: the wrapper's Linux branch now decides on the **native
  unit first**, before docker — picking `urza-selfupdate.sh` on a native box
  would build an image and start a container that fights the running unit for
  :8787. `--no-pull` is legal on the native path. `detectMachineEnv` gains
  `nativeScript` + `nativeUnit`; +4 tests (cli 136→139).
- **Bug caught by the flip** (`5308ca9`): the client-daemon identity rule
  (`cli/src/daemon.ts daemonPids`) matched any node process of this checkout
  whose argv contained `src/index.ts` — the arbiter's `server/src/index.ts`
  included. With arbiter and daemon in ONE checkout for the first time,
  `idlefill daemon pids` reported the arbiter's processes as the client's, and
  `install-client-service.sh`'s "already running outside systemd" guard
  false-fired against the very unit it renders. Live proof on the Mac before
  the fix: `pids` answered 6 processes (both arbiters + the daemon pair); it now
  answers the daemon pair alone (62936/62937). Extracted as the pure, tested
  `isClientDaemonCmdline`; the installer filter now skips pids whose cgroup is
  `idlefill-client.service` (a hand-run daemon still refuses).

## Prerequisite: Node 22 on urza

The repo targets Node 22; urza's system node is 18.19.1 (`/usr/bin/node`).
Installed user-local, no root: `node-v22.23.0-linux-x64.tar.xz` from nodejs.org,
`SHASUMS256.txt` verified (`node-v22.23.0-linux-x64.tar.xz: OK`), unpacked to
`~/.local/tools/…`, symlinked `~/.local/node22`. Every unit carries that bin dir
as `@NPATH@`, so the arbiter/daemon/helper run 22.23.0 regardless of the login
shell. (Naming honestly: urza already had a Node 22.23.0 at
`~/.local/share/pi-node/…` exported by `~/.bashrc` — interactive shells only. A
`~/.profile`/`~/.bashrc` PATH line I first appended was wrong (it baked a literal
PATH and dropped `~/.local/bin`); it was reverted, both files are back to their
pre-cutover content.)

## Mesh: re-joined, identity unchanged

- The Mac's peer row never moved: urza is back online at the same
  `instance_id m-d6d72403a67f` (`fetch_age_s` 2–6s, `i_control: true`), so the
  control edge and the update button survived — nothing had to be re-paired.
- urza's side is where the mesh was actually broken: its `mac-sam` row pointed at
  `http://100.94.165.102:8787` and **urza cannot reach the Mac over the tailnet**
  (tailscale `ping` answers from m1-max in 3 ms, but TCP 22/8787/8888 to
  100.94.165.102 are all refused while the Mac's own firewall is disabled — an
  inbound rule on the tailnet side, not an idlefill fact). `idlefill mesh leave
  mac-sam` + `idlefill mesh join http://10.10.10.28:8787 --name mac-sam` — the
  probe answered `/api/mesh` as `m-99fdd154dd20` with the peer_token matching
  both sides, the row landed with a timestamped backup, `server_peers` byte-intact,
  and the scoped re-read applied it with no arbiter restart. urza's `mesh status`
  now reads `mac-sam … online — snapshot fetched 1s ago`.
- The build-gap counter is honest across the flip: urza publishes
  `revision 5308ca9…` (its own boot commit), and the Mac's observer names the
  Mac the stale one (`build: {relation: "ahead", ahead: 7}` — urza is 7 ahead of
  the Mac's arbiter, which still booted at `47b142c`).

## Live verification

- Healthcheck after the flip: `/api/state` → 200, `idle` block present, both
  client rows, `servers: srv-watched@http://127.0.0.1:11434`, projects 1,
  sessions 2 — the same carried-over state.
- The client daemon re-registers at loopback (`observed_ip 127.0.0.1`) with
  `revision 5308ca9`, `last_seen` seconds-old — the fused shape, and the
  build-gap line for the daemon zeroed on urza's own dashboard.
- **The update plane was exercised end to end rather than assumed**: from the
  Mac, `POST /api/mesh/control/m-d6d72403a67f {action:"update"}` →
  `202 queued u-a45b91c1`; urza's helper claimed it, ran
  `native-selfupdate.sh`, and 95 s later logged `update succeeded` +
  `result reported: done`. The arbiter restarted (new MainPID), now publishing
  `revision 5308ca9`; `~/.idlefill/native-last-known-good` = `5308ca9`. So the
  dashboard's update button on urza is a working native path, not a container
  swap waiting to fail.
- Gates at each push: `npm run test` green (server 467, client 273, cli 139,
  dashboard 64, fleet 54, adapters 17, +2 +3 — 0 fail), `npm run build` green,
  `tsc --noEmit` clean for `cli`. `bash -n` on both new shell files.

## Named, not fixed

- **llama-swap is down on urza** (pre-existing): `:11434` answers nothing while
  the system service `llama-swap-watchdog.service` is running
  (`/mnt/docker/llama-swap/watchdog/watchdog.sh`), so the engine row reads
  degraded and the arbiter's idle verdict says `activity fetch failed`. That was
  the posture before the flip too; the flip neither caused nor hid it.
- urza→Mac tailnet inbound is refused (above); the mesh row uses the LAN address.
  If the tailnet ACL is ever opened, re-point the row with `mesh leave` +
  `mesh join`.
- Kept on purpose: the stopped container + `idlefill-server:*` images (rollback),
  `~/idlefill/config.json` (the container seed config), and the redundant
  `~/idlefill/src` checkout — the owner can delete that checkout now; nothing
  runs from it.
- urza's state dir is untouched by the flip, so the arbiter's history is
  continuous; `state.json.pre-native-20261013T020451Z` is the pre-flip copy, and
  each config edit left a `config.json.bak-<stamp>` (gitignored).
- The Mac's own arbiter still boots at `47b142c` (7 behind main). Its update is
  the operator's own `./update.sh`; not run here, since this change is about
  urza and it costs a lease-window.

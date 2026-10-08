# Actions runner (Forgejo Runner, this Mac)

idlefill's CI/CD runs on a **Forgejo Runner** daemon on urza (the Mac that
also hosts the repo's main checkout, the daemon, and the Tauri app). One
runner home per repo lives under `~/Software/ci-cd/` so every runner is in
the same place — this one is `~/Software/ci-cd/idlefill-runner/`.

## What's in the repo vs. what's on the host

| Thing | Where | Why |
|---|---|---|
| Workflows (`.gitea/workflows/*.yml`) | in the repo | versioned; *define* the pipeline |
| Release tooling (`scripts/release.sh`, `scripts/drop-auto-release.sh`) | in the repo | invoked by the release workflow |
| Runner config (uuid + **registration token**) | `~/Software/ci-cd/idlefill-runner/config.yaml`, 0600 | secret; the repo is **public** |
| Runner state file (`runner`), `runner.log` | same host dir | runner's own bookkeeping |
| launchd agent (`com.sam.idlefill.actrunner`) | `~/Library/LaunchAgents/` | keeps the daemon alive across reboots |

## Setup (one-time, per runner home)

```bash
brew install forgejo-runner        # the Forgejo-correct package (NOT gitea-runner)

# 1. Create a repo-scoped runner in the UI:
#    https://git.samwarth.com/sam/idlefill/settings/actions/runners
#    -> "Create new runner". It shows a UUID + a one-time token.

# 2. Drop in the config (this dir is the template):
mkdir -p ~/Software/ci-cd/idlefill-runner
cp runner/config.yaml.example ~/Software/ci-cd/idlefill-runner/config.yaml
chmod 600 ~/Software/ci-cd/idlefill-runner/config.yaml
#    ...and paste the UUID + token into the two PASTE-... lines.

# 3. Install the launchd agent (RunAtLoad + KeepAlive, clean PATH, no NODE_ENV):
cp runner/com.sam.idlefill.actrunner.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sam.idlefill.actrunner.plist

# 4. Confirm it's polling:
tail -f ~/Software/ci-cd/idlefill-runner/runner.log
#    "declared successfully" + "[poller] launched" = healthy
```

The runner appears as **online** on the repo's Actions → Runners page.

## How jobs run (no Docker)

The label is `urza:host` — the `:host` suffix tells forgejo-runner to run
job steps as **plain processes** on the Mac instead of spinning a container
(which is also why the daemon doesn't require a Docker daemon at all). The
host must therefore have the toolchain the workflows use in `PATH`:

- node ≥ 20 (workflows pin 22 via `actions/setup-node`) + npm
- python3 (release.sh + drop-auto-release.sh glue)
- the Rust toolchain: cargo + the tauri CLI (the shell's cargo gates —
  issue #69 D9 replaced the retired `swiftc -parse` gate)

`actions/checkout` + `actions/setup-node` resolve from
`https://data.forgejo.org`, so the host needs outbound HTTPS to it (and to
`git.samwarth.com` itself).

## Gotchas learned

- **`NODE_ENV` must not reach the jobs.** If the daemon is ever started
  from a shell that has `NODE_ENV=production` exported, `npm ci` skips
  `devDependencies` and the `tsx`-based test suites die in ~3s. The
  workflows pin `env: NODE_ENV: test` to make this hermetic; the launchd
  plist additionally exports no `NODE_ENV` at all.
- **Register with the public URL** (`https://git.samwarth.com/`), not an
  internal one — jobs must be able to resolve it when they check out.
- **Repo-scoped, not instance-scoped:** the runner only runs
  `sam/idlefill` workflows. Registering at instance level would run every
  repo's workflows on this Mac.
- The `forgejo-runner register` subcommand is **deprecated** in v13 —
  registration is the `server.connections` block in the config (that's the
  uuid + token pair the UI issues). The old subcommand can't consume those
  credentials ("runner registration token not found").

## Day 2

- Watch a run: repo → Actions → the run → the job (logs stream there; the
  daemon's `runner.log` only shows lifecycle lines).
- Restart: `launchctl kickstart -k gui/$(id -u)/com.sam.idlefill.actrunner`
- Uninstall: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sam.idlefill.actrunner.plist`,
  delete the plist, and remove the runner on the Forgejo Runners page.

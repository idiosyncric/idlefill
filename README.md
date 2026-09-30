# idlefill

Run background AI work (job-queue evaluation) on a local LLM server **only when
that server has been idle**, so background work never contends with interactive
traffic.

Two parts:

- **server** — the *arbiter*: a Fastify container that watches the LLM
  gateway's activity feed (+ the inference engine's log mtime), decides when the
  box is idle, and issues/revokes **leases** to registered clients.
- **client** — a Mac daemon (e.g. this machine) that registers with the
  arbiter, asks for a lease for the next job in its queue, runs a project
  executor behind a loopback proxy, and reports usage back. Results land in
  `idlefill/data/` — never in the project repos it works for (career-ops is
  strictly read-only).

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, server (Docker), client daemon, career-ops adapter, tests | **Done** — see `npm test`, Docker build |
| 1.5 | Arbiter deployed to **urza** (2026-09-25) | **Done** — `idlefill-server:amd64`, host network, `~/idlefill/data`, token in `~/idlefill/config.json` (0600). Dashboard: `http://100.105.225.1:8787` (unauthenticated — phase-2 middleware gates it). Image built natively on urza: `docker build -t idlefill-server:amd64 server/` (urza is amd64; the Mac's arm64 image won't run there) |
| 2 | urza hardening (compose + traefik route + IP/auth middleware), launchd client, NInfer log ro-mount | **Untested** — artifacts in `deploy/` are clearly marked; nothing there has been exercised by a real deployment |

## Architecture

```
                        ┌────────────────────────────────────────────┐
                        │ urza (Docker)                              │
                        │                                            │
  interactive users ──▶ │  llama-swap :8080 (OpenAI-compat /v1)      │
                        │   ├── activity feed /api/metrics/activity  │
                        │   └── NInfer req-*.jsonl (throughput log)  │
                        │           │                                │
                        │           ▼ ro-mount (phase 2)             │
                        │  ┌──────────────────────────┐              │
                        │  │ idlefill (arbiter) :8787 │              │
                        │  │  IdleDetector + Arbiter  │◀── traefik   │
                        │  └────────────┬─────────────┘              │
                        └───────────────┼────────────────────────────┘
                                        │ t3-proxy network
                          register / poll / WS (token auth)
                                        │
                 Mac (this repo, phase 1 local / launchd phase 2)
                 ┌────────────────────────────────────────────────┐
                 │ idlefill client                                 │
                 │  └─ loopback proxy 127.0.0.1:11435 ──────────┐  │
                 │  └─ executor (adapters/career-ops/eval.mjs)  │  │
                 └───────────────────────────────────────────────│──┘
                                                                 ▼
                                              llama-swap :11434 (tailnet)
                                                                 │
                                    while lease is active, the arbiter
                                    EXEMPTS this client's tailnet IP
                                    from the idle calculation — and only then
```

**The self-traffic trap (the reason this design exists):** when a backfill
client holds a lease and sends LLM requests, those requests show up in the
activity feed (`src` = the client's IP). If the arbiter counted that traffic,
it would revoke its own lease (starving itself). If it exempted the client
unconditionally, it would flood interactive users. So the exemption applies
**if and only if** the client currently holds an active lease.

## Quickstart (phase 1, local dev)

Prereqs: Node 22+, Docker (for the server image), npm workspaces already
installed (`npm install` at the root).

```bash
npm install            # at the repo root

# 1. Server (Docker)
cd server
cp config.example.json config.json    # set api_tokens to something real
docker build -t idlefill-server:dev ..
docker run --rm --name idlefill-dev \
  -e IDLEFILL_CONFIG="$(cat config.json)" \
  -e IDLEFILL_STATE=./state.json \
  -p 8787:8787 idlefill-server:dev
# (phase 1 dev: -p is for convenience; phase 2 publishes nothing — traefik fronts it)

# 1b. Or run the server directly on the Mac (no Docker):
#   cd server && npx tsx src/index.ts   (reads ./config.json)

# 2. Client (Mac daemon)
cd client
cp config.example.json config.json    # set token to match the server
npm run start                          # tsx src/index.ts

# 3. Build the career-ops job queue (read-only against career-ops)
node scripts/build-careerops-queue.mjs

# 4. Dashboard: open http://127.0.0.1:8787/
```

## Layout

```
server/     arbiter (Docker image) — idle detection, lease state machine,
            Fastify API, WS events, static dashboard
client/     Mac daemon — register, lease loop, loopback proxy, executor
            supervision, usage reporting, crash-safe queue handling
adapters/   per-project executors (career-ops: queue builder + JD evaluator
            + the idlefill MCP server, idlefill-mcp.mjs)
scripts/    thin CLI wrappers (build-careerops-queue.mjs)
deploy/     PHASE 2, UNTESTED: compose.yaml, traefik/idlefill.yml, deploy.sh,
            com.sam.idlefill.client.plist
data/       gitignored; queue.jsonl, results.jsonl land here
```

## The client (Mac daemon)

The daemon registers, polls, claims leases, and runs the project's executor
(`bash -c "<cmd>"`) under the loopback proxy.

**The executor runs in its own process group.** The spawn is detached, so
the bash wrapper leads a group that also contains everything it forks
(the career-ops eval and Playwright). Preemption, timeouts, and shutdown
all signal the WHOLE group (`SIGINT` → grace → `SIGKILL`). A signal to the
bash pid alone would orphan the eval — and an orphaned eval keeps talking
to the LLM, which the arbiter reads as interactive activity and stops
granting work. Killing the group is what keeps the box honest.

**Per-project timeout.** Each project config may carry `timeout_seconds`
(default 1200 — the career-ops worst case is ~90s extract + 15min eval).
When a run exceeds it, the daemon uses the same escalation as a
preemption: `SIGINT`, the grace period, then `SIGKILL` — the job is
reported `ok:false, error:"timeout"` and goes through the retry path.

**Retry and quarantine.** A job is "done" only when its executor exits 0
AND its result line says `ok:true`. Every other outcome — a clean
`ok:false` result (a transient page failure), a crash, a preemption, a
timeout — leaves the job in the queue with `attempts` bumped by one. When
`attempts` reaches 3 the job moves to `data/quarantine.jsonl` (with its
last error) and never runs again until you edit the files by hand. The
dashboard shows the quarantine count next to the queue depth.

**Token accounting.** On a successful finish the result file's
`tokens_out`/`tokens_in` (the LLM's own numbers) are authoritative. The
loopback proxy's byte count (bytes/4 — an overcount) is only the fallback
when the result lacks them, or the only signal at all for a preempted/killed
job that never wrote a result.

**Self-traffic IP.** The exemption that keeps the arbiter from counting
your own backfill traffic keys on the IP it OBSERVES on your connection —
not the static `ip` in your client config. Tailscale reassigns addresses;
the observed value tracks that, and the configured value is kept only for
display/audit (`reported_ip` on the client row).

## The menu bar app (macOS)

`menubar/IdlefillMenubar.swift` is an AppKit `NSStatusItem` + `NSPopover`
companion (macOS 14+, built with plain `swiftc` — no Xcode project; the
SwiftUI `MenuBarExtra` exposes no click count, so the status item is built
by hand and the existing panel view is hosted in a popover unchanged) that
shows the arbiter state at a glance and controls the local client daemon.
It is a second *view* of the same daemon, not a different daemon: liveness
is read from the arbiter (the client row's `last_seen`, within the
arbiter's 90s window), so the daemon can be started from anywhere — the
menu bar, an Orca tab, launchd — and the arbiter stays the ground truth.
The panel shows the state word, this machine's status, queue depth,
today's finished/failed, and the running lease, plus Open Dashboard ·
Show Logs · Start/Stop · Restart · Update code · Quit.

- **Click routing:** a *single click* toggles the popover (the panel —
  today's behavior, exactly). A *double click* opens the **desktop app**
  (`idlefill://open` — the `State` view), falling back to
  `open /Applications/Idlefill.app` if the URL-scheme open is not handled.
  "Installed" = `/Applications/Idlefill.app` exists (the standard install
  target of `desktop/update.sh`).
- **Handoff rows:** **Open Dashboard** opens the desktop app's
  **Projects** view (`idlefill://projects` — this client's project config);
  if the desktop app is not installed it opens `server_url + "/"` in the
  browser (today's behavior). **Show Logs** opens the desktop app on
  **Logs** (`idlefill://logs`); if the desktop app is not installed it
  opens the log dir in Finder (today's behavior). With the desktop app
  installed the menu bar no longer opens the arbiter web dashboard — the
  handoff goes to the desktop app.

- **Build:** `menubar/build.sh` → `menubar/IdlefillMenubar.app`, a real
  bundle: `Contents/MacOS/IdlefillMenubar` + `Contents/Info.plist`
  (bundle id `com.sam.idlefill.menubar`, `LSUIElement` — a status-bar app,
  no dock icon). `CFBundleShortVersionString` is the root `package.json`
  version (read with `node` at build time, overridable via
  `IDLEFILL_VERSION`), injected into the binary through the
  `__MENUBAR_VERSION__` placeholder — so the binary answers
  `IdlefillMenubar --version` with the release it was built from. The
  bundle is ad-hoc `codesign`ed as the last step (the desktop's
  `build.sh` is the pattern). The compiled bundle is gitignored.
- **Install:** `menubar/install.sh` scripts `launchctl bootstrap` for the
  LaunchAgent (`com.sam.idlefill.menubar`) — idempotent: an already-loaded
  label is a clean no-op (no re-bootstrap, no writes), `--reinstall` takes
  the bootout+bootstrap cycle, `--uninstall` is bootout only. It renders
  the live plist from the committed template
  (`menubar/IdlefillMenubar.plist`) with this checkout's repo root in
  every path and creates the log dir. The menu bar survives
  logout/login (the agent is `RunAtLoad` + `KeepAlive`). It touches only
  the menubar label, never the daemon's.
- **Update check:** on launch and every 6h the app GETs the Forgejo
  releases list **anonymously** (the repo is public — the arbiter token is
  never sent to Forgejo), picks the newest release — a release number
  (`v1`, `v2`, …; the pre-numbering semver tags `v0.0.1`/`v0.0.2` are still
  understood and sort below any number) — and
  compares it against its own baked version. Strictly newer → an
  exception-only `Install Update <version>` row appears in the panel
  (hidden while no update is available); the install downloads the
  `IdlefillMenubar-<version>.app.zip` release asset **and its `.sha256` sidecar**,
  verifies the hash before touching anything (a mismatch or missing
  sidecar refuses and keeps the current bundle), swaps
  `menubar/IdlefillMenubar.app` in place, and `launchctl kickstart -k`s
  the agent when it is loaded. OFFLINE-TOLERANT: with the network down
  the check says nothing and fails quiet — no dialog, no error row; the
  next cadence tick retries.
- **Update Code:** fast-forwards this checkout to `origin/main` and
  reinstalls/rebuilds/restarts only what changed. Pre-flight gates, in
  order — a refusal at any gate writes nothing (no merge, no install, no
  signal to the daemon): (a) the tree must be clean
  (`git status --porcelain`, timeout-bounded) — a dirty tree refuses with
  `commit or stash first`; (b) `git fetch origin main` must succeed — a
  failed fetch refuses; (c) `HEAD` must be an ancestor of `origin/main`
  (`git merge-base --is-ancestor`) — a diverged local branch refuses.
  `git pull` is never run: the only write is `git merge --ff-only
  origin/main`, after all three gates. If `HEAD == origin/main` the
  update is a no-op (`already up to date`), no install/rebuild/restart.
  The daemon is stopped **first** (the same `SIGINT`-the-whole-pair path
  as Stop), so it never runs against a mid-merge tree or a torn-down
  `node_modules`; `npm ci` runs **only** when `package-lock.json` differs
  between the two revisions (`git diff --quiet old new --
  package-lock.json`), never while the daemon runs. Then the menu bar
  bundle is rebuilt (`menubar/build.sh`), and if the launchd label is
  loaded **and** runs this process's own binary (exact path compare — a
  stale label pointing elsewhere is a note, never a kill),
  `launchctl kickstart -k` relaunches the agent on the new code and the
  note before the kick says `restarting menu bar with new code`. Each
  completed update appends one line to `logs/idlefill-menubar.log`
  (`<oldsha> → <newsha> <ISO ts> daemon-pid=<pid|none>
  lock-changed=<yes|no>`, rotated at 1 MiB keeping the last 512 KiB —
  never deleted, never truncated to empty) and the panel's `revision`
  row shows the deployed `git rev-parse --short HEAD`. The decision core
  (`UpdatePlan`) is pure and is proven headlessly by
  `menubar/uc-update-test.sh` against scratch repos (the same harness
  pattern as `menubar/uc-test.sh`).
- **Repo discovery:** the binary ships at `<repo>/menubar/`, so it resolves
  the repo from its own location (one level up), honoring
  `IDLEFILL_CONFIG_FILE` when set. The token is read at runtime from the
  gitignored `client/config.json` — never baked in.
- **Starting the daemon** runs the repo's `node_modules/.bin/tsx` on
  `client/src/index.ts` with the client dir as cwd and a real `PATH`
  (a GUI-launched app inherits only `/usr/bin:/bin`, where `node` does not
  live — the tsx shim resolves node via `#!/usr/bin/env node`). Stop sends
  `SIGINT` to the whole tsx pair (clean, crash-safe shutdown).

**The control CLI** — `scripts/idlefill-menubar.mjs` — drives and
troubleshoots the app and the daemon from a terminal while developing
either. Same repo discovery and the same daemon-identity rule the app
uses: a `node` process whose command line carries this repo's path AND the
client entry (`src/` or `dist/` `index.ts`). (A bare `pgrep -f src/index.ts`
matches any shell that merely quotes the path — do not use it.)

```
node scripts/idlefill-menubar.mjs status              repo/config/tsx/daemon/app + arbiter view
node scripts/idlefill-menubar.mjs start               launch the daemon (same command the app's Start runs)
node scripts/idlefill-menubar.mjs stop                SIGINT the daemon (clean, crash-safe)
node scripts/idlefill-menubar.mjs restart             stop, then start
node scripts/idlefill-menubar.mjs logs [--lines N]    tail client/logs/client.log
node scripts/idlefill-menubar.mjs diagnose            status + tsx/node checks + log tail + interpretation
node scripts/idlefill-menubar.mjs app start|stop|status   control the menubar binary itself
```

`diagnose` is the troubleshooting entry point: it checks config, tsx, and
node, then cross-references the local daemon process against the arbiter's
`online` view and tells you which of "daemon is up but not heartbeating" /
"arbiter says online but no local process" / "nothing running, arbiter down"
you're in. The arbiter token is read at runtime from the gitignored client
config and never printed.

## The desktop app (macOS)

`desktop/IdlefillDesktop.swift` is a windowed companion (macOS 14+, built
with plain `swiftc` into a real `.app` bundle — no Xcode project) that shows
the arbiter state at a glance and manages the two LaunchAgents on this
machine. Like the menu bar app it is a *view* of the daemon, not a second
one: liveness and the state word come from the arbiter's `/api/state`
(client row `last_seen`, 90s window), so the daemon can be started from
anywhere — launchd, an Orca tab, the menu bar — and the arbiter stays the
ground truth.

- **Build:** `desktop/build.sh` → `desktop/Idlefill.app` (ad-hoc signed).
  It assembles the bundle (`Contents/MacOS/Idlefill` + `Info.plist`,
  `LSUIElement false` — it has a window), registers the `idlefill://` URL
  scheme (`CFBundleURLTypes`), draws the dock icon at runtime (the
  open-ring logo, no `.icns`), links the vendored **Sparkle** framework into
  `Contents/Frameworks`, writes the Sparkle keys into `Info.plist`
  (`SUFeedURL`, `SUPublicEDKey`, `SUEnableInstallerLauncherService`), and
  `codesign --force -s -` signs it so Gatekeeper-on-local is happy. The
  version is `IDLEFILL_VERSION` (default `0.0.1`). Run it with
  `open desktop/Idlefill.app`.
  Install to Applications with `cp -R desktop/Idlefill.app /Applications/`,
  or just run **`desktop/update.sh`** — one command to update an installed
  copy: rebuilds, quits the running app (clean SIGTERM — the app holds no
  leases; the daemon is a separate process), replaces the bundle in
  `/Applications` (or a target dir passed as the first argument), and
  relaunches.
- **URL scheme `idlefill://`.** Hosts: `""` or `open` → **State** (the
  default), `logs` → **Logs**, `projects` → **Projects**; any unknown host
  → State. A URL that *launches* the app opens on the requested tab; a URL
  delivered to a *running* app activates it, brings the window forward, and
  switches tabs (extra restored windows are closed — the link targets one
  window). Parsing is the pure `AppModel.route(for:)` (unit-tested by the
  headless driver). This is how the menu bar's double-click and its
  re-routed rows hand off to the desktop app.
- **Four tabs in the window** (a tab strip; the deep links and the tab
  buttons both set the active tab)
  - **State** — the color-coded state word, this machine's status, queue
    depth, today's finished/failed, and the running lease. Polls
    `GET /api/state` every 5s with the Bearer token.
  - **Logs** — the client daemon log (`client/<entry>/logs/client.log`,
    `src` in dev / `dist` after a build; falls back to `client/logs/` if
    the entry log is missing). Refreshed on a ~2.5s timer, keeps the last
    ~2000 lines, auto-scrolls to the tail while you're at the bottom and
    pauses when you scroll up (the "follow tail" toggle resumes it).
  - **Projects** — this client's project config (`<repo>/client/config.json`,
    read at runtime — never baked in): `client_name` + `server_url`
    read-only, then one row per `projects[]` entry with editable
    `name`, `model`, `queue_file`, `estimated_seconds`,
    `timeout_seconds`; `executor` and `cwd` read-only. **Save** validates
    the rows and rewrites the file preserving every other key byte-for-byte
    (the token included — it is never displayed anywhere) and keeps the
    file's `0600` mode; afterwards a "daemon restart to apply" note offers a
    Restart that uses the same launchd path as Settings.
  - **Settings** — opt-in launchd management (below) plus the repo-path
    field.
- **launchd management model (opt-in).** Two toggles — **daemon** and
  **menu bar** — each manage a LaunchAgent in the user's `gui/<uid>` domain
  (no root, no system domain). **ON** writes the agent's plist and runs
  `launchctl bootstrap gui/<uid>`; **OFF** runs `launchctl bootout`. The
  daemon plist points the repo's `node_modules/.bin/tsx` at
  `client/src/index.ts` (working dir `client/`, `KeepAlive SuccessfulExit=false`,
  `ThrottleInterval 30`, a real `PATH`); the menu-bar plist points at
  `<repo>/menubar/IdlefillMenubar` (building it first via
  `menubar/build.sh` if the binary is missing). **The plist carries no
  token** — the daemon reads `client/config.json` itself at startup. The
  toggles reflect **real launchctl state** (`launchctl print gui/<uid>/<label>`
  exit 0 = loaded), re-checked every 5s, so a failed bootstrap shows an
  error note and leaves the toggle OFF rather than a stale "on".
- **Repo path resolution:** defaults to `~/Software/idlefill`, overridable
  by the `IDLEFILL_REPO_PATH` env var or the Settings field (persisted to
  `~/Library/Application Support/Idlefill/config.json`). All plist paths,
  the log path, and the token source derive from it. The token is read at
  runtime from the gitignored `client/config.json` — never baked into the
  plist, the bundle, or the binary.

## Updating (Sparkle, private feed)

The desktop app self-updates via [Sparkle](desktop/vendor/sparkle/SPARKLE.md)
against a **private update feed**: the appcast and update zips live as
**assets on a Forgejo release** (`git.samwarth.com/sam/idlefill`), not in
the repo tree. The repo is public but **ingress is LAN-restricted**, so the
feed is only reachable from inside the network — that is what makes it
private in practice (Sparkle does a plain HTTPS GET, no auth).

**Feed URL** (in `Info.plist` `SUFeedURL` and the app's `kSparkleFeedURL`):

```
https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml
```

Gitea's release-download route is `/releases/download/{vTag}/{fileName}` —
there is **no** `/releases/latest/download/` route (that GitHub form 404s on
Gitea even once the repo is public), so the feed uses the `latest`
pseudo-tag in the `{vTag}` slot. `latest` resolves to the newest release,
which carries the **whole current feed**: `appcast.xml` + every zip it
references. The enclosures in the appcast point at the same
`/releases/download/latest/` prefix.

**Signing.** Each update is signed with **ed25519 (EdDSA)**: the enclosure
carries a `sparkle:edSignature` (a 64-byte ed25519 signature over the zip),
and the bundle's `Info.plist` carries the matching **`SUPublicEDKey`**
(base64 of the 32-byte public key) that Sparkle verifies against. The
private seed lives at `~/.config/idlefill/sparkle-ed-key.b64` (mode `0600`,
base64 of 32 bytes). `scripts/release.sh` derives the public key from it;
if the file is missing it generates one and prints the public key to bake
into the build.

**Releasing** — `scripts/release.sh` runs the whole pipeline:

1. build the app (`IDLEFILL_VERSION=<release number>`, with the `SUPublicEDKey`);
2. zip the bundle (`Idlefill <n>.zip`);
3. `generate_appcast` with `--maximum-deltas 0` (zips only, no `.delta`)
   against a **persistent staging dir** (`~/idlefill-release-staging`) so
   the feed carries the full history — old zips are carried forward;
4. parse the feed and collect every referenced enclosure;
5. **publish** to Forgejo: delete any existing release named
   `Release #<n>`, create release `Release #<n>` tagged `v<n>`, and
   attach `appcast.xml` + every referenced zip (idempotent re-runs);
6. **verify the live feed** (authed GET): it parses as XML, the newest
   `sparkle:version` is `<n>`, every zip enclosure GETs `200` with a
   zip-ish `Content-Type`, and the ed25519 signature is present.

```bash
IDLEFILL_VERSION=2 FORGEJO_TOKEN=<forgejo token> scripts/release.sh
# FORGEJO_TOKEN is read at runtime from the gitignored credential — it is
# never written into the feed or the repo.
```

**In-app.** The Settings tab has a **Check for Updates…** button and a
status line. The `SPUStandardUpdaterController` is created **lazily — on
the first tap**, never at launch — so headless builds and tests never start
an updater. Status reports: checking, up-to-date, update found / downloaded
/ installed, or a fetch/parse failure (the feed is only reachable from the
LAN, so an off-network machine reports a fetch failure, not "up to date").

## Releases & CI (Gitea Actions)

The repo runs Forgejo Actions on a **local runner** (urza, arm64 macOS —
`com.sam.idlefill.actrunner` via launchd, like the daemon and menubar). It
has the Xcode CLT, node, and python3 the pipeline needs. Tradeoff: cutting a
release requires that Mac to be on — the same constraint as the manual
`scripts/release.sh` path. Setup + day-2 ops for the runner live in
[`runner/`](runner/README.md) (token-free templates; the live config with
its registration secret stays on the host at
`~/Software/ci-cd/idlefill-runner/`, never committed — this repo is public).

Two workflows in `.gitea/workflows/`:

- **`test.yml`** — every push + PR to `main`: full suite (server + client +
  adapter tests, `tsc --noEmit` both packages, `npm run build`, `node --check`
  on the MCP server, `swiftc -parse` on the desktop and menubar sources).
  Tests only — never publishes.
- **`release.yml`** — on a `v*` tag on `main` (or manual re-run): the same
  full suite runs **first, as a hard gate** — any failing step stops the job
  and nothing is published. Only a fully green gate reaches the publish step:
  `scripts/release.sh` (build desktop + menubar → zip + sha256 sidecar →
  sign appcast → Forgejo publish → live feed verify).

**Why tag-triggered, not merge-triggered:** a release ships the Mac
artifacts (the desktop `.app` Sparkle feed + the menubar `.app` zip and
sha256 sidecar) — the arbiter, daemon, and MCP server run from each
machine's local checkout and are not distributed. Publishing on every
merge would push a possibly-broken build to every user's machine on every
push, even when nothing changed. Tagging `v<number>` (the release number) on
`main` is the deliberate "this version is a release" bump.

### Versions & releases

Releases are **numbered** — release #1, #2, #3, … — not semver. The release
number is the version: the root `package.json` holds the next release number,
the tag is `v<number>`, and the Forgejo release is named `Release #<number>`.
(The pre-numbering releases `v0.0.1`/`v0.0.2` are the one-off semver
exceptions; they stay in the signed feed and every consumer keeps
understanding them — they sort below any release number, so an installed
`0.0.2` app picks up release #1 as an update.)

The root `package.json` is the single version source: the release tag
`v<number>` is cut from it, and the release artifacts are stamped with it —
the desktop feed's `sparkle:version` and the menubar bundle's
`CFBundleShortVersionString` + baked `--version` string (the menubar's
`build.sh` reads the root version with `node` by default;
`scripts/release.sh` takes `IDLEFILL_VERSION` = the release number). The
daemon resolves it the same way at runtime — its registration carries
`version` + `protocol` (the version handshake), echoed on `/api/state`
per worker row and shown on the dashboard's per-worker row when present.
```bash
node client/src/index.ts --version    # the daemon prints its version (exit 0)
menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar --version
```
The daemon does not self-update — it reports its version and the
operator sees which revision each worker speaks; the menu bar is the
self-updating artifact (update check + sha256-verified install, above).

To cut a release: bump the root `package.json` version to the next release
number, commit, and tag (the tag is the version with a `v`):

```bash
# bump root package.json to the next number (e.g. "2"), commit, then:
git tag v2 main && git push origin v2     # runs release.yml; gate then publish
```

The runner injects `FORGEJO_TOKEN` (write:releases on this repo) into the
publish step; the ed25519 signing key stays at
`~/.config/idlefill/sparkle-ed-key.b64` on the runner host (never in the
repo, never a CI secret).

## Auth model

- Every API call and the WS connection must present a token from the server's
- Every API call and the WS connection must present one of the configured tokens (Bearer
- credential header or `token` query parameter).
- Exception (documented, LAN/tailnet-only): the dashboard page (`/`) and
  `GET /api/state` are unauthenticated **read-only** in phase 1. If a request
  to `/api/state` *does* carry a token, a bad one is rejected (401). Phase 2
  adds traefik's `middleware-local-ip-range` in front.

## Operator overrides (pause / force clients)

Per-client, operator-set, persisted in the state file, surfaced on the
dashboard (Clients panel) and in `GET /api/state` (`clients[].override`):

| Override | Effect |
|---|---|
| `pause` | The arbiter refuses **new** leases for that client (reason `client_paused`). A lease already running is NOT revoked — revocation stays driven by idle/preempt/TTL. The client daemon also stops asking for work while paused. |
| `force` | The arbiter grants the client a lease even while the box is **not idle** (bypasses the idle verdict and the post-revocation reidle gate). It does **not** bypass: a degraded signal (activity data unreliable ⇒ never grant), `max_concurrent_leases`, project pause, or the daily budget. The client daemon requests work while forced. |

Overrides optionally carry an `until` (epoch ms) and auto-expire; expired or
orphaned entries are swept on each arbiter tick.

```bash
# token is read at runtime from the gitignored client/server config —
# it never appears on a command line
node scripts/idlefill-control.mjs clients
node scripts/idlefill-control.mjs pause  <name-or-id> [--for 30m]
node scripts/idlefill-control.mjs force  <name-or-id> [--for 30m]
node scripts/idlefill-control.mjs clear  <name-or-id>
```

HTTP equivalent (token-authed): `POST /api/clients/:ref/override` with body
`{"override":"pause"|"force"|null, "until":<epoch_ms>}` — `null` clears.

The dashboard also drives this: the right side of the header is split into
three elements — a color-coded live-state word (`Idle` green / `Busy` amber /
`Running Idle Tasks` blue / `Degraded` red, or `unreachable` when the poll
fails), the **Engine gate** combobox (`Engine Paused` / `Engine Running`, one
global gate across all clients), and the **gate token** field (paste the
arbiter token once per browser — it lives next to the gates it enables, is
stored in `localStorage`, and accepts a clear by emptying it). *Engine
Paused* sets the `pause` override on every registered worker; *Engine
Running* clears it and clients run their normal idle-gated schedule.

## Project-level controls (pause + grant knobs)

Beyond the global gate and per-worker overrides, each project configured in
the server's `projects[]` has its own controls, persisted in the state file
(surviving restarts) and visible in the dashboard's Projects pane:

- **Project pause** — `POST /api/projects/:name` with `{"paused":true|false}`
  (also the per-project gate combobox in the dashboard). Same semantics as a
  client pause: no NEW leases for the project, active leases keep running.
- **Per-project grant knobs** — `POST /api/projects/:name/settings` with any
  of `idle_seconds`, `max_concurrent_leases`, `lease_ttl_seconds` (positive
  numbers), or `{"clear":true}` to drop all of them. A set value overrides
  the global knob for that project only; an unset knob inherits the global.
  `GET /api/state` / `GET /api/projects` expose both: `scheduling` carries
  the EFFECTIVE values plus `scheduling.overrides` (the raw per-project
  values, `null` = inherit).

**Adaptive lease TTL (the estimate lever).** Each lease also starts with a
per-job cap on its lifetime: when the client reports a positive
`estimated_seconds` for the job, the lease expires after
`min(estimated_seconds × lease_ttl_safety_factor, lease_ttl_seconds)` —
floored at `lease_ttl_floor_seconds` (default 60). The safety factor
(default 2, server config `lease_ttl_safety_factor`) keeps a lease at ≥2×
the estimate, because the client's estimate is a first-run guess; and the
cap at the (per-project or global) `lease_ttl_seconds` means the estimate
can only make a lease expire SOONER, never later — preemption, budget, and
anti-thrash see strictly less staleness, never more. With no estimate (or
≤0) the lease keeps the full static TTL, exactly as before. Today the
client sends its per-project `estimated_seconds ?? 900` and the default
TTL is 1800, so `min(900×2, 1800) = 1800` — zero behavior change until an
operator tunes it: set `estimated_seconds` close to the job's real duration
in the CLIENT config (`client/config.json` `projects[].estimated_seconds` —
the dashboard's per-project settings editor exposes only the arbiter-side
knobs, not this one) and a 2-minute job stops holding the box "running"
for the full 30-minute static TTL after it finishes; a crashed or
abandoned job frees the single lease slot at ~2× its estimate instead of
the full TTL. The trade-off is that an estimate SHORTER than a job's real
duration expires the lease early while the job is still working — the
client's usage report on the expired lease is still counted once (no
double-count, no failure attribution: a `ttl_expired` is never treated as
a job failure), but the slot is free to re-grant sooner. When the effective
TTL differs from the global, the `lease_granted` event records it
(`… (ttl 1200s from est 600s*2)`) so the dashboard's event feed shows why
a lease expired early.

```bash
node scripts/idlefill-control.mjs projects
node scripts/idlefill-control.mjs project career-ops set [--idle 600] [--max 2] [--ttl 900]
node scripts/idlefill-control.mjs project career-ops clear
```

## Inference-server inventory

The arbiter watches exactly one activity feed today (the configured
`llama_swap_url` + `activity_path`). The state file also keeps a
**declared-server inventory** — one row per inference server the box is
connected to, seeded from config (`server_name`, `server_models`,
`server_peers`) on first load and then operator-managed:

- `GET /api/servers` (and the `servers` key of `GET /api/state`) — one row
  per declared server: `name`, `url`, `models` (each with `running` /
  `queued`, computed from the live leases and the clients' self-reported
  queue depths), `peers`, and — for the watched row only — `watched: true`
  plus the live `signal` (the idle signal object: `idle_for_s`,
  `last_activity`, `degraded`, `reidle_gated`, …). A declared-but-unwatched
  row carries `signal: null` — it is inventory, not a live feed.
- `POST /api/servers` — add (no `id`) or patch-update (by `id`) a declared
  connection: `{name, url, activity_path?, models?, peers?}`. Create
  requires a valid http(s) `url` and rejects a duplicate
  (url + activity path). This is **config + display only**: the arbiter
  keeps watching its single configured feed; a declared row is where a
  future multi-feed core will point the watcher. `peer:` backends (e.g.
  `peer:gpu2`) are plain-words metadata — the entry point fronts them; the
  arbiter never routes to them.

```bash
node scripts/idlefill-control.mjs servers
node scripts/idlefill-control.mjs server add box-two http://192.168.9.9:11434 [--models a,b] [--peers peer:gpu2]
node scripts/idlefill-control.mjs server set <id> [--name N] [--url U] [--models a,b] [--peers p1]
```

## Dashboard layout (the work flow)

The dashboard reads top-to-bottom as the operator's work flow: the header
state word answers *is the box doing what it should* (`Idle` green /
`Busy` amber / `Running Idle Tasks` blue / `Degraded` red, or `unreachable`
when the poll fails), then **two panes** — **Inference Servers** and
**Projects** — and the fixed bottom **logs** tray (Events/Leases tabs,
shared records-to-show).

- **Inference Servers** — one block per declared inference server (today:
  the one watched feed). The watched block carries the live signal: the
  countdown (`idle for`, the page's one display number), the last activity
  (model · source · how long ago), and the exception-only diagnostics
  (the log write age while the box is judged not idle, signal health when
  degraded, the re-idle gate when armed). Below that, the server's **model
  resources** — one row per declared model with its running state (blue
  dot), the self-reported queued depth, and the per-job estimate when a
  connected worker uses that model. `peer:` backends show as a plain-words
  line when configured. A declared-but-unwatched server reads "declared —
  not watched yet".
- **Projects** — one block per project configured in the server's
  `projects[]`, absorbing the running/queued/workers views:
  - **head** — the project name, exception tags (`paused`, `budget full`),
    the per-project **gate** combobox (pause/resume this project), and the
    **jobs waiting** count (the sum of the connected workers' queue
    depths, shown only when non-zero),
  - **running jobs** — one row per active lease for this project (all of
    them; with `max_concurrent_leases > 1` the second lease is not
    hidden): job, worker, how long it has been running, and when it
    auto-cancels,
  - **tokens today (UTC)** — the project's output against its
    `daily_token_cap`, with a bar (amber past 80%),
  - **workers** — a **collapsible list** (expanded by default; per-project
    collapse state in `localStorage`) of the connected clients that
    reported they are allocated to the project: online dot, name (+ a
    `paused` badge when a client-pause override is active), model,
    per-job estimate, queued jobs, and the **per-worker gate** (pause/
    resume this worker — a worker paused from any project block is paused
    from all of them, the scope being a worker-level override). Under each
    row, the worker's **published stats** (client-computed key/values the
    client daemon reports at registration: finished/failed today, last
    job, queue) — rendered verbatim; the arbiter shows them, it never
    computes them, and the section is absent when nothing is published,
  - **exception notes** — why nothing is running right now (`project
    paused`, `budget full`, `no workers online`), and **today's results**
    (jobs finished / failed today, UTC — counted from the lease end-records
    the arbiter already keeps: a lease that terminated as `finished` counts
    finished; any other terminal lease counts failed),
  - **schedule** — the EFFECTIVE knobs that gate the project's grants
    (idle threshold, max concurrent, lease TTL — per-project overrides
    win; a dim mark appears only when this project overrides the globals),
  - **settings** — a collapsed editor under each project block for the
    grant knobs (`POST /api/projects/:name/settings`): one field per knob,
    a filled value is the current override and an empty (dashed) field
    shows the global it inherits. Save posts only the fields the operator
    touched (an override emptied on purpose sends `null`); **Reset to
    global** posts `{clear:true}`; token-gated like the gates.
- **Inference Servers** additions — each server block also shows the
  declared connection (url, activity path, declared/changed age) and an
  **edit connection** editor (`POST /api/servers` by `id` — patch semantics:
  only the changed fields are sent), and the pane head carries a **+ add
  server** editor (create; name + an http(s) url required, a duplicate
  url + activity path is a 400 shown in the form). All settings editors are
  token-gated: with no gate token the write is refused and the header
  points at the token field.
- **queue detail page** — a worker row with queued jobs gets a **view**
  link into `/[project]/[worker]/queue` (served by the arbiter as the SAME
  single-file dashboard; the inline script switches views on the path):
  the worker's published **queue preview** — the first rows of its queue
  file in priority order (job, company, score, retries used) — plus model,
  per-job estimate, full depth vs. rows shown, online state, and what is
  running now. The preview is client-published: the heartbeat carries the
  first 100 rows (sanitized at registration: bounded rows/fields), and the
  arbiter displays it verbatim — it never reads queue files. A worker
  running an older client that doesn't publish a preview degrades to the
  depth number.

Workers are **self-reported by the clients** (the arbiter does not infer
allocations): each client daemon re-registers on every poll tick (~20s) with
its project list — `name`, `model`, `estimated_seconds`, and a **live queue
depth** (the arbiter never reads the queue files). The server stores this in
the state file and refreshes `last_seen` on every heartbeat; a worker is
**online** when its heartbeat is <90s old (≈5 daemon polls). Re-registration
stays idempotent by name: same `client_id`, so client overrides (pause/force)
keep sticking across daemon restarts.

In the API: `POST /api/clients/register` accepts an optional
`projects: [{name, model, estimated_seconds, queue_depth, queue_preview?, stats?}]`
(malformed rows are dropped; `stats` is a small object of number/short-
string values the client computed itself — the arbiter stores and displays
them verbatim), and `GET /api/state` / `GET /api/projects` return per-project
`workers: [{client, model, estimated_seconds, queue_depth, queue_preview?, online, stats}]`,
a `today: {finished, failed}` results row (UTC day of each lease's end), and
a `scheduling` object (the EFFECTIVE `idle_seconds`,
`max_concurrent_leases`, `lease_ttl_seconds`, `daily_token_cap`, plus
`overrides` for the raw per-project values and `global` for the global
knobs an unset override falls back to — the dashboard's settings editors
show those as the dashed "inherit" placeholders). `GET /api/state` also carries
the `servers` inventory (see Inference-server inventory above). A project
with no connected workers shows "no workers connected" — a scheduling row
with no executor behind it tells you the queue will not drain.

## Scheduling work: the idlefill MCP server

`adapters/career-ops/idlefill-mcp.mjs` is an MCP (Model Context Protocol)
server over stdio — no dependencies, plain `node` — that lets an agent
(e.g. a Hermes profile) schedule idle work without touching the arbiter API
or the queue files directly:

| Tool | What it does |
|---|---|
| `idlefill_add_jobs` | Enqueue job openings `{url (required), company?, title?, score?, extra?}`; `dry_run=true` previews. A job is skipped (and the response names which skip: `skipped_in_queue` / `skipped_done` / `skipped_quarantined` / `skipped_duplicate`) when it is already queued, its last result is `ok:true`, or it was quarantined — the same ground-truth rules as the queue builder, re-read on every call. The daemon picks new lines up on its next idle grant — no restart. |
| `idlefill_queue_status` | Queue depth + a preview of the first jobs (default 10, `limit` up to 200), plus — when the arbiter is reachable — the idle signal, project pause state, connected workers, and what is running now (the arbiter read is best-effort). |
| `idlefill_results` | Recent results lines, newest first (`job_id`, `ok`, `score`, `error`, `tokens_out`, `report_path`). |

Config is read at call time from the client config (`<client dir>/config.json`
— `server_url`, `token`, and the per-project `queue_file`/`results_file`
mapping; override the client dir with `IDLEFILL_CLIENT_DIR`, the repo data
dir with `IDLEFILL_DATA`). Job identity is `<company-slug>-<sha256(url)[0:8]>`
— identical to the queue builder — so a job added through the MCP is the same
job the builder and the daemon know.

The daemon is a single `node` process, so the Hermes profile configures it
as an MCP server pointing at the file, e.g.:

```json
"mcpServers": {
  "idlefill": { "command": "node", "args": ["/Users/sam/Software/idlefill/adapters/career-ops/idlefill-mcp.mjs"] }
}
```

Test: `node --test adapters/career-ops/mcp.test.mjs` (drives the real
process over stdio against scratch ground-truth files).

## Conventions

See `AGENTS.md`. Short version: Node 22, ESM, `node --test` (run via tsx for
TS), no framework lock-in beyond Fastify, secrets via env/config files that are
gitignored.

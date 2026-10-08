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

## Install

Prereqs: Node 22+ and npm. No special network required — just a reachable
arbiter (the server) for the client to point at.

```bash
git clone https://github.com/idiosyncric/idlefill
cd idlefill
npm install                    # at the repo root (npm workspaces)

# 1. Server (the arbiter)
cp server/config.example.json server/config.json   # set api_tokens to something real
cd server && npm run dev                           # tsx src/index.ts, reads ./config.json

# 2. Client (the machine that runs the work)
cd ../client
cp config.example.json config.json                 # set server_url to your arbiter
                                                   # (http://<arbiter-host>:8787) and
                                                   # token to match the server's api_tokens
npm run start                                      # tsx src/index.ts
```

Both `config.json` files are gitignored — the examples are the starting
point. The dashboard is then at `http://<arbiter-host>:8787/`. For the
Docker path and the rest of the deployment internals, see Quickstart and
Architecture below.

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
scripts/    thin CLI wrappers (build-careerops-queue.mjs, the control
            CLIs: idlefill-control.mjs arbiter-side, idlefill-menubar.mjs
            daemon-side — platform-portable, systemd-aware on Linux)
deploy/     PHASE 2, UNTESTED: compose.yaml, traefik/idlefill.yml, deploy.sh,
            com.sam.idlefill.client.plist; systemd/ + install-client-service.sh
            = the Linux client service (issue #54 — exercised, see below)
docs/       reports/ — per-issue build reports (historical record; see
            docs/reports/README.md). New issue reports land there, never at
            the repo root.
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

## The Linux client (issue #54)

The daemon, gate and proxy are plain Node — they run on Linux. Only the
service plumbing was macOS-shaped (launchd). On Linux the supervisor is a
**systemd user unit**, and the **dashboard is the Linux surface** (no
native app; the Swift apps keep their read-only contract and now also
name-match their own client row, so a second online client never hijacks
a machine's STATE view).

Install, from a checkout on the Linux box:

```bash
git clone https://git.samwarth.com/sam/idlefill.git ~/Software/idlefill
cd ~/Software/idlefill && npm ci            # node >= 18 works (tsx floor);
                                            # the CI standard is 22
cp client/config.example.json client/config.json
$EDITOR client/config.json                  # server_url (tailnet IP), token,
                                            # a UNIQUE client_name per machine
bash deploy/install-client-service.sh       # render -> verify -> enable -> start
```

The installer mirrors the plist semantics (`KeepAlive{SuccessfulExit=false}`
→ `Restart=on-failure`, `ThrottleInterval` → `RestartSec=30`) and the
fail-closed install discipline (render to temp, byte-verify — placeholders
surviving or ExecStart not matching this checkout abort before anything
loads). It refuses to install while a non-systemd daemon for the same
checkout is running. The unit starts at boot once lingering is on
(`sudo loginctl enable-linger <user>` — the installer prints the command
when it cannot run sudo itself).

Lifecycle on Linux belongs to systemd: `systemctl --user
start|stop|restart|status idlefill-client`, logs via `journalctl --user -u
idlefill-client`. `scripts/idlefill-menubar.mjs` is the portable
daemon-side control (status/start/stop/logs/diagnose/pids) — on Linux it
shows the unit's state and refuses a raw SIGINT while the unit is active
(a signal death reads as a crash and `Restart=on-failure` relaunches).
Issue #49's code-staleness flag works here unchanged: the boot `revision`
comes from `git rev-parse HEAD` in the checkout, so the cycle is
`git pull && systemctl --user restart idlefill-client`.

CI: `.gitea/workflows/test-linux.yml` keeps the node suites honest on
ubuntu (the runner label must exist before it dispatches — see
docs/reports/).

## Session gate (interactive agent traffic — issue #9)

Several long-context Hermes sessions (TUI, Orca tabs, gateway) share one
local inference box. The client daemon's loopback proxy doubles as the
per-Mac **router + gate** for that interactive traffic: sessions register
with the arbiter by first sight, admission is capacity-limited, and a
queued or paused session's LLM request is **held at the router, not
failed** — when it is admitted the held request proceeds and the agent
continues as if nothing happened.

**Point a Hermes session at the router.** In the session, set its base_url
to a tokenized router path (one distinct token per session):

```
/model http://127.0.0.1:11435/s/<token>
```

The router strips `/s/<token>` and forwards `/v1/...` to `llm_target`.
First sight of a token registers the session at the arbiter (idempotent,
with your client identity); traffic is the heartbeat (refreshed at most
once per ~10s per session, plus on the daemon's poll tick). Desktop-app
token minting and the model endpoint are follow-ups — for now you set the
base_url by hand. Plain `/v1/...` traffic (the lease-gated job flow) is
untouched: exact single-target passthrough, never gated.

**Knobs** (`client/config.json`, same file as `proxy_port`/`llm_target`):

| key | default | meaning |
| --- | --- | --- |
| `session_gate` | `true` | turn the router/gate off entirely |
| `max_active_agent_sessions` | `2` | sessions that may hold the engine at once (FIFO queue beyond that) |
| `session_hold_cap_ms` | `120000` | max a queued/paused request parks before a retryable `503` + `Retry-After` (~15s + jitter). Hermes' own request timeout is `HERMES_API_TIMEOUT` (default 1800s), so the default cap is far inside it |

**Admission + overrides.** A session holds a slot while it has a request in
flight; when one finishes, the head of the FIFO queue is admitted and its
parked request streams through. Operator overrides (arbiter-side, learned
from the daemon's `/api/state` poll): `pause` holds a session's traffic
even with free slots; `force` bypasses the slot cap for that session.

**Gate-state visibility.** The register heartbeat also carries what the
router's queue knows about the session, so the arbiter's session rows — and
every sessions surface: the page's Sessions view (the desktop app hosts
that page), and the menubar panel's exception one-liners — can show "queued
behind another session · N waiting" instead of just "registered". The body
gains an optional `gate` block; a session that neither holds a slot nor
parks anything sends NO block, and the arbiter then CLEARS any stored gate
(a session that stopped waiting must not stay tagged). Invalid blocks are
dropped, never rejected; an old arbiter simply ignores the extra field.

```
POST /api/sessions/register  { "token": "…", "gate": { "state": "active" | "queued", "waiting": 3, "position": 1 }, "session_id": "…", "history": { "rpm": [0,0,1,2,0,0,0,0,3,5], "model": "…", "tokens": 1234 } }
```

**Queue position (#44).** A `queued` block also carries `position` — that
session's 1-based place in the router's FIFO line (queue order is
router-local truth; the arbiter only echoes the report). The session
HOLDING a slot sends no position (it is not in the queue). A malformed
position drops only the key — the gate block still stores; an old router
keeps the exact old shape. Dashboard queued rows render `queued · #N` from
it (the `N waiting` form survives only when the router is too old to
report positions).

**Session detail (#45).** The heartbeat also carries a `history` ADD-key
when the session has traffic: `{ "rpm": [10 per-minute counts,
oldest→newest], "model": "…", "tokens": 1234 }`. The ROUTER computes it —
a capped in-memory ring counts every request it sees (forwarded OR
parked), and the model + token totals come from the upstream RESPONSE
(the engine echoes the served model; its usage block carries
total_tokens). The request body is never peeked: a parked request's body
must stay unconsumed for the forward on admission. The arbiter stamps
`reported_at`, sanitizes per-key (drop-don't-reject; an all-empty block
is absent; an absent report never clears a stored block), and the
dashboard rows render the facts exception-only: `model <name>` tag,
`18.4k tok`, and a tiny inline sparkline of requests/min. Legacy rows
render unchanged.

**Force, exposed (#44).** The dashboard's per-session gate select is now a
three-option gate: Session Running / Session Paused / **Session Forced**.
`force` was always honored (the arbiter stores it, the router admits a
forced session past the slot cap and releases its parked holds); the
dashboard was the surface that never offered it. A forced row gets the
exception-only `forced` tag. Queue *manipulation* (promote/remove) is a
deferred slice — it needs an arbiter→router command channel that does not
exist yet.

**Hermes conversation id (#42 Slice 0).** When a request on a session path
carries the `X-Hermes-Session-Id` header, the router captures it and the
register heartbeat gains the `session_id` add-key — the REAL Hermes
conversation id (the one the TUI banner shows), so two concurrent chats on
one profile are two distinguishable rows even before the gate plugin
lands. The first request that carries it sets the row's id; a later
headerless request never clears it. Malformed values (over 128 chars,
control chars) are dropped, never rejected — the same posture as the
token rule. A session that never carried the header (curl, other clients)
has no key and renders exactly as before. The future middleware-plugin
path (#42) publishes the SAME field from the other side.

**Gate posture (#41).** The client daemon's register heartbeat also
carries `gate_posture`: `armed` while the arbiter link is up (slot cap +
operator overrides in force) or `fail_open` after the link drops (every
session admitted, cap OFF). The router owns this truth — the arbiter
cannot observe it — so the arbiter stores + echoes the last valid report
verbatim, and the dashboard puts a `gate fail-open` badge on that
machine's worker rows. `armed` renders nothing (no tag is the healthy
state); a daemon with `session_gate: false` sends no key at all.

**Session launcher (#43).** The heartbeat also carries `proxy_port` — the
port the proxy ACTUALLY bound (config `proxy_port: 0` = ephemeral, so only
the daemon knows). The dashboard's Sessions view shows a **New session**
section, exception-only: it appears once at least one online client
reports a port. One `new session` button per machine mints a
`<8hex>-<4hex>` token in the browser and hands over the exact line
`/model http://127.0.0.1:<port>/s/<token>` with a copy button; the line
persists across refreshes until you dismiss it. The arbiter never sees a
token until the session's first request hits the router — the mint is
purely page-side.

`state`: `active` = the session currently holds an inference slot
(in-flight > 0); `queued` = it has ≥1 parked request waiting for admission.
`waiting`: the parked-request count for that session right now.

```
curl -X POST $ARBITER/api/sessions/<token>/override -d '{"override":"pause"}'   # hold
curl -X POST $ARBITER/api/sessions/<token>/override -d '{"override":null}'      # resume
```

**Fail-open.** If the arbiter is unreachable (registration POST fails,
state poll down), the gate admits everything and releases every parked
request. A dead arbiter must never wedge a conversation. Daemon shutdown
releases parked requests cleanly too.

**Manual acceptance checklist** (the issue's scenario):

1. Set `max_active_agent_sessions: 1` in `client/config.json`, restart the
   client daemon (`launchctl kickstart -k gui/$(id -u)/com.sam.idlefill.client`).
2. Session A: `/model http://127.0.0.1:11435/s/sessA`; ask it something
   long-running. It streams (it holds the only slot).
3. Session B: `/model http://127.0.0.1:11435/s/sessB`; send a message —
   it just waits (the request is parked at the router; the dashboard shows
   B registered, and the client log shows `session sessB first sight`).
4. Pause A from the dashboard (or the override curl above). A's next
   request holds; when A's in-flight request finishes, B is admitted and
   its parked request proceeds — **no message typed into either
   conversation**. Unpause A when done.
5. Kill the arbiter (`launchctl`/docker as applicable) and send messages
   in both sessions: both must keep working (fail-open).

## The desktop app (macOS — the one Tauri shell)

`tauri/` is the ONE Mac shell (issue #69 cutover, decision doc
`docs/architecture/tauri-cutover.md`): a Tauri v2 app, built from this
checkout, that is both the window and the menu-bar companion. The two
Swift trees that preceded it — `desktop/` (the windowed app) and
`menubar/` (the status-item app) — retired WITH their harnesses at the
cutover; this section replaces their two former sections.

- **Shape (D1):** one `WebviewWindow` on the arbiter's **live origin**
  (the `server_url` from `client/config.json`, loaded at runtime as
  `WebviewUrl::External` — never a bundled copy of the page, the #61
  rule) plus ONE status item. A **single click** on the status item
  toggles the **glance** (a small borderless window anchored under the
  tray icon: the state word, this machine's row, the revision row, the
  exception-only sessions block, and the action rows); the tray menu
  carries **Open Desktop**, **Settings**, and **Quit**. The double-click
  gesture and the update row retired (Q-c). The glance dismisses on
  focus loss.
- **Token injection (D3):** the gate token is read at runtime from the
  gitignored `client/config.json` and rides `initialization_script`
  (document-start) into the page's own `idlefill.token` key — write-only
  everywhere, never baked, never printed. The page's own token box stays
  functional for browser users.
- **Lifecycle parity (D4):** the Settings window re-hosts what the arbiter
  can never know — the **daemon / app / arbiter** launchd toggles read
  from real `launchctl print` state on a 5s tick (the `com.sam.idlefill.app`
  toggle manages the shell's OWN LaunchAgent; the daemon and arbiter
  labels are the same services the former desktop app managed), the runs:
  lines, the repo path, and the exception-only **stopped** marker +
  one-button **Relaunch** for a loaded-but-exited arbiter (the e737411
  semantics: liveness = the `pid =` line, `launchctl kickstart` without
  `-k`). The update-channel block retired (Q-b).
- **Deep links (D5):** `idlefill://` is owned by this app (LaunchServices
  re-registered at the cutover; verified live by an `idlefill://open`
  round-trip that spawned no second process — single-instance). Every
  host routes the one window onto the page's default view or `#<view>`
  via the ported pure `hashView` map (state→#overview, sessions→#sessions,
  projects→#projects, usage→#usage), unit-tested on the Rust side.
- **Blank-origin behavior (D6):** wry exposes no page-load *Failed*
  event, so the signal is the missing page-load Finished event plus the
  arbiter pid-line liveness check — the same trio the Swift shell used.
  The exception-only Relaunch parity stands; per the owner call (Q-a),
  the window auto-reloads ONCE per dead→live transition edge when the
  arbiter comes back.
- **Build:** `bash tauri/build.sh` → `tauri/src-tauri/target/release/`
  `bundle/macOS/Idlefill.app` (no signing identity, no notarization, no
  install step in the build — Q-b). The `IDLEFILL_VERSION` env sets the
  bundle version (semver, default 1.0.0); the `IDLEFILL_BUILD_MARKER`
  env bakes the build marker the `--version` argv prints (default `dev`;
  `update.sh` passes the commit's short sha). The tray icon is generated
  at build time (`make-tray-icon.py`), not a checked-in binary blob. The
  script byte-verifies the bundle's Info.plist (URL scheme + ATS merge)
  with the raw-only `plutil` forms — a mutating `plutil` form corrupts
  the plist it checks (the 2026-10-06 incident; the gate guards itself).
- **Install / autostart (Q-d):** ONE LaunchAgent,
  `com.sam.idlefill.app` (RunAtLoad), installed by `bash tauri/install.sh`
  (idempotent; `--reinstall` renders the committed
  `tauri/IdlefillApp.plist` template to a temp file + byte-verifies
  BEFORE any bootout — a render refusal never leaves the loaded agent
  down; `--uninstall` is bootout only). The shell's exit path is
  `launchctl bootout gui/$(id -u)/com.sam.idlefill.app` or the tray menu's
  Quit. The retired `com.sam.idlefill.menubar` label is gone from this
  machine (booted out at the cutover, plist removed, in the same step as
  the install — never a zero-tray window, never two trays).
- **Update:** there is no update plane — an update is a rebuild from the
  checkout (`./update.sh`; see the Releases & CI section below for the
  build-identity rules).
- **The bundled views** (settings + glance) are React in `tauri/ui/`;
  `tauri/settings-ui/` is the committed build output (the frontendDist —
  `bash tauri/build.sh` needs no npm step, the build-from-checkout rule).
  Rebuild `tauri/ui` before a commit that touches its `src/`.

## Updating (build from a checkout)

There is no update plane. The Sparkle feed, the appcast, the ed25519
signing, the branch (edge) channel, and every self-update row and check
retired with the Swift shells at the #69 cutover (Q-b LOCKED,
2026-10-06). The app is built from a checkout on every machine that runs
it; the Rust toolchain (cargo + the tauri CLI) and the Node toolchain are
required on that machine — both present on this one.

An update is `./update.sh` — one command, fail-closed at every step:

1. refuse a checkout with uncommitted tracked changes;
2. fast-forward `main` (`--no-pull` skips the pull and rebuilds the
   current commit — e.g. a pinned checkout);
3. `tauri/build.sh` with `IDLEFILL_BUILD_MARKER=<short sha>` so the
   bundle proves its own origin;
4. stage the bundle into `/Applications/Idlefill.app` (a rename swap —
   an rsync/cp over a running app's binary fails with ETXTBSY, a rename
   never does; the staged copy must pass `--version` before it lands);
5. `tauri/install.sh --reinstall` re-pointed at the `/Applications`
   copy, and settle on the PROCESS: the label is verified live only when
   a process running the NEW binary path exists (launchd's bootout is
   async — a `launchctl print` check at the drain window reads a doomed
   label as loaded, so the process is the proof).

```bash
./update.sh              # pull + rebuild + reinstall
./update.sh --no-pull    # rebuild THIS checkout, reinstall
```

**Build identity.** The marker contract survives the pipeline's death:
`idlefill-app --version` prints `idlefill <marker>` — the commit's short
sha on an `update.sh` build, `dev` on a bare `tauri/build.sh`. The
running app's revision is also visible on the page (the arbiter
echoes the registration) and on the glance's revision row, so an
installed build proves its own origin.

## Releases & CI (Gitea Actions)

The repo runs Forgejo Actions on a **local runner** (urza, arm64 macOS —
`com.sam.idlefill.actrunner` via launchd, like the daemon). It carries
the node, python3, AND Rust toolchains (cargo + the tauri CLI) the
pipeline needs. Tradeoff: cutting a release requires that Mac to be on.
Setup + day-2 ops for the runner live in [`runner/`](runner/README.md)
(token-free templates; the live config with its registration secret stays
on the host at `~/Software/ci-cd/idlefill-runner/`, never committed — this
repo is public).

Two workflows in `.gitea/workflows/` (the third, `edge.yml`, retired with
the edge channel at the #69 cutover — Q-b: it published only the Swift
app zips):

- **`test.yml`** — every push + PR to `main`: full suite (server + client
  + adapter tests, `tsc --noEmit` both packages, `npm run build`,
  `node --check` on the MCP server) plus the Tauri shell gates (issue
  #69 D9, replacing the retired `swiftc -parse` gates):
  `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, and a
  debug `cargo build` as the bundle-plumbing smoke. Tests only — never
  publishes.
- **`release.yml`** — on a `v<N>` tag on `main` (or manual re-run): the
  same full suite runs **first, as a hard gate** — any failing step stops
  the job and nothing is published. Only a fully green gate reaches the
  publish step: the tag's release NOTES (no artifacts — Q-b).

**Why tag-triggered, not merge-triggered:** the arbiter, daemon, and MCP
server run from each machine's local checkout, and the shell is built
from a checkout too — nothing is distributed from the tag. The tag is the
deliberate "this version is a release" bump: it stamps the release number
that the daemons and arbiter carry in their registration (see below), and
it publishes the notes that say how to get that build.

### Versions & releases

Releases are **numbered** — release #1, #2, #3, … — not semver. The release
number is the version: the root `package.json` holds the current release
number, the tag is `v<number>`, and the Forgejo release is named
`Release #<number>` (notes only since the #69 cutover — the pre-numbering
releases `v0.0.1`/`v0.0.2` and the artifact releases before the cutover
are the historical record).

The root `package.json` is the single version source for the daemon: its
registration carries `version` + `protocol` (the version handshake),
echoed on `/api/state` per worker row and shown on the dashboard's
per-worker row when present. The registration also carries `revision`
(issue #49): the git commit the daemon's RUNNING process loaded its code
from (`git rev-parse HEAD`, once at startup). The version handshake cannot
see a daemon that predates its own working tree — the release number only
bumps on a tag, and launchd relaunches only on crash — so the surfaces
compare `revision` against their own checkout HEAD and show an
exception-only `daemon behind` marker; the daemon's boot revision clears
it within one heartbeat of a restart. The arbiter only stores + echoes
it: the comparison is client-side, since the arbiter has no view of any
client's repo tree. A non-git checkout reports nothing and renders
exactly as before.

```bash
node client/src/index.ts --version    # the daemon prints its version (exit 0)
idlefill-app --version                # the shell prints idlefill <marker>
```

The daemon does not self-update — it reports its version and the operator
sees which revision each worker speaks. To cut a release: the root
`package.json` already carries the number (it bumps when a release is
cut), commit the bump, and tag (the tag is the version with a `v`):

```bash
git tag v2 main && git push origin v2     # runs release.yml; gate then notes
```

The runner injects `FORGEJO_TOKEN` (write:releases on this repo) into the
publish step. The shell's build identity is the marker, not the release
number (see Updating above).

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
≤0) the lease keeps the full static TTL, exactly as before. The client
sends a PER-JOB estimate when the queue line carries one (issue #6):
`payload.estimated_seconds` on the queue line — a finite number > 0 — wins
over the per-project `estimated_seconds ?? 900`, so one long job no longer
inherits a short project default (or vice versa). The career-ops queue
builder passes the field through only when its source row already carries
a sane value; it never invents one. Today the default is still
`min(900×2, 1800) = 1800` — zero behavior change until an
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
  connection: `{name, url, activity_path?, log_glob?, auth_token?, models?, peers?}`. Create
  requires a valid http(s) `url` and rejects a duplicate
  (url + activity path). This is **config + display only**: the arbiter
  keeps watching its single configured feed; a declared row is where a
  future multi-feed core will point the watcher. `peer:` backends (e.g.
  `peer:gpu2`) are plain-words metadata — the entry point fronts them; the
  arbiter never routes to them.
- **Per-server API keys (#60 B):** `auth_token` is a **write-only** field
  for key-gated engines (oMLX answers its feed and `/v1/*` only with
  `Authorization: Bearer <token>`). When a row carries one, the arbiter's
  feed fetcher sends it as that header; the watched row's seed comes from
  config `server_auth_token`. The value is NEVER echoed by any read
  surface — `/api/state` (including the anonymous view), `/api/servers`,
  the POST response, and mesh snapshots carry an `auth_set` boolean
  instead. Patch semantics: a non-empty string sets/replaces, the empty
  string is the sentinel that REMOVES it, an absent key keeps the stored
  value (a read-modify round-trip of the other fields can never drop the
  secret). The state file is written 0600 — it is the only place the value
  lives. The dashboard's server form has a password field for it: empty =
  keep, type = replace, the remove tick box = the clear sentinel.
- **Feed-off providers (#60 A1):** an **explicit empty `activity_path`**
  (config `activity_path: ""` or a create/patch body carrying `""`) declares
  the server has NO activity feed — oMLX and other key-gated engines expose
  none. The detector then DISABLES the feed signal instead of degrading it,
  and `log_glob` alone carries the idle verdict (`idle_for_s` from the log
  mtime; `null` — never idle — when the glob matches nothing, so the
  fail-closed posture is unchanged). The signal carries `feed_enabled:
  false` for the dashboard. An absent key keeps the default
  `/api/metrics/activity`, so every existing row behaves exactly as before.

```bash
node scripts/idlefill-control.mjs servers
node scripts/idlefill-control.mjs server add box-two http://192.168.9.9:11434 [--models a,b] [--peers peer:gpu2] [--auth TOKEN]
node scripts/idlefill-control.mjs server set <id> [--name N] [--url U] [--models a,b] [--peers p1] [--auth TOKEN | --auth-clear]
```

## Dashboard layout (the work flow)

The dashboard reads top-to-bottom as the operator's work flow: the header
state word answers *is the box doing what it should* (`Idle` green /
`Busy` amber / `Running Idle Tasks` blue / `Degraded` red, or `unreachable`
when the poll fails), then a **view-tab bar** (#61 step 2: **Overview ·
Projects · Sessions · Usage** — one page, four views, so the desktop
webview reads as one tabbed surface), then the sections of the active view,
and the fixed bottom **logs** tray (Events/Leases tabs, shared
records-to-show — a dock, not a tab: it stays reachable from every view).

- **The hand-off pair** — two quiet header buttons, `copy url` and
  `copy token`, next to the gate-token field. They put the two values an
  agent config needs to reach this arbiter on the clipboard: `server_url`
  and the API token. One button per value (the paste targets are two
  different config fields, so one combined button would force the operator
  to split the string by hand). `copy url` copies `location.origin` — the
  origin the page is provably served from, which is also what the
  dashboard's own fetches ride; a loopback origin only answers this
  machine, so a remote agent needs the tailnet URL (open the page on that
  URL, or copy it from the mesh row). `copy token` copies the token THIS
  browser already holds (`localStorage idlefill.token`); with nothing
  stored the label says `paste it in first` rather than putting an empty
  value on the clipboard. **There is deliberately no server route that
  serves the token** — every `/api/*` read is token-gated or anonymous
  (the write-only credential posture), so a token-returning route would
  hand the credential to any page that can read it. Clipboard mechanics
  ride one helper (`copyText`): `navigator.clipboard` is UNDEFINED on a
  plain-HTTP origin that is not loopback (`isSecureContext` excludes
  `http://<tailnet-ip>:8787`), so the async API needs an
  `execCommand("copy")` textarea fallback; a button that cannot copy says
  `copy failed` and leaves it there — a blind `copied` over an empty
  clipboard is the worst failure mode for a paste into an agent config.

- **The view split** — every section carries a view: **Overview** =
  Inference Servers, Machines (mesh), Cycles, Throttled jobs; **Projects** =
  the Projects pane + queue search; **Sessions** = interactive traffic;
  **Usage** = the metrics charts. The switch is a CSS class flip
  (`section.vthide`), never inline display — the exception-only sections
  keep owning their own hidden-while-empty state inside a tab, and the view
  shows an italic empty line only when its whole area would be blank. The
  selection persists (`localStorage idlefill.viewTab`); the Sessions tab
  badges a count only while sessions sit queued, the Projects tab only
  while jobs are throttled (exception-only). The queue detail route
  (`/[project]/[worker]/queue`) hides the tab bar and keeps its
  single-section layout.
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

### Extending the MCP server with tool modules (issue #15)

The server's tool table is an extension point: a **tool module** is an ES
module that default-exports `{ api, tools, call }` — `api` is the
server↔module contract version it targets (`MODULE_API` in
`adapters/career-ops/mcp-tools-registry.mjs`, currently 1; a module declaring
a higher `api` aborts startup with an actionable message), `tools` is the
array of JSON Schema tool definitions exactly as `tools/list` requires, and
`call(name, args, ctx)` is the handler. `ctx` is supplied by the server —
`{ project, paths, config, arbiter, log }` — so a module never resolves the
client config itself and never opens a file by a hand-computed path.

Discovery runs once at startup, two origins searched in order:

1. `adapters/<dir>/idlefill-mcp-tools.mjs` — one bounded scan, same depth as
   the adapter registry. An adapter ships its module with the adapter; the
   optional `idlefill.mcp_tools` manifest field names a different file.
2. `IDLEFILL_MCP_TOOLS` — a `:`-separated path list (absolute or relative)
   for out-of-tree tools. A path may be a module file or a directory holding
   `idlefill-mcp-tools.mjs`.

Names from (1) shadow names from (2) (reported on stderr). A duplicate tool
name within one origin, a module re-declaring a core tool, an api-too-new
module, or a module that fails to import aborts startup (exit nonzero, the
message on stderr names both offending paths for duplicates). The published
set is `(core ∪ discovered) ∩ policy` — discovered tools flow through the
per-project `mcp` policy (#14) unchanged, and a discovered tool whose
annotations say `readOnlyHint:false` / `destructiveHint:true` is treated as
write-bearing (blocked for `allow_write:false` projects exactly like the core
write tools). Registration order is sorted by name, so the list never depends
on readdir order. A throwing module handler is reported as `isError: true`
naming the module; the server stays up.

The core tools' JSON Schemas are pinned in `adapters/career-ops/tools.golden.json`
(regenerate: `node adapters/career-ops/idlefill-mcp.mjs --dump-core-tools`);
the test byte-compares the core subset of `tools/list` against it. The
fixture `adapters/career-ops/test-fixtures/hello-tool/` is the reference
module. The `register(api)` module shape is deliberately out of scope.

## Conventions

See `AGENTS.md`. Short version: Node 22, ESM, `node --test` (run via tsx for
TS), no framework lock-in beyond Fastify, secrets via env/config files that are
gitignored.

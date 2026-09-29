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

`menubar/IdlefillMenubar.swift` is a `MenuBarExtra` companion (macOS 14+,
built with plain `swiftc` — no Xcode project) that shows the arbiter state
at a glance and controls the local client daemon. It is a second *view* of
the same daemon, not a different daemon: liveness is read from the arbiter
(the client row's `last_seen`, within the arbiter's 90s window), so the
daemon can be started from anywhere — the menu bar, an Orca tab, launchd —
and the arbiter stays the ground truth. The panel shows the state word, this
machine's status, queue depth, today's finished/failed, and the running
lease, plus Open Dashboard · Show Logs · Start/Stop · Restart · Update
code · Quit.

- **Build:** `menubar/build.sh` → `menubar/IdlefillMenubar`. It is **not**
  installed as a launchd job by default; `menubar/IdlefillMenubar.plist` is
  the opt-in LaunchAgent if you want it at login.
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
  `LSUIElement false` — it has a window), draws the dock icon at runtime
  (the open-ring logo, no `.icns`), and `codesign --force -s -` signs it so
  Gatekeeper-on-local is happy. Run it with `open desktop/Idlefill.app`.
  Install to Applications with `cp -R desktop/Idlefill.app /Applications/`.
- **Three surfaces in the window**
  - **State** — the color-coded state word, this machine's status, queue
    depth, today's finished/failed, and the running lease. Polls
    `GET /api/state` every 5s with the Bearer token.
  - **Logs** — the client daemon log (`client/<entry>/logs/client.log`,
    `src` in dev / `dist` after a build; falls back to `client/logs/` if
    the entry log is missing). Refreshed on a ~2.5s timer, keeps the last
    ~2000 lines, auto-scrolls to the tail while you're at the bottom and
    pauses when you scroll up (the "follow tail" toggle resumes it).
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

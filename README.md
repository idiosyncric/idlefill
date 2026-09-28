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
adapters/   per-project executors (career-ops: queue builder + JD evaluator)
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

Workers are **self-reported by the clients** (the arbiter does not infer
allocations): each client daemon re-registers on every poll tick (~20s) with
its project list — `name`, `model`, `estimated_seconds`, and a **live queue
depth** (the arbiter never reads the queue files). The server stores this in
the state file and refreshes `last_seen` on every heartbeat; a worker is
**online** when its heartbeat is <90s old (≈5 daemon polls). Re-registration
stays idempotent by name: same `client_id`, so client overrides (pause/force)
keep sticking across daemon restarts.

In the API: `POST /api/clients/register` accepts an optional
`projects: [{name, model, estimated_seconds, queue_depth, stats?}]`
(malformed rows are dropped; `stats` is a small object of number/short-
string values the client computed itself — the arbiter stores and displays
them verbatim), and `GET /api/state` / `GET /api/projects` return per-project
`workers: [{client, model, estimated_seconds, queue_depth, online, stats}]`,
a `today: {finished, failed}` results row (UTC day of each lease's end), and
a `scheduling` object (the EFFECTIVE `idle_seconds`,
`max_concurrent_leases`, `lease_ttl_seconds`, `daily_token_cap`, plus
`overrides` for the raw per-project values and `global` for the global
knobs an unset override falls back to — the dashboard's settings editors
show those as the dashed "inherit" placeholders). `GET /api/state` also carries
the `servers` inventory (see Inference-server inventory above). A project
with no connected workers shows "no workers connected" — a scheduling row
with no executor behind it tells you the queue will not drain.

## Conventions

See `AGENTS.md`. Short version: Node 22, ESM, `node --test` (run via tsx for
TS), no framework lock-in beyond Fastify, secrets via env/config files that are
gitignored.

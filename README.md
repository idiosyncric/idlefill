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
| 2 | Deploy to urza (compose + traefik route), launchd client, NInfer log ro-mount | **Untested** — artifacts in `deploy/` are clearly marked; nothing there has been exercised by a real deployment |

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

## Auth model

- Every API call and the WS connection must present a token from the server's
- Every API call and the WS connection must present one of the configured tokens (Bearer
- credential header or `token` query parameter).
- Exception (documented, LAN/tailnet-only): the dashboard page (`/`) and
  `GET /api/state` are unauthenticated **read-only** in phase 1. If a request
  to `/api/state` *does* carry a token, a bad one is rejected (401). Phase 2
  adds traefik's `middleware-local-ip-range` in front.

## Conventions

See `AGENTS.md`. Short version: Node 22, ESM, `node --test` (run via tsx for
TS), no framework lock-in beyond Fastify, secrets via env/config files that are
gitignored.

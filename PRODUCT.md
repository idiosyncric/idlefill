# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user today: the owner alone — single operator of a personal homelab.
Their job: keeping an idle LLM box (urza) productive by running background job
queues only while the box is idle, with the arbiter dashboard as the
glance-and-control surface. They look at it daily and expect it to be
excellent — not a throwaway operator page.

Direction (confirmed 2026-09-26, not yet built): expand idlefill into a SaaS
product for small local businesses that want to manage their own local
inference servers. The four named capabilities: manage connected local
inference servers, schedule idle tasks, collect metrics, and manage how model
routing is handled for connected clients. Until the SaaS phase exists, design
for the single operator; the SaaS audience is a future, not a current, user.

## Product Purpose

Run background AI work (job-queue evaluation) on a local LLM server **only
while that server has been idle**, so background work never contends with
interactive traffic. Success = the idle box produces queued results (e.g.
career-ops JD evaluations) automatically, and the operator can see at a glance
who is running what, how much budget is left, and pause/force anything.

## Positioning

The self-traffic exemption: a backfill client's LLM requests show up in the
same activity feed the arbiter watches. idlefill revokes its own lease
(unless it counts that traffic) or floods interactive users (unless it
exempts the client unconditionally). The mechanism that makes the whole class
of "fill my idle inference box" work safe: exemption applies **if and only if
the client currently holds an active lease**. No neighboring product can
truthfully copy a scheduler that is correct about its own traffic.

## Operating Context

- Homelab topology: the arbiter runs on urza (Docker, host networking) next to
  the LLM gateway (llama-swap) whose activity feed it watches; client daemons
  run on Macs over the tailnet. The compose + traefik hardening plane is
  RETIRED (2026-10-08): urza is host-networked via scripts/deploy-server.sh.
- Access posture: LAN/tailnet-only. Dashboard page and `GET
  /api/state` are unauthenticated read-only; all writes are Bearer-token
  authed. Reach is tailnet/LAN-only by deployment choice (no published port).
- Operator controls the system from the dashboard (header state word + engine
  gate combobox, per-client gates, gate token field) and from the CLI
  (`scripts/idlefill-control.mjs`). No other user-facing surfaces exist.
- Results land in `idlefill/data/` — never in the project repos the client
  works for (career-ops is strictly read-only).
- Dashboard copy convention (established, binding): plain words, no jargon —
  schedules read `runs when idle ≥Ns · max N jobs at a time · auto-cancels
  after Xm`; exception-only state tags; no lease/ttl/tok-per-day vocabulary in
  operator-facing UI.

## Capabilities and Constraints

Current (phase 1, live on urza):

- Idle detection from the gateway's activity feed + inference-engine log
  mtime; verdicts: idle / busy / degraded (degraded ⇒ never grant).
- Lease state machine: grants gated on idle + reidle gate; revocation on
  activity preemption, TTL expiry, budget; `max_concurrent_leases`.
- Per-project scheduling: `idle_seconds`, `max_concurrent_leases`, lease TTL,
  `daily_token_cap` (budget bar, amber past 80%).
- Workers are **self-reported** by client daemons (re-register every poll
  tick with live queue depths; online = heartbeat <90s); the arbiter never
  reads queue files and never infers allocations.
- Operator overrides per client: `pause` (block new grants; never revoke
  active) and `force` (bypass idle verdict + reidle gate only), with optional
  `until` expiry swept each tick; idempotent re-registration by name keeps
  overrides sticking across daemon restarts.
- Dashboard panels: Clients (rows + gate comboboxes + override badges),
  Projects (workers, budget, plain-words schedule), Leases, fixed Logs bottom
  tray (Events/Leases, shared records-to-show).
- Auth: Bearer token (header or `token` query param); one bad token on an
  otherwise-anonymous route is a 401.

Constraints: Node 22, TypeScript strict, npm workspaces monorepo, Fastify
(server), no framework lock-in beyond Fastify; dashboard is hand-written
static HTML+CSS+JS in `server/public/index.html` (outside tsc coverage —
inline script must be checked separately). urza is amd64; Mac is arm64 — the
shipping image is built natively on urza, never on the Mac. Secrets live in
gitignored config files; tokens never appear in commands, commits, or UI
copy.

## Brand Commitments

- Name: **idlefill** (product, arbiter, daemon, repo).
- Dashboard voice: operator-plain. Plain words over jargon; the state is the
  color-coded word, not the frame; exception-only tags (no tag = running
  fine). This was an explicit dont-make-me-think pass the owner signed off
  on (recent history: "don't-make-me-think pass — plain-words schedule, no
  jargon, drop the no-op tag").

## Evidence on Hand

- `README.md` — architecture, the self-traffic trap, auth model, operator
  overrides, projects/workers view, phase status.
- Live dashboard implementation: `server/public/index.html` (hand-written).
- Test suites (server + client), `npm run test` / `npx tsc --noEmit` gate.
- A deployed, working instance on urza (dashboard at the tailnet IP:8787).
- Absences future work must not fabricate: no customers, no public launch,
  no pricing, no SLAs, no third-party benchmarks, no testimonials. The SaaS
  phase has zero evidence on hand yet — it is direction only.

## Product Principles

1. **Idle is a hard gate, not a preference.** Background work runs only when
   the box has been idle long enough; when in doubt (degraded signal), never
   grant. Interactive traffic always wins.
2. **Self-reported state.** Clients report their queues, models, and
   allocations; the arbiter trusts reports over sniffing, and stays correct
   about its own traffic by exempting only active leases.
3. **Crash-safe and recoverable.** Crash-safe queue handling, idempotent
   registration, auto-expiring overrides, deploys with auto-rollback — a
   dropped daemon or a failed deploy must never corrupt the box.
4. **Plain words for the operator.** The dashboard is glanced at daily;
   jargon is a defect. Show exceptions, not the null case.
5. **One operator first.** Every control exists because a single operator
   uses it daily; the SaaS expansion must earn its complexity later, not
   preload it.

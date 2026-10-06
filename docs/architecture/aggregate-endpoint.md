# Aggregate inference endpoint — issue #63 (grilling, 2026-10-05)

The owner ask: every Hermes profile points at ONE loopback endpoint. The
`hermes model` list there shows the de-duplicated union of models from
every connected inference engine. Map: #42 (the session-identity plane —
the `/s/<token>` retirement lives there, not here) · #60 (the per-server
`auth_token` plane + the Mac-local arbiter) · #50 (the locked mesh
topology this doc sits on). Companion: `docs/architecture/mesh.md`
(locked). This document is the GRILL, not the build. Decisions are
LOCKED where the trade-off is clear-cut for the single-operator fleet.
The rest are PROPOSED for the owner. Nothing here is built.

## The gap, re-verified against the code

Every claim below was re-read on disk (2026-10-05). The issue body's
line numbers were treated as claims. The citations here are the verified
ones.

- The loopback proxy forwards to exactly ONE target. `startLlmProxy`
  takes `opts.target` as a single string and builds one `URL` from it
  (`client/src/proxy.ts:51,62`). It binds 127.0.0.1 only
  (`client/src/proxy.ts:192`).
- `/s/<token>/...` hits the session gate. Every other path is exact
  single-target passthrough (`client/src/proxy.ts:160-183`, gate branch
  at 163-179, passthrough at 181-182).
- `llm_target` is a single string (`client/src/config.ts:113`), default
  `http://100.105.225.1:11434` (`client/src/config.ts:152`).
  `proxy_port` defaults to 11435 (`client/src/config.ts:151`),
  `session_gate` defaults true (`client/src/config.ts:153`),
  `max_active_agent_sessions` defaults 2 (`client/src/config.ts:154`).
- Session rows are keyed by the `/s/<token>` path token
  (`SessionRecord.token`, `server/src/types.ts:398-400`). The gate keys
  its in-memory sessions by the same token
  (`client/src/session-gate.ts:217`). `X-Hermes-Session-Id` is captured
  per request (`client/src/session-gate.ts:199,283`) into the
  `session_id` ADD-key (#42 slice 0, commit `5bf3190`). Hermes core sends
  no identity header today — the seam (`client_kwargs["default_headers"]`,
  `agent/agent_init.py:832-836`) exists in the Hermes repo but is OUT OF
  SCOPE this wave, so the header may be absent on aggregate traffic.
- `ServerConnection` rows carry `models: string[]`
  (`server/src/types.ts:274`), a `provider` kind
  (`server/src/types.ts:285`, kinds include llama-swap / strata / omlx —
  #62), and a per-server `auth_token` (`server/src/types.ts:294`). The
  token is WRITE-ONLY: `serverView` destructures it out and substitutes
  the `auth_set` boolean (`server/src/api.ts:232-244`), and that view
  feeds both `GET /api/servers` and the anonymous `/api/state`. The only
  on-disk home is the arbiter state file, written mode 0600
  (`server/src/state.ts:117-119`).
- The arbiter's HTTP surface is Fastify with an `onRequest` auth hook
  scoped to `/api/*` (`server/src/api.ts:255-284`): every API route
  needs a token from config `api_tokens`, except the anonymous
  `GET /api/state` / `GET /api/metrics` and peer-token-scoped
  `GET /api/mesh`. The route table (api.ts, verified by grep) has NO
  `/v1/*` data-plane route. The arbiter listens on `cfg.listen`
  (default 8787, `server/src/config.ts:23`) with host `0.0.0.0`
  (`server/src/index.ts:251`).
- Nothing in the repo probes `/v1/models`. `grep` across `server/src` and
  `client/src` returns zero matches. The `models: string[]` on a row is
  operator-declared inventory — seeded from config `server_models`
  (`server/src/config.ts:22,69-71`) or typed into the dashboard form. It
  is NEVER observed from the engine.
- Commit `f5b8ab5` states it plainly: the arbiter→router command channel
  "does not exist" — promote/remove were deferred for exactly that
  reason. There is still no channel by which the arbiter pushes anything
  to the router.
- The gate learns arbiter state only by READING the daemon's
  `GET /api/state` poll (`SessionGate.onStatePoll`,
  `client/src/session-gate.ts:563-602`). It never receives a push.
- Fleet state measured live (2026-10-05): the Mac arbiter listens on
  :8787 (lsof, PID 83174), the daemon proxy on 127.0.0.1:11435 (PID
  83190), oMLX on :8000 (PID 79619). Nothing listens on 8888. The Mac
  arbiter's `/api/state` reports three server rows: `oMLX`
  (`http://127.0.0.1:8000`, watched, auth_set false, models
  `Qwen3.8-Flash-Next`, `Qwen3.8-Flash-Next-REAP-288-MLX-4bit`),
  `strata` (`https://strata.samwarth.com`, watched, auth_set TRUE),
  `strata-scanbot` (`http://10.10.10.241:8080`, watched, auth_set TRUE).
  oMLX answers `GET /v1/models` anonymously with 401. urza's llama-swap
  answers `GET /v1/models` with 200. The `flash` profile's active
  base_url is `http://127.0.0.1:11435/s/flash/v1` (profile config.yaml,
  line 4). Port 8888 elsewhere in the fleet is `dgx-spark-tyler`
  (`http://100.95.230.70:8888/v1`, another owner's box) — a name
  collision to respect, not ours to bind remotely.

## The rules this doc inherits

From `docs/architecture/mesh.md` (locked), restated as constraints on
this grill:

1. **One fused process per machine** (mesh D5). The machine's arbiter +
   client daemon + gate + surfaces are ONE instance. A third listening
   process is against the lock.
2. **Local-first surfaces** (mesh D3). Every surface points at the LOCAL
   arbiter. Thin clients never fan out.
3. **Engine ownership is EXCLUSIVE** (mesh rule 1). Only the owning
   machine's arbiter holds a detector and grants leases for an engine.
   A non-owning arbiter may hold a reference row — display + routing
   target, fail-closed for grants.
4. **State is published, never computed remotely** (mesh rule 3).
   Federation moves snapshots, never decisions.
5. **The session gate fails open per machine** (mesh rule 2). The gate
   lives in the client router. An unreachable arbiter never wedges a
   conversation.

## D1 — Who serves the aggregate endpoint: the client router, second port

**LOCKED.** Option (a): the client router (the daemon's loopback proxy)
binds a SECOND fixed loopback port — `aggregate_port`, default 8800 —
and routes by the `model` field of the request body against a router-
local catalog table. Every Hermes profile's config.yaml then carries the
same `http://127.0.0.1:8800/v1` on every machine.

Rejected (b) — the arbiter serves a data plane (`:8787/v1/...`):

- It breaks the credential model. `auth_token` is write-only by
  construction (`server/src/api.ts:232-244`). Surfacing the engine list
  to a profile through the arbiter invites a read surface that reveals
  or relays engine credentials. The write-only posture exists precisely
  so no HTTP surface ever carries them out.
- It changes the arbiter's exposure. The arbiter listens on `0.0.0.0`
  (`server/src/index.ts:251`) and answers the tailnet. A `/v1` data
  plane on that origin puts a proxying inference door on the network
  face of the control plane. Profiles want loopback-only.
- It changes the failure posture. Today a dead arbiter never wedges a
  conversation (mesh rule 2, gate fail-open). An arbiter-served data
  plane makes every chat depend on the arbiter's HTTP being up.

Rejected (c) — a separate thin router process:

- Against mesh D5 (one fused process per machine). It adds a second
  launchd label, a second config plane, and a second copy of the
  inventory to keep fresh. The daemon process already holds the proxy,
  the gate, and the arbiter link. A second listener inside it is the
  same capability at zero process cost.

The deciding trade-off: (a) keeps the data plane loopback-only,
in-process with the gate that must police it, and fail-open-capable,
while (b) collides with the write-only credential rule and the arbiter's
network-facing bind, and (c) breaks the fused-process lock. The "second
fixed port" is mesh D5-compatible: mesh D5 counts processes, not
listeners. The proxy already proves one process can own two listeners
(`client/src/proxy.ts:192` plus the daemon's other surfaces).

Rules for the endpoint:

- Bind 127.0.0.1 only, exactly like the proxy (`client/src/proxy.ts:192`
  posture).
- One config key on the client: `aggregate_port` (default 8800, `0` =
  disabled). It is an add key, and the loader's DEFAULTS pattern fits
  (`client/src/config.ts:146-156`).
- Route by `model` in the request body (the `sniffModelChunk` regex
  already reads it without buffering, `client/src/session-gate.ts:183-187`
  shape). `/v1/models` is answered BY THE ROUTER from the catalog — the
  union of catalog rows, not a passthrough probe.
- With the catalog empty or the model unknown, the router forwards to
  the machine's default `llm_target` exactly as today. A profile on 8800
  can never be worse than a profile on 11435 passthrough.

## D2 — The credential plane: the router asks the arbiter to fetch, never to hand over

**LOCKED.** The token stays in the arbiter's state file (its only on-disk
home, `server/src/state.ts:117-119`, mode 0600). For the catalog, the
arbiter probes each server row's `/v1/models` WITH the row's
`auth_token`, using the per-row fetcher that already receives the token
for feed fetches (`IdleDetectorOpts.auth_token`,
`server/src/idle.ts:227-231` and the strata fetcher pattern,
`server/src/idle.ts:155-167`). The arbiter publishes the catalog to the
router over an EXISTING authenticated direction: the daemon's
`GET /api/state` poll gains an ADD-key `catalog` block — model name,
server id, engine URL, `auth_set` boolean — and NOT the token. The
router's 8800 listener then adds the `Authorization` header per request.
The token reaches the outbound engine request without ever crossing an
ordinary HTTP response.

Two honest sub-shapes, one chosen:

- (chosen) **Router-held in-process secret through a scoped loopback
  pull:** the daemon does one new authenticated request
  (`GET /api/server-keys`, admin-token scoped, NOT part of `/api/state` —
  that view is anonymous-readable, `server/src/api.ts:263-266`) that
  returns the per-row engine URL + token for the ROUTER's own use. The
  arbiter answers this route only over loopback (a loopback check in the
  route, since the arbiter binds 0.0.0.0). The router keeps the tokens
  in memory next to the gate, forwards them on the wire, and never
  persists or re-publishes them. The write-only posture SURVIVES the API
  contract (no read surface other than the dedicated loopback route the
  router itself calls), and this is the simplest honest end-to-end
  answer: a routed request's engine token lives in the router process's
  memory, fetched from the arbiter over loopback, refreshed on the same
  cadence as the catalog.
- (rejected) **Arbiter-side proxying** — the router forwards the chat
  request to a new arbiter data plane, and the arbiter adds the token:
  it re-adds every D1(b) objection (arbiter network bind, arbiter in
  the chat hot path, arbiter-down wedges chats) and additionally puts
  the full chat payload through two more hops.
- (rejected) **Duplicate the tokens in `client/config.json`:** direct
  violation of the #60 B write-only posture. Two on-disk copies of every
  secret, neither the single source.
- (rejected) **Wait for the arbiter→router command channel:** `f5b8ab5`
  says it does not exist, and building a push channel is strictly more
  machinery than one loopback pull route. The pull route is the
  primitive the future command channel reuses. It does not pre-empt it.

The deciding trade-off: the operator is one person on two machines, so
"the token lives in the arbiter, is pulled once over loopback into the
router that needs it, and never appears on any other read surface" is
the smallest honest system. D2 answers the end-to-end question plainly:
**for a routed request, the engine token lives in the router process's
memory (in-process, loopback-fetched, never persisted by the router).**

## D3 — Session identity today: derive a stable key, keep the header as the upgrade

**LOCKED.** Aggregate traffic (8800) enters the SAME `SessionGate` code
path as `/s/<token>` traffic. The gate's key is today whatever the
router derives, in this order:

1. `X-Hermes-Session-Id` when present (it may be absent this wave — the
   Hermes-core injection is out of scope): key = the header value.
   `SessionGate.route` already captures and sanitizes it
   (`client/src/session-gate.ts:283, 199, 203-211`).
2. Fallback when the header is absent: key = the model name from the
   request body (sniffed without buffering, the #45 pattern
   `client/src/session-gate.ts:183-187`). One coarse row per model per
   machine.

That fallback IS the identity key that survives headerless traffic
TODAY: the engine+model pair the request names, because on aggregate
traffic the engine IS determined by the model (D4's routing). A Hermes
profile calling model X maps to exactly one row while it calls X.

Rejected alternatives:

- One single "aggregate" row for all of 8800: destroys the per-session
  pause/force control the gate exists to provide. One noisy profile
  would starve every other chat with no operator lever in between.
- Derive identity from the connection socket: keep-alive reuse and
  per-request client connections make the socket an unstable key.
  Nothing durable maps it to a conversation.
- Mint a token per profile config (the old `/s/flash` shape smuggled
  into 8800): reintroduces the hand-set plane #42 exists to retire.

The deciding trade-off: the model-name key is coarse but stable,
self-describing (the row names the model — the same fact #45 renders),
and it dies cleanly. The moment Hermes-core header injection lands, rule
1 subsumes rule 2 on the same field (`SessionRecord.session_id`,
`server/src/types.ts:420-429` contract), and #42's plugin path
converges on it. Nothing built here needs un-building later.

Surfaces: aggregate rows ride the SAME `POST /api/sessions/register`
heartbeat (`server/src/api.ts:681`) as gate rows. The row's `token`
field carries the derived key. The `session_id` ADD-key carries the real
Hermes id when the header ever arrives. Registration already distinguishes
by client (`client_name` + the #54 adoption rule,
`client/src/session-gate.ts:571-581`), so a derived key that names a
common model on two machines stays two honest rows.

## D4 — The de-duplicated catalog: declared union + live probe, collisions qualified

**LOCKED.** The catalog is built IN THE ARBITER
(it owns the rows and the tokens) on the existing `poll_ms` tick (15000
default, `server/src/config.ts:36`), then published to the router
through D2's mechanism.

- Base layer: the declared `models: string[]` on every
  `ServerConnection` row (`server/src/types.ts:274`) — union across rows.
  This layer is already true today (operator-declared inventory).
- Probe layer: a NEW per-row probe of `GET <row.url>/v1/models`,
  authenticated with the row's `auth_token` when set — the same credentialed
  fetcher pattern the #60 B / #62 feed fetchers already use
  (`server/src/idle.ts:227-231`). Verified today: oMLX 401s anonymously,
  so the probe needs the row token. llama-swap answers 200. Nothing in
  the repo probes `/v1/models` yet (grep across both packages: zero) —
  this is NEW arbiter code, in the same co-located fetcher family.
- Merge: probe results REPLACE the declared list for that row when the
  probe succeeds. A failed probe keeps the declared list (the declared
  inventory is never silently lost — same drop-don't-reject discipline
  as every observed field).
- Name collisions (one name, N rows — already true today:
  `Qwen3.8-Flash-Next` sits on both the oMLX row and the strata row on
  the live Mac arbiter): the catalog shows the bare name once
  (de-duplicated). The ROUTING target for a bare name follows the
  owner's fail-over vocabulary from #60 B2: primary = the row the
  operator lists first in a per-model order (config `model_preference:
  [server_name, …]`, default = row declaration order), and the request
  is pinned there — the aggregate endpoint does NOT fail over inside one
  chat. The display shape is the bare name (owner decision, below): a
  name served by N engines renders ONCE in `hermes model`, and idlefill
  picks the engine.
- What the arbiter provably CANNOT see for feed-off providers: for a
  provider kind with no supported sampler — oMLX's own `/metrics` and
  `/api/stats` 404 (`server/src/idle.ts:176`), and #62's honest
  `kindGapReason` covers the no-signal case (`server/src/idle.ts:201-205`)
  — the arbiter sees presence and model NAMES (through D4's probe or the
  declared row), but NEVER that engine's per-model token counts or
  request counters except through #62's local samplers (oMLX sqlite,
  strata `/metrics`). A row that is feed-off AND probe-blocked (401
  without a key, firewall) contributes ONLY its declared model list —
  the probe adds nothing and the catalog must say so (the row is
  `catalog_source: declared`, never falsely `probed`).

Rejected: pure declared union (goes stale silently — oMLX gains a model
and the catalog never learns). Pure probe is worse: a key-gated or
firewalled engine disappears from the operator's own list.

## D5 — Gate + lease interplay: aggregate traffic is session traffic

**LOCKED.** 8800 traffic enters the SAME session gate, under D3's key.
It behaves exactly like `/s/<token>` traffic on every control:

- slot cap (`max_active_agent_sessions`, default 2 — shared, not a
  second pool),
- FIFO park + hold cap + retryable 503 (`session_hold_cap_ms` default
  120000, `client/src/config.ts:155` and `expireHold`,
  `client/src/session-gate.ts:465-493`),
- pause / force overrides. The operator sets them by token, and the
  derived key IS the token in `POST /api/sessions/:token/override`
  (`server/src/api.ts:730-753`),
- fail-open when the arbiter is unreachable (`onLinkDown`,
  `client/src/session-gate.ts:605-612`),
- idle folding + preemption: the session row's `last_activity` folds
  into the owning server's idle verdict through
  `sessionActivityOn(server_id)` (`server/src/arbiter.ts:855-862`). The
  router therefore reports the row's `server_id` as the catalog-chosen
  server for the request's model (register already accepts `server_id`,
  `server/src/api.ts:686`). Absent that, the row lands on the watched
  server by the `leaseServerId` fallback (`server/src/arbiter.ts:86`) —
  wrong folding for an engine chosen off the watched row, so the router
  MUST set it on aggregate rows.

The cap is SHARED across 11435 and 8800 because both listeners share one
`SessionGate` instance in one process. That is the honest model: the
slot cap counts sessions at THE ENGINE, and the engines are shared.

Leases: aggregate traffic needs NO lease, exactly like `/s/<token>`
traffic (`SessionRecord` doc, `server/src/types.ts:388-397` — session
admission is capacity-only at the router. The arbiter tracks rows for
visibility, idle folding, and overrides). The background-job lease path
(`POST /api/leases`) stays untouched. Preemption stays honest: session
activity on the chosen row preempts background leases ON THAT ROW's
server, same rule, correct row per D3/D5's `server_id` requirement.

One gate instance per process means one gate per machine, which is what
mesh rule 2 locks anyway. Two gate instances (one per listener) would
double the effective slot cap against the same engines — the bug shape
this section exists to forbid.

## D6 — What stays untouched

**LOCKED.**

- The `/s/<token>` path stays exactly as built (#9/#33/#43/#44): the
  proxy's gate branch (`client/src/proxy.ts:162-179`) is untouched, and
  the Sessions launcher's hand-over line (the bound `proxy_port`,
  `client/src/index.ts:1559`, dashboard minting) keeps working for
  non-Hermes clients and per-chat explicit identity. #42 owns that
  plane's retirement. This doc does not touch it.
- Plain `/v1/...` job passthrough keeps the exact single-target contract
  (`client/src/proxy.ts:181-182`, proxy header contract lines 10-16).
  The career-ops flow (executor points at `127.0.0.1:11435/v1`) never
  enters the gate and never sees the catalog. The 11435 listener's
  behavior is byte-for-byte unchanged.
- The `flash` profile's working config
  (`base_url: http://127.0.0.1:11435/s/flash/v1`, config.yaml line 4)
  keeps working with zero edits. Moving it to 8800 is an operator
  action after the build wave, not a behavior this doc changes.
- The lease/queue/budget machinery, the mesh read plane, and every
  existing `/api/*` shape stay as-is. New surfaces are ADD keys or new
  routes (`GET /api/server-keys`, loopback-only) — never renames.

## Rules (restated crisp)

1. The aggregate endpoint is a SECOND LISTENER (default 8800, loopback-
   only) inside the daemon process — never a new process, never on the
   arbiter's network-facing origin.
2. The catalog is built in the arbiter from `ServerConnection` rows plus
   authenticated `/v1/models` probes, and published to the router. The
   router routes. The arbiter inventories.
3. Engine tokens live in the arbiter's state file. The router may hold
   them in memory through one loopback-scoped pull route. No other read
   surface ever carries them.
4. 8800 traffic is session traffic: one shared gate, one shared slot
   cap, overrides by derived key, fail-open, idle folding against the
   CORRECT server row (`server_id` reported).
5. The session key today is `X-Hermes-Session-Id` when present, else the
   request's model name. The header plane is the upgrade, not a
   dependency.
6. `/s/<token>`, plain `/v1` passthrough, and leases keep their exact
   current contracts.

## What changes vs what stays untouched

Changes (the build wave, after this grill):

- `client/src/config.ts`: ADD `aggregate_port` (default 8800, 0 = off).
- `client/src/index.ts`: start a second `startLlmProxy`-shaped listener
  with a catalog router in front of the SAME `SessionGate`. Add the
  catalog fetch/refresh loop.
- `client/src/proxy.ts` (or a sibling module): the model-routed forward
  — one target per row chosen, per-request `Authorization` from the
  router's in-memory key table.
- `server/src/api.ts`: ADD `GET /api/server-keys` (loopback-only, admin
  token) — engine URL + token per row, for the router.
- `server/src/arbiter.ts` / idle.ts family: the per-row `/v1/models`
  probe on the poll tick, credentialed per row. Add the catalog publish
  step.
- Suite: catalog merge + collision rule, key-pull loopback rule,
  derived-key gate behavior, probe-failure keeps declared list.

Untouched (fenced by D6 and the inherited mesh locks):

- The 11435 listener's passthrough + `/s/<token>` gate branch.
- `SessionRecord`'s existing fields (the ADD-key contract).
- Every existing `/api/*` route's auth scope and shape.
- The lease engine, budgets, the job flow, the mesh read plane.
- Every profile's config except as the OPERATOR later edits them.

## Decisions (owner, 2026-10-05)

1. **Ambiguous names render BARE.** A model name served by N engines
   appears once in `hermes model`. No host suffix, no suffix routing
   key. idlefill picks the engine inside the routing layer. LOCKED.
2. **First wave: row declaration order, no new key.** The owner
   deferred; the doc's default stands. `model_preference` stays the
   named follow-up knob — it is added only when a real collision needs
   an override the declaration order cannot express. Nothing blocks the
   build wave.
3. **Loopback key-pull accepted.** The owner deferred; D2's chosen
   shape stands: the token lives in the arbiter state file, crosses
   into the router's memory only over the loopback-scoped
   `GET /api/server-keys`, and never appears on any other read surface.
   The rejected alternative (arbiter-side proxying) costs the chat hot
   path and the arbiter's network bind.
4. **The port is 8800, not 8888.** The owner picked `:8800` fleet-wide
   (configurable via `aggregate_port`, default 8800, `0` = off).
   Verified: nothing on this machine binds 8800. The old grill probe
   above (8888, other hosts) is the measured history at grill time.

Every named decision is now LOCKED. Issue #63 closes with this
section. The build wave rides issue #64.

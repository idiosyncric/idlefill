# Alias stability and slow engines — :8800 as the self-healing inference face (2026-10-12 incident, owner posture)

## The owner ask (authoritative)

1. Configured model aliases are the STABLE advertised surface. They always appear on
   `:8800 /v1/models` while their config exists. Engine probing NEVER un-publishes an
   alias; probe evidence only *alerts* on misalignment.
2. Agents talk only to `:8800`. A request must never silently fall through to a
   machine default (oMLX) when the name is a configured alias — a configured-but-
   unavailable model answers a clean error, never a 401 from an unrelated engine.
3. Slow inference engines: if idlefill can see a request is still queued/working,
   keep waiting. Config must offer (a) wait (today), (b) auto-forward to the next
   healthy alias pair (pre-first-byte only), or (c) prompt the operator to re-route
   the session in the dashboard (highlighted session→engine edge + one-click engine pin).

## The gap, re-verified against the live incident (2026-10-12 — do not re-derive)

- The arbiter (:8787) was SIGTERM'd 11:56 EDT and stayed down ~5h; the client
  fail-opened. Cold start (13:09:32) published `model_aliases: []` for the first
  ~15s: every stored pair sat on a probe-SUCCEEDED row whose list did not yet
  contain the id (engine cold), so `buildAliasBlock` dropped every pair and the
  alias was "not offered" (server/src/arbiter.ts:1574-1586 — today's
  all-pairs-dead exception).
- The client's `this.aggregate.updateAliases(st.model_aliases ?? [])`
  (client/src/index.ts:1614) CLEARED the router's alias map, and the next
  `Qwen3.8-Flash-Next` request fell to `llm_target` (oMLX :8000) with the agent
  key STRIPPED (`#68` null-auth on the default-target path) → `401 "API key
  required"` from oMLX (log 12:55:11 & 13:11:43 EDT, matching Hermes agent.log
  within 10ms). Two failure rounds; sessions a0f1fdb0 / 20261012_131104_c4f89f.
- `aliasPublished` is ephemeral and boot-seeded empty; a client cold-started
  during a publish gap has never SEEN the alias names at all.
- Capability keys ride only from a live probe entry (arbiter.ts:1608,1623-1625);
  a `declared` winner advertises no caps even though `lastProbed` (#67) retains
  last-good entries.
- The forward path (`client/src/aggregate.ts` `forwardTo`/`forwardBuffered`) has
  no TTFB timeout, no watchdog, no failover. The probe fetcher is 10s
  (server/src/catalog.ts:136) — probe cadence is healthy; the FORWARD is what
  hangs.
- Queue depth exists only for oMLX (`/api/status` `waiting_requests` →
  `load.queue_depth`, server/src/load.ts:68); llama-swap/strata expose gauges, no
  queue count. The arbiter already publishes `servers[].load` on /api/state.
- Session re-route primitives EXIST: the engine-pin write
  (`POST /api/sessions/:token/pin`, server/src/api.ts:1255 → gate `pinFor` →
  `pinnedEntryFor`, client/src/aggregate.ts:536-559). No alert/prompt UI.

## Inherited rules and amendment discipline

This doc AMENDS exactly three LOCKED decisions and leaves the rest standing:

- model-aliases.md D3 "all pairs dead = not offered" — amended by D1 below.
- model-capabilities.md D2 "winner-only capability ADD keys … a declared
  winner claims nothing" — amended narrowly by D1 (carry-over from `lastProbed`
  is still captured truth, never fabricated; D1's "capture, never fabricate"
  stands).
- aggregate-endpoint.md D6 fence "unknown/absent model → `llm_target`" —
  NARROWED by D2 (configured-alias names are no longer "absent").
- engine-health-routing.md D2 winner chain — UNCHANGED (D1 keeps the chain
  byte-for-byte whenever any survivor exists).
- model-capabilities.md D4 "misalignment is derived at display, not stored" —
  stands: `mismatch` remains a per-tick ephemeral marker, exactly like today's
  per-tick `dropped`; the state file changes for NO key.

## Decisions

### D1 — Publish posture: stored config ALWAYS publishes; probe contradiction ALERTS **LOCKED (owner, 2026-10-12)**

`buildAliasBlock` (server/src/arbiter.ts:1546) becomes an evidence ALERTER over
the stored config, not a filter:

- Every tick, every alias whose stored name passes the D1 sanitizer publishes
  EXACTLY ONE entry, as long as at least one pair references an existing row
  with a usable url. Nothing else can un-offer an alias.
- Per-pair markers: a probe-SUCCEEDED row whose list lacks the pair's id is now
  marked `mismatch` (renames today's per-tick `dropped` semantics for that
  case). `dropped` REMAINS the marker for sanitizer drops (hostile id, missing
  row, blank url) — those are config corruption, not probe contradiction.
  `aliasPairStates` / `GET /api/aliases` / the Models view carry the rename.
- Candidate set for the winner: today's survivors (probed ∪ declared) are the
  FIRST-RANK candidates and the health-ordered chain (engine-health-routing.md
  D2: pin-healthy → first healthy non-pin → pin-degraded → first survivor,
  group filter on steps 1-2 only) runs over them BYTE-FOR-BYTE. Only when
  FIRST-RANK is empty (today's unpublish case) does the same chain run over the
  `mismatch` candidates, so the alias still publishes — honestly degraded
  instead of vanished.
- ADD-key `degraded: true` on the published entry when the winner's pair source
  is `mismatch` OR `declared` (a winner that is not probe-confirmed this tick).
  Omitted on probe-confirmed winners. The router IGNORES the key; the dashboard
  renders it. `fallback` keeps its exact today semantics (winner ≠ stored pin).
- Capability carry-over: a `mismatch` winner inherits caps from `lastProbed`
  (the #67 last-good map, entry matching that model); `lastProbed` absent →
  caps omitted, exactly today. A `declared` winner with a `lastProbed` entry
  for its row+model now carries those caps too (previously omitted) — last-GOOD
  truth, never fabricated (the D1 capture rule stands; model-capabilities.md
  D2 is amended for this narrow carry-over).
- ADD-key `fallback_targets`: array of the OTHER pairs (survivors OR mismatch,
  stored order, winner excluded, only rows that exist with a non-empty url),
  each `{server_id, url, engine_model}` — the same D1 sanitizers, and NO token
  by construction (the client already pulls per-server row tokens via
  `/api/server-keys`). Omitted when empty. This is the client failover surface
  (D3); the arbiter never forwards anything itself.
- Event alert: when a pair transitions into `mismatch` (or stays there), the
  arbiter appends a `alias_pair_mismatch` event to the state.json event log
  (`store.appendEvent` — the same plane as `mesh_control`), detail
  `<alias>: <server_id>/<model>`. Rate-limited: per (alias, server_id, model)
  at most once per 15 minutes; at most 10 such events per tick.
- Cold start: `modelAliases()` must NEVER return an empty array while
  `store.state.model_aliases` is non-empty. The arbiter seeds the publish block
  at load (all pairs `declared`, no probe evidence yet) BEFORE `/api/state` can
  answer; the existing boot `tickOnce()` (server/src/index.ts:473) then refines
  it with probe evidence. A sanitizer-degenerate config (no pair with a usable
  url) is the only empty case, and D2's client fence still fences the names it
  has seen.

### D2 — The default-target fence: a configured alias never silently falls through **LOCKED (owner, 2026-10-12)**

The client router (client/src/aggregate.ts) keeps a process-lifetime monotonic
set `configuredAliasNames`: every alias name EVER accepted into the routing map
(added by `updateAliases`; NEVER removed — an empty/absent block no longer
wipes the fence memory, though it still clears the routing map itself).

At dispatch, after the model sniff: if the requested name is in
`configuredAliasNames` and NO entry resolves (neither the alias map NOR the
bare catalog map), the router answers locally with `503` and an OpenAI-style
body —

```json
{"error":{"message":"model \"<name>\" is configured on this machine but no engine currently serves it","type":"model_unavailable","code":"model_unavailable","model":"<name>"}}
```

— before the gate, with zero bytes written to any upstream. Never `llm_target`,
never a stripped-agent-key hop to an unrelated engine (the 2026-10-12 shape).

- A bare catalog row of the same name DOES resolve → routes normally with that
  row's token (a bare-name route is not a machine-default fall-through).
- Genuinely unknown names keep today's `llm_target` fall-through byte-for-byte
  (aggregate-endpoint.md D6, narrowed not removed).
- Honesty limit (documented, not fixed): a client process cold-started while
  the arbiter published nothing for those names has never SEEN them — the fence
  can only fence what it has seen. D1 removes that server-side window.

### D3 — Slow-engine policy: TTFB watchdog, failover, queue awareness **LOCKED (owner, 2026-10-12)**

New client config keys (ADD-key posture, flat snake_case like `aggregate_port`):

| key | default | meaning |
| --- | --- | --- |
| `aggregate_slow_handling` | `"wait"` | `wait` = today byte-for-byte; `failover` arms the watchdog |
| `aggregate_ttfb_timeout_ms` | absent (watchdog OFF) | time to first upstream response byte before the watchdog fires |
| `aggregate_queue_depth_cap` | `3` | queue-suppression cap (read only in `failover` mode) |

- Watchdog scope: the BUFFERED aliased forward (`forwardBuffered`) ONLY — the
  body is already fully buffered, so it is replayable. `forwardTo` (piped
  bodies: bare names, alias-with-same-id, default target) never gets a
  watchdog; its bytes are not replayable.
- The timer starts when the upstream request is dispatched; it fires when no
  upstream RESPONSE (headers) arrives before the deadline. If ANY upstream
  response (even an error status) has arrived, or ANY byte has reached the
  caller, the watchdog is disarmed forever for that request: NEVER retry
  after first response byte.
- Queue suppression: the router keeps a per-server queue digest
  (`server_id → queue_depth + observed_at`), fed from the arbiter's existing
  `servers[].load` on the same /api/state poll (`load.queue_depth`, oMLX rows
  only today — absent elsewhere). On a watchdog fire: if that target's queue
  digest is FRESH (age ≤ 20s), `queue_depth > 0`, AND `queue_depth <` the cap,
  the engine is demonstrably still working → re-arm the watchdog (extend the
  wait), no failover. Stale/zero/over-cap → failover is eligible.
- Failover (pre-first-byte only): abort (destroy) the current upstream, retry
  ONCE against the first usable `fallback_targets` entry — its own
  `engine_model` spliced into the already-buffered body, its row token from the
  existing keys map (same auth resolution as the primary, #68 rules included).
  One retry, no chain. Log the switch:
  `aggregate: alias <name> ttfb > <ms>ms → failover <server_id>/<engine_model>`.
- If failover is not eligible (watchdog fired with no usable target): answer
  `504` OpenAI-style `{error:{message, type:"upstream_timeout",
  code:"upstream_timeout", model}}` — headers not yet sent, so it is clean.
- `wait` mode + no timeout key = today's flow byte-for-byte: socket errors only,
  no abort, no retry.

### D4 — Dashboard: the session→engine edge and the re-route prompt **LOCKED (owner, 2026-10-12)**

- Models view: `mismatch` pair markers render (the `dropped` label renames to
  `mismatch` for the probe-contradiction case; sanitizer `dropped` keeps its
  own label), and a `degraded` chip on an alias whose winner is not
  probe-confirmed. Data: `GET /api/aliases` + the published `model_aliases`
  block (D1's new keys).
- Sessions view: every session row draws its engine EDGE (session → the
  server_id it routes through), annotated with that row's load state (busy /
  queue depth / sample age).
- "Slow" heuristic (display only): session gate state `active` AND its edge's
  engine row shows fresh `queue_depth > 0`, OR a load sample older than ~15s,
  OR row posture `no-signal`/`degraded` → highlight the edge and surface a
  "Re-route…" affordance.
- Re-route: a pair chooser over that session model's alias pairs (from
  `GET /api/aliases`) that POSTs the EXISTING engine-pin API
  (`POST /api/sessions/:token/pin`) — no new server surface, no new credential
  plane. The pin lands through the existing release-time resolver
  (`pinnedEntryFor`), so a parked session moves at its next release.

## Rules (restated crisp)

1. An alias is offered iff its config exists (minus degenerate sanitizer
   cases); probe evidence marks pairs `mismatch` and appends a rate-limited
   `alias_pair_mismatch` event — it NEVER un-publishes.
2. Winner chain unchanged: first-rank survivors run the health chain first;
   mismatch pairs only publish when nothing else survives, flagged
   `degraded: true`.
3. `mismatch`/`declared` winners inherit caps from `lastProbed` when present;
   caps are never fabricated, only last-good-carried.
4. `fallback_targets` carries `{server_id, url, engine_model}` only — a token
   never enters the block (the client pulls row tokens separately).
5. A name the router has EVER seen published, with no usable entry now, gets a
   local 503 `model_unavailable` (OpenAI body, `error.model` echoed) — never
   `llm_target`, never another engine's 401. Unknown names: unchanged.
6. `aggregate_slow_handling=wait` (default) and absent
   `aggregate_ttfb_timeout_ms` = today's byte-for-byte flow.
7. Failover is buffered-aliased-only, pre-first-byte-only, exactly one retry,
   into a `fallback_targets` entry with its keys-map token; fresh
   0<queue_depth<cap means "still working" → extend, never fail over.
8. The dashboard highlights slow session→engine edges and re-routes with the
   EXISTING pin API. No new server endpoints except D1's publish keys/events.
9. The state file gains no key: `mismatch` stays a per-tick ephemeral marker
   (model-capabilities.md D4 stands).

## What changes vs what stays untouched

- CHANGES: `buildAliasBlock` (posture + markers + `degraded` +
  `fallback_targets` + carry-over), boot-seeded publish block,
  `alias_pair_mismatch` events, client router fence + `configuredAliasNames`,
  buffered-forward watchdog/failover, three new client config keys, dashboard
  Models/Sessions surfaces, docs D-amendments.
- UNTOUCHED: the health chain order and group filter, the `fallback` key,
  splice/buffer posture, gate/lease interplay, the agent-key plane, the pin
  API, `/api/state` session rows, the state file schema, unknown-name
  fall-through.

## Work-package mapping

- A = this doc. B = D1 (server). C = D2 (client). D = D3 (client, after B —
  needs `fallback_targets`). E = D4 (dashboard, after B, D preferred).
  F = live runbook + per-issue reports.

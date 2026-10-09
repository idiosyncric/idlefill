# #73 — Hermes Gateway API connector: the observed complement to the gate

**Status:** delivered on branch `issue-73` (base `f47326d`). Not pushed, not merged.

The client daemon now observes the per-Mac **Hermes Gateway API** (`127.0.0.1:8642`)
as a strictly fail-open *complement* to the egress session gate, and exposes a
*runs control* seam for dispatching/controlling runs through that same API.

## Plane map (why it is a complement, never a second gate)

From [ISSUE9-RESEARCH-HERMES-SURFACES.md](ISSUE9-RESEARCH-HERMES-SURFACES.md): the
loopback proxy is the **egress plane** — it holds a provider call already in
flight (the gate's chokepoint). The arbiter is the **control plane**. The Hermes
Gateway API server is the **inbound plane**: one listener serves every profile
(native routes mirrored under `/p/<profile>/...`), and it *can never hold a
provider call already in flight*. It therefore cannot gate anything the gate
already holds — it is an **observed complement**, never an alternative gate.

## What was built

### Slice A — session enrichment (the `hermes_meta` ADD-key)

- **`client/src/hermes-gateway.ts`** (new): the `HermesGatewayConnector`.
  Each poll round does `GET /v1/health` (unauthenticated — proves the server is
  up even when every authed route 401s) + one `GET /api/sessions` (default
  home ledger) and one `GET /p/<profile>/api/sessions` per named profile.
  Ledger rows (titles, model, message/tool/token counts, `estimated_cost_usd`,
  `last_active`, `ended_at`, `end_reason`) are sanitized per-member
  (drop-don't-poison) and merged **last-known-wins** into a session-id →
  meta map: an absent member never erases what a better poll reported; an
  explicit `ended_at: null` rides (the row ended without a reason).
- The daemon's register-heartbeat closure (in `client/src/index.ts`) joins the
  ledger to the gate's session rows on the `session_id` the router already
  captures from the `X-Hermes-Session-Id` header (#42 slice 0) and publishes
  the result as ONE new key, `hermes_meta`. **ADD-key discipline throughout**:
  absent = unset (the key is omitted — never a fake zero); an absent key never
  clears a stored arbiter value; an old arbiter ignores the key.
- **Sanitizer on the arbiter side** (`server/src/arbiter.ts`):
  `cleanHermesMeta` mirrors the existing block sanitizers — a non-object/null
  block drops the whole key (never a rejection, never a clear); strings are
  bounded + trimmed; counters are non-negative ints; `estimated_cost_usd`
  finite ≥ 0; `last_active` finite > 0; nothing-valid ⇒ the key is absent.

### Slice B — host facts on the client register heartbeat

- `hermes_version` (string, ≤64) + `gateway_reachable` (exact boolean) ride the
  `POST /api/clients/register` heartbeat, alongside `gate_posture`.
  `reachable: false` is **exception-only** (the "gateway down" badge on the
  dashboard) and rides *only after a poll round actually found the gateway
  down* — before the first round the connector publishes **nothing** (no false
  badge at boot). Disabled connector ⇒ nothing published.

### Slice C — runs control (the seam; the verbs genuinely exist)

The gateway's runs surface is real (verified in
`gateway/platforms/api_server_runs.py`, v0.21.6): `POST /v1/runs` (dispatch),
`GET /v1/runs/{id}` (status), `GET /v1/runs/{id}/events` (SSE lifecycle),
`POST /v1/runs/{id}/stop`, `/steer`, `/approval`. The seam implements all of
them in `HermesRunsControl` with one **scope law**: a control verb may only
address a run *this process dispatched* — a foreign run id is refused
**without an HTTP request** (the gateway would refuse it too; the client
refuses earlier so a misconfiguration can never steer/stop something idlefill
did not create).

**Gate note (recorded, not solved):** a run's provider calls pass the loopback
gate **only** when the run's profile routes its session runtime through the
idlefill aggregate endpoint. Dispatching production work through this seam
before that is verified is a capacity gap — the adapter decision lives with
the caller.

## Enablement

The daemon's config loader drops unknown JSON keys and `config.ts` is a frozen
surface (parallel #47 work), so enablement is **opt-in per machine via env**:

- `IDLEFILL_HERMES_GATEWAY=1` — construct the connector (unset ⇒ the register
  heartbeat bodies are byte-for-byte the pre-#73 shape; the strictest
  fail-quiet).
- `IDLEFILL_HERMES_GATEWAY_URL` — non-default base URL (test seam).
- Operator key: `IDLEFILL_HERMES_GATEWAY_KEY` (default-home ledger) and the
  key file `~/.idlefill/hermes-gateway-keys.json` (`{ "<profile>": "<key>" }`)
  for per-profile ledgers — the gateway serves every profile from one
  listener, each key profile-scoped. A profile with no key is simply not
  fetched (its rows stay last-known). The key value is confined to request
  headers; it is never logged, never published, never written.

Profiles are auto-discovered from `~/.hermes/profiles` (+ `default`).

## Fail-open / fail-quiet (proven)

- Gateway down (connection refused/timeout) ⇒ `reachable=false`, **no meta
  published**, the gate's register heartbeat body is byte-for-byte the
  pre-#73 shape — the complement publishes nothing, the gate is untouched.
- 401/403 (no/foreign key) ⇒ the server IS up: `reachable=true` (the version
  still rides from health) but the affected profile's rows stay last-known.
- Malformed row/member ⇒ dropped individually; a round never throws, never
  poisons a heartbeat.
- The gate is **not modified at all** for this work: the enrichment lookup
  lives in the daemon's register callback closure (`client/src/index.ts`),
  because `client/src/session-gate.ts` and `client/src/config.ts` are frozen
  surfaces under parallel #47 work. The gate's `register` dep already hands
  the closure the captured `session_id`; the closure does the join.

## Tests (run for real, `NODE_ENV=test`)

- `client/test/hermes-gateway.test.ts` — 14 tests (11 against an **in-process
  stub gateway** on an ephemeral loopback port — no live Hermes, no operator
  keys; 3 daemon-level byte-for-byte proofs):
  ledger fetch + `/p/<profile>` mirror paths with per-profile keys;
  drop-don't-poison member sanitize; last-known-wins merge (absent keeps,
  present replaces, explicit `null` rides); health gate (down ⇒ unreachable,
  no meta, no crash, one quiet log line); 401 ⇒ reachable-but-no-rows;
  unkeyed profile skipped without a request; config resolution (defaults,
  env key, explicit profile list, disabled, key file, malformed inputs);
  runs control — dispatch/status/steer/stop/approval reach the stub, the
  `input` wire contract, the scope law (foreign run refused **without an HTTP
  request**), failed dispatch owns nothing, SSE event-stream parsing; and three
  **daemon-level** fail-open proofs (real `ClientDaemon` + real gate + the fake
  arbiter): switch unset ⇒ the session/client heartbeat bodies are byte-for-byte
  pre-#73 (no `hermes_meta`, no `hermes_version`/`gateway_reachable` at all);
  switch on + gateway up ⇒ `hermes_meta` (joined on the captured id) + the host
  facts ride the heartbeats; switch on + gateway down ⇒ the session body omits
  `hermes_meta` while the exception-only `gateway_reachable:false` badge rides.
- `server/test/hermes-meta.test.ts` — 6 tests end-to-end through the real
  Fastify app: valid block stores + echoes on `/api/sessions` + `/api/state`;
  malformed drops the key only (the stored block stands — never a clear, the
  ledger is not ephemeral state like the gate block); partial member drop;
  fresh row with an all-invalid block starts without the key; slice B
  exact-value sanitize (string ≤64 / exact boolean), stored + echoed; absent
  never touches a client row (an old client's row is byte-for-byte unchanged).

**Not exercised live (plain statement):** the live gateway on this machine
answers `GET /v1/health` (v0.21.6, verified), but its **session ledger and
runs verbs require an operator API key that is not provisioned here** — with
no key the ledger rows are empty (last-known = nothing) and the runs verbs
were proven against the stub, not against a live dispatched run (dispatching
live would create real agent work). The `hermes_meta` end-to-end path
(connector → heartbeat → arbiter row) is therefore proven component-by-component
and through the real Fastify app, not through a live key-holder round.

## Files

- new: `client/src/hermes-gateway.ts`, `client/test/hermes-gateway.test.ts`,
  `server/test/hermes-meta.test.ts`, this report
- changed: `client/src/index.ts` (connector wiring + register-closure join +
  client-register host facts), `client/package.json` / `server/package.json`
  (test script entries), `server/src/types.ts` (ADD-key types),
  `server/src/arbiter.ts` (sanitizer + register paths), `server/src/api.ts`
  (register/state routes)
- **not touched** (frozen, parallel #47 work): `client/src/session-gate.ts`,
  `client/src/config.ts`, `plugins/hermes-idlefill`

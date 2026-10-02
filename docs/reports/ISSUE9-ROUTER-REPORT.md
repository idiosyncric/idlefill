# Issue #9 Part A — client-as-router session gate (router + queue + hold)

Branch `issue-9-router`, base `82dd236`. Scope: client only — no `server/`
files touched, no push, no merge.

## What was built

1. **`client/src/session-gate.ts` (new)** — the gate state machine:
   - `/s/<token>/…` path contract (`SESSION_PATH_RE`), token ≤128 chars
     (arbiter rule) enforced at the proxy edge with a loud 400.
   - Per-session state derived from slot count + operator override:
     a session holds a slot while it has an in-flight request; `pause`
     holds its traffic even with free slots; `force` bypasses the slot cap.
   - Strict FIFO queue by arrival. A paused head-of-queue is *skipped*
     (an operator hold is not a slot wait — it must not starve the rest of
     the queue) and keeps its position, so unpause takes the next free
     slot without queue-jumping.
   - Parked requests are held on the wire (body never consumed); on
     admission they are piped through the proxy's forwarder as-is — no
     client retry, no stale-context guard (Hermes rebuilds per attempt).
   - Hold cap → retryable `503` JSON `{error:"session queued", retry:true,
     retry_after_seconds}` + `Retry-After: 15–20s` (same JSON discipline as
     the proxy's 502). No `req.destroy()` after `res.end()` — destroying
     the shared socket truncates the 503 in flight (found while testing).
   - Registration: first sight + throttled ≤1/10s per session
     (`heartbeatMs`), plus a `heartbeat()` folded into the daemon tick.
   - Fail-open: registration POST failure/refusal or a dead state poll ⇒
     every session admitted and every parked request released; re-armed on
     the next successful register or state poll.
   - `releaseAll()` on daemon shutdown: parked requests proceed, no 503s.

2. **`client/src/proxy.ts`** — the request handler was factored into a
   `forward(req, res, path)` closure (byte-for-byte the old behavior, now
   parameterized on path) and the server callback routes `/s/<token>/…`
   through the gate when one is attached. **Without a gate the proxy is
   exactly the old single-target pipe**; with a gate, every non-`/s/` path
   (plain `/v1/…`, `/`, unknown) takes the identical passthrough. The gate
   receives `forward` and calls it on admission, so held requests stream
   through the same no-buffering path (SSE preserved).

3. **`client/src/config.ts`** — `session_gate` (true),
   `max_active_agent_sessions` (2, floored at 1), `session_hold_cap_ms`
   (120000, floored at 1000) via the existing `str`/`num` DEFAULTS pattern.
   Optional on the `ClientConfig` interface so the hand-built test fixtures
   stay valid; the loader always sets them.

4. **`client/src/index.ts` (daemon wiring)** — the gate is constructed in
   `ensureProxy()` with arbiter url/token/client identity captured in the
   `register` closure (POSTs `/api/sessions/register` with token +
   `client_id` + `client_name` + `last_activity`); the proxy now starts at
   daemon **boot** (interactive sessions work without a lease job ever
   running — `runJob`'s `ensureProxy` stays as the idempotent path); the
   existing `/api/state` poll feeds `sessions[]` into
   `gate.onStatePoll(...)` and calls `gate.heartbeat()`; a tick exception or
   non-200 poll calls `gate.onLinkDown()`; the gate can wake the poll loop
   early (`stateWake`, debounced 2s) to learn overrides when a new session
   arrives or a request parks; `stop()` calls `gate.releaseAll()` before
   stopping the proxy.

5. **Tests** — `client/test/fake-arbiter.ts` extended with
   `POST /api/sessions/register` (idempotent, 201/200),
   `POST /api/sessions/:token/override`, and `sessions[]` on
   `/api/state`, plus `sessionRegisters` / `setSessionOverride` seams.
   New `client/test/session-gate.test.ts` (7 tests, real sockets, ephemeral
   ports, controllable fake upstream):
   - (a) `/s/tok/v1/chat/completions` → upstream sees `/v1/chat/completions`
   - (b) plain `/v1/…` and `/` passthrough unchanged; never registers
   - (c) max=1: second session parks (no upstream hit, queueDepth 1); first
     finishing admits it — proceeds with **no client retry**
   - (e) cap exceeded ⇒ 503 + `Retry-After` 15–20 + `retry:true` JSON;
     retry after admission succeeds
   - (f) arbiter down at first sight ⇒ fail-open (both sessions forwarded
     even beyond capacity)
   - (g) register on first sight, throttled ≤1/10s per session (clock seam),
     independent per token, refresh after the window
   - daemon integration: proxy up at boot with no projects; registration
     carries `client_id`/`client_name`; `pause` override learned from the
     real `/api/state` poll holds the next request; unpause releases it
     transparently.

6. **Docs** — README "Session gate" section (operator `/model` line, knobs
   table, overrides, fail-open, manual acceptance checklist) and
   `client/config.example.json` knobs + `_docs` entry.

## Settled decisions honored

- #38 client daemon is the router+gate; arbiter untouched (admission
  bookkeeping stays arbiter-side; routing on the client).
- #36 gate lives inside the existing proxy — no new process, no new port.
- #33 registration by first sight via the existing `POST
  /api/sessions/register`; traffic is the heartbeat; ≤1/10s throttle +
  daemon-tick refresh; no Hermes-side component.
- #32 capacity-only admission, FIFO by arrival; idleness never gates;
  `pause`/`force` overrides enforced from the `/api/state` poll.
- #34 held-not-failed; cap 120s; retryable 503 + Retry-After ~15s+jitter
  (proxy 502 JSON precedent); released requests proceed as-is.
- #35 strict FIFO v1, single queue (one engine = `llm_target`); no bump.
- #32 override plumbing: enforcement client-side only; arbiter API already
  existed — `server/` untouched.
- Path contract: `/s/<token>/v1/…` stripped and forwarded; ALL other paths
  byte-identical passthrough (test (b) is the regression guard).
- Out of scope respected: no desktop token minting, no multi-engine, no
  context accounting, no priority, no menubar/dashboard work.

## Probe verification (decision #5 — Hermes timeout default)

Read-only inspection of `~/.hermes/hermes-agent`:

- `run_agent.py:565-569` — `_resolved_api_call_timeout()`:
  `return cfg if cfg is not None else env_float("HERMES_API_TIMEOUT", 1800.0)`
  → **default 1800s** (docstring line 567: "…> `HERMES_API_TIMEOUT` > 1800s").
- `agent/chat_completion_helpers.py:3022-3040` — `_stream_timeouts()`:
  base = same 1800s; stream read timeout defaults 120s **but** line 3034
  raises it to the full base for local endpoints (`is_local_endpoint` —
  loopback included, `agent/model_metadata.py:674`): the router is
  `127.0.0.1`, so a held stream gets the 1800s read budget.
- `run_agent.py:597` — the non-stream stale detector auto-disables for
  local endpoints when unconfigured (`uses_implicit_default and
  is_local_endpoint(base_url)`), so it cannot fire during a hold either.

**Conclusion:** the 120s default cap sits 15× under the effective 1800s
client timeout for loopback providers. Locked.

## Deviations (with rationale)

1. **`NODE_ENV= npx tsc --noEmit` from repo root** prints tsc's help and
   exits 1: the repo has **no root tsconfig.json** (workspaces each own
   one). The real gate is per-workspace: `npx tsc -p client/tsconfig.json
   --noEmit` and `npx tsc -p server/tsconfig.json --noEmit` — both zero
   errors (output below).
2. The proxy starts at daemon **boot** instead of lazily on first grant.
   Required: the gate must serve interactive sessions whether or not lease
   work ever runs. `runJob`'s `ensureProxy()` call is unchanged and stays
   idempotent.
3. Gate knobs are optional on the `ClientConfig` interface (loader always
   sets them) so the seven existing hand-built `ClientConfig` test fixtures
   compile untouched.
4. A paused head-of-queue is skipped by the admit loop rather than
   blocking it — otherwise one paused session would starve the FIFO,
   contradicting "unpause takes the next free slot" for everyone else.
   The paused row keeps its queue position (no queue-jumping on unpause).
5. `session_hold_cap_ms` is clamped ≥1000 and
   `max_active_agent_sessions` ≥1 at load — a 0/negative cap would make
   the gate answer 503 before any hold semantics could apply.

## Verification (real output)

```
$ NODE_ENV= npx tsc -p client/tsconfig.json --noEmit   # repo root
CLIENT_TSC_OK
$ (cd server && NODE_ENV= npx tsc -p tsconfig.json --noEmit)
SERVER_TSC_OK

$ NODE_ENV= npm test          # all workspaces
> idlefill-server@0.1.0 test      ℹ tests 87  ℹ pass 87  ℹ fail 0
> idlefill-client@0.1.0 test      ℹ tests 58  ℹ pass 58  ℹ fail 0   (incl. 7 new session-gate tests)
> idlefill-adapter-career-ops     ℹ tests 15  ℹ pass 15  ℹ fail 0
> idlefill-adapter-noop@0.1.0     ℹ tests  2  ℹ pass  2  ℹ fail  0

$ NODE_ENV= npm run build     # tsc -p per workspace
(exit 0)
```

New gate tests (spec reporter):

```
✔ (a) /s/<tok>/v1/chat/completions forwards to the engine as /v1/chat/completions (34ms)
✔ (b) plain /v1/... passthrough is unchanged with a gate attached (job-flow regression guard) (39ms)
✔ (c) max=1: second session parks; first finishing releases it with NO client retry (192ms)
✔ (e) hold cap exceeded ⇒ retryable 503 + Retry-After; retry after admission succeeds (295ms)
✔ (f) arbiter down at first sight ⇒ fail-open (request forwarded, not held) (38ms)
✔ (g) registration fires on first sight, throttled to ≤1 per 10s per session (63ms)
✔ daemon integration: session registers with client identity; pause override holds, unpause proceeds (239ms)
```

## Commits (git show --stat)

```
7d1e643 issue #9 Part A: session gate — client-as-router admission for /s/<token> traffic
 client/src/config.ts       |  23 +++
 client/src/index.ts        |  73 +++++++-
 client/src/proxy.ts        |  46 ++++-
 client/src/session-gate.ts | 436 +++++++++++++++++++++++++++++++++++++++++++++
 4 files changed, 572 insertions(+), 6 deletions(-)

dd47c68 issue #9 Part A: session-gate tests (a–g) + fake-arbiter sessions endpoints
 client/package.json              |   2 +-
 client/test/fake-arbiter.ts      |  40 +++++
 client/test/session-gate.test.ts | 366 +++++++++++++++++++++++++++++++++++++++
 3 files changed, 407 insertions(+), 1 deletion(-)

a7e393f issue #9 Part A: README 'Session gate' operator section + config.example knobs
 README.md                  | 65 ++++++++++++++++++++++++++++++++++++++++++++++
 client/config.example.json |  6 ++++-
 2 files changed, 70 insertions(+), 1 deletion(-)

(report commit) issue #9 Part A: report (this file)
 ISSUE9-ROUTER-REPORT.md | ~215 +
```

`git status --short` after the final commit: empty.

## Manual acceptance checklist (for the operator)

Also in README → "Session gate". Summary:

1. `client/config.json`: `"max_active_agent_sessions": 1`; restart the
   client daemon (`launchctl kickstart -k gui/$(id -u)/com.sam.idlefill.client`).
2. Session A → `/model http://127.0.0.1:11435/s/sessA`; long-running prompt.
3. Session B → `/model http://127.0.0.1:11435/s/sessB`; send a message —
   it waits (parked at the router; client log: `session sessB first sight`).
4. Pause A (dashboard / `POST /api/sessions/sessA/override {"override":"pause"}`).
   When A's in-flight request finishes, B's parked request proceeds —
   nothing typed in either conversation. Unpause A afterwards.
5. Kill the arbiter; both sessions keep answering (fail-open).

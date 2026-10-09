# Issue #47 — admission priority classes + per-session budgets (the session gate)

Date: 2026-10-09. Branch `issue-47` (worktree `.wt/47`, HEAD base 4369a37). Not merged.

## What the issue asked

Admission at the client-as-router gate is pure FIFO with a global slot cap.
Interactive sessions (a user waiting in a TUI) and background Orca-tab agents
compete equally, and nothing bounds how much a single greedy session can
consume. Three things:

1. A **priority class per session** (interactive > background). The middleware
   plugin knows `platform`; the router can infer from request cadence or a
   token suffix.
2. A **policy knob** in client config (default OFF so current behaviour is
   unchanged): when enabled, an interactive session's request is admitted
   ahead of parked background requests at the FIFO boundary, and background
   never starves (age-based aging promotes a long-waiting background session).
3. A **per-session token budget** from streamed usage: over budget ⇒ demote to
   the lowest priority (never a hard stop).

Acceptance: with `maxActive = 1` and a background agent parked in the queue,
an interactive session's first request is admitted within one in-flight-request
boundary, and the background session resumes after it.

## What landed

All in the router's gate (`client/src/session-gate.ts`) + the config knobs
(`client/src/config.ts`), wired in the daemon's `ensureProxy` (`client/src/index.ts`).
Opt-in via the config knob; **default OFF** keeps every existing deployment on
the historical strict-FIFO park.

### 1. Priority class per session

- **Reported** — a session may carry an `X-Hermes-Priority: interactive |
  background` header (the middleware plugin knows the platform). Bounded by the
  new `cleanPriority()` (drop-don't-reject, like the session-id rule): only
  `interactive`/`background` survive (case-insensitive); anything else is
  dropped. Last-write-wins, and a later headerless request never clears a class
  the session already reported.
- **Inferred** — when not reported, a session with a request inside
  `interactiveWindowMs` (default **30s**) is interactive; otherwise background.
  (Cadence: an interactive TUI keeps requesting; a background agent goes quiet
  between turns.)
- **Resolved** — `reportedPriority` (last-write-wins) beats cadence inference; a
  latched budget demotion forces background. Resolution happens **at admission
  time** (rank is computed when a slot frees), so a session that has been quiet
  ages out of interactive without any timer.
- The resolved class is **reported to the arbiter** as the `priority` ADD-key on
  the register heartbeat's session payload — sent only when the knob is ON
  (ADD-key posture: absent when OFF, so the wire stays byte-for-byte unchanged
  for existing deployments). The arbiter's register route ignores the new key
  (back-compat), so no server change is required.

### 2. Policy knob + admission rule (documented in the module header)

Knobs (all in `client/src/config.ts`, loaded by `loadClientConfig`):

| key | type | default | meaning |
| --- | --- | --- | --- |
| `session_priority` | bool | **false (OFF)** | enable priority classes + aging + budgets |
| `session_token_budget` | number | unset | per-session token budget (unset = no budget) |
| `session_aging_ms` | number | 60000 | age-based aging threshold |
| `session_interactive_window_ms` | number | 30000 | cadence window for inference |

When `session_priority` is OFF, `admitLoop()` ranks every candidate by its
**queue index** — the historical strict-FIFO pick, byte-for-byte. When ON, a
**parked** session's **admission rank** (lower is admitted first when a slot
frees) is:

- **0** = a BACKGROUND session that has waited ≥ `session_aging_ms` — the
  no-starvation guarantee: it is promoted ahead of interactive sessions so a
  long-queued background agent is never starved;
- **1** = INTERACTIVE (reported, or inferred by cadence);
- **2** = BACKGROUND.

Ties within a rank keep arrival order (FIFO). A paused session is always
skipped regardless of rank (the operator hold wins over the class).

The exact rule is stated in the `session-gate.ts` module header. What priority
does **NOT** do: it never preempts an in-flight request, never raises the
`maxActive` slot cap, and never touches the hold cap. It only orders WHICH
parked session is released next.

**Aging anchor:** a parked session records `waitStart` at its FIRST parked
request and clears it when it has no local state left (no in-flight, no holds).
Aging is measured on the session's wait, not one request, so a background agent
that keeps parking new requests still ages on the same clock.

### 3. Per-session token budget (streamed usage)

The gate already peeks the piped response for `total_tokens` (#45). Now it also
tracks a sticky **peak** (`tokensPeak`) across the session's requests. When
`session_priority` is ON and `session_token_budget` is set, and the session's
peak streamed `total_tokens` exceeds the budget, the session is **demoted to
background** (`demoted` latches sticky). The demotion is **admission-only —
never a hard stop**: the session is still admitted, just ranked last (rank 2),
and a later small turn never re-promotes a greedy session. The demotion logs a
line (`session <tok> demoted to background (peak tokens N > budget M)`).

## Acceptance scenario (proven by test)

`test('#47 (acceptance) max=1 + a streaming background agent: …')` — real
sockets end-to-end (real proxy + real `SessionGate` + controllable fake upstream
+ `onStatePoll([])` for a live arbiter), `maxActive = 1`, priority ON:

1. A **background** agent holds the only slot, streaming (reports its class via
   `X-Hermes-Priority`).
2. An **interactive** session's **first** request arrives — no free slot ⇒ it
   parks.
3. **The boundary:** the background's in-flight turn finishes. The interactive
   first request is admitted **within this one in-flight-request boundary**
   (the slot frees ⇒ the parked interactive is released). Asserted from the
   upstream's recorded bodies.
4. The background agent's **next** turn arrives while the interactive holds the
   slot ⇒ it parks.
5. The interactive turn finishes → the **background session resumes** (its
   parked turn is released whole, no client retry).

Two companion tests round out the acceptance: the **no-header cadence-inference**
variant (a fresh session with no header is interactive by cadence and is
admitted within one in-flight boundary ahead of a parked background session),
and the **no-starvation** variant (a background session parked ≥ `agingMs` is
promoted ahead of a newly-arrived interactive request). A **knob-OFF** test
confirms the historical strict-FIFO park is unchanged (an interactive class never
jumps a background parked earlier). A **budget** test confirms exceeding it
demotes to background (admission order only, never a hard stop). A **wire** test
confirms the `priority` ADD-key rides the heartbeat only when the knob is ON.

## Files

- `client/src/session-gate.ts` — module header (the exact rule),
  `PRIORITY_HEADER`/`cleanPriority`, `SessionGateDeps` gains
  `priorityEnabled`/`tokenBudget`/`interactiveWindowMs`/`agingMs` (+ the
  register callback's `priority` arg), `Session` gains `reportedPriority`/
  `demoted`/`waitStart`/`tokensPeak`, `route()` captures the header, `touch()`
  stores the class, `register()` reports the `priority` ADD-key (knob ON only),
  `park()`/`forgetHold()`/`settle` anchor + clear `waitStart`, `forwardNow`
  tracks the token peak + demotes, `admitLoop()` ranks candidates (index when
  OFF, class when ON), new `priorityRank()`/`resolvedClass()`.
- `client/src/config.ts` — the four knobs + defaults (OFF / unset / 60s / 30s)
  + `loadClientConfig` parsing.
- `client/src/index.ts` — `ensureProxy` wires the knobs into the gate; the
  register closure forwards the `priority` ADD-key; the startup log line notes
  priority on (when set).
- `client/test/session-gate.test.ts` — 8 new tests (cleanPriority, acceptance,
  acceptance no-header, no-starvation, knob-OFF regression, budget demotion,
  register wire ADD-key); `makeGate` extended with the knobs + log capture;
  `startControllableUpstream` gains `setUsage` for budgeting; new `postTag`
  helper (body-tagged requests so the admission order is readable back from
  `up.hits`).

## Verification (actual output, from the worktree root)

- `NODE_ENV=test npm run test` — server **241 pass / 0 fail**, shell-ui
  **17/17**, tauri **2/2**, client **149/150** (the one fail is
  `--version (dev path)`, **pre-existing on base 4369a37** — reproduced on a
  clean stash; unrelated to #47).
- `client/test/session-gate.test.ts` alone: **32 pass / 0 fail** (was 24 before
  #47).
- `NODE_ENV=test npm run build` — **exit 0** (all workspaces; the dashboard/tauri
  bundle churn is a byproduct of the root build and is **not** part of this
  change — reverted).
- `cd client && NODE_ENV=test npx tsc --noEmit` — **clean** (exit 0, strict).

## Decisions / scope notes

- **Class channel = header, not token suffix.** The issue left the channel open
  ("request cadence or a token suffix convention"). A token suffix would require
  the arbiter to mint differently-suffixed tokens (a server change); a header is
  self-contained in the client, matches the existing `X-Hermes-Session-Id`
  precedent, and lets the router infer from cadence when it is absent. The
  middleware-plugin `platform` the issue mentions is exactly the kind of context
  that maps cleanly to an `X-Hermes-Priority` header.
- **No server change.** The `priority` class is an ADD-key on the register
  heartbeat; the arbiter's register route ignores unknown body keys
  (back-compat), so an old arbiter and a new arbiter both accept the router's
  wire without a server edit. A follow-up could persist/surface it on the
  session row, but that is out of scope here.
- **In-memory only.** `reportedPriority`/`demoted`/`waitStart`/`tokensPeak` are
  per-process, reset on restart — consistent with the gate's existing in-memory
  posture (ring, holds, queue).
- **Default OFF.** `session_priority: false` is the default; the FIFO index-rank
  path is taken when the knob is off, so current behaviour is unchanged.

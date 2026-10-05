# Issue #44 — queue transparency + exposed force (additive slice)

Date: 2026-10-05. Landed on `main`. Screenshot: `ISSUE44-queue-force.png`.

## What the issue asked

Three things: make the router's queue visible (position in line), expose the
force override in the dashboard, and queue manipulation (promote/remove).

## What landed (the additive two thirds)

### Queue position — `queued · #N`

- `client/src/session-gate.ts`: `SessionGateSnapshot` gains the `position`
  add-key. A parked session reports its 1-based place in the router's FIFO
  queue (`queue.indexOf(token) + 1`). The session HOLDING a slot reports no
  position — it is not in the queue.
- `server/src/arbiter.ts` `normalizeSessionGate()`: accepts a valid integer
  `position >= 1`; a malformed value drops only the key — the gate block
  still stores (drop-don't-reject, per-key). An old router that never
  reports the key keeps the exact old shape.
- Dashboard: the queued tag now renders `queued · #1`, `queued · #2` … from
  the router-reported position (the `N waiting` form survives only when the
  router is too old to report positions).

Queue order is router-local truth — the arbiter only echoes what the
router's heartbeat carried. That is why promote/remove is NOT in this slice
(it needs a new arbiter→router command channel; see Scope below).

### Exposed force

The `force` override was already honored end-to-end: the API validates
`pause | force | null`, the arbiter stores it, the router's `route()`
admits a forced session past the slot cap and releases its parked holds on
the next state poll (`releaseHoldsOf`). The dashboard was the only surface
that never OFFERED it. Now:

- The session gate select is a three-option gate — Session Running /
  Session Paused / Session Forced — same optimistic+revert write pattern as
  pause.
- A forced session gets the exception-only `forced` tag (accent border),
  the same posture as `queued` and `stale`: healthy rows render nothing new.

### Layout repair (pulled from #43's review)

The #42 hermes-id meta made long session rows wrap the state word + gate
select onto ragged second lines, and a header note duplicated the tab
strip's own subtitle. Fixed: state word + select are one right-pinned
cluster (`.sess .sright`) that never strands; the stray header subtitle
removed.

## Live proof

Throwaway arbiter on `:18899` with two queued sessions (positions 1 and 2,
one then forced through the dashboard's own select change handler):

- rows render `queued · #1` / `queued · #2` with position tooltips,
- the forced row renders the `forced` tag and its select reads
  Session Forced after the page refresh,
- geometry eval: state word and select share one line on every row
  (`sameLine: true`, right edges aligned),
- tab strip no longer carries the stray subtitle.

## Tests

- client `session-gate.test.ts`: 18 pass — queued-snapshot assertions
  widened to carry `position`; a new end-to-end test parks three sessions
  and asserts 1-based FIFO places reach the register heartbeat, with the
  slot-holder reporting none, then drains the queue un-wedged.
- server `api.test.ts`: 48 pass — three new tests: position add-key
  (valid stores+echoes, malformed drops only the key, old routers
  unchanged), session force override end-to-end (set → state echo →
  clear), and the dashboard structure (forced option, forced tag,
  position tag).

Full suites: server 177 pass / 0 fail, client 90 pass / 0 fail (see commit).

## Scope — what did NOT land (and why)

Queue MANIPULATION (promote a session to the head, remove one from the
line) needs an arbiter→router command channel that does not exist: today
the arbiter only sends state, never commands. That is a separate slice
(command envelope on the state-poll reply, or a router-side pull endpoint)
and is deliberately deferred rather than faked with a client poll hack.

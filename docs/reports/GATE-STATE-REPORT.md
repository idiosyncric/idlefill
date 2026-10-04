# GATE-STATE-REPORT — gate-state visibility on the session rows

Branch `gate-state` off main `9a87330`. The vertical slice:
**gate → register heartbeat → arbiter store → /api/state payload → desktop row.**

## What was built

**Client (`client/src/session-gate.ts`, `client/src/index.ts`)**
- `SessionGateSnapshot` type + `SessionGate.snapshot(token)`: pure read of
  the router's queue truth — `inflight > 0` ⇒ `{state:'active', waiting:
  holds}` (the parked count still rides for a holder); parked-only ⇒
  `{state:'queued', waiting: holds}`; neither ⇒ `null`.
- The `register` dep signature is `(token, gate)`; the private register
  path passes `this.snapshot(token)` at call time. The ≤10s heartbeat
  throttle is untouched — no new network loop.
- The daemon's register closure folds the snapshot into the POST body:
  `...(gate ? { gate } : {})` — an idle heartbeat sends NO gate key
  (back-compat: an old arbiter never sees the field).

**Server (`server/src/types.ts`, `arbiter.ts`, `api.ts`)**
- `SessionRecord.gate?: { state: 'active' | 'queued'; waiting: number } | null`.
- `normalizeSessionGate` (arbiter.ts) — three verdicts: valid ⇒ store
  (last-write-wins on every heartbeat); null/absent ⇒ CLEAR to null (the
  idle report — a session that stopped waiting never stays tagged);
  invalid (bad state, non-finite/negative/non-int waiting, non-object) ⇒
  DROPPED, the registration is never rejected and the stored value stands.
  On create, invalid is dropped whole (row starts gate-less).
- `POST /api/sessions/register` forwards `body.gate` verbatim.
  `GET /api/sessions` and `/api/state` already spread the record —
  verified `gate` rides through both (asserted in api.test.ts).
- No new sweeper: the gate rides the existing row lifecycle.

**Desktop (`desktop/IdlefillDesktop.swift`)**
- `SessionRow` gains `queued: Bool` + `waitingCount: Int` (count only when
  >1). `SessionsView.project` reads `gate`: `state == "queued"` ⇒ tag;
  missing/null/malformed (old arbiter) ⇒ renders exactly as before.
- `SessionsPanel.sessionRow` renders the tag next to the state word:
  `queued` / `queued · N waiting`, mono/quiet idiom (the `stale` tag's
  styling), tooltip "held at the router behind another session".
- The state-word logic is UNCHANGED — the tag is an ADDITIONAL fact like
  `stale`: queued+paused shows both, queued+stale shows both. The
  optimistic pause/resume flip carries the router's gate fields unchanged
  until the next poll.

**Out of scope (honored):** dashboard HTML untouched, menubar untouched,
no deploy to urza, no push, no merge.

## Decisions honored / deviations

- All settled design decisions followed as written (wire shape, clear on
  absent, drop-don't-reject on invalid, no new loop, tag-not-state-word).
- Deviation (semantics, spec-consistent): `snapshot` reports `active` with
  the waiting count when a session BOTH holds a slot and parks requests
  (e.g. paused mid-flight). The spec's test plan explicitly wants "both
  (inflight + parked) → active with the waiting count still reported".
- Note: the desktop harness baseline on main is **54** PASS lines (the
  spec said 57); all 54 still pass, plus 10 new (h) assertions = **64**.
- Live-proof driver note: `curl` half-closes the request stream after the
  body, which settles the gate's slot early; the proof driver keeps the
  connection open like a real agent HTTP client (this is a harness
  artifact, not a gate bug — the parked-request tests cover it).

## Tests + command outputs (all run in this worktree)

### 1. `bash desktop/sessions-test.sh` — PASS 64 (54 existing + 10 new), RC=0
```
PASS count: 64   (baseline on main: 54 — all still green)
SESSIONS-DT-EXIT=0
SESSIONS-DT-DEADPORT-EXIT=0
SESSIONS-DT-HARNESS-PASS
```
New (h) block: queued tag + waiting count, queued+paused shows both,
queued+stale shows both, state word unchanged (Active stays Active),
active-gate row gets no tag, absent/null/malformed gate render as before.

### 2. `NODE_ENV= npm run test` — RC=0, 0 failures
```
idlefill-server: tests 89  pass 89  fail 0   (arbiter + api + idle)
idlefill-client: tests 61  pass 61  fail 0   (session-gate 10/10 incl. 3 new)
adapters/career-ops: 15 pass 0 fail; adapters/noop: 2 pass 0 fail
```
New coverage: snapshot active/queued/both/idle; register calls carry the
snapshot (first-sight null, heartbeat active/queued, idle null); wire
contract through the fake arbiter (stores + echoes + clears); arbiter
store/clear/invalid-dropped matrix; REST: /api/state + /api/sessions carry
the gate, invalid 200-dropped, absent clears.

### 3. `NODE_ENV= npm run build` — RC=0 (server tsc clean)

### 4. `bash desktop/build.sh` — RC=0
```
==> built .../desktop/Idlefill.app (version 1.0, marker 1.0, SUPublicEDKey absent)
```

### 5. Live proof (local stub arbiter + slow upstream + daemon from THIS worktree)
Setup: scratch stub arbiter on 127.0.0.1:18787 (logs every register body
verbatim), slow upstream on 18890 (45s hold), daemon via
`IDLEFILL_CLIENT_CONFIG` with `max_active_agent_sessions: 1`, scratch proxy
port 18735. The user's launchd daemon and the live arbiter were NOT
touched. Two keep-open chat drivers (real-client semantics) hit
`/s/sessA2/v1/...` then `/s/sessB2/v1/...`.

Actual register bodies captured by the stub (relative time):
```
t+  0.0s  sessA2  gate=(absent)                          ← first sight, pre-forward
t+ 17.8s  sessB2  gate=(absent)                          ← first sight, parks
t+ 23.0s  sessA2  gate={"state":"active","waiting":0}    ← A HOLDS the slot
t+ 43.1s  sessA2  gate={"state":"active","waiting":0}    ← A still holds
t+ 43.1s  sessB2  gate={"state":"queued","waiting":1}    ← B QUEUED behind A  ★
t+ 63.1s  sessA2  gate=(absent)                          ← A drained ⇒ idle-clear
t+ 63.1s  sessB2  gate={"state":"active","waiting":0}    ← B admitted, now holds
t+103.1s  sessB2  gate=(absent)                          ← B drained ⇒ idle-clear
```
B's parked request completed 200 with no client retry when A released.
Back-compat proof: the live arbiter on urza is the old build — when this
client heartbeats the optional `gate` field at it, the old arbiter ignores
it (an extra JSON key with no validation on the register route) — exactly
the contract the api.test back-compat case pins.

## Commits (branch only — no push, no merge)
1. client: gate snapshot on the register heartbeat
2. server: store + expose the session gate block
3. desktop: queued tag on the sessions rows
4. tests: gate-state coverage across client/server/desktop harnesses
5. docs: README gate-state wire shape + this report

## Follow-up: the two surfaces this report left out (branch `gate-state-surfaces`)

The dashboard HTML and the menubar panel now carry the same gate-state fact,
on a branch off main `47bd162` (the slice merged first, so this rides it):

- **Menubar (`menubar/IdlefillMenubar.swift`)** — `ScopeSession` gains
  `queued` + `waitingCount`; the exception one-liner composes words in the
  desktop's order (override, then queued, then stale), so
  `mac-q · paused · queued · 2 waiting` shows every applicable fact. The
  count buckets are unchanged (queued-but-healthy still counts active).
- **Dashboard (`server/public/index.html`)** — `sessBlock` renders a
  `queued` / `queued · N waiting` tag beside the state word, same
  exception-tag idiom as `stale`; the state word logic is untouched.
- **Harness (`menubar/sessions-test.sh`)** — new (g) block: queued one-liners
  (with/without the >1 waiting count), queued+paused and queued+stale show
  both, active gate is not an exception, and the back-compat matrix (absent /
  null / malformed gate renders exactly as before).

Gates on this branch: `bash menubar/sessions-test.sh` → SESSIONS-ALL-PASS;
`bash desktop/sessions-test.sh` → harness PASS; `NODE_ENV= npm run test` →
RC=0; `bash menubar/build.sh` → RC=0 (ad-hoc signed). The live check
(cap=1, two sessions, second shows queued) stays the owner's step — the
dashboard and menubar read the same `gate` block the desktop row already
proved end-to-end above.

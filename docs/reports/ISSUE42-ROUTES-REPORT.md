# Issue #42 — Slice 2: the daemon-side gate routes — build report (2026-10-09)

**What landed.** `POST /gate/heartbeat` + `GET /gate/state` on the client loopback proxy — the
exact contract slice 1's plugin (`plugins/hermes-idlefill`) already calls. Until these routes
existed the plugin was a documented no-op by fail-open; now a Hermes profile whose plugin points
`IDLEFILL_GATE_PORT` at the daemon gets a real answer: it registers its real `session_id` (+ the
`/s/<token>` key when its base_url carries one), reads the gate's real state, and HOLDS its
provider call while the gate reports `queued`/`paused` instead of passing through unheld.

**The design seam: session_id → token.** The plugin knows a session id; the gate keys sessions by
token. The gate now keeps a `session_id → token` index (a Map, cap 256, evicted oldest-first,
in-memory, a restart starts empty), populated by the existing register path (the header capture in
`touch()` and every register fire) and by the heartbeat bind. A stale or unknown id resolves to
nothing, so the state read stays `armed`: an unknown session never causes a hold, never a fake
state. The cap evicts only a hostile flood (a machine runs a few dozen live sessions; the #80
roster bound is 24 profiles).

**The routes (client/src/proxy.ts, answered before any passthrough).**
`POST /gate/heartbeat {session_id, token?}` → 200 (idempotent): it binds the pair (last-write-wins,
the header-capture posture), touches NO ring entry and NO queue slot (a heartbeat is not router
traffic — the #76 drop rule sees real traffic only), and may fire the arbiter register throttle.
Body bounded at 16 KB; oversized or malformed bodies fail quiet (200, nothing learned) — a bad
heartbeat never errors.
`GET /gate/state?session_id=...[&token=...]` → `{state, position?}` ONLY: `armed` (nothing holds
the session), `queued` (a parked request waits for a slot), `paused` (the operator hold owns
admission). The token never appears in a response body. `position` is the 1-based queue place,
present only while the session sits in the queue (the #44 posture — never a fake zero). A released
gate, a down arbiter link (fail-open), an unknown id, an unknown token, or a stale binding all
answer `armed`.

**Behavior unchanged elsewhere.** `/s/<token>/...` requires the `/s/` segment, so a `/gate/...`
path is never mistaken for session traffic; a gate-less daemon stays untouched (absent gate ⇒
plain passthrough exactly as before). A bare `/gate/state` (no query) answers `armed` too — caught
by a probe when it slipped to passthrough; the control surface never reaches the LLM target. No
`plugins/`, `server/`, `dashboard/`, or pairing-doc file touched.

**Verification (real output, 2026-10-09).**

- `client/test/gate-routes.test.ts` (new, real sockets) — **4/4**: unknown id → 200
  `{state:"armed"}` with no position, no token, no echo (no hold); heartbeat then state read →
  the real state; a queued session → `{state:"queued", position:1}` (the gate's `snapshot()`
  agrees); an unregistered token → the read stays `armed` and the heartbeat bind learns nothing.
- `NODE_ENV=test npm run test -w client`: **177/177**. `NODE_ENV=test npm run test` (root, all
  workspaces): server **316/316**, client **177/177**, career-ops **17/17**, noop **2/2** — exit 0.
- `NODE_ENV=test npx tsc --noEmit` (client): clean. No served bundle in this slice (the plugin
  talks plain HTTP; the dashboard is untouched). No push, no merge: branch `issue-42-routes`.

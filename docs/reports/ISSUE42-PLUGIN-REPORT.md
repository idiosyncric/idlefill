# Issue #42 — Slice 1: the Hermes gate plugin — build report (2026-10-09)

**What landed.** `plugins/hermes-idlefill/` — a standalone Hermes Agent
plugin (`llm_execution` middleware, the seam verified in #9's research:
callback runs inline on the turn thread, may block before `next_call`
with no timeout, single-use `next_call`, and a crashing frame is
skipped — fail-open). Per LLM call: register/heartbeat the session at
the local idlefill daemon with the real Hermes `session_id` (+ the
`/s/<token>` gate key when the profile's `base_url` carries one), block
(0.4s → 2s backoff) while the gate reports `queued`/`paused`, then run
`next_call` exactly once. Whole body in one try/except: daemon
unreachable, no session id, no `IDLEFILL_GATE_PORT`, or any error
⇒ admit immediately. No logging, no file writes, no secrets,
127.0.0.1 only, 0.75s cap per loopback hop.

**Files (new only; no daemon, client, server, or doc file touched).**

- `plugin.yaml` — manifest (orca-status shape; `provides_middleware:
  llm_execution`).
- `__init__.py` — the middleware + `register(ctx)`.
- `README.md` — behavior, profile install, daemon-down posture, the
  honest limit.
- `test_plugin.py` — 12 stdlib-unittest cases, no network.

**Verification (real output).**

- `python3 -m unittest plugins/hermes-idlefill/test_plugin.py -v` —
  **12/12 OK**: armed ⇒ `next_call` exactly once, zero sleeps; queued
  ⇒ held through both queued polls (next_call only after the admitting
  poll; backoff asserted); paused ⇒ held; unreachable (heartbeat +
  state) ⇒ admits immediately, never raises; daemon-down mid-hold ⇒
  one hold then admit; malformed/None state ⇒ fail-open; heartbeat
  throttled per session (1 POST per 2s window); `IDLEFILL_GATE_PORT`
  unset / no session id / hostile id ⇒ zero daemon contact;
  `register()` wires `llm_execution` → the callback.
- Client suite (17 files): **145/146** — the single failure is
  `version-handshake.test.ts:132` (the dev-path `--version` guard
  throws `tsx missing — npm install in the repo first`): this worktree
  has no `node_modules` and `npm install` was off-limits for this run;
  the guard throws before executing anything, independent of this
  diff (the diff adds only `plugins/`). Everything else green.
- Server suite (11 files): **241/241**.
  (Both run with the parent checkout's `tsx` + `node_modules` — the
  worktree carries no deps of its own.)

**Honest limits (repeated in the plugin README).** Additive: it gates
the calls one Hermes profile makes in-process; the loopback router
path (`/s/<token>` + :8800) still serves non-Hermes clients and
unplugged Hermes sessions exactly as before. The daemon-side routes
(`POST /gate/heartbeat`, `GET /gate/state` on the client's loopback
proxy) are this slice's contract; their implementation is slice 2.
Until they land the plugin is a documented no-op by fail-open — the
correct interim behavior.

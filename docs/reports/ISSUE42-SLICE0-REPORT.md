# Issue #42 — Slice 0: session-id header contract — build report (2026-10-05)

**The gap.** Hermes never identified its session on the wire: provider
requests carried only `User-Agent: HermesAgent/<version>`. idlefill's
session rows were keyed by the hand-set `/s/<token>` path token, so two
concurrent chats on one profile could collide into one indistinguishable
row, and the dashboard could never show the id the TUI banner shows.

**The contract** (full text in `ISSUE42-BRIEF.md`): Hermes sends
`X-Hermes-Session-Id: <id>` with every provider request; the idlefill
router captures it at the loopback proxy and publishes it on the session
register heartbeat as the `session_id` ADD-key on `SessionRecord`. The
future middleware-plugin path (`llm_execution` sees the real session_id
per call) and this header path converge on the SAME stored field — one
contract, two sources. Nothing renamed; an old arbiter ignores the key
and an old client sends nothing.

**Changes (the idlefill side; the Hermes side lives in the Hermes
repo).**

- `client/src/session-gate.ts` — `SESSION_ID_HEADER` constant; capture in
  `route()` per request; `cleanSessionId` sanitizer (bounded printable
  ≤128, drop-don't-reject — the token rule); `Session.session_id` stored
  last-known-wins (a headerless follow-up never clears it); the register
  dep gains a third arg.
- `client/src/index.ts` — the register body carries `session_id` only when
  captured (ADD-key posture).
- `server/src/arbiter.ts` — `cleanReportedId` (same sanitizer posture);
  `registerSession` stores on create + update, never clears on absent,
  drops malformed without rejecting.
- `server/src/api.ts` — the register body forwards `session_id` verbatim;
  validation lives in the arbiter (single seat).
- `server/src/types.ts` — `SessionRecord.session_id` documented.
- `server/public/index.html` — session rows show `hermes <id>` in the
  meta line, exception-only: a row that never carried one renders exactly
  as before.

**Verification (real output).**

- `client/test/session-gate.test.ts` — 3 new end-to-end proxy tests:
  header → register heartbeat; headerless follow-up keeps the id;
  oversized header dropped, request forwards exactly as before; no header
  = no key. 34/34 in that file.
- `server/test/api.test.ts` — 4 new tests: valid id stores and rides
  `/api/state` + `/api/sessions`; absent never clears; malformed dropped
  (five hostile shapes, stored value stands, fresh row starts id-less);
  two concurrent sessions keep distinct ids (the one-row complaint, now
  two distinguishable rows). 41/41 in that file.
- `npx tsc --noEmit` clean both workspaces; `npm run build` exit 0.
- Live proof on the throwaway arbiter (:18899): the Sessions view row for
  the id-carrying session shows `hermes 20261005_172826_f38167`; the
  headerless row renders unchanged. Screenshot: `ISSUE42-session-id.png`.

**Not in this slice:** the Hermes-side header injection (one seam:
`client_kwargs["default_headers"]` at provider client init — tracked in
the Hermes repo, brief §1) and the middleware plugin (the full #42).

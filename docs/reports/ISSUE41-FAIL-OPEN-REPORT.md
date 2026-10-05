# Issue #41 — gate fail-open posture, surfaced — build report (2026-10-05)

**The problem.** The session gate (`client/src/session-gate.ts`) goes
fail-open whenever the arbiter link is down: every session is admitted and
the slot cap is off. Only a daemon log line said so. The operator's
surfaces could not tell whether the gate was holding. A silently fail-open
gate is the whole danger this issue exists to close.

**The design.** The router owns posture truth — the arbiter cannot observe
it. The client publishes its own posture on the register heartbeat:

- `gate_posture: 'armed'` — the arbiter is reachable, the slot cap and
  operator overrides are in force.
- `gate_posture: 'fail_open'` — the arbiter is unreachable, so every
  session is admitted and the cap is off.
- key absent — the daemon has no session gate (nothing to report).

ADD-key contract: an old arbiter ignores the extra field; an old client
sends nothing. The arbiter stores the last valid report verbatim (exact
enum, malformed values dropped — same heartbeat rule as version/revision)
and echoes it on the client row AND the per-project worker row. The
dashboard badge is exception-only: `fail_open` renders a warning tag,
`armed` and absent render nothing. A recovered gate re-registers `armed`
on its first heartbeat, so the badge clears within one poll.

**Changes.**

- `client/src/session-gate.ts` — nothing new: the posture derives from the
  EXISTING `failOpen` getter (the same `linkUp` flag the log lines key on;
  no second source of truth).
- `client/src/index.ts` — the register heartbeat carries
  `gate_posture: this.gate.failOpen ? 'fail_open' : 'armed'` when a gate
  exists, and nothing when it does not.
- `server/src/types.ts` — `ClientRecord.gate_posture` documented as a
  client-owned, verbatim-echoed fact.
- `server/src/arbiter.ts` — `registerClient` sanitizes (exact enum) and
  stores; same update-if-valid rule as version/revision.
- `server/src/api.ts` — the register body accepts the key; the state
  projection echoes it exception-only.
- `server/public/index.html` — worker rows inherit the posture from the
  client row; `fail_open` renders a `gate fail-open` tag with a plain
  explanation in the title.

**Verification (real output).**

- `server/test/api.test.ts` — 4 new tests (armed stores on client + worker
  row; fail_open stores then a later armed heartbeat overwrites; a
  register without the key stays key-less; a malformed value is dropped,
  never rejected). 41/41 pass in that file.
- `client/test/session-gate.test.ts` — 2 new end-to-end daemon tests:
  `gate_posture=armed` observed on a real register body; the arbiter
  dying flips `failOpen` (the production fail-open path); a
  `session_gate: false` daemon never sends the key.
- `npx tsc --noEmit` clean in both workspaces; `npm run build` exit 0.
- Live visual proof: throwaway arbiter on :18899 with two registered
  workers — `mac-mini` (fail_open) shows the badge, `urza` (armed) shows
  nothing. DOM assert: `[{"name":"mac-mini gate fail-open","badge":"gate
  fail-open"},{"name":"urza","badge":null}]`. Screenshot:
  `ISSUE41-failopen-badge.png` (this directory).

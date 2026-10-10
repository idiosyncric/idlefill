# Issue #46 slice 3 — true pause: the LIVE hold signal and the turn interrupt (build report, 2026-10-10)

Map: #46 slice 1 (`ISSUE46-TRUE-PAUSE.md` — waitSince + release) · slice 2
(`ISSUE46-SIGNAL-REPORT.md` — the end-of-episode line) · the spike
(`ISSUE46-INTERRUPT-SPIKE.md` — plain raises are swallowed; THIS slice is
built on its follow-up finding) · #42 (the plugin) · #29 (the control
socket has no per-session verb — still true, and NOT the road taken).

## The finding that unblocked it (the spike's missed branch)

The spike proved a PLAIN raise from the parked `llm_execution` callback is
swallowed by the Hermes frame (skip-and-continue, provider call proceeds)
and stopped the design there. It did not test the frame's OWN fence:
`_run_execution_chain` catches `_DownstreamExecutionError` BEFORE its
skip branch and re-raises `exc.original` (`hermes_cli/middleware.py`,
installed `bbbf50cf2e2da1d4`) — and the frame cannot tell where the fence
was raised. So a parked plugin that synthesizes
`_DownstreamExecutionError(InterruptedError(...))` OUTSIDE its own
fail-open wrapper delivers the runner's stop type to
`conversation_loop._run_api_retry_loop`'s `except InterruptedError` →
`handle_api_interrupt` — the exact `/stop` unwind (kept partial text or
the "Interrupted waiting for model" row, session persisted, retry loop
broken), with the provider call NEVER running. Spike S6 (bare fence
through the real frame) + S7 (real plugin, daemon answers `paused +
interrupt`) prove it against the installed frame: stop type escapes,
provider 0x, real plugin logged the signal then stopped.

## Shipped — 1: the LIVE in-session hold signal (plugin)

Slice 2's single end-of-episode line was replaced with live lines
(`plugins/hermes-idlefill/__init__.py`): the FIRST line lands the moment
the hold is detected — the parked loop's very first `GET /gate/state`
says `queued`/`paused` (poll cadence 0.4s), so inside the issue's ~5s
budget — `held by idlefill gate (paused, 0s)`; a held call re-signals
every `_SIGNAL_REFRESH_S` (15s) so the reported Ns ages; a reason flip
(queued ⇄ paused) re-signals the new word at once. The posture is
unchanged: exception-only, measured (never a fabricated value, the 0s is
the actual length at detection), the token never appears, fail-open means
no line. Channel honesty: the plugin's stderr is the only channel this
plugin has (Hermes hooks are observer-only, there is no in-transcript
system-message API) — it surfaces in the Hermes process's stderr/log.
A session whose CURRENT provider call is in flight parks (and signals)
when its NEXT call hits the gate — the same boundary pause itself has;
the wire plane keeps the 503 + Retry-After and the Sessions row keeps
`waitSince` (slice 1).

## Shipped — 2: the turn interrupt (client daemon — the optional stronger pause)

Spec, shipped exactly: a loopback control endpoint that interrupts the
PARKED turn, the /stop equivalent.

- `POST /sessions/<token>/interrupt` (`client/src/session-control.ts`)
  on the same bind, the EXACT slice-1 guard posture (loopback Host,
  loopback Origin when carried, `X-Idlefill-Edit` constant-time against
  the daemon's own arbiter token, fail-closed 401 NO-OP, 405 on GET).
  Answer `{ ok, armed, released }`; unknown token ⇒
  `{ armed: false, released: 0 }`, never an error, never a phantom session.
- `SessionGate.requestInterrupt(token)` (`client/src/session-gate.ts`)
  covers BOTH hold planes in one call: it arms a per-token interrupt
  flag (TTL 30s, pruned on read) AND releases the session's parked wire
  holds with the existing slice-1 503 + Retry-After answer.
- The `interrupt` ADD-key: `GET /gate/state` carries `interrupt: true`
  ONLY while the session is actually HELD (paused/queued) and the flag
  is live; an `armed` answer never carries it; absent is the byte-for-byte
  pre-slice body (a plugin that ignores the key behaves exactly as before).

## Shipped — 3: the plugin consumes it (the raise path)

While parked, the plugin reads `(state, interrupt)` each poll; on
`interrupt: true` it stops holding and raises the fence outside its
fail-open wrapper, after one honest line:
`held by idlefill gate (paused, Ns) -> interrupt requested: parked turn
stopped`. If the fence class cannot be imported (older Hermes) it
DEGRADES to today's release semantics (admit the call) with a named
honest line — never a half-interrupt, never a swallowed raw
`InterruptedError` (the spike's S2: that path silently runs the provider
call instead).

Caveats, stated where they live:
- #29 still stands: the gateway control socket has NO per-session verb,
  and this ships none. The interrupt rides Hermes' in-process fence +
  stop type — a private symbol (`_DownstreamExecutionError`) and frame
  behavior pinned by the spike. Re-run `spike_interrupt.py` after any
  Hermes upgrade that touches middleware; if it ever reports UNEXPECTED,
  the plugin auto-degrades to admit (fail-open posture).
- It does NOT preempt an IN-FLIGHT provider call: the flag lands on the
  session's next HELD call within the TTL window (the gate never
  preempts running traffic — the same rule priority honors).
- It does NOT clear the operator pause override: the NEXT call parks
  again while paused — the interrupt stops the TURN, not the policy
  (un-pause stays the operator's call, the override routes).
- A session without the plugin gets the release half (the wire 503
  contract) — no middleware to signal.

## Wire-shape discipline

No server, arbiter, or dashboard change. The register heartbeat, the
gate snapshot, and `/api/state` are byte-for-byte untouched; the only
new wire surface is the loopback `interrupt` ADD-key on `/gate/state`
(ADD-only, absent = unset) and the new control verb.

## Tests (real output, 2026-10-10)

- `python3 -m unittest plugins/hermes-idlefill/test_plugin.py`: **23/23
  OK** — slice-2's five one-line tests replaced by three LIVE-signal tests
  (detect line, 15s refresh ages it to exactly 15s on the sleep-driven
  fake clock, word-change re-signal) + five interrupt tests (fence raised
  with a stubbed frame class, provider NEVER called; mid-hold interrupt;
  DEGRADE to admit without the fence; the flag never fires while armed;
  a malformed `interrupt` value is never true).
- `client/test/session-control.test.ts` **+3** (r7 arms the key on a
  paused session + answers the wire hold 503 + the pause override still
  owns admission; r8 unknown/idle token no-op, the key never rides an
  armed answer; r9 wrong-token 401 / GET 405 are NO-OPs that neither
  release nor arm) and r6 extended for the new verb.
- `client/test/session-gate.test.ts` **+1** pure unit: flag arms for
  tracked tokens only, rides held reads only, lapses at the TTL (clock
  seam), an absent row clears adoption per the normal poll rules.
- `python3 plugins/hermes-idlefill/spike_interrupt.py`: exit 0, S1–S4
  unchanged, **S6** fence escapes provider 0x, **S7** real plugin +
  real frame: fence(InterruptedError) escapes, provider 0x, both signal
  lines logged.
- Root `npm run test`: **792/792** across workspaces (server 451,
  client 255, rest unchanged), exit 0. `tsc --noEmit` clean (client,
  server). `npm run build` green.

## What remains open (unchanged by this slice)

The dashboard release/interrupt affordance per Sessions row (the design
doc's "one release affordance per row") — the loopback verb is shipped,
the button is not. Open decision 5 (`hold_kind` naming) untouched — the
signal names the gate's state word, the shipped slice-2 rule. Open
decision 3 answered in practice (the native plugin path ships); open
decision 4 answered (the interrupt is scoped to the held turn via the
fence, no Hermes verb, no gateway socket extension).

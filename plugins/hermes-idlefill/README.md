# hermes-idlefill — the Hermes side of the session gate (#42, slice 1)

A Hermes Agent plugin that holds each of its LLM calls at the idlefill
session gate. It is a single `llm_execution` middleware: it wraps the
provider call in-process, so it works for a Hermes session whose traffic
is gated by the idlefill client — no `/s/<token>` base_url required.

## What it does

On every LLM call, in the Hermes process itself:

1. **Register/heartbeat the session** at the local idlefill daemon with
   the real Hermes session id (`POST /gate/heartbeat`, loopback,
   idempotent, throttled to one per 2s per session). The `/s/<token>`
   gate key rides along when the profile's `base_url` carries one.
2. **Block while queued or paused — and say so.** A `GET /gate/state`
   polling loop (0.4s → 2s backoff) holds the call while the gate
   reports `queued` (session behind the slot cap) or `paused` (operator
   override). While held, the plugin logs the hold signal —
   `held by idlefill gate (queued, Ns)` the instant the hold is
   detected, refreshed every 15s so the age ages, and a fresh line when
   the reason word changes.
3. **Stop cleanly when the operator interrupts.** If the daemon answer
   carries `interrupt: true` (armed by `POST /sessions/<token>/interrupt`
   on the loopback daemon), the plugin stops holding and raises Hermes'
   own execution-frame fence (`_DownstreamExecutionError`) wrapping the
   runner's stop type (`InterruptedError`). The middleware frame re-raises
   the original, the turn loop finalizes the turn exactly like `/stop`
   (`handle_api_interrupt`), and the provider call never runs. (A PLAIN
   raise would be swallowed by the frame — only the fence escapes; see
   `spike_interrupt.py` S6/S7.) On an older Hermes without the fence
   class the plugin degrades to admitting the call, honestly logged.
4. **Run the provider call exactly once** when the gate reports
   `armed` — or immediately when it cannot be determined (below).

**When the daemon is down:** every probe fails within a 0.75s loopback
timeout and the call is admitted at once — the plugin fails open, same
posture as the router's own gate (a dead daemon must never wedge a
conversation). A daemon that dies mid-hold releases the held call the
same way. Malformed/unknown gate answers are treated the same way
(drop-don't-reject). The plugin writes no file and holds no secret; its
only output is the exception-only hold-signal log (stderr) and its only
raise is the #46 operator-interrupt fence. Everything is 127.0.0.1 only.

## Install (into a Hermes profile)

```sh
cp -R plugins/hermes-idlefill ~/.hermes/profiles/<profile>/plugins/
# dev: a symlink works too — the plugin reads no config file of its own
export IDLEFILL_GATE_PORT=<the idlefill daemon's proxy_port>
```

Restart the Hermes session. `IDLEFILL_GATE_PORT` unset (or invalid) makes
the plugin a complete no-op — no daemon contact, zero behavior change,
so installing it is safe before the daemon side lands.

## The honest limit

This plugin is **additive**. It gates the calls a given Hermes profile
makes in-process; it does not change what the daemon serves. The
loopback router path (`/s/<token>` and the :8800 aggregate endpoint)
**still serves non-Hermes clients and Hermes sessions that run without
this plugin** exactly as before — the two paths converge on the same
gate state, one contract.

Also: the daemon-side routes (`/gate/heartbeat`, `/gate/state` on the
client's loopback proxy) are implemented on the idlefill client (the
#42 slice-2 routes); an unreachable daemon makes the plugin a documented
no-op by fail-open, which is the correct interim behavior.

## Tests

`test_plugin.py` (stdlib unittest, no network):

```sh
python3 -m unittest plugins/hermes-idlefill/test_plugin.py -v
```

Drives the real callback against a stub daemon and a fake clock: armed,
queued (blocked until the admitting poll), paused, the live hold signal
(detect + refresh + word-change lines), the interrupt fence (stops the
parked turn, provider never runs) and its degrade path, unreachable
(immediate fail-open), daemon-down mid-hold, malformed state, heartbeat
throttle, disabled no-op, and the single-use `next_call` contract.

`spike_interrupt.py` (against the REAL installed Hermes frame, no
network) proves the frame semantics the interrupt rides on: plain raises
are swallowed, the fence re-raises — run it after any Hermes upgrade
that touches middleware.

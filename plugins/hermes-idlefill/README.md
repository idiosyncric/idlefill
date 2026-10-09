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
2. **Block while queued or paused.** A `GET /gate/state` polling loop
   (0.4s → 2s backoff) holds the call while the gate reports `queued`
   (session behind the slot cap) or `paused` (operator override). The
   turn looks "thinking"; `/stop` is the escape hatch.
3. **Run the provider call exactly once** when the gate reports
   `armed` — or immediately when it cannot be determined (below).

**When the daemon is down:** every probe fails within a 0.75s loopback
timeout and the call is admitted at once — the plugin fails open, same
posture as the router's own gate (a dead daemon must never wedge a
conversation). A daemon that dies mid-hold releases the held call the
same way. Malformed/unknown gate answers are treated the same way
(drop-don't-reject). The plugin never raises, never logs, never writes
a file, and never holds a secret — everything is 127.0.0.1 only.

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
client's loopback proxy) are the contract this slice defines — the
daemon implementation lands in slice 2. Until it does, the plugin is a
documented no-op by fail-open, which is the correct interim behavior.

## Tests

`test_plugin.py` (stdlib unittest, no network):

```sh
python3 -m unittest plugins/hermes-idlefill/test_plugin.py -v
```

Drives the real callback against a stub daemon: armed, queued (blocked
until the admitting poll), paused, unreachable (immediate fail-open),
daemon-down mid-hold, malformed state, heartbeat throttle, disabled
no-op, and the single-use `next_call` contract.

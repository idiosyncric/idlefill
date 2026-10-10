# #46 — can the plugin raise to stop the parked turn? (interrupt spike)
**Verdict: NOT feasible.** A raise from the `llm_execution` middleware while parked
(queued/paused) does not stop the turn — not `RuntimeError`, not `InterruptedError`
(the runner's stop type), not any `Exception`. No daemon endpoint would help: the
Hermes frame swallows callback exceptions and **runs the provider call anyway**.
## Mechanism (real Hermes source, quoted)
`hermes_cli/middleware.py::_run_execution_chain` (lines 200–212) decides it:
```python
try:
    return callback(**call_kwargs)
except _DownstreamExecutionError as exc:
    raise exc.original
except Exception as exc:
    manager._report_hook_failure(kind, callback, call_kwargs, exc, surface="Middleware")
    if next_succeeded: return next_result
    if next_called: raise
    return call_at(index + 1, payload)   # <- parked frame: skipped, provider call runs
```
Parked = the plugin called `next_call` **zero times**, so the marked branch **runs
the downstream provider call directly**; the exception yields only a warn-once log
(`plugins_dispatch.py:247`). `_DownstreamExecutionError` is the ONLY re-raised
exception, produced solely BELOW a frame (`middleware.py:194–195`) — by the
provider call, never by middleware code. Stop type = builtin `InterruptedError`:
the turn loop wraps the provider call in `agent/conversation_loop.py:1517`
(`except InterruptedError:` → `handle_api_interrupt`, `agent/turn_api_call.py:171`).
The real `/stop` is in-process: `agent.interrupt()` sets `agent._interrupt_requested`
(`agent/interrupt_control.py:158`); the interruptible API-call layer raises
`InterruptedError` on seeing that flag (`chat_completion_helpers.py:1055`). The
exception must originate INSIDE the `next_call` closure — the middleware callback
gets no agent reference, no interrupt flag, no `is_interrupted()` (context:
`turn_api_call.py:133–139`). Second blocker: the plugin's own fail-open wrapper,
`try: … except Exception: pass` (`plugins/hermes-idlefill/__init__.py:240–241`).
## What the spike proves (real output)
`spike_interrupt.py` drives the REAL frame (imported from the installed Hermes
workspace; `_delivery_manager` stubbed to its two used attributes — no deps, no
network) and the REAL plugin callback:
```
S1 parked callback raises RuntimeError       -> swallowed, provider ran 1x (warn-once)
S2 parked callback raises InterruptedError   -> swallowed, provider ran 1x (warn-once)
S3 callback admits; PROVIDER raises InterruptedError (real /stop path) -> propagated
S4 real plugin: gate raises inside its try   -> swallowed by the plugin, provider ran 1x
```
## Not built (per the spike's answer)
- **No daemon endpoint** (per CONTEXT) — would be dead code: even a perfect
  “stop now” signal could only make the plugin raise, which S1/S2 prove is
  swallowed and the call proceeds (the only signal `/stop` sets is
  `agent._interrupt_requested`; #29: no gateway verb).
- **No `__init__.py` change, no flag, no new plugin tests** — the conditional
  raise is provably inert, so the knob would do nothing.
## Needs the owner's decision
1. **Pause semantics**: “stop thinking” is not expressible in Hermes today —
   (a) keep Pause = stall-at-the-gate and say so in the UI, or (b) wait for a
   Hermes change (middleware exception propagation, or a per-session interrupt
   handle in the middleware context).
2. **Whether a (dead) flag ships**: recommend NO — document the limit instead.
3. Slice-2 open decisions (hold cap, pause-period aging, signal channel) remain
   as recorded in `ISSUE46-SIGNAL-REPORT.md`.
**Verification (real output):** spike exit 0; `python3 -m unittest
plugins/hermes-idlefill/test_plugin.py` 17/17 OK (unchanged suite); root
`NODE_ENV=test npm run test` (all workspaces) exit 0.
## ADDENDUM (same day, slice 3) — the spike's missed branch SUPERSEDES the verdict
The verdict holds for PLAIN raises (S1/S2/S4) — and it stopped the design
one branch short: the frame's `except _DownstreamExecutionError as exc:
raise exc.original` runs BEFORE the skip branch and cannot tell where the
fence was raised. Synthesizing that fence around the stop type from the
parked callback escapes the frame and stops the turn (provider never
runs). Added spike cases S6 (bare fence, real frame) and S7 (real plugin,
daemon answers paused+interrupt) prove it against the installed frame —
the interrupt SHIPPED on this path in slice 3: `docs/reports/ISSUE46-INTERRUPT-REPORT.md`.
The "no daemon endpoint" conclusion also flips: the shipped
`POST /sessions/<token>/interrupt` is what arms the flag the plugin
consumes. Re-run the spike after any Hermes upgrade that touches
middleware — it is the pin for the private-symbol dependency.
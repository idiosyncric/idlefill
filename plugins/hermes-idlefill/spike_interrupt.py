"""Issue #46 spike: can a middleware raise from the parked callback to stop the turn?

Standalone, stdlib-only. Drives the REAL Hermes middleware frame
(`hermes_cli.middleware.run_llm_execution_middleware`) against a stub provider
call, and the REAL idlefill plugin callback against a stub gate, to prove what
a raised exception actually does:

  S1  callback raises RuntimeError while parked (before next_call)
  S2  callback raises InterruptedError (the runner's stop type) while parked
  S3  callback admits; the provider call itself raises InterruptedError
      (what the real /stop path does inside the interruptible call)
  S4  the real plugin callback: the gate raises from inside its try
      (simulating a raise in the parked loop) -- does anything escape?
  S6  (added by slice 3) parked callback raises the frame's OWN fence,
      _DownstreamExecutionError wrapping InterruptedError -- the frame's
      `except _DownstreamExecutionError: raise exc.original` cannot tell
      where the fence was raised, so the stop type reaches the turn loop
      WITHOUT the provider call. This is the shipped interrupt path.

No network. The real `hermes_cli.plugins` needs third-party deps (ruamel);
the frame only needs `_delivery_manager()` with `_middleware` +
`_report_hook_failure`, so the spike stubs exactly that and uses the real
frame code.

Usage:  python3 plugins/hermes-idlefill/spike_interrupt.py [HERMES_SRC]
"""
from __future__ import annotations

import importlib
import importlib.machinery
import os
import sys
import types

DEFAULT_HERMES_SRC = os.environ.get(
    "HERMES_SRC",
    "/Users/sam/.hermes/installs/bbbf50cf2e2da1d4/environments/"
    "84ba40938c9d4ca9b32e02e026ad3ee2/workspace",
)

mw = None  # the real hermes_cli.middleware (imported in main)


class _StubManager:
    """The only two attributes the frame uses on the delivery manager."""

    def __init__(self, callbacks):
        self._middleware = {"llm_execution": list(callbacks)}
        self.reports = []

    def _report_hook_failure(self, kind, callback, kwargs, exc, *, surface="Hook"):
        self.reports.append(
            f"{surface} '{kind}' callback {getattr(callback, '__name__', repr(callback))} "
            f"raised: {type(exc).__name__}: {exc}"
        )


_MANAGER = {}


def _stub_plugins() -> None:
    """Make `from hermes_cli.plugins import _delivery_manager` resolve to the stub."""
    stub = types.ModuleType("hermes_cli.plugins")
    stub._delivery_manager = lambda: _MANAGER["manager"]
    sys.modules.setdefault("hermes_cli.plugins", stub)


def _run_frame(title: str, callback, terminal):
    _MANAGER["manager"] = _StubManager([callback])
    provider_calls = {"n": 0}

    def counting_terminal(payload):
        provider_calls["n"] += 1
        return terminal(payload)

    raised = None
    result = None
    try:
        result = mw.run_llm_execution_middleware({"model": "stub"}, counting_terminal)
    except BaseException as exc:  # noqa: BLE001 - the observation IS the raise
        raised = exc

    print(f"== {title}")
    if raised is None:
        print(f"   raised out of run_llm_execution_middleware: nothing (result: {result!r})")
    else:
        print(f"   raised out of run_llm_execution_middleware: {type(raised).__name__}: {raised}")
    print(f"   stub provider call executed: {provider_calls['n']}x")
    for r in _MANAGER["manager"].reports:
        print(f"   frame reported (warn-once): {r}")
    print()
    return raised, provider_calls["n"]


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_HERMES_SRC
    sys.path.insert(0, src)
    _stub_plugins()
    global mw
    import hermes_cli.middleware as real_mw  # noqa: E402 - path set above

    mw = real_mw
    print(f"frame under test (real code): {mw.__file__}\n")

    def parked_runtime_error(request, next_call, **ctx):
        # Gate reports `paused`; the callback raises while parked instead of
        # calling next_call (a plain error).
        raise RuntimeError("idlefill gate paused: turn interrupt requested")

    def parked_interrupted_error(request, next_call, **ctx):
        # The exact question from issue #46: raise the runner's stop type
        # (InterruptedError) from the parked callback.
        raise InterruptedError("idlefill gate paused: stop thinking")

    def admit(request, next_call, **ctx):
        # The plugin's normal behavior: gate passes, run the provider call.
        return next_call()

    def provider_interrupted(payload):
        # What the real provider-call layer does when /stop was pressed
        # (chat_completion_helpers.py: `raise InterruptedError(...)` when
        # agent._interrupt_requested is set).
        raise InterruptedError("Agent interrupted during API call")

    def parked_base_exception(request, next_call, **ctx):
        # Edge probe: KeyboardInterrupt is a BaseException, NOT Exception --
        # can it slip past the frame's `except Exception`?
        raise KeyboardInterrupt

    r1, n1 = _run_frame("S1  parked callback raises RuntimeError (before next_call)",
                        parked_runtime_error, lambda p: "llm-response")
    r2, n2 = _run_frame("S2  parked callback raises InterruptedError (the runner's stop type)",
                        parked_interrupted_error, lambda p: "llm-response")
    r3, n3 = _run_frame("S3  callback admits; the PROVIDER call raises InterruptedError (real /stop path)",
                        admit, provider_interrupted)
    r5, n5 = _run_frame("S5  parked callback raises KeyboardInterrupt (BaseException, not Exception)",
                        parked_base_exception, lambda p: "llm-response")

    def parked_fence_interrupted(request, next_call, **ctx):
        # S6: synthesize the frame's OWN fence around the stop type. The
        # frame catches _DownstreamExecutionError before its skip-and-
        # continue branch and re-raises `exc.original` -- it cannot tell
        # the fence was raised BY the callback, not below it.
        raise mw._DownstreamExecutionError(
            InterruptedError("idlefill gate: operator interrupt")
        )

    r6, n6 = _run_frame("S6  parked callback raises _DownstreamExecutionError(InterruptedError)",
                        parked_fence_interrupted, lambda p: "llm-response")

    # --- S4: the real plugin callback (its own fail-open wrapper) ---------
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    # Load the REAL plugin file directly: the hermes workspace above carries a
    # regular `plugins` package that would shadow the repo's namespace package,
    # and the plugin has no intra-package imports (self-contained).
    loader = importlib.machinery.SourceFileLoader(
        "idlefill_gate_spike", os.path.join(root, "plugins", "hermes-idlefill", "__init__.py")
    )
    plugin = loader.load_module()
    os.environ["IDLEFILL_GATE_PORT"] = "18899"
    plugin._post_json = lambda url, payload: None
    plugin._get_json = lambda url: {"state": "paused"}
    plugin._sleep = lambda s: None
    plugin._gate_state = lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError("simulated raise from the parked loop (flag-on behaviour)")
    )
    calls = {"n": 0}

    def next_call():
        calls["n"] += 1
        return "llm-response"

    raised4 = None
    result4 = None
    try:
        result4 = plugin.llm_execution_gate({"request": True}, next_call,
                                            session_id="20261009_spike",
                                            base_url="http://127.0.0.1:8800/v1")
    except BaseException as exc:  # noqa: BLE001 - the observation IS the raise
        raised4 = exc
    print("== S4  real plugin callback: the gate raises inside its try (parked loop)")
    if raised4 is None:
        print(f"   raised out of llm_execution_gate: nothing (result: {result4!r})")
    else:
        print(f"   raised out of llm_execution_gate: {type(raised4).__name__}: {raised4}")
    print(f"   stub provider call executed: {calls['n']}x")
    print()

    # --- S7: the REAL plugin, daemon answer says paused + interrupt -------
    # (fresh module load: S4 replaced this module's _gate_state stub;
    # sys.path still carries the real Hermes, so the plugin's lazy
    # `from hermes_cli.middleware import _DownstreamExecutionError` at
    # raise time resolves to the REAL frame class.)
    plugin7 = loader.load_module()
    plugin7._post_json = lambda url, payload: None
    plugin7._get_json = lambda url: {"state": "paused", "interrupt": True}
    plugin7._sleep = lambda s: None
    plugin7_logs: list[str] = []
    plugin7._log = plugin7_logs.append
    calls7 = {"n": 0}

    def next_call7():
        calls7["n"] += 1
        return "llm-response"

    raised7 = None
    result7 = None
    try:
        result7 = plugin7.llm_execution_gate({"request": True}, next_call7,
                                             session_id="20261009_spike7",
                                             base_url="http://127.0.0.1:8800/v1")
    except BaseException as exc:  # noqa: BLE001 - the observation IS the raise
        raised7 = exc
    fence7 = isinstance(raised7, mw._DownstreamExecutionError) and isinstance(
        getattr(raised7, "original", None), InterruptedError
    )
    print("== S7  real plugin, daemon answers paused + interrupt (real frame class importable)")
    print(f"   raised out of llm_execution_gate: {type(raised7).__name__ if raised7 is not None else 'nothing'}"
          + (f" wrapping {type(raised7.original).__name__}" if fence7 else ""))
    print(f"   stub provider call executed: {calls7['n']}x")
    for line in plugin7_logs:
        print(f"   plugin logged: {line}")
    print()

    # --- verdict ------------------------------------------------------------
    swallowed = (r1 is None and n1 == 1) and (r2 is None and n2 == 1)
    propagated = isinstance(r3, InterruptedError) and n3 == 1
    print("VERDICT")
    print(f"  S1 plain error raised while parked   -> swallowed by the frame, provider ran: {r1 is None and n1 == 1}")
    print(f"  S2 InterruptedError raised while parked -> swallowed by the frame, provider ran: {r2 is None and n2 == 1}")
    print(f"  S3 InterruptedError from the provider call -> propagated to the turn loop: {propagated}")
    print(f"  S5 KeyboardInterrupt raised while parked -> escaped the frame: {isinstance(r5, KeyboardInterrupt)} "
          f"(provider ran: {n5}x)")
    print(f"  S4 real plugin: raise inside its own try -> swallowed by the plugin, provider ran: {raised4 is None and calls['n'] == 1}")
    print(f"  S6 the frame's own fence wrapping InterruptedError -> stop type escapes, provider ran {n6}x: "
          f"{isinstance(r6, InterruptedError) and n6 == 0}")
    print(f"  S7 real plugin, daemon paused+interrupt -> fence(InterruptedError) escapes, provider ran {calls7['n']}x: "
          f"{fence7 and calls7['n'] == 0}")
    s6_ok = isinstance(r6, InterruptedError) and n6 == 0
    s7_ok = fence7 and calls7["n"] == 0
    if swallowed and propagated and raised4 is None and calls["n"] == 1 and s6_ok and s7_ok:
        print("  => a PLAIN raise from the parked callback does NOT stop the turn (the frame swallows it,")
        print("     warn-once, provider call proceeds -- S1/S2/S4). But the frame re-raises its own fence")
        print("     _DownstreamExecutionError(original), so a parked gate CAN deliver a clean turn")
        print("     interrupt: synthesize the fence around the runner's stop type (S6/S7) -- the stop type")
        print("     reaches conversation_loop's `except InterruptedError` -> handle_api_interrupt, and the")
        print("     provider call NEVER runs. This is the shipped #46 slice-3 interrupt path.")
        sys.exit(0)
    print("  => UNEXPECTED result: re-run and inspect the frame; do not ship on this output.")
    sys.exit(1)


if __name__ == "__main__":
    main()

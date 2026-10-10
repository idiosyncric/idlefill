"""Unit tests for the hermes-idlefill gate plugin (issue #42, slice 1).

Stdlib unittest only, no network. Drives the real `llm_execution` callback
against a stub idlefill daemon loopback (scripted /gate/heartbeat +
/gate/state), covering: armed, queued, paused, unreachable, disabled, and
no-session-id. The stub `next_call` mirrors the real middleware frame:
single-use — a second call raises.

Seams: the plugin resolves `_post_json` / `_get_json` / `_sleep` / `_now`
/ `_log` through its OWN module globals, so patching `plugin._post_json`
etc. is enough — no real HTTP, no real sleeping, no real clock. The fake
clock advances only with the stub's sleeps, so hold durations in the
#46 signal lines are exact.

#46 slice 3 adds the interrupt tests: with a stubbed Hermes fence class
(a fake `hermes_cli.middleware` in sys.modules) the parked call raises
the fence wrapping InterruptedError and NEVER calls next_call; without it
the plugin degrades to today's release semantics (admit, one honest log
line).
"""
import importlib
import os
import sys
import types
import unittest

PORT = "18899"  # the stub daemon's loopback port (never bound)


def _load_plugin():
    return importlib.import_module("plugins.hermes-idlefill")


class StubDaemon:
    """Scripted idlefill daemon loopback: gate states + traffic counters.
    `sleep` advances the shared fake clock by the slept seconds, so the
    plugin's hold-signal "Ns" is fully deterministic."""

    def __init__(self, states, clock=None):
        self.states = list(states)
        self.clock = clock
        self.state_polls = 0
        self.heartbeats = []
        self.sleeps = []
        self.next_calls = 0
        self.next_call_polls = None

    # --- the plugin's HTTP/time seams ---

    def post_json(self, url, payload):
        assert url.startswith("http://127.0.0.1:" + PORT + "/gate/heartbeat"), url
        self.heartbeats.append(payload)

    def get_json(self, url):
        assert url.startswith("http://127.0.0.1:" + PORT + "/gate/state?"), url
        self.state_polls += 1
        if not self.states:
            return {"state": "armed"}  # run-out default: the gate admits
        value = self.states.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        if self.clock is not None:
            self.clock[0] += seconds

    # --- next_call: single-use like the real middleware frame ---

    def next_call(self, *args, **kwargs):
        self.next_calls += 1
        if self.next_calls > 1:
            raise RuntimeError("next_call() called more than once (single-use)")
        self.next_call_polls = self.state_polls
        return "llm-response"


class GatePluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = _load_plugin()
        self.plugin._last_heartbeat.clear()
        self.saved_port = os.environ.get("IDLEFILL_GATE_PORT")
        os.environ["IDLEFILL_GATE_PORT"] = PORT
        self._real_sleep = self.plugin._sleep
        self._real_now = self.plugin._now
        self._real_log = self.plugin._log
        self.lines = []
        self.plugin._log = self._record_log
        # Fake clock: frozen unless a stub sleep advances it, so the
        # hold-signal "Ns" values are exact and clock-independent.
        self.clock = [0.0]
        self.plugin._now = lambda: self.clock[0]

    def _record_log(self, line):
        self.lines.append(line)

    def _install_fake_fence(self):
        """Fake `hermes_cli.middleware` carrying the frame fence class, so
        the plugin's lazy interrupt import resolves without real Hermes."""

        class _DownstreamExecutionError(Exception):
            def __init__(self, original):
                super().__init__(str(original))
                self.original = original

        pkg = types.ModuleType("hermes_cli")
        mod = types.ModuleType("hermes_cli.middleware")
        mod._DownstreamExecutionError = _DownstreamExecutionError
        pkg.middleware = mod
        sys.modules["hermes_cli"] = pkg
        sys.modules["hermes_cli.middleware"] = mod
        return _DownstreamExecutionError

    def tearDown(self):
        os.environ.pop("IDLEFILL_GATE_PORT", None)
        if self.saved_port is not None:
            os.environ["IDLEFILL_GATE_PORT"] = self.saved_port
        self.plugin._sleep = self._real_sleep
        self.plugin._now = self._real_now
        self.plugin._log = self._real_log
        self.plugin._last_heartbeat.clear()
        sys.modules.pop("hermes_cli.middleware", None)
        sys.modules.pop("hermes_cli", None)

    def _run(self, states, session_id="20261009_test_gate", base_url="http://127.0.0.1:8800/v1"):
        stub = StubDaemon(states, self.clock)
        self.plugin._post_json = stub.post_json
        self.plugin._get_json = stub.get_json
        self.plugin._sleep = stub.sleep
        context = {}
        if session_id is not None:
            context["session_id"] = session_id
        if base_url is not None:
            context["base_url"] = base_url
        result = self.plugin.llm_execution_gate({"request": True}, stub.next_call, **context)
        return stub, result

    def test_armed_calls_next_call_exactly_once(self):
        stub, result = self._run([{"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.state_polls, 1)
        self.assertEqual(stub.sleeps, [])  # armed: no hold at all
        self.assertEqual(stub.heartbeats, [{"session_id": "20261009_test_gate"}])

    def test_proxy_plane_token_rides_the_heartbeat(self):
        stub, _ = self._run(
            [{"state": "armed"}], base_url="http://127.0.0.1:11435/s/abc123"
        )
        self.assertEqual(
            stub.heartbeats,
            [{"session_id": "20261009_test_gate", "token": "abc123"}],
        )

    def test_queued_blocks_until_admitted(self):
        stub, result = self._run([{"state": "queued"}, {"state": "queued"}, {"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        # Held through BOTH queued reports: next_call ran only after the
        # final (admitting) state poll — the block is real, not a passthrough.
        self.assertEqual(stub.next_call_polls, 3)
        self.assertEqual(len(stub.sleeps), 2)  # slept once per queued report
        self.assertGreater(stub.sleeps[0], 0)
        self.assertGreaterEqual(stub.sleeps[1], stub.sleeps[0])  # backoff

    def test_paused_blocks_until_unpaused(self):
        stub, result = self._run([{"state": "paused"}, {"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.next_call_polls, 2)
        self.assertEqual(len(stub.sleeps), 1)

    # --- issue #46 slice 2 + 3: the LIVE in-session hold signal ---

    def test_queued_hold_signals_on_detect_then_refresh(self):
        # Cumulative stub sleeps: 0.4, 0.6, 0.9, 1.35, then 2.0s steps —
        # the first 15s refresh fires at ~15.25s of fake-clock hold.
        states = [{"state": "queued"}] * 11 + [{"state": "armed"}]
        stub, result = self._run(states, base_url="http://127.0.0.1:11435/s/abc123")
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        # Exception-only, exception-fast: the FIRST line lands the moment
        # the hold is detected (0s measured — never a fake zero, it is the
        # actual hold length at detection), then ONE refresh line ages it.
        self.assertEqual(
            self.lines,
            ["held by idlefill gate (queued, 0s)", "held by idlefill gate (queued, 15s)"],
        )
        # The token never appears in any signal line.
        for line in self.lines:
            self.assertNotIn("abc123", line)

    def test_paused_hold_signals_on_detect(self):
        stub, result = self._run([{"state": "paused"}, {"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, ["held by idlefill gate (paused, 0s)"])

    def test_state_word_change_re_signals_the_new_reason(self):
        states = [{"state": "queued"}, {"state": "paused"}, {"state": "armed"}]
        stub, result = self._run(states)
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        # The reason flipped queued -> paused: a fresh line names the NEW
        # word at once (no waiting for the 15s refresh).
        self.assertEqual(
            self.lines,
            ["held by idlefill gate (queued, 0s)", "held by idlefill gate (paused, 0s)"],
        )

    def test_armed_session_emits_no_signal_line(self):
        stub, result = self._run([{"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, [])  # no hold: no line at all

    def test_unreachable_emits_no_line_and_still_admits(self):
        down = ConnectionError("daemon down")
        stub, result = self._run([down, down])
        self.assertEqual(result, "llm-response")  # fail-open: admitted
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, [])  # no gate data: no line

    def test_malformed_state_emits_no_line_and_never_raises(self):
        stub, result = self._run([{"state": "weird"}, None])
        self.assertEqual(result, "llm-response")  # no exception escapes
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, [])

    # --- issue #46 slice 3: the operator turn interrupt ---

    def test_interrupt_stops_the_parked_turn_never_calls_provider(self):
        fence = self._install_fake_fence()
        stub = StubDaemon([{"state": "paused", "interrupt": True}], self.clock)
        self.plugin._post_json = stub.post_json
        self.plugin._get_json = stub.get_json
        self.plugin._sleep = stub.sleep
        raised = None
        try:
            self.plugin.llm_execution_gate(
                {"request": True}, stub.next_call,
                session_id="20261009_test_gate", base_url="http://127.0.0.1:8800/v1",
            )
        except BaseException as exc:  # noqa: BLE001 - the observation IS the raise
            raised = exc
        # The plugin raises the frame's OWN fence wrapping the stop type:
        # the frame re-raises the original, the turn loop finalizes
        # cleanly, the provider call NEVER runs (spike S6/S7).
        self.assertIsInstance(raised, fence)
        self.assertIsInstance(getattr(raised, "original", None), InterruptedError)
        self.assertEqual(stub.next_calls, 0)
        self.assertEqual(stub.sleeps, [])  # interrupted at once, no hold-on
        self.assertEqual(len(self.lines), 2)
        self.assertEqual(self.lines[0], "held by idlefill gate (paused, 0s)")
        self.assertIn("interrupt requested: parked turn stopped", self.lines[1])

    def test_interrupt_mid_hold_stops_without_provider_call(self):
        self._install_fake_fence()
        stub = StubDaemon(
            [{"state": "queued"}, {"state": "queued", "interrupt": True}], self.clock,
        )
        self.plugin._post_json = stub.post_json
        self.plugin._get_json = stub.get_json
        self.plugin._sleep = stub.sleep
        raised = None
        try:
            self.plugin.llm_execution_gate(
                {"request": True}, stub.next_call,
                session_id="20261009_test_gate", base_url="http://127.0.0.1:8800/v1",
            )
        except BaseException as exc:  # noqa: BLE001 - the observation IS the raise
            raised = exc
        self.assertIsInstance(getattr(raised, "original", None), InterruptedError)
        self.assertEqual(stub.next_calls, 0)
        self.assertEqual(len(stub.sleeps), 1)  # held once, then the interrupt lands
        self.assertEqual(self.lines[0], "held by idlefill gate (queued, 0s)")
        self.assertIn("interrupt requested: parked turn stopped", self.lines[-1])

    def test_interrupt_without_fence_degrades_to_admit(self):
        # No `hermes_cli` importable (this test env): the plugin must NOT
        # raise (a raw InterruptedError would be swallowed by the frame
        # and the provider would run anyway — spike S2). It admits and
        # says so honestly.
        stub, result = self._run([{"state": "paused", "interrupt": True}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(len(self.lines), 2)
        self.assertIn("no interrupt path: call proceeds", self.lines[1])

    def test_interrupt_never_fires_while_armed(self):
        # An armed session is not parked: the flag is not consumed, the
        # call proceeds exactly like before, no line, no raise.
        stub, result = self._run([{"state": "armed", "interrupt": True}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, [])

    def test_malformed_interrupt_key_is_not_true(self):
        # `interrupt` must be exactly true: a string/1/0 never interrupts.
        stub, result = self._run([{"state": "paused", "interrupt": "1"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)

    def test_unreachable_never_raises_and_admits(self):
        down = ConnectionError("daemon down")
        stub, result = self._run([down, down])  # heartbeat + state both refused
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.sleeps, [])  # fail-open IMMEDIATELY: no hold

    def test_unreachable_mid_hold_fails_open(self):
        down = ConnectionError("daemon died mid-hold")
        stub, result = self._run([{"state": "queued"}, down])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(len(stub.sleeps), 1)  # held once, then the dead daemon admits

    def test_malformed_state_fails_open(self):
        stub, result = self._run([{"state": "weird"}, None])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.sleeps, [])

    def test_heartbeat_throttled_per_session(self):
        stub, _ = self._run([{"state": "armed"}])
        stub2 = StubDaemon([{"state": "armed"}])
        self.plugin._post_json = stub2.post_json
        self.plugin._get_json = stub2.get_json
        self.plugin._sleep = stub2.sleep
        self.plugin.llm_execution_gate(
            {"request": True}, stub2.next_call,
            session_id="20261009_test_gate",
            base_url="http://127.0.0.1:8800/v1",
        )
        # Second call same session inside the window: registered once total.
        self.assertEqual(len(stub.heartbeats) + len(stub2.heartbeats), 1)
        self.assertEqual(stub2.next_calls, 1)

    def test_disabled_without_port_is_a_noop(self):
        del os.environ["IDLEFILL_GATE_PORT"]
        stub, result = self._run([{"state": "queued"}, {"state": "queued"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.state_polls, 0)  # no daemon contact at all
        self.assertEqual(stub.heartbeats, [])
        self.assertEqual(stub.sleeps, [])

    def test_no_session_id_is_a_noop(self):
        stub, result = self._run([{"state": "queued"}], session_id=None)
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.state_polls, 0)
        self.assertEqual(stub.heartbeats, [])

    def test_hostile_session_id_is_dropped(self):
        stub, result = self._run([{"state": "queued"}], session_id="bad\x00id")
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(stub.state_polls, 0)  # unsanitizable => absent => no-op

    def test_register_wires_the_llm_execution_middleware(self):
        registered = []

        class Ctx:
            def register_middleware(self, kind, callback):
                registered.append((kind, callback))

        self.plugin.register(Ctx())
        self.assertEqual(len(registered), 1)
        kind, callback = registered[0]
        self.assertEqual(kind, "llm_execution")
        self.assertIs(callback, self.plugin.llm_execution_gate)


if __name__ == "__main__":
    unittest.main()

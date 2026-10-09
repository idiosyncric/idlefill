"""Unit tests for the hermes-idlefill gate plugin (issue #42, slice 1).

Stdlib unittest only, no network. Drives the real `llm_execution` callback
against a stub idlefill daemon loopback (scripted /gate/heartbeat +
/gate/state), covering: armed, queued, paused, unreachable, disabled, and
no-session-id. The stub `next_call` mirrors the real middleware frame:
single-use — a second call raises.

Seams: the plugin resolves `_post_json` / `_get_json` / `_sleep` through
its OWN module globals, so patching `plugin._post_json` etc. is enough —
no real HTTP, no real sleeping.
"""
import importlib
import os
import unittest

PORT = "18899"  # the stub daemon's loopback port (never bound)


def _load_plugin():
    return importlib.import_module("plugins.hermes-idlefill")


class StubDaemon:
    """Scripted idlefill daemon loopback: gate states + traffic counters."""

    def __init__(self, states):
        self.states = list(states)
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

    def _record_log(self, line):
        self.lines.append(line)

    def _fake_now(self, values):
        vals = list(values)

        def now():
            return vals.pop(0) if vals else 0.0

        self.plugin._now = now

    def tearDown(self):
        os.environ.pop("IDLEFILL_GATE_PORT", None)
        if self.saved_port is not None:
            os.environ["IDLEFILL_GATE_PORT"] = self.saved_port
        self.plugin._sleep = self._real_sleep
        self.plugin._now = self._real_now
        self.plugin._log = self._real_log
        self.plugin._last_heartbeat.clear()

    def _run(self, states, session_id="20261009_test_gate", base_url="http://127.0.0.1:8800/v1"):
        stub = StubDaemon(states)
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

    # --- issue #46 slice 2: the in-session hold signal ---

    def test_queued_hold_emits_one_signal_line(self):
        self._fake_now([1000.0, 2000.0, 2031.0])
        stub, result = self._run(
            [{"state": "queued"}, {"state": "queued"}, {"state": "armed"}],
            base_url="http://127.0.0.1:11435/s/abc123",
        )
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        # Exactly ONE exception-only line for the whole hold episode
        # (two queued reports, one line): the reason and the measured
        # hold length (31s on the fake clock).
        self.assertEqual(self.lines, ["held by idlefill gate (queued, 31s)"])
        # The token never appears in the signal line.
        for line in self.lines:
            self.assertNotIn("abc123", line)

    def test_paused_hold_emits_one_signal_line(self):
        self._fake_now([1000.0, 5000.0, 5040.0])
        stub, result = self._run([{"state": "paused"}, {"state": "armed"}])
        self.assertEqual(result, "llm-response")
        self.assertEqual(stub.next_calls, 1)
        self.assertEqual(self.lines, ["held by idlefill gate (paused, 40s)"])

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

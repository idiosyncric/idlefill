"""
Hermes <-> idlefill session gate (issue #42, slice 1).

An `llm_execution` middleware wrapping every provider call in a Hermes
session. Per call:

  1. register/heartbeat THIS session at the local idlefill daemon with the
     real Hermes session id (loopback only, best-effort, throttled);
  2. block (the turn looks "thinking" — the seam has no timeout) while the
     gate reports the session `queued` or `paused`, signaling the hold in
     the log; the gate's `interrupt` key (operator `POST
     /sessions/<token>/interrupt`) or Hermes' own /stop ends the turn;
  3. run the provider call (`next_call`) exactly once.

In-session hold signal (issue #46, slice 2; LIVE in slice 3): while the
gate reports `queued` or `paused` the plugin holds this call and logs
the signal to its own log — the FIRST line lands as the hold is
detected (seconds after the park, inside the issue's ~5s budget), with
refreshes every _SIGNAL_REFRESH_S naming the reason (the gate's state
word) and the measured hold length in whole seconds, and a fresh line
when the state word changes. Never a fabricated value, never a fake
zero; no hold means no line; the token never appears in a line.

Turn interrupt (issue #46, slice 3 — the optional stronger pause): when
the daemon answers `interrupt: true` (armed by the operator via
`POST /sessions/<token>/interrupt` on the loopback daemon) the plugin
STOPS holding the parked call and raises Hermes' own execution-frame
fence, `_DownstreamExecutionError`, wrapping the runner's stop type
(`InterruptedError`). The middleware frame re-raises the original, the
turn loop's `except InterruptedError` → `handle_api_interrupt` finalizes
the turn cleanly (the same unwind as /stop), and the provider call
NEVER runs. A PLAIN raise would be swallowed by the frame (spike S1/S2)
— only the fence escapes (spike S6/S7). If the fence class cannot be
imported (older Hermes), the plugin degrades to today's release
semantics (admit the call) and says so — never a half-interrupt.

Fail-open, always. Daemon unreachable, no session id, no gate port
configured, or ANY unexpected error => the provider call proceeds
immediately. A crashing gate must never wedge a conversation (Hermes
skips a crashing middleware frame anyway — this plugin simply makes sure
there is no crash path to take).

Loopback contract (served by the idlefill client on its loopback proxy;
an absent/unreachable daemon makes this plugin a no-op by fail-open,
which is the documented posture):

  POST /gate/heartbeat  {"session_id": ..., "token"?}  -> 200 (idempotent)
  GET  /gate/state?session_id=...[&token=...]
        -> {"state": "armed" | "queued" | "paused", "position"?,
            "interrupt"? (true only while an operator interrupt is live)}

Config (per Hermes process, environment; nothing here is a secret and
nothing is written to disk):

  IDLEFILL_GATE_PORT  the idlefill daemon's loopback proxy port.
                      Unset/invalid => the plugin is a no-op.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional

# Loopback only: the daemon binds 127.0.0.1 and nothing else reaches it.
_HOST = "127.0.0.1"
_PORT_ENV = "IDLEFILL_GATE_PORT"

# One bounded timeout for every loopback hop (orca-status posture: the
# gate must add at most sub-second latency on the healthy path).
_TIMEOUT_S = 0.75

# Register/heartbeat throttle: at most one register POST per window per
# session. A turn fires several LLM calls back-to-back; the daemon's
# register is idempotent, so the window only bounds loopback traffic —
# a session's first sight always heartbeats.
_HEARTBEAT_WINDOW_S = 2.0

# Hold-loop poll cadence while the gate reports queued/paused: back off
# from 0.4s to 2s. The daemon-side hold cap (session_hold_cap_ms, then a
# retryable 503 at the router) bounds how long a request may sit parked
# on the WIRE; a middleware hold is a pre-call hold with no such cap, so
# the bound that matters here is daemon liveness — if the daemon dies
# mid-hold the state poll fails and the call is admitted (fail-open).
_POLL_FIRST_S = 0.4
_POLL_MAX_S = 2.0
_POLL_BACKOFF = 1.5

# #46 slice 3: hold-signal refresh cadence. The FIRST signal line lands
# the instant a hold is detected (seconds after the park — inside the
# issue's ~5s visibility budget); a held call re-signals at this interval
# so the reported "Ns" ages. The lines are exception-only (they appear
# only while a hold is on), so this only bounds verbosity.
_SIGNAL_REFRESH_S = 15.0

# The proxy-plane base_url carries the gate key: .../s/<token>[...].
_TOKEN_RE = re.compile(r"/s/([^/]+)(?:/|$)")
# Same posture as the gate's cleanSessionId: printable, <=128, else absent.
_HOSTILE_RE = re.compile(r"[^\x20-\x7e]")

# Per-session heartbeat throttle state (in-memory; a restart starts empty).
_last_heartbeat: Dict[str, float] = {}


# --- seams (stdlib; tests replace these module attributes) -----------------


def _post_json(url: str, payload: dict) -> None:
    """One loopback POST; any failure is an OSError/HTTPError for the caller."""
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_S):
        pass


def _get_json(url: str) -> Optional[dict]:
    """One loopback GET -> parsed JSON object (bounded read), or None."""
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as resp:
        raw = resp.read(16 * 1024)
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _now() -> float:
    return time.monotonic()


def _log(line: str) -> None:
    """One line of the plugin's own log (stderr, fail-quiet).

    The only output this plugin ever writes. The in-session hold
    signal (issue #46) is exception-only: at most one call per hold
    episode, and only after the gate reported queued or paused. A
    log failure must never block the provider call.
    """
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# --- helpers (pure) ---------------------------------------------------------


def _clean_id(value: Any) -> Optional[str]:
    """Bound + sanitize a session id (drop-don't-reject, the token rule)."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or len(s) > 128 or _HOSTILE_RE.search(s):
        return None
    return s


def _port() -> Optional[int]:
    raw = os.environ.get(_PORT_ENV, "").strip()
    if not raw:
        return None
    try:
        port = int(raw)
    except ValueError:
        return None
    return port if 0 < port < 65536 else None


def _token_from_base_url(base_url: Any) -> Optional[str]:
    """The /s/<token> gate key, when this profile's base_url carries one."""
    if not isinstance(base_url, str):
        return None
    m = _TOKEN_RE.search(base_url)
    if not m:
        return None
    return _clean_id(m.group(1))


def _heartbeat(session_id: str, token: Optional[str]) -> None:
    """Register/refresh this session at the local daemon (throttled)."""
    port = _port()
    if port is None:
        return
    now = _now()
    last = _last_heartbeat.get(session_id)
    if last is not None and now - last < _HEARTBEAT_WINDOW_S:
        return
    _last_heartbeat[session_id] = now
    payload: Dict[str, str] = {"session_id": session_id}
    if token:
        payload["token"] = token
    _post_json(f"http://{_HOST}:{port}/gate/heartbeat", payload)


def _gate_state(session_id: str, token: Optional[str]) -> "tuple[Optional[str], bool]":
    """(state, interrupt): state is 'armed' | 'queued' | 'paused' (None =
    daemon unreachable/unknown); interrupt is True ONLY when the body
    carries `interrupt: true` (the #46 slice-3 ADD-key — absent or
    malformed is False, never a guess)."""
    port = _port()
    if port is None:
        return None, False
    query = {"session_id": session_id}
    if token:
        query["token"] = token
    url = f"http://{_HOST}:{port}/gate/state?" + urllib.parse.urlencode(query)
    try:
        body = _get_json(url)
    except Exception:
        return None, False
    if not body:
        return None, False
    state = body.get("state")
    word = state if state in ("armed", "queued", "paused") else None
    return word, body.get("interrupt") is True


def _interrupt_exception() -> Optional[BaseException]:
    """Build the #46 slice-3 interrupt raise: Hermes' OWN execution-frame
    fence, `_DownstreamExecutionError`, wrapping the runner's stop type.
    The middleware frame catches the fence before its skip-and-continue
    branch and re-raises `original`, so the stop type reaches the turn
    loop (`except InterruptedError` -> `handle_api_interrupt`) and the
    provider call never runs — a PLAIN raise from this callback would be
    swallowed (spike S1/S2; only the fence escapes, spike S6). Returns
    None when the fence class cannot be imported (older Hermes): the
    caller then degrades to today's release semantics (admit), never a
    half-interrupt."""
    try:
        from hermes_cli.middleware import _DownstreamExecutionError

        return _DownstreamExecutionError(
            InterruptedError("idlefill gate: operator turn interrupt")
        )
    except Exception:
        return None


# --- the middleware ---------------------------------------------------------


def llm_execution_gate(request: Any, next_call: Callable[..., Any], **context: Any) -> Any:
    """The `llm_execution` callback: gate, then run the provider call once.

    `request` is the middleware payload (used as-is — no rewrite); the
    context carries `session_id` (the real Hermes conversation id) and
    `base_url` (carries the /s/<token> gate key on the proxy plane).
    """
    held_state: Optional[str] = None
    held_at: Optional[float] = None
    interrupt_requested = False
    try:
        session_id = _clean_id(context.get("session_id"))
        if session_id is not None:
            token = _token_from_base_url(context.get("base_url"))
            try:
                _heartbeat(session_id, token)
            except Exception:
                pass  # best-effort: the state poll below decides admission
            delay = _POLL_FIRST_S
            state, interrupt = _gate_state(session_id, token)
            last_signal_at: Optional[float] = None
            while state in ("queued", "paused"):
                if held_state is None:
                    held_state = state  # the reason: the gate's state word
                    held_at = _now()
                if state != held_state:
                    # The reason flipped while parked (queue congestion ->
                    # operator pause or back): surface the NEW word at once.
                    held_state = state
                    last_signal_at = None
                if held_at is not None and (
                    last_signal_at is None or _now() - last_signal_at >= _SIGNAL_REFRESH_S
                ):
                    # The LIVE hold signal (#46 slice 3): the first line
                    # lands the moment the hold is detected — seconds into
                    # the park, inside the issue's ~5s visibility budget —
                    # and a held call re-signals every _SIGNAL_REFRESH_S so
                    # "Ns" ages. Reason = the gate's state word; length =
                    # the plugin's own measured episode (whole seconds,
                    # never a fabricated value). The token never appears.
                    _log(f"held by idlefill gate ({held_state}, {max(0, int(_now() - held_at))}s)")
                    last_signal_at = _now()
                if interrupt:
                    interrupt_requested = True
                    break
                _sleep(delay)
                delay = min(delay * _POLL_BACKOFF, _POLL_MAX_S)
                state, interrupt = _gate_state(session_id, token)
            # armed / unreachable / unknown state => admit (fail-open).
    except Exception:
        pass  # fail-open: a gate failure must never wedge a conversation
    if interrupt_requested and held_state is not None and held_at is not None:
        # #46 slice 3: the operator stopped this parked turn. Raise OUTSIDE
        # the fail-open wrapper (the plugin's own `except Exception` would
        # otherwise swallow it — spike S4) and as the frame's own fence
        # (a plain raise is swallowed — spike S1/S2): the frame re-raises
        # the wrapped InterruptedError, the turn loop finalizes the turn
        # cleanly (handle_api_interrupt), and the provider call never runs.
        exc = _interrupt_exception()
        held_s = max(0, int(_now() - held_at))
        if exc is not None:
            _log(f"held by idlefill gate ({held_state}, {held_s}s) -> interrupt requested: parked turn stopped")
            raise exc
        # No fence (older Hermes): degrade to the shipped release
        # semantics — the parked call proceeds, honestly logged, never a
        # half-interrupt.
        _log(
            f"held by idlefill gate ({held_state}, {held_s}s) -> "
            "interrupt requested but this Hermes has no interrupt path: call proceeds"
        )
    return next_call()


def register(ctx: Any) -> None:
    """Plugin entry point: register the llm_execution middleware."""
    ctx.register_middleware("llm_execution", llm_execution_gate)

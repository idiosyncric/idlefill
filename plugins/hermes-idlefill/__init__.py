"""
Hermes <-> idlefill session gate (issue #42, slice 1).

An `llm_execution` middleware wrapping every provider call in a Hermes
session. Per call:

  1. register/heartbeat THIS session at the local idlefill daemon with the
     real Hermes session id (loopback only, best-effort, throttled);
  2. block (the turn looks "thinking" — the seam has no timeout; /stop is
     the escape) while the gate reports the session `queued` or `paused`;
  3. run the provider call (`next_call`) exactly once.

Fail-open, always. Daemon unreachable, no session id, no gate port
configured, or ANY unexpected error => the provider call proceeds
immediately. A crashing gate must never wedge a conversation (Hermes
skips a crashing middleware frame anyway — this plugin simply makes sure
there is no crash path to take).

Loopback contract (served by the idlefill client on its loopback proxy;
the daemon-side routes land in slice 2 — until then this plugin is a
no-op by fail-open, which is the documented posture):

  POST /gate/heartbeat  {"session_id": ..., "token"?}  -> 200 (idempotent)
  GET  /gate/state?session_id=...[&token=...]
        -> {"state": "armed" | "queued" | "paused", "position"?}

Config (per Hermes process, environment; nothing here is a secret and
nothing is written to disk):

  IDLEFILL_GATE_PORT  the idlefill daemon's loopback proxy port.
                      Unset/invalid => the plugin is a no-op.
"""
from __future__ import annotations

import json
import os
import re
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


def _gate_state(session_id: str, token: Optional[str]) -> Optional[str]:
    """'armed' | 'queued' | 'paused'; None = daemon unreachable/unknown."""
    port = _port()
    if port is None:
        return None
    query = {"session_id": session_id}
    if token:
        query["token"] = token
    url = f"http://{_HOST}:{port}/gate/state?" + urllib.parse.urlencode(query)
    try:
        body = _get_json(url)
    except Exception:
        return None
    if not body:
        return None
    state = body.get("state")
    return state if state in ("armed", "queued", "paused") else None


# --- the middleware ---------------------------------------------------------


def llm_execution_gate(request: Any, next_call: Callable[..., Any], **context: Any) -> Any:
    """The `llm_execution` callback: gate, then run the provider call once.

    `request` is the middleware payload (used as-is — no rewrite); the
    context carries `session_id` (the real Hermes conversation id) and
    `base_url` (carries the /s/<token> gate key on the proxy plane).
    """
    try:
        session_id = _clean_id(context.get("session_id"))
        if session_id is not None:
            token = _token_from_base_url(context.get("base_url"))
            try:
                _heartbeat(session_id, token)
            except Exception:
                pass  # best-effort: the state poll below decides admission
            delay = _POLL_FIRST_S
            state = _gate_state(session_id, token)
            while state in ("queued", "paused"):
                _sleep(delay)
                delay = min(delay * _POLL_BACKOFF, _POLL_MAX_S)
                state = _gate_state(session_id, token)
            # armed / unreachable / unknown state => admit (fail-open).
    except Exception:
        pass  # fail-open: a gate failure must never wedge a conversation
    return next_call()


def register(ctx: Any) -> None:
    """Plugin entry point: register the llm_execution middleware."""
    ctx.register_middleware("llm_execution", llm_execution_gate)

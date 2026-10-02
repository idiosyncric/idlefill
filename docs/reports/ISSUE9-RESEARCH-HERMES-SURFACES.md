# Hermes surfaces for a "session gate" (idlefill issue #9: pause/queue/resume agent sessions vs local LLM capacity)

Package root: `/Users/sam/.hermes/hermes-agent/` — all paths below are relative to it.
Every claim is marked confidence: **high** = read directly in code this pass; **medium** = strong inference from surrounding code; **low** = not confirmed, probe suggested.
Live system state (state.db, gateway verbs) probed read-only on this machine, 2026-09-30.

## Already verified (previous pass, carried forward)

- **Hooks are observer-only.** `gateway/hooks.py` (event-hook system; hooks live in `~/.hermes/hooks/<name>/` with `HOOK.yaml` + `handler.py`; events incl. `gateway:startup`, `session:start/end/reset`, `agent:start/step/end`, `command:*`; "errors never block the pipeline"). `agent/api_request_hooks.py` (API-request lifecycle payloads, redaction, `api_request_error`). `hermes_cli/lifecycle.py` (`_observe`/`invoke_hook`/`ainvoke_hook`/`has_hook` — observer dispatch). **high**
- **Middleware is the deferrable surface.** `hermes_cli/middleware.py` — "Observer hooks report what happened. Middleware can change what happens by rewriting a request or wrapping the actual execution callback." `run_llm_execution_middleware(request, next_call, **context)` at `middleware.py:135`; call site `agent/turn_api_call.py:133`; compat `run_api_execution_middleware` at `middleware.py:233-239`. Plugin registration `hermes_cli/plugins.py:934` `register_middleware(kind, callback)`; `invoke_middleware` at `plugins.py:1863-1869`; `VALID_HOOKS` starts at `plugins.py:108`. **high**
- **Per-attempt assembly.** `agent/turn_api_request.py` (re-applies reasoning echo pad / prompt-cache decoration, builds `api_kwargs`, runs LLM request middleware + `pre_api_request` hooks; fallback provider may differ from primary). **high**
- **Provider routing.** `base_url` is per-profile `config.yaml`. `hermes_cli/main_tui_launch.py:400` exports `HERMES_MODEL` + `HERMES_INFERENCE_MODEL`. Session-scoped `/model` flags in `hermes_cli/model_switch.py:477-482,520` (`--provider`, `--reasoning`, `--global`, `--session`, `--once`). `OPENAI_BASE_URL` read at `agent/auxiliary_client.py:4525` for the **auxiliary** client only (main-agent path covered in Q3 below). **high**
- **Session identity.** `~/.hermes/state.db` (SQLite): tables incl. `sessions`, `messages`, `session_model_usage`, `gateway_routing`, `gateway_heartbeats`, `session_turn_leases`, `async_delegations`, `conversation_generations`, `system_prompts`. `~/.hermes/sessions/sessions.json` is a LEGACY MIRROR of the gateway routing index (primary = `gateway_routing` table). `served_profiles`: default + 10 named profiles. **high**
- **Gateway control socket.** `gateway/control_socket.py` — `CONTROL_PROTOCOL_VERSION=1` (L28), socket `~/.hermes/gateway.sock` (+ `gateway.sock.path` pointer; per-`HERMES_HOME` naming via `_home_hash` L39-43), 64KB request / 512KB response (L34-35), client `query_gateway_control(home, verb, params, timeout)` (L273). `reload-plugins` verb handler at `gateway/run_plugin_rewire.py:82`. **high**

---

## Q1. Middleware kinds + deferral semantics

### 1.1 The complete set of middleware kinds — **high**

`hermes_cli/middleware.py:19-26`:

```python
TOOL_REQUEST_MIDDLEWARE  = "tool_request"
TOOL_EXECUTION_MIDDLEWARE = "tool_execution"
LLM_REQUEST_MIDDLEWARE   = "llm_request"
LLM_EXECUTION_MIDDLEWARE = "llm_execution"
VALID_MIDDLEWARE = {TOOL_REQUEST_MIDDLEWARE, TOOL_EXECUTION_MIDDLEWARE,
                    LLM_REQUEST_MIDDLEWARE, LLM_EXECUTION_MIDDLEWARE}
```

That is the **entire set** — 4 kinds. Compat aliases (plugin-compat block, `middleware.py:222-224`): `API_EXECUTION_MIDDLEWARE = LLM_EXECUTION_MIDDLEWARE`, `API_REQUEST_MIDDLEWARE = LLM_REQUEST_MIDDLEWARE`, plus `apply_api_request_middleware` / `run_api_execution_middleware` wrappers (L226-239) that forward to the LLM variants. `register_middleware` (`plugins.py:934-939`) validates against `VALID_MIDDLEWARE` via `_track_callback` (`plugins.py:941-952`) — unknown kinds **warn but are still stored** (L946-949), so a fifth kind string would dispatch, but only the 4 above have call sites.

Call sites:
- `llm_request`: `agent/turn_api_request.py:140-154` — per attempt, **before** the `pre_api_request` hook; payload-rewriting only (returns `{"request": {...}}`, `middleware.py:88-99`). Exception anywhere in the request-middleware pass is caught and the **original** payload is used (`turn_api_request.py:152-154`).
- `llm_execution`: `agent/turn_api_call.py:133-139` — wraps the actual provider call (see 1.2).
- `tool_request`: `agent/` tool path via `apply_tool_request_middleware` (`middleware.py:102-132`) — rewrites tool args; also applies nemo-relay intercepts (L113-120).
- `tool_execution`: `run_tool_execution_middleware` (`middleware.py:143-149`).

### 1.2 Can a middleware callback BLOCK/DEFER before calling `next_call`? **YES — unbounded.** **high**

`_run_execution_chain` (`middleware.py:161-214`) is the whole execution-middleware engine:

- The callback is invoked **synchronously, inline, on the caller's thread** (the agent turn thread): `return callback(**call_kwargs)` (`middleware.py:201`). Nothing wraps it in a timeout worker.
- The hook-timeout machinery does **not** apply to middleware. `_HOOK_TIMEOUT_BOUNDED_HOOKS` (`hermes_cli/plugins_dispatch.py:42-46`) lists only observer hooks (`post_tool_call`, `transform_*`, `pre_llm_call`, `pre_api_request`, `api_request_error`, `on_session_start/end`, …); `_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS = {"pre_tool_call"}` (L49). Middleware kinds appear in neither set, and `invoke_middleware` (`plugins_dispatch.py:591-602`) is a plain synchronous loop with no timeout wrapper. The 30s `plugins.hook_callback_timeout` (default; `plugins.py:1153-1175`, resolved in `_resolve_hook_callback_timeout`) bounds only the sets above.
- Therefore a `llm_execution` callback may wait **arbitrarily long** before (or instead of) calling `next_call`. While it waits, the turn is parked inside `perform_api_call` (`turn_api_call.py:133`); from the outside the session looks like "thinking". No built-in deadline, no watchdog on the middleware frame.
- Escape hatch: `/stop` (or `/new` running-agent fast path) interrupts the turn — `handle_api_interrupt` (`turn_api_call.py:171-212`) handles `InterruptedError` during the provider call; the turn also fires the `agent_loop_stopped` observer hook (`plugins.py:139-142`, fired from `gateway/run_agent_cache.py:482+` `_interrupt_and_clear_session`). **medium** that an interrupt raised while parked inside a *plugin* callback (not inside the provider call itself) propagates as cleanly — the interrupt mechanism is aimed at the API call / turn loop; probe by holding a session in a gate and issuing `/stop`.

**Error/timeout semantics** (`middleware.py`):
- `next_call` is **single-use per frame**: a second call raises `RuntimeError("... called next_call() more than once; downstream execution is single-use")` (`middleware.py:179-188`). The documented retry pattern is to let the *outer* retry loop re-invoke the whole chain (new request build, `turn_api_request.py`).
- `_DownstreamExecutionError` (L152-159) wraps exceptions from below the middleware frame so the frame's own failure handling can't swallow them.
- If a callback raises and `next_call` **has not** been called → the frame is **skipped** (fail-open, `middleware.py:212` `return call_at(index + 1, payload)`) with a warn-once report via `manager._report_hook_failure` (L207). So a crashing gate **does not block** the request — it fails open.
- If it raises after `next_call` succeeded → the downstream result is returned (L208-209); if after `next_call` failed → the downstream exception re-raises (L210-211).
- No callbacks registered for the kind → `terminal_call` runs directly (L167-168).
- No timeout → a *hung* (not crashing) gate holds the turn forever; the only recovery paths are `/stop` and process restart. **high**

### 1.3 Payload the LLM-execution callback receives — **high**

`run_llm_execution_middleware(request, next_call, **context)` (`middleware.py:135-140`); `middleware_payload(**kwargs)` adds `telemetry_schema_version`/`middleware_schema_version` (L44-47), then `call_kwargs[payload_key] = payload; call_kwargs["next_call"] = next_call` (L197-199).

The call site (`turn_api_call.py:133-138`) passes context kwargs:
`task_id, turn_id, api_request_id, session_id, platform, model, provider, base_url, api_mode, api_call_count, middleware_trace` — plus `original_request`.

So the callback **sees, per outgoing provider call:**
- `session_id`, `platform`, `model`, `provider`, `base_url`, `api_mode` — explicitly as kwargs (and redundantly inside `request` for `model`/`base_url`, see below). **This is everything a per-session gate needs to identify and hold the call.**
- `request` dict = the `api_kwargs` built by `_build_api_kwargs` (`agent/chat_completion_helpers.py:1555-1572` → `_build_chat_completions_kwargs` L1470+; common keys L1500-1508: `model`, `messages`, `tools`, `base_url`, `timeout`, `max_tokens`, `ephemeral_max_output_tokens`, `reasoning_config`, `request_overrides`, `session_id`, `cache_scope_id`, `provider_preferences`, …; anthropic/bedrock/codex variants build their own shapes).
- `next_call(next_payload=None)` — call with a modified payload to rewrite the outgoing request (deep-copied; `_safe_copy`, `middleware.py:50-60`), or as-is.
- **`api_key` is NOT in the payload.** Credentials live on the agent (`agent.api_key`/`agent.base_url`, mirrored into the shared client kwargs — `agent/client_lifecycle.py:563-567` `_sync_client_kwargs_credentials`) and are consumed by the transport, not passed in `api_kwargs`. For a gate that only needs to *hold or redirect* traffic, `session_id` + `base_url` + `model` suffice. **high**

**Conclusion for the gate:** a `llm_execution` middleware callback is a per-request, per-session chokepoint that can inspect `session_id`/`base_url`/`model`, block indefinitely before `next_call`, rewrite the request payload (e.g. retarget `base_url`/`model` in `request`), and must survive being crash-skipped (fail-open) — a gate that silently fails open will *not* protect the local LLM.

---

## Q2. Control socket verb set

### 2.1 Complete verb map — **high** (only one registration site)

The only `GatewayControlServer(...)` construction in the tree (grep-verified) is `gateway/run.py:5670-5679`. Built-ins are merged in at `control_socket.py:137-138`:

| Verb | Handler | Effect |
|---|---|---|
| `identify` | `build_identify_payload` (`control_socket.py:98-112`) | Liveness/identity: protocol, kind, pid, start_time, hermes_home, profile, supervisor, code identity, `served_profiles` |
| `status` | `build_status_payload` (`control_socket.py:115-119`) | Live runtime status + `answered_at`, `answering_pid` |
| `pause-for-update` | `gateway/run.py:5633-5653` | Gateway-wide drain+exit (see 2.2) |
| `rescan-profiles` | `gateway/run.py:5655-5668` | Reconcile `profiles/` now; `{"multiplex", "served_profiles", ...}` or `pending` after 5s |
| `serve-profile` | `run_profile_reconcile.serve_profile_verb` (imported `run.py:5622`) | Hot-serve a profile; `params={"name": ...}` |
| `unserve-profile` | `run_profile_reconcile.unserve_profile_verb` | Unroute a profile; `params={"name": ...}` |
| `migrate-profile-identity` | `run_profile_reconcile.migrate_profile_identity_verb` | Rekey `agent:<old>:` → `agent:<new>:` routing (in-memory + durable) |
| `purge-profile-identity` | `run_profile_reconcile.purge_profile_identity_verb` | Drop a deleted profile's routing identity (in-memory index **and** durable rows) |
| `reload-plugins` | `gateway/run_plugin_rewire.py:82` (`reload_plugins_verb`) | Force plugin re-discovery for a profile home; re-wires live adapters now (tools/prompt wait for next session) |

**9 verbs total. None of them touch individual session state.** **high**

Probing tip: an unknown verb returns `ok:false` **with `"supported_verbs": sorted(self._handlers)`** (`control_socket.py:210-212`) — so the live verb list of any running gateway is discoverable via `query_gateway_control(home, "bogus")`. **high**

### 2.2 `pause-for-update` exact semantics — **high**

`run.py:5633-5653`: handler runs on the socket executor thread, marshals `runner.request_restart(detached=False, via_service=True)` onto the main loop, waits up to 5s for acceptance. Returns:

```python
{"pausing": accepted, "already_stopping": not accepted, "pid": os.getpid(),
 "drain_timeout": _drain}   # _drain = _get_restart_drain_timeout(), fallback 30.0
```

- `pausing: true` → accepted; the gateway **drains in-flight turns then exits** (same drain path as SIGUSR1/service restart, per the comment block `run.py:5625-5630`) so the updater can swap code and relaunch.
- `already_stopping: true` → a restart/drain was already in progress; nothing new started.
- This is **gateway-wide, not per-session** — it stops *all* sessions of the serving profile(s). Client helper: `pause_gateway_for_update` (`control_socket.py:345-352`), returns `None` when no gateway answers (caller falls back to legacy signal/tree-kill).

### 2.3 What actually stops a single session — **high/medium**

There is **no per-session pause/resume verb on the control socket** (consistent with the earlier pass: the only "pause/resume" hits in `run.py` are the session-resume-pending logic at L906, L956-958 — unrelated to this). Per-session stop mechanisms that do exist:
- `/stop` slash command → `_interrupt_and_clear_session` (`gateway/run_agent_cache.py:482+`): interrupts the running turn, interrupts detached async delegations for the session, fires `agent_loop_stopped` hook, discards parked user follow-ups. This is **interrupt, not pause** — the turn's partial state is finalized; there is no "resume from here" for a `/stop`ed turn (the `resume_pending` flag, `session.py:515-524`, is for restart/drain-timeout recovery, not user-requested pause).
- API server: `POST /api/sessions/{session_id}/stop` (`gateway/platforms/api_server.py:353`), plus `POST /api/sessions/{session_id}/model` (`session_model_lock`, `api_server.py:98/1741`) for the per-session model override (Q3).
- The `agent_loop_stopped` hook (`plugins.py:139-142`) is the observer signal a gate plugin can use to learn a session's run was interrupted mid-run.

**Conclusion:** the control socket offers process-level coordination (identify/status, profile serve/unserve, plugin reload, gateway-wide pause-for-update). Per-session pause/queue/resume must be built from (a) `llm_execution` middleware deferral (Q1) and/or (b) the API-server session endpoints — not from new verbs on the existing socket (adding a verb would require a gateway code change; the socket is not user-extensible). **high**

---

## Q3. Per-session base_url — **YES, a mechanism exists**

### 3.1 The per-session `/model` override carries `base_url` — **high**

- `PERSISTABLE_MODEL_OVERRIDE_KEYS = ("model", "provider", "base_url")` (`gateway/session.py:466`); comment: "`api_key`/`api_mode` must NEVER reach sessions.json". `sanitize_model_override` (`session.py:469-477`) copies only those three non-secret keys.
- Stored on `SessionEntry.model_override` (`session.py:529-531`), persisted into the routing index (`set_model_override` at `session.py:1089-1105` → `gateway_routing.entry_json` + legacy `sessions/sessions.json` mirror); `get_model_override` at `session.py:1107-1111`.
- Written by `/model` (`gateway/slash_commands_model.py:260,278`), cleared on `/new`/login paths (`slash_commands_session.py:907`, `slash_commands_login.py:195`).
- Rehydrated after a gateway restart: `_rehydrate_session_model_override` (`gateway/run_agent_cache.py:146-189`) restores model/provider/base_url, **re-resolves credentials fresh** (`api_key` never persisted; L167-174), drops stale foreign endpoints, and heals opencode/llama.cpp URL quirks.

### 3.2 Where it's applied per turn — **high**

`_resolve_session_agent_runtime` (`gateway/run_turn.py:172-301`), documented priority: **session `/model` override → `channel_overrides` → global config/env**. The override's `base_url` flows through the fast path (`run_turn.py:196-211`: `override_runtime` picks up `provider, requested_provider, api_key, base_url, api_mode, max_tokens, credential_pool, request_overrides, capabilities`) and via `_apply_session_model_override` (`run_agent_cache.py:196-220`, applying `_OVERRIDE_APPLY_KEYS` onto `runtime_kwargs`, which become `AIAgent(**runtime_kwargs)` — i.e. the agent's `agent.base_url`/`agent.api_key` attributes, `agent/client_lifecycle.py:566`).

**Net effect: one session's main-agent LLM traffic can be pointed at a different base_url/model than the profile default, per-turn, durable across restarts, and settable without the user** (via the API server's `session_model_lock` endpoint or a gateway-side `/model`). Caveats:
- It applies **at turn-resolution time** (agent construction), not mid-request; an in-flight turn keeps its current client. **high**
- It is settable from outside only via the API server (`POST /api/sessions/{session_id}/model`, `api_server.py:98/1741/2146-2175` — `session_model_override`/`session_model_lock` route sources) or by injecting a `/model` command; it is **not** exposed on the control socket (Q2). **high**
- `channel_overrides` (config.yaml) is a coarser, config-file-based tier applied *after* the session override's absence (`run_turn.py:254-270`). **high**

### 3.3 Env-var overrides in the MAIN agent path — **medium**

`OPENAI_BASE_URL` in the main path: `hermes_cli/models.py:1286-1288` (endpoint-inference precedence: `$OPENAI_BASE_URL` → config `model.base_url` → canonical) and `hermes_cli/runtime_provider_backends.py:160-164` (host-gated credential binding: the env var's *host* may gate which key resolves, "OPENAI_BASE_URL never picks the endpoint (config.yaml is the single source of truth for endpoint", L121). Reads go through the **per-profile secret scope** (`get_secret_str`, e.g. `model_switch.py:1546-1571`) — under a multiplexed gateway that scope is per-profile, and the agent's `base_url` is stamped from resolved runtime kwargs at client construction (`client_lifecycle.py:566,641,768,774,808,981-983`). So env vars are **process/profile-scoped, not session-scoped** — a session gate cannot re-route a single session by setting env in its own process; it must use the `/model` override (3.1) or middleware payload rewrite (Q1.3: `llm_request`/`llm_execution` can replace `request["base_url"]`/`request["model"]` — **medium**: the transport's `build_kwargs` consumes `params.get("base_url")` (e.g. `transports/chat_completions.py:466-520`), so rewriting the request's `base_url` before `next_call` plausibly redirects the wire target; a live probe with `HERMES_DUMP_REQUESTS=1` + a rewrite middleware would confirm end-to-end).

**Conclusion:** per-session base_url = **YES** via the session `/model` override (`model`/`provider`/`base_url`, persisted, restart-safe, applied per turn), settable programmatically via the API server session endpoint; plus per-request retargeting is available to middleware via payload rewrite. **high**

---

## Q4. Session enumeration (state.db)

Schemas read live from `~/.hermes/state.db` (read-only; profile DBs at `~/.hermes/profiles/<name>/state.db` have the same schema). **high**

### 4.1 `sessions` — conversation ledger

PK `id` (e.g. `20260930_135001_891414`). Notable columns: `source` (e.g. `tui`), `user_id`, `session_key` (**nullable** — null for TUI/subagent rows), `chat_id`/`chat_type`/`thread_id`, `display_name`, `origin_json`, `model` (e.g. `Qwen3.8-27B`), `model_config` (JSON: `max_iterations`, `reasoning_config`, `_delegate_from`, `_usage_anchor`, …), `system_prompt`(+`_hash`), `parent_session_id`, `started_at`/`ended_at`/`end_reason`, `message_count`, `tool_call_count`, token counters, `cwd`/`git_*`, `billing_provider`/`billing_base_url`/`billing_mode`, cost fields, `last_activity_at`(+description/provenance), `api_call_count`, `profile_name`, `archived`/`pinned`/`hidden`, `transport_profile`, `created_source`. 381 rows in the default profile DB.
→ This is the **transcript-level** record: what a session was, which model/billing endpoint it used, activity time. Not a liveness signal by itself.

### 4.2 `gateway_routing` — the routing index (primary source of truth)

PK `(scope, session_key)`; columns `entry_json` (full `SessionEntry` JSON), `updated_at`. `scope` = the home's sessions dir (live sample: `'/Users/sam/.hermes/sessions'`). The entry JSON carries the live session identity and state — verified keys in live rows: `session_key`, `session_id` (points at `sessions.id`), `created_at`/`updated_at`, `platform`, `chat_type`, `display_name`, `origin`, token counters, `suspended`, `resume_pending`(+`resume_reason`/`last_resume_marked_at`), `was_auto_reset`/`auto_reset_reason`, `prev_session_id`, `is_fresh_reset`, `metadata`, `active_turn_token`, `active_turn_started_at`, `model_override` (when a `/model` override is set; 0 live rows with one at probe time), `transport_profile`.
`SessionEntry` definition: `gateway/session.py:481-535`; `active_turn_token` is the "durable marker of the executing turn; CAS-cleared on normal unwind, left behind by SIGKILL/OOM so unclean startup recovers the exact session" (`session.py:525-528`).
Persistence API: `hermes_state_gateway.py:288-317` (`save_gateway_routing_entry` / `replace_gateway_routing_entries` / `load_gateway_routing_entries`).
→ **`gateway_routing` is the source of truth for "which sessions exist for this gateway, on which platform/chat, current session_id, suspended/resume flags, and whether a turn is executing right now"** (`active_turn_token` non-null = turn in flight).

### 4.3 `gateway_heartbeats` — live backend processes

Columns: `backend_id` **PK** (format `<profile>@<host>:<pid>:<hash8>`, e.g. `default@M1.local:28698:27f9d24b`), `pid`, `started_at`, `last_heartbeat` (epoch seconds), `profile`, `host`. 99 rows live. Insert at `hermes_state_gateway.py:820`; consumed by maintenance: a session row is reaped only "when no live backend (heartbeat within grace)" owns it (`hermes_state_maintenance.py:152,176-177`).
→ Source of truth for **which gateway/serve processes are alive** (per-profile, per-host). Not per-session.

### 4.4 Supporting tables

- `session_model_usage`: PK `(session_id, model, billing_provider, billing_base_url, billing_mode, task)` + counters + `first_seen`/`last_seen` → per-session, per-model usage/cost (useful for capacity accounting of what a session consumed).
- `session_turn_leases`: PK `conversation_id`, `holder`, `acquired_at`, `expires_at` → per-conversation turn mutual-exclusion leases (used by state compression; `hermes_state_messages.py:47,249-257`).
- `conversation_generations`: PK `(source, session_key)` → `generation` counter per lane (session-reset fencing).
- `sessions.profile_name` + `gateway_heartbeats.profile` are the profile-identity columns (`hermes_cli/profile_identity.py:6`).

### 4.5 Answer: which table is the source of truth for "currently live/active sessions"

- **Live processes:** `gateway_heartbeats` (heartbeat recency). **high**
- **Live sessions + in-flight turns:** `gateway_routing` — `entry_json.updated_at` (last activity), `entry_json.active_turn_token` (turn executing now), `suspended`/`resume_pending` (needs-attention state). This is the authoritative in-memory→durable routing index; `~/.hermes/sessions/sessions.json` is only its legacy mirror. **high**
- **Transcript/billing identity:** `sessions` (joined via `entry_json.session_id`). **high**

Practical enumeration query for a gate (read-only):
`SELECT session_key, entry_json->>'session_id', entry_json->>'updated_at', entry_json->>'active_turn_token', entry_json->>'model_override' FROM gateway_routing WHERE scope = ?` — then join `sessions` for `model`/`billing_base_url`/`last_activity_at`, and check `gateway_heartbeats` for the owning process.

---

## Bottom line for idlefill #9

1. **Deferral:** `llm_execution` middleware is the only supported in-process gate that can hold a specific session's provider call indefinitely (no timeout, single-use `next_call`, fail-open on crash, `/stop` as the escape). It sees `session_id`/`model`/`provider`/`base_url` per call — enough to admit/queue per session. (Q1)
2. **Control plane:** the gateway control socket has 9 verbs, all process/profile-level; `pause-for-update` is a gateway-wide drain+exit, not per-session. Per-session stop exists only via `/stop` (interrupt) and API-server session endpoints — a true pause/queue/resume is new surface, best placed in middleware + the API server. (Q2)
3. **Rerouting:** per-session `base_url` routing already exists as the session `/model` override (`model`/`provider`/`base_url`, durable, applied per turn, settable via `POST /api/sessions/{id}/model`); middleware can additionally retarget per-request via payload rewrite. Env-var knobs are profile-scoped only. (Q3)
4. **Enumeration:** `gateway_routing` (live sessions + `active_turn_token`) + `gateway_heartbeats` (live backend processes) + `sessions` (model/billing/activity ledger) in `~/.hermes/state.db` per profile. (Q4)

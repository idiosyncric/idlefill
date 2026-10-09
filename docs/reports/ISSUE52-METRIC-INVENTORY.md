# Issue #52 — per-engine metric inventory (probe record)

Probed 2026-10-09 at 05:55 UTC from the web-dev Mac. That is the machine that
runs the arbiter on :8787 (the fused instance). Every claim below carries the
probe and the actual response. Responses are verbatim and truncated where
noted. The full captures sit at the end of this file.

Companion: `docs/architecture/metrics-sidecar.md` (the design this inventory
feeds). Map: #51 (the store), #50 (mesh, co-location), #62 (kind adapters).

Status (2026-10-09, slice 1): the CAPTURE half of the design shipped on
branch `issue-52-capture` — the llama-swap feed `tokens` block +
`duration_ms` kept (ADD), the llama-swap `/metrics` and oMLX `/health`
fetches with the D5 ADD keys, `metrics_load_stale_s` (default 45, age
labelling only). The idle verdict is UNCHANGED (D4 stays off — the owner
has not set the llama-swap busy threshold). What is still PROPOSED: the
busy veto, strata `in_flight`, the dashboard load read, `queue_depth`
values. See `ISSUE52-CAPTURE-REPORT.md` (what shipped vs still
PROPOSED, the verdict byte-identity proof, the test evidence).

## The want list

The idle verdict is per engine. Today it fuses an activity feed with a log
mtime (`server/src/idle.ts`). That is inference, not measurement. The issue
asks for measurement, per engine:

1. Queue depth
2. In-flight requests
3. Tokens per second
4. KV-cache pressure
5. Model and quant identity

## Engine 1 — oMLX (`127.0.0.1:8000`)

Row (live `GET /api/state`): provider `omlx`, `activity_path` empty
(feed off, declared), `log_glob`
`/Users/sam/Library/Application Support/oMLX/logs/server.log`,
`watched` true, `auth_set` true.

### Probes

```
GET /v1/models -> 401
{"error":{"message":"API key required","type":"authentication_error","param":null,"code":null}}

GET /health -> 200
{"status":"healthy","default_model":"LFM2.5-2.6B-MLX-8bit","engine_pool":{"model_count":13,"loaded_count":0,"final_ceiling":38332312276,"current_model_memory":0},"mcp":null}

GET /metrics -> 404 (22 bytes)
GET /api/metrics/activity -> 404 (22 bytes)
GET /api/stats -> 404 (22 bytes)
GET /metrics/health -> 404 (22 bytes)
GET /api/health -> 404 (22 bytes)
```

A local store (read by the #62 sampler, `server/src/omlx.ts`):
`~/.omlx/usage.sqlite3`, table `model_usage_hourly` (requests,
`prompt_tokens`, `completion_tokens`, per hour and model). The sampler sums
the table and diffs between polls. The granularity is hourly.

### What it exposes today

- `/health`: engine status, the default model name, and the pool state:
  13 models known, 0 loaded at probe time, a memory ceiling of
  38332312276 bytes, 0 bytes resident.
- No HTTP activity feed. No HTTP metrics endpoint. The same 404s are
  recorded in code (`server/src/idle.ts` declares omlx feed-off after
  verifying `/metrics` and `/api/stats` 404).
- An hourly usage counter on disk (the store above).

### What it does not expose

- Queue depth: nothing.
- In-flight requests: nothing. `loaded_count` counts models resident in
  memory. It does not count requests running.
- Tokens per second: nothing live. The hourly store delta is coarse. A
  15-second poll sees nothing until an hour closes.
- KV-cache pressure: nothing. `current_model_memory` against
  `final_ceiling` is model memory. It is not the KV pool.
- The loaded model name: nothing. `default_model` is a configuration
  default. At probe time `loaded_count` was 0, so the payload carries no
  loaded model either. When a model is loaded, the payload still names
  none.

### The verdict today

Log mtime only (feed off, declared). The mtime says "a log line was written
recently." It does not say "a request is running." That is the gap the
sidecar fills for this kind.

## Engine 2 — llama-swap (`100.105.225.1:11434`, on urza)

Row (live `GET /api/state`): provider `llama-swap`,
`activity_path` `/api/metrics/activity`, `watched` true, `auth_set`
false, no `log_glob`.

### Probes

```
GET /v1/models -> 200 (1598 bytes)
{"data":[{"id":"Qwen3.8-27B","object":"model","created":1791525328,"owned_by":"llama-swap","name":"Qwen3.8-27B","description":"Qwen3.8 27B NVFP4 NINFER, MTP=3,FP8 KV, 240K context, vision","architecture":{"input_modalities":["text","image"],"modality":"text+image->text","output_modalities":["text"]},"capabilities":{"function_calling":true,"vision":true},"supported_parameters":["tools","tool_choice"],"context_length":240000,"context_window":240000,"meta":{"llamaswap":{"aliases":["qwen3.8-27b-dflash2","qwen38-df","Qwen3.8-27B-NInfer","Qwen3.8-27B-NInfer-DFlash2"],"reasoning_efforts":["none","low","medium","xhigh"],"type":"model"},"n_ctx":240000},"status":{"value":"loaded"}},{"id":"dgx-spark-tyler/qwen3.8-flash-next","object":"model","created":1791525328,"owned_by":"llama-swap","name":"dgx-spark-tyler: qwen3.8-flash-next","meta":{"llamaswap":{"peerID":"dgx-spark-tyler","type":"peer"}},"status":{"value":"unloaded"}},{"id":"mac-m4-mtplx/mtplx-qwen38-27b-optimized-speed","object":"model","created":1791525328,"owned_by":"llama-swap","name":"mac-m4-mtplx: mtplx-qwen38-27b-optimized-speed","meta":{"llamaswap":{"peerID":"mac-m4-mtplx","type":"peer"}},"status":{"value":"unloaded"}},{"id":"qwen38-27b","object":"model","created":1791525328,"owned_by":"llama-swap","name":"Qwen3.8 27B","description":"Routes to whichever Qwen3.8-27B NInfer variant is currently loaded; never swaps a running model (cold-starts the primary MTP entry if nothing is loaded)","meta":{"llamaswap":{"strategy":"warm","targets":["Qwen3.8-27B"],"type":"selector"}},"status":{"value":"loaded"}}],"object":"list"}
```

`GET /metrics -> 200 (4538 bytes)`, Prometheus text (full capture at the
end). The gauges found: per-core CPU for 24 cores (core 20 at 100 at probe
time), memory total/used/free, swap, load average (1m 1.98), network
bytes, and GPU on an RTX 5090: `gpu_util_percent 91`,
`gpu_memory_util_percent 95.51` (32.6 of 34.2 GB used), 70 C, 448.69 W
draw, fan 51.

```
GET /api/metrics/activity -> 200 (11463 bytes)
{"data":[{"id":69577,"timestamp":"2026-10-09T05:55:25Z","src":"ip:100.94.165.102","model":"Qwen3.8-27B","req_path":"/v1/chat/completions","resp_content_type":"text/event-stream","resp_status_code":200,"tokens":{"cache_tokens":0,"draft_tokens":4464,"draft_acc_tokens":2846,"input_tokens":45880,"output_tokens":4334,"prompt_per_second":6384.427118730863,"tokens_per_second":141.41882904412867},"duration_ms":102908,"has_capture":true,"metadata":{"fifo_priority":"0"}},{"id":69576,"timestamp":"2026-10-09T05:54:48Z","src":"ip:100.94.165.102","model":"Qwen3.8-27B","req_path":"/v1/chat/completions","resp_content_type":"text/event-stream","resp_status_code":200,"tokens":{"cache_tokens":79732,"draft_tokens":3873,"draft_acc_tokens":2766,"input_tokens":3142,"output_tokens":4057,"prompt_per_second":3303.630116672734,"tokens_per_second":147.53771359034795},"duration_ms":65850,"has_capture":true,"metadata":{"fifo_priority":"0"}}, ... 5 more entries, ids 69571-69575, same shape ...]}
```

All 7 entries in the window: model `Qwen3.8-27B`, src
`ip:100.94.165.102`, status 200, ids 69571 to 69577. Every entry carries a
duration and a status. The probe saw no in-flight entry.

```
GET /api/stats -> 404 (19 bytes)
GET /metrics/health -> 404 (19 bytes)
GET /api/health -> 404 (19 bytes)
GET /health -> 200 (2 bytes: "ok")
```

### What it exposes

- The activity feed (`GET /api/metrics/activity`): one entry per finished
  request, newest first, numeric ids (69577 at probe time). Per entry:
  id, timestamp, src, model, req_path, resp_status_code, plus a `tokens`
  block `{cache_tokens, draft_tokens, draft_acc_tokens, input_tokens,
  output_tokens, prompt_per_second, tokens_per_second}`, `duration_ms`,
  `has_capture`, `metadata.fifo_priority`.
- `/metrics`: host and GPU gauges in Prometheus text (above). This
  endpoint is not fetched by idlefill today. No row path points at it.
- `/v1/models`: four entries. `Qwen3.8-27B` with status `loaded` and the
  description "Qwen3.8 27B NVFP4 NINFER, MTP=3,FP8 KV, 240K context,
  vision." Two peer entries with status `unloaded`. One selector entry
  (`qwen38-27b`, strategy `warm`). The quant identity sits in free-text
  description fields.

### What idlefill reads of this today

- The feed. The parser keeps six fields (`ActivityEntry`,
  `server/src/types.ts:598`: id, timestamp, src, model, req_path,
  resp_status_code). The `tokens` block is on the wire and unread. The
  engine's tokens per second, its cache reuse, and the durations are all
  dropped at the type.
- `/metrics`: not fetched at all.
- The verdict for this row: feed only (the row carries no `log_glob`. The
  live signal shows `last_log_write_age_s` null).

### What it does not expose

- Queue depth: nothing. `metadata.fifo_priority` is a per-request priority
  value (0 in every probe entry). It is not a queue count.
- In-flight requests: nothing in the feed. The GPU gauges in `/metrics`
  are a proxy (utilization, not a count).
- KV-cache occupancy: nothing. `tokens.cache_tokens` is a per-request
  reuse count (79732 on one probe entry: tokens served from the KV
  cache). `gpu_memory_util_percent` is host-level. Neither is the KV pool
  occupancy.
- Structured quant: nothing. The description is free text.

## Engine 3 — strata / NInfer (urza row, `https://strata.samwarth.com`)

Row (live `GET /api/state`): provider `strata`, `activity_path`
`/metrics`, `watched` true, `auth_set` true, `probed_at` null,
`model_source` `declared`.

### Probes (the engine is down)

```
GET /v1/models -> 502, body "Bad Gateway"
GET /metrics -> 502, body "Bad Gateway"
GET /api/metrics/activity -> 502, body "Bad Gateway"
GET /api/stats -> 502, body "Bad Gateway"
GET /health -> 502, body "Bad Gateway"
GET /metrics/health -> 502, body "Bad Gateway"
GET /api/health -> 502, body "Bad Gateway"
```

Live arbiter evidence (same tick as the probes): the row's signal block
reads `degraded` true, `degraded_reason` "activity fetch failed",
`idle_for_s` null, `feed_enabled` true. The verdict is fail-closed: no
grant, no revoke on stale activity. That is the existing degraded
semantics, observed in production.

### What it exposes (when it is up)

The payload shape is verified in code
(`server/src/idle.ts`, `parseStrataMetrics`; the comment there records a
live verification on 2026-10-05):

- `time`: the engine clock, epoch seconds.
- `engine.model`: the loaded model name.
- `totals`: since-boot counters: `since`, `requests`, `prompt_tokens`,
  `reused`, `output_tokens`.
- `requests[]`: finished jobs: `time` (start, epoch seconds),
  `duration_s`, `finish`.
- `live`: the in-flight generation: `state`.

So: a monotonic request and token counter, one in-flight generation
state, and the model name. `live` is a single slot: the engine reports
one generation at a time. The adapter treats every state except
`idle`, `stopped`, and `none` as generating.

### What it does not expose

- Queue depth: nothing in the payload.
- A multi-request in-flight count: `live` is one slot.
- Tokens per second: nothing direct. The delta of `totals` between two
  polls gives a rate. The #62 sampler already diffs the counters
  (`server/src/omlx.ts`, `CounterDeltaTracker`).
- KV-cache occupancy: nothing. `totals.reused` is a reuse counter (tokens
  served from cache). It is not pool occupancy.
- Structured quant: the model id carries it as text (the scanbot row
  below serves `qwen3.8-flash-next-q2_0`. The quant is the `q2_0`
  suffix).

## Engine 4 — strata (scanbot row, `http://10.10.10.6:8080`)

Keyless probe (the arbiter holds the row token; `auth_set` true):

```
GET /v1/models -> 401 (82 bytes)
GET /metrics -> 401 (82 bytes)
GET /health -> 200 (145 bytes)
```

Live arbiter evidence: the row is probed (`model_source` `probed`), and
its signal reads `idle` false, `idle_for_s` 2, `last_activity` model
`qwen3.8-flash-next-q2_0`, src `strata:engine`. Same payload shape as
Engine 3, served by a second strata instance.

## The local arbiter (`127.0.0.1:8787`)

```
GET /api/state -> 200
14 top-level keys: active_leases, catalog, clients, engine_groups,
events, idle, leases, mesh, model_aliases, now, projects, servers,
sessions, throttled_jobs
```

Per-row signal blocks (live, verbatim, one each):

```
oMLX          {"idle": true,  "idle_for_s": 594, "last_activity": null, "last_log_write_age_s": 594, "degraded": false, "degraded_reason": null, "feed_enabled": false, "no_signal_reason": null, "reidle_gated": false, "session_last_activity_age_s": null}
urza (strata) {"idle": false, "idle_for_s": null, "last_activity": null, "last_log_write_age_s": null, "degraded": true, "degraded_reason": "activity fetch failed", "feed_enabled": true, "no_signal_reason": null, "reidle_gated": false, "session_last_activity_age_s": null}
strata-scanbot{"idle": false, "idle_for_s": 2, "last_activity": {"ts": 1791525920288, "model": "qwen3.8-flash-next-q2_0", "src": "strata:engine", "age_s": 2}, "last_log_write_age_s": null, "degraded": false, "degraded_reason": null, "feed_enabled": true, "no_signal_reason": null, "reidle_gated": false, "session_last_activity_age_s": null}
llama-swap    {"idle": false, "idle_for_s": 7, "last_activity": {"ts": 1791525915000, "model": "Qwen3.8-27B", "src": "ip:100.94.165.102", "age_s": 7}, "last_log_write_age_s": null, "degraded": false, "degraded_reason": null, "feed_enabled": true, "no_signal_reason": null, "reidle_gated": false, "session_last_activity_age_s": null}
```

Note: the live block carries three keys that the HEAD `IdleSignal` type
does not list (worktree HEAD `f7d0a74`): `last_log_write_age_s`,
`reidle_gated`, `session_last_activity_age_s`. The production build runs
ahead of the worktree HEAD. The build wave re-verifies the type before
adding keys (open question 6 in the design doc).

```
GET /api/metrics?series=engine&bucket=raw&from=<now-3600s>&to=<now> -> 200
{"series":[],"truncated":false}
```

The #51 store is live. The raw window was empty at probe time. That is an
honest answer, not an error.

```
GET /api/mesh -> 401 (no peer token; expected, mesh.md D2)
```

## The gap table (the want list compared to what each engine exposes)

| Want | oMLX | llama-swap | strata |
| --- | --- | --- | --- |
| Queue depth | nothing | nothing | nothing |
| In-flight requests | nothing (`loaded_count` counts models) | nothing in the feed; a GPU gauge as proxy | 1 slot: `live.state` |
| Tokens per second | the hourly store delta (coarse) | per request in the feed (unread by idlefill) | the `totals` delta between polls (the #62 sampler does this) |
| KV-cache pressure | nothing (model memory only) | per-request reuse + host GPU memory (proxies) | a reuse counter (a proxy) |
| Model and quant identity | the default name only, not the loaded one | name + load state + quant in a description | the name; the quant sits in the model id |

## The sidecar's job (what is missing for the verdict)

1. A direct busy read per engine: a veto input for the verdict. strata has
   one today (`live.state`). llama-swap has a gauge (the threshold is an
   owner decision). oMLX has none.
2. A load read that never reads falsely idle. The engine reads busy while
   our own jobs run. That is the conservative direction the strata feed
   adapter already uses (a fixed non-IP src, no self-exemption).
3. Model and quant identity as structured fields, so the verdict and the
   dashboard name what the engine actually holds.

## Full captures (verbatim, untruncated)

The llama-swap `/metrics` body (4538 bytes, 2026-10-09 05:55:28Z):

```
# HELP llamaswap_cpu_util_percent CPU utilization per core (0-100)
# TYPE llamaswap_cpu_util_percent gauge
llamaswap_cpu_util_percent{core="0"} 4.674796750987706
llamaswap_cpu_util_percent{core="1"} 3.434343435141629
llamaswap_cpu_util_percent{core="2"} 6.048387095411371
llamaswap_cpu_util_percent{core="3"} 2.4096385552448734
llamaswap_cpu_util_percent{core="4"} 4.408817634718856
llamaswap_cpu_util_percent{core="5"} 2.208835341093205
llamaswap_cpu_util_percent{core="6"} 1.4056224901053562
llamaswap_cpu_util_percent{core="7"} 1.6000000014528633
llamaswap_cpu_util_percent{core="8"} 0.20040080062373203
llamaswap_cpu_util_percent{core="9"} 2.0161290318037906
llamaswap_cpu_util_percent{core="10"} 3.4068136269342513
llamaswap_cpu_util_percent{core="11"} 1.0060362170752424
llamaswap_cpu_util_percent{core="12"} 1.606425701975697
llamaswap_cpu_util_percent{core="13"} 2.4096385540760448
llamaswap_cpu_util_percent{core="14"} 2.0161290318037906
llamaswap_cpu_util_percent{core="15"} 2.610441767171543
llamaswap_cpu_util_percent{core="16"} 11.336032389656214
llamaswap_cpu_util_percent{core="17"} 3.212851401910051
llamaswap_cpu_util_percent{core="18"} 5.410821643669948
llamaswap_cpu_util_percent{core="19"} 1.0040160628581891
llamaswap_cpu_util_percent{core="20"} 100
llamaswap_cpu_util_percent{core="21"} 2.799999998016283
llamaswap_cpu_util_percent{core="22"} 1.8072289150148664
llamaswap_cpu_util_percent{core="23"} 1.0040160651958463
# HELP llamaswap_memory_total_bytes Total memory in bytes
# TYPE llamaswap_memory_total_bytes gauge
llamaswap_memory_total_bytes 101147738112
# HELP llamaswap_memory_used_bytes Used memory in bytes
# TYPE llamaswap_memory_used_bytes gauge
llamaswap_memory_used_bytes 50385125376
# HELP llamaswap_memory_free_bytes Free memory in bytes
# TYPE llamaswap_memory_free_bytes gauge
llamaswap_memory_free_bytes 7827619840
# HELP llamaswap_swap_total_bytes Total swap in bytes
# TYPE llamaswap_swap_total_bytes gauge
llamaswap_swap_total_bytes 8588886016
# HELP llamaswap_swap_used_bytes Used swap in bytes
# TYPE llamaswap_swap_used_bytes gauge
llamaswap_swap_used_bytes 8580497408
# HELP llamaswap_load_average Load average
# TYPE llamaswap_load_average gauge
llamaswap_load_average{interval="1m"} 1.98
llamaswap_load_average{interval="5m"} 1.96
llamaswap_load_average{interval="15m"} 2.13
# HELP llamaswap_network_bytes_total Total network bytes transferred
# TYPE llamaswap_network_bytes_total counter
llamaswap_network_bytes_total{interface="eth0",direction="recv"} 1322002322
llamaswap_network_bytes_total{interface="eth0",direction="sent"} 1087254044
# HELP llamaswap_gpu_temperature_celsius GPU temperature in Celsius
# TYPE llamaswap_gpu_temperature_celsius gauge
llamaswap_gpu_temperature_celsius{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 70
# HELP llamaswap_gpu_vram_temperature_celsius GPU VRAM temperature in Celsius
# TYPE llamaswap_gpu_vram_temperature_celsius gauge
llamaswap_gpu_vram_temperature_celsius{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 0
# HELP llamaswap_gpu_util_percent GPU utilization percent (0-100)
# TYPE llamaswap_gpu_util_percent gauge
llamaswap_gpu_util_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 91
# HELP llamaswap_gpu_memory_util_percent GPU memory utilization percent (0-100)
# TYPE llamaswap_gpu_memory_util_percent gauge
llamaswap_gpu_memory_util_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 95.51323335480112
# HELP llamaswap_gpu_memory_used_bytes GPU memory used in bytes
# TYPE llamaswap_gpu_memory_used_bytes gauge
llamaswap_gpu_memory_used_bytes{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 3.2656850944e+10
# HELP llamaswap_gpu_memory_total_bytes GPU memory total in bytes
# TYPE llamaswap_gpu_memory_total_bytes gauge
llamaswap_gpu_memory_total_bytes{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 3.4190917632e+10
# HELP llamaswap_gpu_fan_speed_percent GPU fan speed percent (0-100)
# TYPE llamaswap_gpu_fan_speed_percent gauge
llamaswap_gpu_fan_speed_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 51
# HELP llamaswap_gpu_power_draw_watts GPU power draw in watts
# TYPE llamaswap_gpu_power_draw_watts gauge
llamaswap_gpu_power_draw_watts{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 448.69
```

The remaining captures (every engine path probed, with status and body)
are in the probe session log. The four decisive ones are quoted verbatim
in the engine sections above.

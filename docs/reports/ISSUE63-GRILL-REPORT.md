# ISSUE63 GRILL REPORT — aggregate inference endpoint: six decisions settled on verified code

Map: #63 (the aggregate endpoint gap) · #50 (the locked mesh topology —
D3/D5 bind this grill) · #42 (session identity plane, intersected not
owned) · #60 (write-only `auth_token` plane + the live Mac arbiter) ·
Type: wayfinder:grilling

## What landed

The decision doc is `docs/architecture/aggregate-endpoint.md` — D1..D6
in the mesh.md format (chosen option + rejected alternatives + deciding
trade-off per decision), a crisp rules section, "what changes vs what
stays untouched", and four open owner questions. No code, config, or
test file touched. This report and the README index line are the only
companions to the doc.

## Every brief claim re-verified (two corrections)

- Confirmed: single `opts.target` + 127.0.0.1-only bind
  (`client/src/proxy.ts:51,62,192`), gate branch vs exact passthrough
  (`proxy.ts:160-183`), `llm_target` single string / proxy_port 11435 /
  gate default true / cap 2 (`client/src/config.ts:113,151-154`),
  token-keyed sessions + header capture (`client/src/session-gate.ts:217,283`,
  `server/src/types.ts:398-400`), write-only `auth_token` stripped in
  `serverView` (`server/src/api.ts:232-244`, `types.ts:294`), no `/v1/*`
  route on the arbiter + `/api/*`-scoped auth hook (`api.ts:255-284` +
  route-table grep), the `f5b8ab5` no-command-channel claim (verbatim in
  the commit subject), the fleet shape (lsof: :8787, 127.0.0.1:11435,
  :8000 live, nothing on 8888), oMLX `/v1/models` → 401 anonymous, urza
  llama-swap `/v1/models` → 200.
- Correction 1: the brief implies the live arbiter may not know oMLX
  models — it does. Live `/api/state` shows three rows (oMLX, strata,
  strata-scanbot) with declared model lists. Two rows carry
  `auth_set: true`. Also: the issue's "8888 appears nowhere" is true of
  OUR repo and fleet, but another owner's box (`dgx-spark-tyler`)
  already serves `http://100.95.230.70:8888/v1` in the flash profile —
  the port name is taken in the fleet vocabulary, loopback bind aside.
- Correction 2: the brief's api.ts line cite (233-241) drifted to
  232-244. The doc cites what was read.
- New verified fact no brief states: NOTHING in the repo probes
  `/v1/models` (zero grep hits across server/src + client/src). The
  `models` arrays are operator-declared inventory only. D4 therefore
  builds the probe, credentialed per row like the #60 B/#62 fetchers
  (`server/src/idle.ts:227-231`).

## Decisions settled

- **D1 (locked):** the client router binds a second loopback listener
  (`aggregate_port`, default 8888) and routes by the body's model.
  Rejected: arbiter data plane (breaks the write-only credential model
  and puts a proxy door on the 0.0.0.0 control-plane bind, and a dead
  arbiter would wedge chats against mesh rule 2), separate process
  (against mesh D5's fused lock). Mesh D5 counts processes, not
  listeners.
- **D2 (locked):** the token stays in the arbiter state file (0600,
  `server/src/state.ts:117-119`). The router pulls engine URL + token
  over ONE new loopback-scoped admin route (`GET /api/server-keys`) —
  not on `/api/state` (anonymous-readable, `api.ts:263-266`) — and
  holds it in memory only. End-to-end answer: for a routed request the
  token lives in the router process's memory. Rejected: arbiter-side
  proxying, client config duplication (violates write-only), waiting on
  the nonexistent command channel (`f5b8ab5`).
- **D3 (locked):** aggregate traffic enters the SAME SessionGate. Key
  today: `X-Hermes-Session-Id` when present, else the request's model
  name — one coarse row per model per machine, the named key that
  survives headerless traffic TODAY. Rejected: one single aggregate row
  (kills per-session pause/force), socket keys (unstable), smuggled
  hand-set tokens (the #42 plane). The header path subsumes the
  fallback when Hermes-core injection lands — same field, no
  un-building.
- **D4 (locked, display shape PROPOSED):** catalog = declared union +
  credentialed `/v1/models` probe on the poll tick, merged IN THE
  ARBITER, probe success replaces, probe failure keeps declared
  (drop-don't-reject). Collisions are real live (`Qwen3.8-Flash-Next`
  on two rows on the Mac arbiter): bare name routes to the first
  preference, no mid-chat fail-over. Stated plainly: for feed-off kinds
  (oMLX: its `/metrics`/`/api/stats` 404, `idle.ts:176`) the arbiter
  provably sees model NAMES and presence only — token/request counters
  need #62's local samplers. A probe-blocked feed-off row contributes
  ONLY its declared list, tagged `catalog_source: declared`.
- **D5 (locked):** 8888 is session traffic — shared gate instance,
  shared slot cap, park/pause/force/fail-open all identical, under
  D3's key. The router MUST report the row's `server_id` on the
  register heartbeat, or idle folding/preemption lands on the wrong
  server (`sessionActivityOn`, `arbiter.ts:855-862`, and the
  `leaseServerId` fallback at `arbiter.ts:86`). No lease for aggregate
  traffic (`types.ts:388-397`). Two gate instances would double the cap
  against shared engines — named as the forbidden shape.
- **D6 (locked):** `/s/<token>`, plain `/v1` passthrough (the
  career-ops flow), and the flash profile's `/s/flash` config stay
  byte-for-byte as today. Moving flash to 8888 is a later operator edit.

## Verification (actual output)

- Re-read on disk: proxy.ts, config.ts, session-gate.ts, api.ts (hook +
  sessions routes + serverView), types.ts, idle.ts, arbiter.ts
  (registerSession, sessionActivityOn, leaseServerId), state.ts (0600).
- Live probes (2026-10-05): `lsof` shows :8787 (node 83174), 127.0.0.1:11435
  (node 83190), :8000 (python 79619), nothing on :8888. Anonymous
  `GET /api/state` returned the 3-row inventory + client
  `mac-sam` proxy_port 11435 gate armed, sessions 0.
  `GET 127.0.0.1:8000/v1/models` → 401. `GET 100.105.225.1:11434/v1/models`
  → 200. flash config.yaml line 4 = `http://127.0.0.1:11435/s/flash/v1`.

## Open owner questions (in the doc)

1. Ambiguous-name display + routing-key syntax (bare vs `name (host)`).
2. `model_preference` config key vs row order as first-wave default.
3. Accept the loopback-scoped key-pull route as write-only-compatible,
   or pay for arbiter-side proxying.
4. Confirm 8888 default fleet-wide (no local bind collision known. The
   remote `dgx-spark-tyler` host is not ours).

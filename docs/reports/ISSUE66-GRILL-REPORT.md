# ISSUE66 GRILL REPORT — model aliases: six decisions settled on verified code

**Doc:** `docs/architecture/model-aliases.md` (new). D1..D6 in the
mesh.md format. D1/D2/D3/D4/D6 LOCKED, D5 LOCKED in posture + PROPOSED
in display shape, three owner open questions. No src, config, or test
file touched. Map: #66 (the alias plane) · #63/#64 (the LOCKED aggregate
endpoint this doc AMENDS, never restates) · #50 (mesh topology, locked) ·
Type: wayfinder:grilling.

## What landed

The decision doc settles each named decision against code read on disk
and the live fleet probed below. It states its amendments to the LOCKED
#63 doc explicitly (amendment-discipline section) and retires the two
things #63 named as its own follow-up: row-order pinning for aliased
names, and the `model_preference` deferred knob. `docs/reports/README.md`
is untouched per fence (the #65 worker owns it this wave).

## Live verification (actual output, 2026-10-06)

Ports (lsof): :8800 LISTEN (node, PID 75744, 127.0.0.1), :8787 LISTEN
(node, PID 10214, `*:8787`), :8000 LISTEN (python3.1x, PID 79619 —
oMLX).

`curl -s http://127.0.0.1:8800/v1/models` — the current union, four
bare names, no aliases:

```json
{"object":"list","data":[
 {"id":"Qwen3.8-Flash-Next","object":"model","owned_by":"srv-watched"},
 {"id":"Qwen3.8-Flash-Next-REAP-288-MLX-4bit","object":"model","owned_by":"srv-watched"},
 {"id":"qwen3.8-flash-next-iq3_s","object":"model","owned_by":"srv-45abb4e8"},
 {"id":"qwen3.8-flash-next-q2_0","object":"model","owned_by":"srv-f1c85327"}]}
```

Anonymous `GET http://127.0.0.1:8787/api/state` `catalog` block (no
token sent — the anonymous read answered directly):

```json
[
 {"name":"Qwen3.8-Flash-Next","server_id":"srv-watched","url":"http://127.0.0.1:8000","auth_set":false,"catalog_source":"declared"},
 {"name":"Qwen3.8-Flash-Next-REAP-288-MLX-4bit","server_id":"srv-watched","url":"http://127.0.0.1:8000","auth_set":false,"catalog_source":"declared"},
 {"name":"qwen3.8-flash-next-iq3_s","server_id":"srv-45abb4e8","url":"https://strata.samwarth.com","auth_set":true,"catalog_source":"probed"},
 {"name":"qwen3.8-flash-next-q2_0","server_id":"srv-f1c85327","url":"http://10.10.10.241:8080","auth_set":true,"catalog_source":"probed"}
]
```

Servers rows from the same read: `srv-watched` oMLX
`http://127.0.0.1:8000` auth_set FALSE declared
[`Qwen3.8-Flash-Next`, `Qwen3.8-Flash-Next-REAP-288-MLX-4bit`],
`srv-45abb4e8` strata `https://strata.samwarth.com` auth_set TRUE
declared [`Qwen3.8-Flash-Next`], `srv-f1c85327` strata-scanbot
`http://10.10.10.241:8080` auth_set TRUE declared
[`Qwen3.8-Flash-Next`].

llama-swap unauthenticated `curl -s http://100.105.225.1:11434/v1/models`
— HTTP 200, NO token needed (a decision-relevant fact: adding it as a
row costs no credential). Names: `Qwen3.8-27B`,
`dgx-spark-tyler/qwen3.8-flash-next` (a `type:"peer"` entry),
`mac-m4-mtplx/mtplx-qwen38-27b-optimized-speed`, `qwen38-27b` (a
selector). The third spelling of the flagship model is confirmed, and it
is a llama-swap row+id pair an alias can bind.

oMLX `curl -s http://127.0.0.1:8000/v1/models` — HTTP 401, body
`{"error":{"message":"API key required","type":"authentication_error",...}}`.
The row carries no token, so its two names publish `catalog_source:
declared`. D2's rule for a pair the probe can never confirm is settled
there (publishable as declared, exception-only marked).

`grep -rn "model_preference" server/src client/src` — see Correction 1.

New probe beyond the brief's list (credentialed strata probes run from
the loopback `GET /api/server-keys` rows inside a script, token never
printed): `srv-45abb4e8` probes `['qwen3.8-flash-next-iq3_s']` — it does
NOT list the bare `Qwen3.8-Flash-Next` it declares. `srv-f1c85327`
probes `['qwen3.8-flash-next-q2_0', 'Qwen3.8-Flash-Next']` — the exact
name. Decisive consequence probed end-to-end: `POST
http://127.0.0.1:8800/v1/chat/completions` with
`{"model":"Qwen3.8-Flash-Next",...}` returns the oMLX 401 `API key
required`. The row-order pin routes the fleet's flagship name to a
keyless engine while a credentialed engine serves the identical id. The
bug the alias plane fixes, on the live system, same-day evidence.

## Citations read on disk (verified line numbers, 2026-10-06 HEAD 23f29ca)

- Collision rule + merge: `server/src/catalog.ts:114-138`
  (`buildCatalog`, pin comment 109-111, dedup skip 126), entry shape
  23-34, `parseModelsPayload` 58-85, `modelsProbeUrl` 48-51,
  `isLoopbackAddress` 147-153.
- Row types: `server/src/types.ts:255-297` (`ServerConnection`,
  `models: string[]` 274, `auth_token?` 294), `ArbiterState` 671-673
  (`servers` sibling), `session_overrides` 713, `SessionRecord` 423-454
  (`server_id?` 430, `session_id?` 454).
- Publish + auth surfaces: `server/src/api.ts:958` (`catalog` ADD-key
  on `/api/state`), anonymous-state check 272, onRequest hook 262,
  `serverView` strip 200-251 (token strip 243-246),
  `GET /api/server-keys` 676-685, `POST /api/servers` 694,
  `POST /api/sessions/:token/override` 775.
- Probe cycle: `server/src/arbiter.ts:848-866` (`probeCatalog`),
  published getter 869-871, wiring `server/src/index.ts:235`, fetcher
  injection 77, `sessionActivityOn` 958, `upsertServerConnection` 1376.
- State persistence: `server/src/state.ts:117` (0600 tmp+rename),
  tolerate-missing lines 80 (`session_overrides` pattern), 92
  (`servers`).
- Router: `client/src/aggregate.ts:36-42` (`AggregateCatalogEntry`),
  `cleanKey` 82-89 (128-char printable bound), first-chunk sniff
  98-126 (regex 114, `unshift` 112), `forwardTo` 150-212 (pipes `req`
  untouched, `req.pipe(upstream)` 211, #65 status now rides 182),
  `forwardFor` 219-227, `serveModelList` 229-239, dispatch 252-266,
  `updateCatalog` 307-318, default-target fallback 226,278.
- Gate posture: `client/src/session-gate.ts:24-26` (override learned
  from the `/api/state` poll), `sniffModelChunk` 183-187 (the 80-char
  name class), `SESSION_ID_HEADER` 199, body-never-touched invariant
  286, pause/force enforcement 300-310, `onStatePoll` 564-602.
- Poll wiring: `client/src/index.ts:1433` (`updateCatalog(st.catalog)`
  on the state poll), 1434 + 1634-1638 (keys pull same cadence), 1659-
  1664 (register carries the catalog-chosen `server_id`), 1110 (client
  poll 20000 ms), 1711-1734 (aggregate start).
- Configs: `client/src/config.ts:114,170,231` (`llm_target`),
  124,172,234 (`aggregate_port` 8800), `server/src/config.ts:35`
  (`poll_ms` 15000). Live Mac `llm_target` = `http://127.0.0.1:8000`
  (client config.json, read in-script).
- Dashboard seam: `server/public/index.html:683` (edit-connection
  toggle), 2190-2243 (`serverFormHtml`), 2400-2440 (patch-by-difference
  save), view tabs 367-370 + sections 380+ (the new-view pattern).

## Corrections against the brief / task list

1. "`grep -rn model_preference server/src client/src` — expected zero
   hits" is NOT zero. One hit: `server/src/catalog.ts:11` — a comment
   citing the #63 deferral ("no model_preference key this wave"). The
   ABSENCE claim still holds in substance: no code, config, or type
   named `model_preference` exists. The deferral never landed, so the
   alias plane retires a knob that was never built.
2. The task's line hints drifted, as expected: session-gate override
   posture reads at 24-26 and 564-602 (not ~23-26 and ~290-310. The
   enforcement sites near 300-310 are real and cited), and the
   aggregate catalog entry sits at 36-42 exactly as the brief says.
3. The brief's live-facts list (2026-10-05) matches today's probes with
   one sharpening: the strata row `srv-45abb4e8` DECLARES
   `Qwen3.8-Flash-Next` but its credentialed probe does NOT list it —
   that name publishes from `srv-watched` (declared) and
   `srv-f1c85327` (probed). D2's per-pair confirmation rule is built
   exactly for this split.

## What the alias plane replaces from #63 (stated as amendments)

- #63 owner decision 2 (row declaration order pins a bare name, and
  `model_preference` was deferred): SUPERSEDED for aliased names. Row order
  still pins non-aliased bare names — `buildCatalog` untouched. The
  deferred knob is RETIRED: D1 argues the alias plane subsumes it.
- #63 D4 merge (probe replaces declared per row, catalog_source
  honesty): UNCHANGED and REUSED. Aliases layer on top as a separate
  publish pass with per-pair confirmation.
- `/api/state` `catalog` ADD-key + `AggregateCatalogEntry`: UNCHANGED
  shape. `model_aliases` rides as a SIBLING ADD-key (the doc's
  amendment-discipline section).
- #64 D2 token plane, D3 gate key, D5 shared gate + `server_id`
  truthfulness: re-affirmed byte-for-byte in D6's fence.

## Decisions settled

- **D1 (locked):** top-level `model_aliases` ADD-key on arbiter state —
  name → pairs `{server_id, engine model}` + `pinned_server_id`. Per-row
  `model_preference` rejected (cannot express a name the engine does not
  use, cannot hold pairs or a winner). Sanitizers matched to `cleanKey`
  (128 printable) and the sniff class (80, no quote/backslash).
- **D2 (locked):** aliases layer over declared+probe. Probe confirms
  pairs, a vanished pair drops the pair never the alias, an unprobeable
  row's pairs stay publishable as 'declared'. Alias beats bare on
  collision — the flagship alias IS a same-name shadow, so write-time
  rejection of collisions would reject the fix.
- **D3 (locked):** catalog block gains the `model_aliases` ADD-key, the
  published entry shape untouched, and the ROUTER rewrites the body's
  model to the engine id. Mechanics pinned: bounded splice in the
  already-sniffed first chunk (same find, same regex class → rewrite
  feasibility equals routing feasibility), content-length delta or
  chunked preserved, byte-level echo tests. Rejected: full JSON parse
  (megabyte tool payloads, breaks the no-buffer contract), chunked JSON
  tracker (largest new failure surface), declaring engine ids directly
  (breaks the drag's "agent never learns" requirement).
- **D4 (locked):** explicit `pinned_server_id`, default first pair,
  fall-through to first surviving pair. Re-pin propagates by the
  existing `/api/state` poll — the pause/force posture verbatim — no new
  push channel (re-verified none exists). The agent and every profile
  config keep one stable name.
- **D5 (locked posture, PROPOSED display):** aliases cannot live in the
  per-row edit-connection form (cross-row entity). A Models view on the
  dashboard, settings-form disclosure pattern, picker fed by the
  `catalog` + `model_aliases` blocks the arbiter already publishes.
- **D6 (locked):** :8800 `llm_target` fallback, one shared gate,
  register keeps the REAL engine row as `server_id`, 11435 byte-for-byte,
  tokens write-only, `/api/server-keys` loopback-only, mesh carries no
  alias data.

## Fence compliance

Committed paths: `docs/architecture/model-aliases.md` +
`docs/reports/ISSUE66-GRILL-REPORT.md` only. No src touched (the
concurrent #65 worker's `aggregate.ts`/`proxy.ts` edits were left
alone — citations above reflect HEAD 23f29ca with those landed). No
`docs/reports/README.md` (the supervisor adds the index line). No push.
Identity `web-dev@agents.samwarth.com`.

## Left for the owner

1. D5 display placement (Models tab vs Overview section).
2. Unconfirmed-pair pin UX (confirmation tick vs declared marker only).
3. Pre-approval of the chunked-forward fallback (bounded full-body
   buffer) if any engine refuses a chunked spliced body — build-wave
   byte tests decide.

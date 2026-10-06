# Issue #66 — model aliases plane report

Wave: build the operator-declared model-alias plane end to end. Decision
doc: `docs/architecture/model-aliases.md` (LOCKED D1–D6). Brief:
`docs/reports/ISSUE66-BRIEF.md`. Grill evidence:
`docs/reports/ISSUE66-GRILL-REPORT.md`. Owner rulings honored: Q3
approved (the scoped full-body buffer) and the chunk-boundary sniff gap
deferred to #67. Fence: the allowed-path list in the wave prompt only.
The frozen files (`server/src/catalog.ts`, `client/src/session-gate.ts`,
`client/src/proxy.ts`, `client/src/config.ts`, the gate, the slot cap,
the 11435 listener, `/s/<token>`, leases) carry zero diff.

## 1. What was built

### Server (`types.ts`, `state.ts`, `arbiter.ts`, `api.ts`) — `7a861db`

- `ModelAliasPair` / `ModelAlias` + `model_aliases: Record<string,
  ModelAlias>` as an ADD-key sibling of `servers` on `ArbiterState` (D1
  shape verbatim: alias, pairs with insertion order, optional
  `pinned_server_id`, `updated_at`). Event kinds `model_alias_updated` /
  `model_alias_removed` join the union.
- State loader: one tolerate-missing-key line (the `session_overrides`
  pattern): object → keep, else base `{}`. An old state file loads
  unchanged.
- Alias pass inside `probeCatalog()`, over the SAME probe map (D2).
  Per-pair confirmation: probe lists the pair's model → `probed`; row
  probe failed → the pair stands as `declared` (never falsely probed);
  probe succeeded without the id → the pair drops for the tick, the
  alias survives; all pairs dead → the alias publishes nothing that
  tick. Winner: stored `pinned_server_id` when it survives, else the
  first surviving pair; a dead pin falls through (D4).
- Publish: one resolved entry per alias (D3 shape: `name, server_id,
  url, auth_set, engine_model, catalog_source`) beside `catalog` on
  `/api/state`. `catalog` itself stays byte-for-byte (the frozen
  `buildCatalog`). Publish-path sanitizers drop-don't-reject: a hostile
  stored key is unpublished while the stored row stays untouched. No
  token ever appears in the block — an alias is `server_id` + engine id
  by construction (D1 write-only posture).
- `GET /api/aliases`: the authoring read (token-gated like every
  `/api/*` — never the anonymous exception). Rows carry per-pair
  markers `probed` / `declared` / `dropped` / `unprobed`.
- `POST /api/aliases` `{ alias, pairs?, pin?, delete? }` (the route
  table has no DELETE verb). Whole-entry validation answers 400 with
  the reason: hostile/over-bound name (printable `0x20`–`0x7e` ≤128,
  the `cleanKey` class), quote/backslash engine ids (`" \x22\x5c`
  class ≤80 — the body-sniff class; a quote would break the splice),
  empty pairs, unknown `server_id`, duplicate pair, malformed pin. A
  pin at a not-present row is legal (a row can die after authoring;
  publish falls through — D4). A POST for an unprobed pair is ACCEPTED
  (the form is the constraint, not the API — D5). Delete of an unknown
  alias → 404 `unknown_alias`. Every write appends an event (the
  `server_connection_updated` pattern).

### Client router (`aggregate.ts`, `index.ts`) — `cebb974`

- `AggregateAliasEntry` (a SEPARATE type; `AggregateCatalogEntry`
  frozen) + `updateAliases(entries)` / `aliasSize()` with the same
  defensive-dedup posture as `updateCatalog`. The poll gains the
  `st.model_aliases ?? []` sibling line — one block, one poll, so
  catalog and alias winners always land together.
- Routing precedence: the alias map beats a bare catalog entry of the
  same name (D2). Unknown/absent model → the machine `llm_target`
  untouched (D6 fence).
- `/v1/models`: alias winners first (`{id: alias, object: 'model',
  owned_by: winner server_id}`), then bare entries no alias shadows —
  one string appears exactly once (D3 dedup).
- Forward-time rewrite at the seam AFTER gate admission (the parked-
  body invariant holds: nothing consumes `req` before admission): an
  aliased entry whose `engine_model` differs buffers the full body
  under `ALIAS_BODY_CAP` (64 MiB, ≥32 MiB per the owner), rejects over
  cap with 413, splices the quoted `"model"` value with the sniff's own
  regex class, forwards with a recomputed `content-length` (the owner
  Q3 posture — the llama.cpp family drops chunked request bodies). A
  `req.resume()` after the buffered write releases the stream the peek
  paused (found live: `pipe()` resumes implicitly, a manual `data`
  listener does not). Bare-name and default-target traffic keeps today's
  `req.pipe` byte-for-byte.
- `onSessionRoute` carries the winner row id, so the register heartbeat
  reports the real engine row for alias-routed traffic (D6 truth; no
  alias placeholder).

### Dashboard (`server/public/index.html`) — `08e633e`

- New top-level Models tab (`data-view="models"`): `VIEW_TABS`,
  `VIEW_TAB_IDS`, `HASH_VIEW_RE`, and the empty-state map each gained
  `models` — the existing tab pattern exactly, deep-linkable.
- Alias rows render: name, winner marked `(pinned)` / `(first pair)`,
  each pair with the exception-only marker (`probed` renders NOTHING,
  `declared` / `dropped` / `unprobed` mark), update time, per-pair pin
  buttons (the drag's keyboard stand-in; `default` clears the pin).
- Add/edit form: alias name field; pair rows of TWO verbatim picks —
  engine select, then that row's probed model select. The pick-list is
  probed `catalog` entries ONLY, grouped by `server_id` (D5, never a
  fuzzy match); a stored unprobed pair round-trips marked. +pair/-pair
  affordances, winner select, delete.
- Writes ride `settingsPost` (`?token=`) to `POST /api/aliases` with
  the settings-form patch-by-difference posture: unchanged → no POST;
  pin-only → `{ alias, pin }`; pair change → full pairs; create omits
  an unchosen pin. The authoring read `GET /api/aliases?token=` fires
  on tab-open + token-set + a 30 s timer — never the 5 s live poll. No
  token → the pane names the requirement and NO alias GET/POST leaves
  the page. No token field appears anywhere in a form (write-only rule).
- Rename is refused client-side: the alias name is the identity; a
  rename is delete + create.

## 2. Tests — `55c691c` (server) + `cebb974` (client, registered in `client/package.json`)

Server (arbiter + api suites):

1. pair confirm / drop-tick / alias survives a pair drop; all-pairs-dead
   → unpublished; stored pairs stand across drops;
2. `declared` posture on a probe-failed row (never falsely probed);
3. winner rule: stored pin wins, an unconfirmed pin pair falls through,
   absent pin = insertion order, a gone pin row → surviving pair;
4. POST 400 family (hostile name, 128-bound, quote/backslash engine
   ids, empty pairs, unknown `server_id`, duplicate pair) + valid
   upsert/re-pin/delete round-trip + events on every write + 404
   unknown delete + the delete lands on the publish block;
5. `/api/state` publishes `model_aliases` beside `catalog`, no token
   VALUE or field name anonymous AND authed, `GET /api/aliases`
   token-gated with markers, unprobed pair ACCEPTED (D5), pin at a
   not-present row legal (D4);
6. alias-beats-bare at PUBLISH: the alias resolves to the PAIRED row
   while the bare catalog keeps its row-order pin (#63 semantics
   intact); plus the dashboard-carries-the-Models-tab assertion.

Client (`client/test/aliases.test.ts`, 11 tests, real sockets + fake
engines):

7. `/v1/models`: alias winner first, shadowed bare name appears once;
8. alias beats a bare entry of the same name at routing;
9. the byte family (echo upstream records exact bytes): engine sees
   `engine_model`, the alias string appears NOWHERE in the received
   bytes, every other byte identical, `content-length` equals the
   received byte count, JSON parses; content-length client AND chunked
   client (curl `-T -` shape → forwarded with a valid content-length,
   the scoped buffer normalizes framing); NON-aliased traffic
   byte-identical to today including chunked-stays-chunked;
10. chunk-boundary name spanning → sniff misses → default target
    (PARITY assertion; the fix defers to #67);
11. over-cap body → 413 (via the `aliasBodyCapBytes` test seam);
12. re-pin propagation: `updateAliases` (a simulated poll) → the next
    request hits the new winner row; plus the D6 fence (unknown model →
    default target) and the `onSessionRoute` winner-truth assertion.

## 3. Gates (paste below = real output)

Workspace test run (clean run; the two timing tests listed in §5 flaked
on one earlier run — pre-existing, proven in §5):

```
ℹ tests 199   ℹ pass 199   ℹ fail 0     (server)
ℹ tests 123   ℹ pass 123   ℹ fail 0     (client, incl. the new aliases.test.ts)
ℹ tests 17    ℹ pass 17    ℹ fail 0
ℹ tests 2     ℹ pass 2     ℹ fail 0
TEST-EXIT=0                               (341 tests total, 0 fail)
```

Type-checks and build (tsx never type-checks; the dashboard inline
script is outside tsc — it gets its own check):

```
$ npx tsc --noEmit -p server/tsconfig.json && echo TSC-SERVER-OK
TSC-SERVER-OK
$ npx tsc --noEmit -p client/tsconfig.json && echo TSC-CLIENT-OK
TSC-CLIENT-OK
$ npm run build            (idlefill-server@0.1.0 build = tsc -p tsconfig.json)
BUILD-EXIT=0
$ node --check <extracted inline script, 120,477 chars>
PAGE-SYNTAX-OK
```

Dashboard inline-script harness (scratch, vm + stub DOM/fetch, the
repo's extract → stub → assert recipe — the harness is NEVER committed):

```
ok 1-2 — TDZ clean; no-token gate posture
ok 3 — GET /api/aliases?token= fires with the stored token
ok 4 — row render: pairs, exception-only markers, winner, pin controls
ok 5 — pin click posts { alias, pin } exactly
ok 6 — patch-by-difference: nothing changed → no POST + fmsg
ok 7 — patch-by-difference: pin-only change posts { alias, pin } only
ok 8 — patch-by-difference: a pair change posts the full pairs
ok 9 — add form: duplicate refused with a message; fresh alias posts name + pairs
ok 10 — a half-filled pair is refused
ok 11 — delete posture
ok 12 — pick-list is probed-only; a stored unprobed pair round-trips marked
HARNESS-66-ALL-PASS
```

The harness earned its keep: it caught a REAL page bug live — `const
btns` then `btns +=` in `aliasBlock` (a TDZ-class TypeError the page
would hit on every alias render). Fixed (`let btns`) before any browser
ever saw the tab.

## 4. Live acceptance (scratch stack; production untouched)

Safety posture: a scratch arbiter on `:18801` under `IDLEFILL_CONFIG`
(JSON env) with `state_file` a scratch copy of the real state (mode
0600); a scratch daemon under `IDLEFILL_CLIENT_CONFIG` with
`aggregate_port 18802` and `proxy_port 0` (ephemeral — never touches
:11435); a scratch echo engine on `:18803` as the llm_target. No
launchd label was installed, loaded, booted, or kickstarted. All
children ran in their own process groups and were group-killed; the
scratch ports are down at the end. The driver never printed a token.
Both flagship rows were re-probed first and both answer live (`probed`),
so no echo-substitute row was needed.

```
md5-before client/config.json: 4df79869f00b12d1e642705406afdce8
md5-before real state: b5e84f47541abebdd96a0f0a9abed45b
PASS production :8787 answers BEFORE
PASS production :8800 answers BEFORE
PASS scratch echo engine up
PASS scratch arbiter on :18801
PASS alias create 201/200
PASS scratch /api/state publishes the alias with winner applied
initial winner (default pin = first pair): srv-45abb4e8 engine: qwen3.8-flash-next-iq3_s source: probed
PASS flagship rows both confirmed probed (live fleet)
PASS scratch aggregate listener on :18802
PASS scratch :18802 /v1/models lists the alias ONCE
alias /v1/models entry: {'id': 'Qwen3.8-Flash-Next', 'object': 'model', 'owned_by': 'srv-45abb4e8'}
PASS owned_by = the winner row
chat#1 status: 200 model: qwen3.8-flash-next-iq3_s id: chatcmpl-cc9326bf5ea944e
PASS chat#1 served by the pinned engine's OWN id
PASS unknown model → scratch echo (llm_target fence intact, model byte untouched)
PASS re-pin 200
re-pinned to: srv-f1c85327 engine: qwen3.8-flash-next-q2_0 — waiting one 20s client poll
chat#3 status: 200 model: qwen3.8-flash-next-q2_0 id: chatcmpl-6e0cd8c67532439
PASS chat#3 (same alias, one poll later) served by the OTHER engine
scratch sessions server_ids: ['srv-f1c85327', 'srv-45abb4e8', 'srv-45abb4e8']
PASS sessions registered with real ROW ids (no alias placeholder)
ACCEPTANCE-ALL-PASS
production :8787 after: 200  production :8800 after: 200
md5-after client/config.json: 4df79869f00b12d1e642705406afdce8   (byte-identical)
md5-after real state: 6e861fcc6ca6ce2bea5514b12949e82e           (changed — see below)
scratch ports still listening: []
```

The flagship case is proven end to end against the REAL fleet: the
request named only `Qwen3.8-Flash-Next`; the aliased body splice landed
the engine's OWN id — chat#1 answered from strata (`iq3_s`) and chat#3,
after one re-pin plus one 20 s poll, answered from strata-scanbot
(`q2_0`). The scratch sessions table carried real row ids only.

The real state file's md5 moved because the PRODUCTION arbiter (untouched,
still serving :8787) writes its own tick state throughout the run. The
isolation of the alias write is proven directly: the real state carries
`model_aliases` count 0 after acceptance, while the scratch state (mode
0600) carries the alias with `pinned_server_id: srv-f1c85327` — the
re-pin landed on the scratch copy only. The real `client/config.json` is
byte-identical.

## 5. Degradations, stated honestly

- Load-sensitive timing tests, stated exactly as measured: one earlier
  full-workspace run at HEAD failed exactly one test —
  `client/test/lease-loop.test.ts` "failed executor: job stays in the
  queue" (340/341). The recorded clean gate run above is TEST-EXIT=0
  with all 341 green, and the client workspace then passed 4/4 repeat
  runs. In isolation that test passed 5/5 at HEAD. Separately,
  `client/test/group-kill.test.ts` "group SIGKILL" failed 1 of 3
  isolated repeats at HEAD (a process-group timing test). Both files
  carry ZERO diff from base `ba3b110` — `git diff ba3b110 --
  client/test/lease-loop.test.ts client/test/group-kill.test.ts` is
  empty — and neither imports any alias-touched path (they import
  `src/index.js` and `src/config.js`). I could not reproduce either
  failure on demand at either tree, so I do not claim a base-tree
  reproduction; I claim zero diff on the failing files and no alias
  code in their import graph.
- Scratch-A/B artifact worth recording: a `git archive` copy of the base
  tree fails two revision-reading tests there for an environment reason
  (the archive has no `.git`, so `resolveRevision` legitimately misses).
  That is not a base-tree flake and says nothing about this wave.
- Chunk-boundary sniff gap: DEFERRED to #67 per the owner. The client
  test asserts the fallback PARITY (a name spanning chunks misses the
  sniff and falls to the default target); it does not fix it.
- Dashboard pin controls are buttons (per-pair pin/unpin, `default`).
  The drag-to-re-route posture named in #67 is the visual follow-up;
  the pin state behind it is already the real thing.
- Alias rename is refused in the form (delete + create instead): the
  alias name IS the identity key.
- The scratch daemon ran with the session gate ON (the real posture)
  and `projects: []`, so the acceptance proves the D6 fence on an
  isolated stack rather than on the production lease plane.

## 6. Commit list (this wave)

```
08e633e feat: #66 dashboard Models tab — … (harness caught the const-btns bug live)
55c691c test: #66 server alias tests — arbiter pass + API matrix
cebb974 feat: #66 client alias plane — alias map, precedence, buffered splice forward, 11 tests
7a861db feat: #66 server alias plane — types, loader line, probe-cycle alias pass, /api/aliases
```

Base verified before the first commit: `git log -1` = `ba3b110`. No
push (the supervisor pushes). No secret printed anywhere.

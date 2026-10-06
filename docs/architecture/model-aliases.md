# Model aliases — issue #66 (grilling, 2026-10-06)

The owner ask: one operator-declared name per model, mapped to the
concrete engine models behind it, with operator control over which engine
answers. This plane replaces the row-order pinning of #63 owner decision
2 and retires the `model_preference` deferral. It is also the substrate
the Sessions-connector drag consumes: a re-pin is a write to this plane,
never a per-request hack. Companion: `docs/architecture/aggregate-endpoint.md`
(LOCKED — this doc amends, never restates, and `docs/architecture/mesh.md`
(locked topology). Decisions are LOCKED where the trade-off is clear-cut
for the single operator. The rest are PROPOSED. Nothing here is built.

## The gap, re-verified against the code and the live fleet

Every claim below was re-read on disk (2026-10-06). The issue body's
line numbers were treated as claims. `docs/reports/ISSUE66-GRILL-REPORT.md`
carries the actual probe output.

- The catalog today pins a bare name to the FIRST row in declaration
  order (`server/src/catalog.ts:114-138`, collision rule at 109-111 and
  126). The live proof this is wrong: `srv-watched` (oMLX) declares
  `Qwen3.8-Flash-Next` with no token, and `srv-f1c85327` (strata-scanbot)
  probed the exact same name. The pin lands on oMLX, and a chat request
  for that name through :8800 answers 401 `API key required` while an
  authenticated engine serves the identical model id elsewhere. Row
  reorder is the only operator lever today.
- Three spellings, one model: oMLX declares `Qwen3.8-Flash-Next`,
  strata-scanbot probes `Qwen3.8-Flash-Next`, and urza's llama-swap
  serves `dgx-spark-tyler/qwen3.8-flash-next`. llama-swap is not an
  idlefill row at all, and its probe needs NO token (verified 200).
- The published catalog block (`server/src/api.ts:958`, entry shape
  `server/src/catalog.ts:23-34`) carries name, `server_id`, url,
  `auth_set`, `catalog_source`. The router consumes it verbatim
  (`client/src/aggregate.ts:36-42`, `updateCatalog` at 307-318).
- The router pipes the request body to the engine UNTOUCHED
  (`client/src/aggregate.ts:150-212`, `req.pipe(upstream)` at 211). Any
  alias whose name differs from the engine's own id requires a body
  rewrite. That rewrite does not exist.
- Routing already depends on finding the quoted `"model":"..."` name in
  the body's FIRST chunk (`client/src/aggregate.ts:98-126`, regex at
  114) and puts the bytes back via `unshift` (112). The gate's forward
  on admission pipes that same intact stream (documented invariant,
  `client/src/session-gate.ts:286`).
- Nothing anywhere is named `model_preference` in code — the #63 deferral
  never landed. One comment cites the deferral (`server/src/catalog.ts:11`).
- There is NO arbiter→router push channel (verified again by the absence
  of any route or WS by which the arbiter initiates). The gate learns
  pause/force purely from the daemon's `GET /api/state` poll
  (`client/src/session-gate.ts:24-26` contract, `onStatePoll` at 564,
  enforcement at 300-310). The catalog rides the same poll
  (`client/src/index.ts:1433`).
- Arbiter state is one JSON file, written mode 0600
  (`server/src/state.ts:117`), loaded with tolerate-missing-key lines per
  plane (`server/src/state.ts:80,92`). `ArbiterState.servers` is the
  sibling an alias plane sits beside (`server/src/types.ts:671-673`).

## The rules this doc inherits

From `docs/architecture/aggregate-endpoint.md` (LOCKED) and
`docs/architecture/mesh.md` (locked):

1. The aggregate listener is the router's second loopback port. The
   arbiter inventories, the router routes. (:8800, D1.)
2. Engine tokens stay write-only. They cross to the router only over
   the loopback-scoped `GET /api/server-keys` (D2).
3. 8800 traffic is session traffic: ONE shared gate, one shared slot
   cap, the register heartbeat carries the REAL engine row as
   `server_id` (D3/D5).
4. New wire shape is ADD keys, never renames. Existing keys keep their
   meaning byte-for-byte.
5. State propagates arbiter→router by PULL on the poll (mesh rule: state
   is published, never computed remotely). No push channel exists.

Amendment discipline against the LOCKED doc, stated once: the `/api/state`
catalog block gains a sibling `model_aliases` ADD-key. The `catalog` key
itself, its entries, and every existing key are unchanged. The published
catalog entry shape does not change. D4's merge and collision rules stand
unchanged for names that have no alias. Where an alias exists, this doc
replaces ONLY the row-order pin for that name — which is exactly what #63
owner decision 2 named as its own follow-up knob (`model_preference`).
That knob is hereby retired in favor of this plane.

## D1 — Data shape: top-level `model_aliases`, not per-row preference

**LOCKED.** Aliases live in arbiter state as a new top-level ADD-key
sibling of `servers` (`server/src/types.ts:671-673`):

```ts
/** One engine-model pair: the row plus that engine's OWN model id. */
interface ModelAliasPair { server_id: string; model: string }

/** One operator-declared alias. Key of the map is the alias name. */
interface ModelAlias {
  alias: string;               // the name the catalog publishes
  pairs: ModelAliasPair[];     // insertion order = default pin order
  pinned_server_id?: string;   // the winner the drag writes; absent = first pair
  updated_at: number;
}

// ArbiterState ADD-key (sibling of `servers`):
model_aliases: Record<string, ModelAlias>;
```

Rejected (a) — per-row `model_preference` (the #63 deferred knob): a
per-row knob cannot express a name the engine does not use. The llama-swap
spelling `dgx-spark-tyler/qwen3.8-flash-next` belongs to no row today, and
the alias name `Qwen3.8-Flash-Next` must resolve to pairs on rows whose
declared lists disagree. The knob also cannot hold a pair list, a winner,
or a re-pin target — every one of which the drag needs. The alias plane
subsumes it. (Row ORDER still pins bare non-aliased names — untouched.)

Rejected (b) — aliases inside each `ServerConnection` row: an alias is a
cross-row entity. Storing it per-row splits one logical name across N
rows, forces a merge to read, and makes the winner field ambiguous.

Sanitizers, matched to what the code already enforces: the write-side
sanitizer bounds alias names like the router's `cleanKey` — printable
`\x20-\x7e`, at most 128 chars, drop-don't-reject
(`client/src/aggregate.ts:82-89`). Engine model ids get the sniff regex's
own class: printable except `"` and `\`, at most 80 chars
(`client/src/session-gate.ts:183-187`). `parseModelsPayload` applies no
length bound (`server/src/catalog.ts:58-85`), so the write side supplies
the bound, and every id that must survive the body rewrite already fits
the routing regex class. The `/api/state` publish path drops malformed
entries (drop-don't-reject, like every observed field). The dashboard
POST endpoint validates whole entries and answers 400 — operator form
input is not telemetry, so a wrong entry is told, not swallowed.

Rules: the state loader gains one tolerate-missing-key line for
`model_aliases` (the `session_overrides` pattern, `server/src/state.ts:80`).
The state file already enforces 0600 (`server/src/state.ts:117`). An
alias carries no secret — `server_id` + engine model name only — so the
write-only token posture is untouched by construction.

## D2 — Merge rules: aliases layer OVER the declared+probe merge

**LOCKED.** `buildCatalog` (`server/src/catalog.ts:114-138`) keeps its
exact job for bare names. A separate alias pass runs on the same tick
over the same probe map (`server/src/arbiter.ts:848-866`):

- A pair is CONFIRMED when the row's probed list contains the pair's
  `model` id. Confirmation is per pair, never per alias.
- A pair on a row whose probe FAILED stays publishable with
  `catalog_source: 'declared'` (the honest #64 reading — never falsely
  'probed').
- A pair on a row whose probe SUCCEEDED but does not list the id is
  dropped for that tick. The alias itself never drops — the stored pairs
  stand, publish filters. All pairs dead for a tick = the alias is not
  offered by `/v1/models` and not routed that tick. That is exception-
  only, visible on the dashboard, never a silent half-name.
- Precedence: alias > bare union. A bare probed or declared name that no
  alias names publishes exactly as today — additive, never hidden.
- Name collision between an alias and a bare engine name: THE ALIAS
  WINS, at publish and at routing. The shadowed bare entry keeps its
  exact shape in the `catalog` key (ADD discipline) but the router's
  name→route map resolves the alias first. Rejected: reject the alias at
  write time. The owner's own flagship case IS a same-name alias — the
  demo pair `Qwen3.8-Flash-Next` shadows oMLX's declared bare name of
  the same string. A write-time rejection would reject the fix the issue
  asks for. Rejected: bare-wins — it makes the alias dead the moment any
  probe lists the name, which is exactly the ambiguous case the plane
  exists to control.
- Write-time rejections that DO apply: duplicate alias name, empty
  pairs, a `server_id` with no row, an over-bound or hostile name. Those
  are 400s on the POST (D1 posture).

The oMLX question the brief asks: a pair on a row the probe can never
confirm (401, no token — verified live) is an UNCONFIRMED declared pair.
It is publishable and routable — the declared list is the operator's
own inventory claim (#63 D4) — but it must render `catalog_source:
'declared'` and the dashboard marks it exception-only so the operator
sees the pin rests on a claim, not on a live observation. Whether to
also warn inline at pin time is an owner taste call (open questions).

## D3 — Publication + the body rewrite

**LOCKED, two parts.**

Publication shape. `GET /api/state` gains the ADD-key
`model_aliases` beside `catalog` (`server/src/api.ts:958` is the
`catalog` line, and the new key is its sibling):

```ts
// one published entry per ALIAS, winner pair resolved by D4:
{ name, server_id, url, auth_set, engine_model, catalog_source }
```

The existing `catalog` entries are untouched (`server/src/catalog.ts:23-34`).
The router answers `GET /v1/models` from the merge: alias winners first
(as `{id: alias, object: 'model', owned_by: server_id}` — the
`serveModelList` shape, `client/src/aggregate.ts:229-239`), then bare
entries whose name no alias shadows. Old routers ignore the new key —
back-compat by ADD rule. Dedup: an alias name shadows a bare name, so
one string still appears ONCE in `hermes model`.

The rewrite. A routed alias whose `engine_model` differs from the
requested name must ship the ENGINE's id in the body. Today nothing
touches the body: `forwardTo` pipes `req` verbatim
(`client/src/aggregate.ts:150-212`, `req.pipe(upstream)` at 211). The
seam: the router ALREADY holds the exact quoted name in the first chunk
— the sniff regex (`client/src/aggregate.ts:110-115`) and the gate's
identical one (`client/src/session-gate.ts:183-187`). Pinned mechanics:

1. The regex runs AGAIN on the same already-peeked first chunk, this
   time capturing the byte offset of the name inside its quotes. No new
   buffering: the chunk is already in hand (the #45 unshift posture,
   `client/src/aggregate.ts:112`).
2. The name match is replaced in-buffer by `engine_model`. The D1
   sanitizer bounds ids to the sniff class (no `"` no `\`), so the
   splice cannot break the JSON quoting.
3. The spliced chunk replaces the original in the `unshift`. Everything
   before and after the match rides byte-for-byte.
4. Length: when the client sent `content-length`, the forward sets
   `content-length = original + delta`. When the client sent
   `transfer-encoding: chunked`, the forward keeps chunked (Node does
   this when no length is set). Engines already accept chunked from the
   same SDKs — the build wave pins this with byte-level tests against
   real strata + llama-swap + oMLX.
   AMENDMENT (2026-10-06, live probes): the assumption holds for oMLX
   and llama-swap and FAILS for the llama.cpp family (the 241 row
   answers 400 "No messages provided" for a chunked body, correct model
   + credential, direct and through the router — see Open questions 3).
   OWNER DECISION (2026-10-06): the scoped full-body-buffer posture is
   APPROVED. For the aliased class the router buffers the full body
   (bounded cap, a larger body is rejected), splices, and forwards with
   a correct content-length. Bare-name traffic keeps today's pipe
   posture byte-for-byte. Built in commit `cebb974`.
5. If the sniff did NOT find the name in the first chunk, routing already
   could not have chosen the alias — that request falls to the machine's
   default target exactly as an unknown model does today
   (`client/src/aggregate.ts:226,278`). The rewrite adds NO failure mode
   routing does not already have: rewrite feasibility is identical to
   routing feasibility, because both read the same find in the same
   chunk. The model-field position problem is therefore a PRE-EXISTING
   routing limit, not a new rewrite limit, and the fix for it (full-body
   buffering) is the rejected option below.
6. The gate path is untouched: the spliced bytes are forwarded at
   forward time, parked requests still keep their body unconsumed until
   then (the session-gate invariant, `client/src/session-gate.ts:286` —
   the splice happens in the router's forward seam, after admission).
7. The rewrite happens ONLY on the aggregate listener. The 11435 proxy
   passthrough never rewrites (D6 fence below).

Byte-level tests the build wave must pin: an echo upstream captures the
EXACT bytes received — the engine sees `engine_model` and no alias
string anywhere, every other byte is identical, `content-length` matches
the received byte count, the JSON parses. One test per case: name in
chunk one, name spanning the chunk boundary (sniff misses both today →
fallback — parity, not regression), chunked client body, non-alias
traffic byte-identical to today.

Rejected (a) — buffer the whole body, parse JSON, re-serialize:
Hermes bodies carry megabytes of tool payloads. It costs a full copy per
request, breaks the streaming posture both forwarders document
(`client/src/proxy.ts:10-12`), and re-serialization reorders bytes the
client chose. Rejected (b) — general chunked JSON rewriting: a
streaming field-position tracker is the largest new failure surface in
this design for zero gain over (1-5). Rejected (c) — declare the
engine's own id directly when an alias has exactly one live pair:
this is the tempting small answer and it LOSES to the drag. A re-pin
changes the published name mid-conversation, breaks every profile
config that named the old string, and violates the Sessions requirement
that the agent never learns the engine changed. The alias name must be
the stable contract. The bytes make it true.

## D4 — Selection: explicit `pinned_server_id`, propagated by the existing poll

**LOCKED.** The winner among N live pairs is the stored
`pinned_server_id`. At creation it defaults to the FIRST pair the
operator entered (insertion order — the operator picked deliberately, no
least-loaded machinery this wave). A dead pin falls through: pin absent,
pin's row gone, or pin's pair unconfirmed → first surviving pair wins.
The choice rides the published `model_aliases` block, so the router never
recomputes it (mesh rule 3: published, not computed remotely).

The runtime re-pin write path, one sentence each:

- Dashboard POSTs the new winner (admin-token route, same family as
  `POST /api/sessions/:token/override`, `server/src/api.ts:775`).
- The arbiter stores it in `state.model_aliases` and appends an event
  (the `server_connection_updated` event pattern).
- The router learns it on the NEXT `/api/state` poll — the same pull
  posture as pause/force, whose contract line is
  "override state is learned from the daemon's GET /api/state poll"
  (`client/src/session-gate.ts:24-26`), whose adoption loop is
  `onStatePoll` (`client/src/session-gate.ts:564`), whose catalog twin
  is `updateCatalog` on the same poll (`client/src/index.ts:1433`). NO
  new push channel exists or is built (re-verified: none in the route
  table or WS). Propagation delay ≤ the client poll period (20 s,
  `client/src/index.ts:1110`).
- The agent never learns. The gate key is the alias name (stable), the
  profile config names only the alias, and the register heartbeat's
  `server_id` flips to the new row on the next heartbeat — idle folding
  and preemption follow the new engine honestly.

Rejected: least-loaded selection (the arbiter's load signals are per-
server idle verdicts, not per-model queues — it cannot rank engines for
one model name honestly, and a machine-picked flip violates "the agent
never learns" at the operator level). A per-request arbiter consult adds
a hot-path dependency the D2 pull model exists to avoid. A new
arbiter→router command channel costs strictly more machinery than the
poll that already ships every 15 s arbiter-side and every 20 s
router-side.

## D5 — Authoring surface: a first-class plane, not a row knob

**LOCKED (owner, 2026-10-06).** Posture: aliases are
cross-row entities (D1), so they CANNOT live in the Servers "edit
connection" per-row form (`server/public/index.html:683`, form builder
at 2190-2243). A per-row form cannot own a name that spans rows or pick
a winner between them. Rejected: extend the edit-connection form (the
alias belongs to no single row). Config-file-only authoring is also
rejected (the #63 dashboard is the operator's tool, and the drag will
write the same plane the form writes).

Display shape: a top-level Models tab on the dashboard (the tab +
`data-view` sections, `server/public/index.html:367-370,380` — the
pattern a new view follows). The alias editor follows the established
settings-form disclosure + patch-by-difference posture
(`server/public/index.html:2400-2440`).

The pairing rule (owner, 2026-10-06): every alias pair is EXPLICIT and
verbatim. The form's engine-model picker suggests from the connected
engines' PROBED model lists only — the catalog entries the arbiter
already publishes grouped by `server_id` — and the operator picks the
exact engine id for each pair. The form never proposes an implicit,
fuzzy, or "close enough" match: a bare-name overlap must NOT pair
`Qwen3.8-Flash-Next` with an engine's `...-REAP-288` or `...-coder`
variation, because the operator's expectation of the alias's performance
is per-engine-exact. A stored pair is the picked string, byte-for-byte.
A pair for an engine the arbiter cannot probe is not pickable in the
form. Config-file authoring stays the power path for declared-only
pairs, and they keep the exception-only `declared` marker on the row
(answers open question 2: the marker, no confirmation tick).

The picker reads the SAME `/api/state` the dashboard already polls: the
`catalog` entries grouped by `server_id` plus the `model_aliases` block
— the probe results the arbiter already holds, no new probe, no new
route for the form. Writes go to the admin-token alias POST. Token
fields never appear on this plane (write-only rule untouched — an alias
stores `server_id` + engine id, never a secret).

## D6 — The fence: what stays byte-for-byte

**LOCKED.**

- The :8800 fallback for an unknown or absent model stays the machine's
  `llm_target` (`client/src/config.ts:114,170,231` and the router's
  `target`, `client/src/aggregate.ts:143,226`).
- ONE shared `SessionGate` instance and one slot cap for 11435 + 8800
  (#64 D5). The alias plane adds no gate, no cap, no session concept.
- The register heartbeat keeps reporting the REAL engine row as
  `server_id` — the chosen pair's row, never an alias placeholder
  (`client/src/index.ts:1659,1664` and #64 D5's correctness rule).
  Idle folding and preemption stay truthful against the engine the
  bytes actually hit.
- The 11435 listener's passthrough and `/s/<token>` behavior stay
  byte-for-byte (#63 D6). No rewrite ever happens there.
- Tokens stay write-only: same state file, same strip in `serverView`
  (`server/src/api.ts:243-246`), same loopback-only key pull
  (`server/src/api.ts:676-685`, `isLoopbackAddress`
  `server/src/catalog.ts:147-153`). Alias writes echo no secrets.
- The `catalog` ADD-key and every existing `/api/*` shape are unchanged
  (amendment discipline above). Mesh federation carries no alias data
  (aliases are local machine state, and the mesh plane is coarse by rule).
- The lease engine, budgets, the job flow, and `parseModelsPayload` /
  `modelsProbeUrl` stay as built (#64).

## Rules (restated crisp)

1. An alias is operator-declared state: name → engine-model pairs + one
   pinned winner. It lives in arbiter state as a top-level ADD-key.
2. The probe CONFIRMS pairs per row. A vanished pair drops the pair,
   never the alias. An unprobeable row's pairs publish as 'declared'.
3. Aliases layer OVER the bare catalog. Alias beats bare at publish and
   routing. Bare names without aliases behave exactly as #64 built.
4. The published block gains `model_aliases` as an ADD-key. Existing
   keys and entry shapes never change.
5. The router REWRITES the body's `model` to the engine's own id, by a
   bounded splice in the first sniffed chunk, before forwarding. Rewrite
   feasibility equals routing feasibility — same find, same chunk.
6. The winner is an explicit stored field. Re-pins propagate arbiter→
   router by the existing `/api/state` poll, the pause/force posture.
   The agent and every profile config see one stable name.
7. The fence: :8800 fallback, one shared gate, real `server_id` on
   heartbeats, 11435 untouched, tokens write-only, /api/server-keys
   loopback-only.

## What changes vs what stays untouched

Changes (the build wave, after this grill):

- `server/src/types.ts`: `ModelAlias` + `model_aliases` on `ArbiterState`.
- `server/src/state.ts`: one tolerate-missing-key line for the new key.
- `server/src/arbiter.ts`: the alias pass over the same probe map, the
  winner rule, the alias POST handler.
- `server/src/api.ts`: `model_aliases` published on `/api/state` beside
  `catalog` and one admin-token alias write route.
- `server/public/index.html`: the Models authoring view (D5 shape).
- `client/src/aggregate.ts`: the alias map beside `catalogByName`, the
  merged `/v1/models`, the first-chunk splice + length rule.
- Suite: pair confirm/drop, alias-beats-bare, winner fall-through, poll
  propagation of a re-pin, and the byte-level rewrite family of D3.

Untouched (fenced by D6 and the inherited locks):

- `buildCatalog`'s bare-name merge and collision rule.
- The `catalog` key's shape and every existing `/api/*` route.
- The gate, the slot cap, the 11435 listener, `/s/<token>`, leases.
- The token plane end to end.

## Open questions (owner input)

1. ~~D5 display shape~~ — LOCKED by the owner 2026-10-06: top-level
   Models tab. Pairs are picked from the connected engines' probed model
   lists, explicit and verbatim (see D5).
2. ~~The unconfirmed-pair pin (oMLX today)~~ — LOCKED by the owner
   2026-10-06: un-probed pairs are not pickable in the form. The
   exception-only `declared` marker carries it (no confirmation tick).
3. ~~Chunked-forward acceptance~~ — LOCKED by the owner 2026-10-06:
   the scoped-buffer call recorded below is APPROVED. Evidence was
   gathered 2026-10-06. The doc's assumption was REFUTED by live probes. The design ships
   `transfer-encoding: chunked` for chunked clients with a spliced body,
   assuming "engines already accept chunked from the same SDKs." They do
   not, all of them:

   - llama.cpp family (the 241 row DIRECT, the exact class strata
     fronts): content-length → 200. Chunked → **400 "No messages
     provided"** — the model was correct, the credential was correct,
     the body framing alone caused it, with AND without
     `Expect: 100-continue`. llama.cpp drops chunked request bodies.
   - oMLX: accepts chunked (200).
   - llama-swap: accepts chunked (parsed the body. The 404 was its
     model-routing miss, not a framing failure).
   - The router is INNOCENT: a replica of the peek/unshift/copy-all
     posture delivered a clean, parseable 73-byte body to an echo
     upstream even when the client sent chunked (`peek-proof.js`,
     scratch). The 400 is the engine's parser, not a router corruption.
   - Real SDK clients send content-length, not chunked: Node fetch with
     a string body (the AI SDK posture) puts `content-length: 57`, no
     `transfer-encoding` (probed live). `curl -T -` is what forces
     chunked. So the chunked class is rare in production traffic.

   Pre-existing consequence, unrelated to aliases: a chunked client
   through :8800 routed to the llama.cpp row ALREADY fails today with
   400 (content-length contrast: 200, same body). The splice does not
   create this wall. It inherits it.

   The call for the owner: when the sniffed name matches an alias, the
   router buffers the FULL body (bounded cap, reject over it), splices,
   and forwards with a correct content-length. That normalizes framing
   for the llama.cpp family and stays scoped: bare-name traffic keeps
   today's pipe posture byte-for-byte, and real SDK clients
   (content-length senders) only pay a body copy when the model is
   aliased. The rejected option (a) was buffering EVERYTHING. This
   buffers only the aliased class. NOTE: forward-time buffering does
 NOT close the chunk-boundary sniff gap (the sniff feeds ROUTING,
 which already happened). Closing that gap needs a bounded
 multi-chunk peek at the SNIFF seam instead (peek more chunks,
 unshift them all back — the gate's body-whole invariant holds).

 OWNER DECISION (2026-10-06, second call): the bounded multi-chunk
 peek at the sniff seam is DEFERRED to #67, which owns the drag/pin
 work in the same region. The #66 wave keeps the first-chunk sniff
 byte-for-byte. Its suite asserts the fallback parity — a name
 spanning the chunk boundary falls to the default target exactly as
 an unknown model does today.

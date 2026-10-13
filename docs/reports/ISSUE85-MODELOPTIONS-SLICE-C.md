# #85 slice C — Model access cross-check: `GET /v1/models` + `GET /api/model/options` per profile

**Status:** delivered on branch `agent/85-slice-bc` (worktree slice; merge to
main by the coordinator). Rides the slice-B connector commit on this branch.

**Naming (inherited from D/B):** the wire keys are `hermes_models` +
`hermes_model_options` — this is HERMES' model surface; a bare `models` /
`model_options` key never rides the register body (pinned by a daemon test —
bare `models` would collide with idlefill's `servers[].models`).

## What shipped

Read-only per-profile model access beside the Models tab's alias cards.
Transport: the client's connector round harvests `GET /v1/models` (what the
gateway SERVES) + `GET /api/model/options?include_unconfigured=false` (what
each profile could SWITCH TO) per keyed profile and publishes the sanitized
blocks as ADD-keys on the register heartbeat — the exact slice-B discipline:
one bounded GET per surface per keyed profile per connector round, zero
requests while down/unkeyed, last-known-wins across rounds, replace-on-answer
per profile, ABSENT ⇒ the register body byte-for-byte today's shape.
**Read-only: no model set/switch verb exists anywhere in the plane.**

- `client/src/hermes-gateway.ts` — the slice-C section: `modelsPath`/
  `modelOptionsPath` (home store + `/p/<profile>` mirror; the options path
  carries the `include_unconfigured=false` filter — the gateway's own
  honest payload: 56→7 providers live), `sanitizeHermesModel`/
  `sanitizeHermesModelProvider` (drop-don't-poison; an
  `authenticated:false` provider drops WHOLE — it cannot serve), the
  `fetchModelOptionsSurface` helper (the top-level `{providers:[…]}`
  envelope — NOT the slice-B list envelope — with a per-profile 200-name
  budget), the per-round fetch inside `fetchRound`, and
  `HermesGatewayConnector.modelsSnapshot()/modelOptionsSnapshot()`.
- `client/src/index.ts` — `hermesGatewayHostFacts()` gains the two ADD-keys:
  `hermes_models`/`hermes_model_options` ride ONLY when a round answered
  non-empty rows.
- `server/src/types.ts` — `HermesModelRow` + `HermesModelProviderRow` + the
  client-row fields (doc-commented like the sibling ADD keys).
- `server/src/arbiter.ts` — `cleanHermesModels` (≤64 rows, id ≤128 required,
  root optional ≤128, decoration has no landing place) and
  `cleanHermesModelOptions` (≤24 provider rows, slug ≤64 required, exact
  booleans, individually-checked names ≤128 capped 24/provider AND a 200-name
  stored budget, sane `total_models ≤10000`; the pricing/endpoint/config bait
  — `api_url`/`capabilities`/`aliases`/`free_tier`/`featured_models`/
  `unavailable_models`/`source`/display `name` — has NO landing place);
  `registerClient` stores on a valid report, ABSENT never clears. The
  difference from the client edge, recorded: the CLIENT drops an
  `authenticated:false` provider before it ever rides; the ARBITER (untrusted
  input, no authority to re-interpret the flag) stores the exact boolean —
  the honest pass-through is the edge-sanitizer posture (hostile extra
  members still drop).
- `server/src/api.ts` — the register route accepts the keys as plain array
  pass-throughs. No roster-route change: the Models join reads the EXISTING
  `/api/state` client rows (the roster route is the Agents join — slice B).
- `dashboard/src/lib/api.ts` — `HermesModelRow`/`HermesModelProviderRow` +
  optional `ClientRow` fields.
- `dashboard/src/lib/hermes-model-access.ts` — pure helpers: the
  `HERMES_MODEL_ACCESS_LABEL = "Hermes model access"` copy constant (the
  "Hermes jobs"/"Hermes capabilities" naming precedent, pinned by test),
  profile grouping (stamped profile; unstamped ⇒ `default`, never a
  name-guess), `idlefillWiredNames` (alias names ∪ engine inventory names —
  the vocabulary the router answers to, compared lower-cased), `servedModelGaps`
  (EXACT membership only — the #66 D5 no-fuzzy-match posture — deduped,
  capped at 12 chips so a pathological list stays a hint),
  `currentProviderOf` (the single exact `current` row; zero or several ⇒
  undefined, never a guess).
- `dashboard/src/views/Models.tsx` — a read-only "Hermes model access"
  section under the alias cards: one card per reporting client, one row per
  profile: served-model chips (gap = a served id no alias/engine names →
  warn chip, explanation in the tooltip), the current provider chip, its
  bounded model-name slice (+ "more" honesty), and a
  "+N switchable providers" count (slugs in the tooltip). Exception-only: a
  machine whose client never reported the blocks renders NOTHING. Zero
  buttons (pinned by a source-pin test).
- Test files are picked up by the `test/*.test.ts` globs (no package.json
  registration needed in this tree).

## Live shape evidence (read-only curl against the running gateway
`http://127.0.0.1:8642`, Hermes **0.21.7**; the operator's `default` key read
locally from `~/.idlefill/hermes-gateway-keys.json` — the key value NEVER
pasted anywhere)

- `GET /v1/models` (keyed) → `200 {object:'list', data:[{id:'hermes-agent',
  object:'created', owned_by, permission, root, parent}]}` — the OpenAI-compat
  served list (the gateway answers as its own agent model). Auth: 401 unkeyed.
- `GET /api/model/options` (keyed) → `200 {model, provider, providers:[{slug,
  name, is_current, is_user_defined, models:[str…], total_models, source,
  api_url, native_catalog_empty, authenticated, free_tier, pricing_pending,
  unavailable_models, capabilities, featured_models, aliases}]}` — 56
  providers UNfiltered; with `?include_unconfigured=false` → **7 providers /
  104 model names** (the connector always sends the filter).
- Per-profile mirrors `/p/<profile>/v1/models` + `/p/<profile>/api/model/
  options` exist and answer 401 to a FOREIGN (default-home) key — the #73
  per-profile Bearer rule holds for these routes too; unkeyed profiles get
  ZERO requests.

## Wire shapes

Register heartbeat (client → arbiter), ADD-keys only:

```
hermes_models?:         [ { profile?, id, root? } ]                          // id ≤128
hermes_model_options?:  [ { profile?, slug, current?, authenticated?,
                            models?, models_truncated?, total_models? } ]    // ≤24 names/provider
```

Absent (connector off, never polled, all profiles unkeyed/failed/malformed,
empty stores) ⇒ the keys are OMITTED — the body byte-for-byte today's shape;
an old arbiter never reads the keys anyway. `WIRE_PROTOCOL` stays 1.

## Caps + sanitizers chosen (ledger-style, drop-don't-poison)

- Client: ≤64 served rows and ≤24 provider rows per profile per round;
  published totals ≤64 served and ≤48 provider rows; names ≤24 per provider
  (over-cap names drop, `models_truncated: true` rides honestly), ≤200 names
  per profile (a budget, not a cliff — the overflow provider's row keeps
  counts, loses names, and says it was truncated); id/root/name caps 128,
  slug 64, profile 64; `total_models` a sane integer ≤10000; EXACT booleans
  for `current`/`authenticated`; `authenticated:false` (definitively cannot
  serve) drops the provider WHOLE. NEVER published: the OpenAI-compat
  decoration (`created`/`owned_by`/`permission`/`parent`), the provider
  display `name` (slug decoration), and the pricing/endpoint/config bait
  (`api_url`, `capabilities`, `aliases`, `free_tier`, `pricing_pending`,
  `featured_models`, `unavailable_models`, `source`,
  `native_catalog_empty`, `is_user_defined`).
- Arbiter: independent re-sanitize at the edge (untrusted client): same caps
  (64/24/200/10000), hostile bait members have no landing place, non-array /
  all-dropped ⇒ ABSENT, ABSENT never clears. The `authenticated:false`
  drop is a CLIENT-edge decision (capability truth); the arbiter stores the
  exact flag rather than re-interpreting it (recorded difference above).
- Dashboard: renders what arrived; the ONLY diff-style claim is the served-
  model gap against `idlefillWiredNames` — the provider catalog is rendered
  as counts/names, NEVER name-by-name diffed against GGUF inventory ids
  (different vocabularies; a 104-name wall is noise, not signal — recorded
  refusal).

## Merge semantics (identical to slice B)

Cross-round last-known-wins: a round that did not answer for a profile
(down / 401 / 500 / malformed envelope) leaves that profile's stored lists
untouched. A 200 with a well-formed envelope is the COMPLETE truth for that
profile (both routes unpaginated — verified live in the shape evidence), so
it REPLACES the stored lists; an empty answer publishes NOTHING (absent,
never a `[]` dump).

## Harness + gates

- `client/test/hermes-model-access.test.ts` — 11 tests: sanitizers vs the
  live-pinned served/options envelopes (bait members NEVER published, the
  authenticated:false whole-row drop, exact-boolean rule, caps);
  `modelsPath`/`modelOptionsPath` + the query filter; connector: ONE GET per
  surface per profile per round (cadence gate), the query rides EVERY options
  request, per-profile keys, unkeyed ⇒ ZERO requests, down ⇒ ZERO, 401/500/
  malformed ⇒ last-known stands, 200 replaces, empty ⇒ publish nothing, all
  four count caps incl. the exactly-consumed 200-name budget + honest
  truncation, poison drops individually; daemon-level: connector off ⇒
  `hermes_models`/`hermes_model_options` NEVER in any register body (byte-
  for-byte), on ⇒ they ride under exactly those keys and NEVER bare
  `models`/`model_options`, bait scan CLEAN on the whole body.
- `server/test/hermes-model-access.test.ts` — 4 tests through the real
  Fastify app: valid stores + echo on `/api/state` clients (the Models
  join); drop-don't-poison + bait-nowhere-to-land + individually-dropped
  name entries; absent-never-clears + old-shaped body leaves the row byte-
  for-byte; `clean*` unit caps (64 rows, 24 provider rows, exact-200 stored
  name budget, trimmed/over-cap member rules).
- `dashboard/test/hermes-model-access.test.ts` — 6 tests: the label constant
  is exactly "Hermes model access" and the Models section source-pin has NO
  Button/onClick (read-only pinned); grouping by stamped profile + the
  unstamped ⇒ default rule; the exception-only gate; `idlefillWiredNames` =
  aliases ∪ engine inventory (case-insensitive); the EXACT-match gap rule
  (prefixes are NOT matches) + dedup + the 12-chip cap; `currentProviderOf`
  single-current-only.

Gates (this commit): `npm run test` exit 0 — server 503/503 (499 + 4),
client 295/295 (284 + 11), dashboard 94/94 (88 + 6), cli 139/139, career-ops
17/17, noop 2/2, shell-ui 3/3, fleet 54/54 = **1107 total, 0 failures** (main
baseline 1067). `npx tsc --noEmit` clean for client, server, dashboard.
`npm run build` exit 0; `dashboard/dist` regenerated and committed (bundle-
drift gate). No tauri sources touched ⇒ cargo gates not applicable.

## Live end-to-end verification (scratch harness, cleaned up)

Real `ClientDaemon` + real arbiter app on scratch loopback :18901 + the
operator's REAL gateway at :8642 (connector's own key-file posture; read-only
GETs; the production arbiter :8787 / aggregate :8800 / live daemon untouched)
— the same harness as slice B, re-run on this commit:

- the stored client row carried `hermes_version` 0.21.7, `hermes_jobs` (D),
  `hermes_toolsets` 28 rows (B), and **`hermes_models` 1 row
  (`hermes-agent`, root `hermes-agent`)** + **`hermes_model_options` 7
  provider rows** — the query filter worked live (56→7), `strata` carries
  `current:true`, `nous` rode exactly 24 names with `models_truncated:true`;
- `hermes_skills` still ABSENT (the live route 500s — slice-B behavior
  intact, nothing guessed);
- JSON scans of the full stored row: `api_url`/`capabilities`/`free_tier`/
  pricing bait ABSENT; toolset decoration ABSENT; the gateway API key value
  NEVER appears;
- scratch arbiter closed, daemon stopped, temp dirs removed.

## Deliberately NOT in this slice

- Any model set/switch verb (`/api/model/set` and friends stay entirely
  outside the plane — read-only strip).
- The `authenticated:false` provider rows: the connector refuses them (they
  cannot serve); the arbiter never re-drops (it stores honest flags).
- A name-by-name diff of the provider catalog against engine inventory —
  refused as noise (different vocabularies); the only gap claim is the
  served-model one, exact-match only.
- Pricing/endpoint/config detail (api_url, capabilities, aliases, free_tier,
  featured_models, …) — bait for the sanitizer tests, NEVER published.
- A roster-route join for models: the Models tab reads the existing
  `/api/state` client rows; the roster route stays the Agents join.
- WIRE_PROTOCOL bump (stays 1, the ADD-keys precedent).

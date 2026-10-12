# Model capabilities: context, modalities, and alias↔engine misalignment (issue #87, 2026-10-11)

## The owner ask

The strata engines serve vision, and the hypnotist profile (like any
consumer of the aggregate endpoint) cannot see that: the catalog probe
parses model NAMES and discards everything else, and `:8800 /v1/models`
advertises `{id, object, owned_by}` only. The owner asks (2026-10-11):

1. Advertise per-model metadata — context size and what inputs/outputs the
   model supports (modalities) — through the idlefill surfaces.
2. Reveal when the inference engine mis-aligns with the model alias
   configured in idlefill (a different variant id answering; pairs of one
   alias that disagree on what they can actually do).

## The gap, re-verified against the code and the live fleet (2026-10-11)

- The engines ALREADY publish capabilities and idlefill throws them away.
  Live probe of the fleet's `/v1/models` (credentialed, the same fetch
  `probeCatalog` runs — `server/src/arbiter.ts:1410-1446`):
  - strata urza: `{"id":"qwen3.8-flash-next-iq3_s","meta":{"n_ctx":262144},"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}`
  - strata scanbot: same shape, `{"id":"qwen3.8-flash-next-q2_0",...,"input_modalities":["text"]}` —
    **scanbot does NOT currently serve vision** (engine launched without a
    projector). The owner's premise ("both strata instances support
    vision") is contradicted by the engine's own payload; this plane makes
    that visible instead of assuming it. Engine-side fix (mmproj) is owner
    work, not idlefill work.
  - omlx watched row: `{"id":"…","max_model_len":262144}` — no modalities.
  - llama-swap row: down at verification time; its upstream is
    llama.cpp-family, so the same `meta`/`architecture` parse applies.
- `parseModelsPayload` (`server/src/catalog.ts:58-85`) reads ONLY `id`/
  `name`; the fetcher type is `(url, auth) => Promise<string[]>`
  (`catalog.ts:41`); the per-tick `probed` map, `lastProbed`,
  `probedModels()`, `buildCatalog`, `buildAliasBlock`, and the
  `serverView` inventory (`server/src/api.ts:282-297`) are all `string[]`
  end to end. Repo-wide: zero reads of `n_ctx`/`max_model_len`/
  `architecture`/modalities anywhere.
- `serveModelList` (`client/src/aggregate.ts:543-556`) advertises only
  `{id, object, owned_by}` — no capabilities, and (deliberately, #66)
  never the winner's variant id.
- The alias→variant fact (`Qwen3.8-Flash-Next` → `…-q2_0` / `…-iq3_s`)
  exists ONLY inside `engine_model` on the published entry
  (`server/src/arbiter.ts:251-267`) and the Models-tab pair rows; nothing
  calls out that the answering engine id differs from the alias name, and
  nothing calls out that the two pairs of one alias DISAGREE on modality.
- Inherited rules: `model-aliases.md` D1–D6 (aliases are arbiter state,
  ADD-key wire discipline, splice, fence) and `engine-health-routing.md`
  D1–D5 (routing health = this tick's `/v1/models` probe) stand unchanged.
  This plane amends their SHAPES (ADD keys only), never their routing.

## Decisions

### D1 — Capture, never fabricate: a `ProbedModel` entry replaces the bare string **LOCKED**

```ts
// server/src/catalog.ts
export interface ProbedModel {
  name: string;
  context_length?: number;      // meta.n_ctx (llama family) | max_model_len (omlx)
  input_modalities?: string[];  // architecture.input_modalities
  output_modalities?: string[]; // architecture.output_modalities
}
export type ModelsFetcher = (url: string, auth?: string) => Promise<ProbedModel[]>;
```

Best-effort parsing, drop-don't-reject: a malformed/absent field just
omits the key. Declared (operator-listed) names NEVER gain capability
keys — a declaration is a routing claim, not a capability claim. One
credentialed GET per row per tick, exactly as today (no extra probes;
`/metrics` untouched).

### D2 — Capability rides every publish surface as ADD keys **LOCKED**

`CatalogEntry` and the published `ModelAliasEntry` gain optional
`context_length`, `input_modalities`, `output_modalities` — omitted when
unknown, so a fleet that exposes nothing publishes byte-for-byte today's
shape. The alias entry's capabilities come from the WINNER pair's
confirmed probed entry ONLY (the router must never advertise a capability
of an engine it is not routing to). `GET /api/servers` /
`/api/state.servers[].models[]` entries gain the same ADD keys from the
row's last-good probe. The state file is untouched — capabilities are
ephemeral like every other observed field.
AMENDMENT (2026-10-12, alias-stability D1 — LOCKED, narrow): the
winner-only rule stands; the SOURCE widens for an unconfirmed winner. A
`mismatch` or `declared` winner inherits `context_length` /
`input_modalities` / `output_modalities` from the LAST-GOOD probe entry
for ITS OWN row+model (the per-model twin of #67's `lastProbed` map —
`lastProbed` itself replaces per-row per success, so on a contradiction
tick it by construction no longer names the contradicted model); absent
→ keys omitted, exactly as before. This is carried truth (an entry the
engine really served once), never fabricated — the D1 capture rule
stands — and the entry carries `degraded: true` so the consumer sees the
caps rode a last-good observation, not this tick's probe.
`probedModels()`, pin legality, and the serverView inventory stay exactly
`lastProbed` — the carry-over map feeds the alias publish and nothing
else.

### D3 — `:8800 /v1/models` advertises capabilities, never the variant **LOCKED (owner, 2026-10-11)**

The advertised `data` entries gain `context_length`, `input_modalities`,
`output_modalities` (ADD keys, omitted when unknown) from the alias
entry. The engine's variant id (`qwen3.8-flash-next-q2_0` answering
`Qwen3.8-Flash-Next`) stays **dashboard-only** disclosure — the alias
surface remains the operator's curated name.

### D4 — Misalignment is derived at display, not stored **LOCKED**

No new state, no new arbiter keys. The dashboard Models tab derives, per
alias:

- **variant chip** — winner `engine_model !== alias name` → shows the
  engine id actually answering (e.g. `variant: qwen3.8-flash-next-q2_0`);
- **modality chips per pair** — each pair's engine looked up in its row's
  probed inventory (from `servers[].models[]`); a pair on a
  probe-blocked/declared row renders "unknown", never assumed;
- **divergence warning** — when the pairs of one alias disagree on a
  modality (urza serves image, scanbot does not), a loud `vision 1/2`
  style chip naming which pair is missing it. Routing already moves
  health-first (engine-health-routing D2); the chip tells the operator
  WHY a pin is unsafe for multimodal traffic.

### D5 — Fence **LOCKED**

Routing, splicing, gating, pinning, the D6 default-target fence, and the
11435 proxy are untouched byte-for-byte. The probe stays the SAME one
fetch per row per tick; only its PARSE and downstream shapes widen.
Tokens never ride any capability surface (auth_set posture unchanged).

## Rules (restated crisp)

1. `ProbedModel` end to end: fetcher, per-tick `probed` map, `lastProbed`,
   `probedModels()`, `buildCatalog`, `buildAliasBlock`, `serverView`.
2. Capability ADD keys: `context_length`, `input_modalities`,
   `output_modalities` — on CatalogEntry, ModelAliasEntry (winner-only),
   servers[].models[], and the :8800 advertise. Absent = unknown, always.
3. Declared lists never claim capabilities.
4. Variant disclosure: dashboard only (:8800 /v1/models stays name-clean).
5. Misalignment = derived from published facts (engine_model vs name,
   per-pair capability lookup); nothing new is persisted.

## What changes vs what stays untouched

- CHANGES: `server/src/catalog.ts` (parse + types), `arbiter.ts`
  (probeCatalog/lastProbed/probedModels/buildAliasBlock shapes +
  ModelAliasEntry ADD keys), `api.ts` serverView inventory,
  `client/src/aggregate.ts` (entry types + serveModelList), dashboard
  Models + InferenceServers views + lib types, tests.
- UNTOUCHED: routing/splice/gate/pin/chain, state file schema, feed and
  load fetchers, 11435 proxy, token posture.

## Open questions (owner input)

- None open: variant-disclosure=dashboard-only and the doc+build posture
  were answered live (2026-10-11). scanbot's missing projector is an
  engine-launch fix outside this plane.

# #87 — Model capabilities: context, modalities, alias↔engine misalignment (2026-10-11)

Design: `docs/architecture/model-capabilities.md` (D1–D5, owner decisions folded in:
variant disclosure stays dashboard-only; capabilities ride every publish surface
as ADD keys).

## Trigger (live)

The hypnotist profile's 502 post-mortem surfaced two truths: the alias
`Qwen3.8-Flash-Next` routes to strata llama.cpp variants (`qwen3.8-flash-next-iq3_s`
/ `q2_0`), and the engines' own `/v1/models` payloads already carry
`meta.n_ctx` + `architecture.input_modalities` — which idlefill's probe parsed
away (names only, `server/src/catalog.ts`). Live probe at verification time also
contradicted the owner's premise: **scanbot reports `input_modalities: ["text"]`**
(no projector) while urza reports `["text","image"]`.

## What was built

**Server (probe → publish):**
- `ProbedModel {name, context_length?, input_modalities?, output_modalities?}`
  replaces the bare string end to end: `ModelsFetcher`, the per-tick `probed`
  map, `lastProbed`/`probedModels()`, `buildCatalog`, `buildAliasBlock`,
  the `serverView` inventory. `parseModelsPayload` captures llama-family
  `meta.n_ctx` / omlx `max_model_len` (first positive finite, floored) and
  `architecture.input_modalities`/`output_modalities` (trimmed, empties
  dropped) — malformed field drops the field, never the entry, never a throw.
- `CatalogEntry` + published `ModelAliasEntry` gain the caps as ADD keys;
  the alias entry takes them from the WINNER pair's confirmed probed entry
  ONLY (never a losing pair; a `declared` winner omits every cap key — a
  declaration is a routing claim, not a capability claim).
- `GET /api/servers` / `/api/state` `servers[].models[]` entries carry the
  caps from the row's last-good probe. State file untouched (ephemeral like
  the rest of the observed plane).

**Client (`:8800` aggregate):**
- `serveModelList` advertises `context_length`/`input_modalities`/
  `output_modalities` per alias, omitted when unknown. The winner's variant
  id is NEVER disclosed on the agent surface (D3, owner 2026-10-11).

**Dashboard (misalignment is DERIVED, nothing stored):**
- Models tab: per-pair cap chips (ctx + non-text modality) joined from the
  row's probed inventory; the winner line's engine id turns warn-colored
  when it ≠ the alias name (the splice/variant case, title names it); the
  footer gains a loud divergence chip per non-text modality — `image 1/2`
  with the pairs that CANNOT serve it named — the urza-vs-scanbot gap
  renders exactly as that. The pair pick-list labels carry the caps, so a
  new pair is never chosen blind.
- InferenceServers: model chips append the ctx word + modality markers,
  caps in the chip title. `fmtCtx` in `lib/format.ts` (262144 → "256k").

## Gates

- server 459/459 (new: parse caps matrix, buildCatalog declared-never-claims,
  alias winner-caps-follow-the-winner + declared omit; widened fakes carry
  entries, existing alias/chain/pin tests byte-for-byte), client 256/256
  (new: advertise ADD keys + omit-when-unknown + variant-never-leaks),
  all other workspaces green; `npm run build` green (incl. dashboard
  `tsc --noEmit` + vite); served bundle regenerated per the bundle rule.

## Live verification (post-restart of com.sam.idlefill.server + .client)

- `:8800 /v1/models` (hypnotist agent key): `Qwen3.8-Flash-Next` advertises
  `context_length: 262144, input_modalities: ["text"], output_modalities:
  ["text"]` — the WINNER (scanbot) truth, scanbot's missing vision made
  visible to the consumer; `Qwen3.8-27B` (declared winner) carries NO cap
  keys; no variant id appears anywhere on the surface.
- `/api/state.model_aliases`: caps ride the resolved entry, winner-only.
- `servers[].models[]`: omlx rows gain `context_length` (max_model_len);
  urza gains `["text","image"]`; scanbot honest `["text"]`.
- The scanbot projector itself remains an engine-launch fix (owner side);
  #87's job was to make the gap visible, and it is.

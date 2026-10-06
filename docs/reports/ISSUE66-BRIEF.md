# Issue #66 brief (mirror of the Forgejo issue body)

## Why

Owner decision (2026-10-05, grill #63) resolved bare-name collisions by **row declaration order**. That was the cheapest first wave. It is now visibly wrong in two ways:

1. llama-swap's copy of the model is literally `dgx-spark-tyler/qwen3.8-flash-next` — a different string than oMLX's `Qwen3.8-Flash-Next`. The catalog keeps both (`:8800/v1/models` shows them as two options). The operator has one model with three spellings across three engines.
2. The operator cannot say *which* engine answers a model name, and cannot fix the `srv-watched` case (row order pins `Qwen3.8-Flash-Next` to a keyless oMLX row while strata has a credentialed one). Row reorder is the only control today.

The owner wants: **a way to add model aliases and select which models from each inference engine resolve to each alias.** This is also the substrate the Sessions-connector drag (separate issue) needs: "drag a connector from one engine to another… which need not inform the agent the model behind the scenes has changed" is an alias-to-row re-pin, not a per-request hack.

## Proposal to grill

An alias is an operator-declared name that maps to one or more concrete engine models (engine row + the engine's own model id). The published catalog serves alias names. Collision order and the model_preference follow-up from #63 are both replaced by this plane if it lands.

## Decisions to settle (each against real code)

- **D1 — data shape.** Where aliases live: a new top-level `model_aliases` state in `server/src/store`-style state (sibling of `servers`), vs. per-row `model_preference` (the #63 deferred knob — argue why the alias plane subsumes or coexists with it). `server/src/types.ts` `ServerConnection` + `server/src/config.ts` loader posture. ADD-key discipline everywhere.
- **D2 — merge rules vs the probe layer.** Today: probe success REPLACES the declared list (`server/src/catalog.ts:99-138`). With aliases: an alias names engine-model pairs. The probe confirms each pair still exists (a vanished pair drops that engine from the alias, never the alias). Unaliased probed names still publish bare (additive, never hides what works). State the precedence: alias > bare union, and what a name collision between an alias and a bare engine name does (alias wins? reject at write time?). Write-time validation beats runtime ambiguity.
- **D3 — publication.** The `catalog` ADD-key on `GET /api/state` (`server/src/api.ts`, catalog block) + the router's `AggregateCatalogEntry` (`client/src/aggregate.ts:36-42`) need the alias mapping without breaking today's shape. `GET /v1/models` on :8800 answers aliases (deduped, one name), `owned_by` = chosen engine. Router forward sends the engine's OWN model id in the body (the alias name must be rewritten in the JSON body — this is new: today the router forwards the body verbatim, `aggregate.ts` forwardTo pipes `req` untouched). Pin who rewrites (router, streaming-safe — the #45 unshift posture) and the byte-level test.
- **D4 — selection policy.** Alias with N engines: which one wins today (first? least-loaded? explicit `preferred` field the operator sets)? The drag feature (Sessions issue) mutates exactly this field at runtime — the arbiter stores it, the router learns via the poll, same override posture as pause/force (`client/src/session-gate.ts:23-26`: override state learned from the `GET /api/state` poll). No arbiter→router push channel exists (#44 report says so). Re-affirm pull-based propagation.
- **D5 — dashboard surface.** Where aliases are authored (Settings? a new Models tab?) using the existing edit-connection form pattern (`server/public/index.html`, the `settings-form`/`edit connection` seam ~line 640). CRUD posture: write-only token rule untouched. Alias writes never echo secrets. The model list per engine comes from the probe results the arbiter already holds.
- **D6 — fence.** :8800 fallback to `llm_target`, the shared gate (D5 of #64), 11435 untouched, `session_id` register posture unchanged. The register heartbeat keeps reporting the REAL engine row (`server_id`), not the alias — idle folding/preemption must stay truthful.

## Live facts to verify during the grill

- `:8800/v1/models` today (verified 2026-10-06): `Qwen3.8-Flash-Next` (srv-watched, declared), `Qwen3.8-Flash-Next-REAP-288-MLX-4bit` (srv-watched, declared), `qwen3.8-flash-next-iq3_s` (srv-45abb4e8 strata, probed), `qwen3.8-flash-next-q2_0` (srv-f1c85327 llama.cpp 10.10.10.241:8080, probed).
- llama-swap (`http://100.105.225.1:11434/v1`, no auth) serves: `Qwen3.8-27B`, `dgx-spark-tyler/qwen3.8-flash-next`, `mac-m4-mtplx/mtplx-qwen38-27b-optimized-speed`, `qwen38-27b` — and llama-swap is NOT an idlefill row at all. An alias demo target: one alias `Qwen3.8-Flash-Next` -> {oMLX: `Qwen3.8-Flash-Next`, strata: `Qwen3.8-Flash-Next`, llama-swap: `dgx-spark-tyler/qwen3.8-flash-next`}.
- The oMLX probe today: oMLX now requires an API key (`API key required`, direct 401) and its row has no token -> `catalog_source: declared` for its two models. The grill should state whether a keyless row that fails probe but declares names is honest or misleading in an alias context (a pair the probe can never confirm).

## Deliverable

`docs/architecture/model-aliases.md` (or an addendum section in `docs/architecture/aggregate-endpoint.md` — grill decides which. The aggregate doc is LOCKED, so an addendum must not restate it) + report in `docs/reports/`. ASD-STE100. Issue closes only when every named decision is settled (wayfinder:grilling rule).

## Out of scope here

The Sessions connector visualization + drag UX is its own issue (it CONSUMES this plane). Status-code fidelity is #65. Hermes-side profile changes are owner actions.

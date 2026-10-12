# Alias publish posture — D1 (server plane) — 2026-10-12

Spec: `docs/architecture/alias-stability-and-slow-engines.md` D1 (LOCKED,
owner 2026-10-12). Worker B of the alias-publish wave. Server plane only:
`server/src/**`, `server/test/**`, three architecture docs amended, this
report. No client/dashboard/cli change (all wire changes are ADD keys the
old readers ignore).

## The incident, before vs after

BEFORE (2026-10-12, verified in the brief): the arbiter (:8787) was
SIGTERM'd 11:56 EDT and cold-started 13:09:32. Every stored alias pair sat
on a probe-SUCCEEDED row whose list did not yet contain the id (engine
cold), so `buildAliasBlock` DROPPED every pair, `model_aliases` published
`[]` for the first ~15 s, the client's `updateAliases([])` CLEARED the
router's alias map, and the next `Qwen3.8-Flash-Next` request fell through
to `llm_target` (oMLX :8000) with the agent key stripped → 401 "API key
required". Capability keys also rode only a live probe entry, so even the
refined publishes were caps-lean.

AFTER (D1, this build): stored config ALWAYS publishes. The arbiter seeds
the publish block at construction (empty probe map → every pair
`declared`, `degraded: true`) so `modelAliases()` is never empty while
`state.model_aliases` is non-empty — before `/api/state` can answer; the
boot `tickOnce` refines. A probe contradiction marks the pair `mismatch`,
appends a rate-limited `alias_pair_mismatch` event, and the entry
publishes honestly degraded (winner chain over mismatch candidates, caps
carried from the last-good observation). Nothing but sanitizer-degenerate
config (no pair names an existing row with a usable url, or a hostile
name) can publish nothing. The client (worker C/D planes) gets the fence
memory + `fallback_targets` instead of a vanishing name.

## What changed

- `server/src/arbiter.ts` — `buildAliasBlock` rebuilt as an evidence
  ALERTER over stored config: per-pair markers `probed | declared |
  mismatch | dropped` (`mismatch` renames the probe-contradiction case;
  `dropped` REMAINS for sanitizer drops only — hostile id, missing row,
  blank url, now checked per pair); the D2 health chain runs over
  FIRST-RANK (probed ∪ declared) BYTE-FOR-BYTE, and over the `mismatch`
  candidates only when first-rank is empty; ADD-keys `degraded` (winner
  not probe-confirmed) and `fallback_targets` (the OTHER pairs, stored
  order, {server_id, url, engine_model} only, omitted when empty, token
  never); capability carry-over for `mismatch`/`declared` winners from
  the per-(row, model) `lastGoodCaps` last-good memory; boot seed in the
  constructor; `alias_pair_mismatch` events via the `logMeshControl`
  appendEvent/trim/save plane — ≤1 per (alias, server_id, model) per 15
  min (in-memory `aliasMismatchEmittedAt`, ephemeral) and ≤10 per tick.
- `server/src/arbiter.ts` types — `ModelAliasEntry` gains `degraded?` +
  `fallback_targets?` (new exported `ModelAliasFallbackTarget`);
  `aliasPairStates` and the `aliasRows()` source unions gain `'mismatch'`
  (`GET /api/aliases` markers carry the rename).
- `server/src/types.ts` — `EventKind` gains `alias_pair_mismatch`
  (detail `<alias>: <server_id>/<model>`).
- Docs: `model-aliases.md` (D2 drop rule + D3 publish shape + boot seed +
  rule 2 — the D1 amendment), `engine-health-routing.md` (D2 amended:
  first-rank-then-mismatch, the chain itself byte-for-byte), 
  `model-capabilities.md` (D2 amended for the carry-over; D4 untouched —
  `mismatch` stays a per-tick ephemeral marker).
- State file: NO new key. Events ride the existing log; every marker and
  the limiter map are in-memory like all other observed facts.

## Tests

Before: repo 959/959 (server 482). After: repo 964/964 (server 487) —
+5 new D1 regression tests, 4 existing tests amended in place, none
removed.

New suite (incident shape): (b) caps ride through a contradiction (last-
good entry for the winner's row+model inherits; a never-capped model
claims nothing, keys never fabricated); (c) `fallback_targets` shape —
survivors AND mismatch in stored order, winner excluded, exactly the
three keys, no token key or value anywhere, omitted when empty; (d) the
event limiter — 12 contradicted pairs emit ≤10 per tick, the 15-minute
window silences repeats, an aged stamp re-alerts exactly that pair;
(e) boot seed — a fresh arbiter over saved state with ZERO probe ticks
publishes non-empty (all declared, degraded), no events from the empty
probe map, no new state key, first cycle refines; (f) the first-rank
chain byte-for-byte — a contradicted PIN never steals the alias from a
survivor, no degraded on a probed winner, `fallback` semantics kept.
Amended: the old "ALL pairs dead → not published" test is now the
incident-posture test (a) — publish anyway, degraded, `mismatch` markers,
alert event; the DROPS-on-contradiction test renames to the mismatch
marker and checks degraded + fallback_targets; the #87 caps test's last
phase flips to carry-over (a declared winner RIDES its last-good entry —
exactly the model-capabilities D2 amendment); the engine-groups step-2
"alpha.local never in the block" assertion narrows to the WINNER fields
(the dead pin's pair now intentionally rides `fallback_targets` — the
failover surface D3 needs; the D2 step-2 chain behavior itself is
unchanged and still asserted).

Gates: `npm run test` repo 964/964 green; `npm run build` green;
`npx tsc --noEmit` green in `server/` (and client/dashboard unaffected).

## The published entry shape now (exact)

Key order as emitted; `fallback` = engine-health D2 (winner ≠ stored
pin), `degraded` = D1 (winner source mismatch or declared),
`fallback_targets` = D1 failover surface, caps = #87 D2 + D1 carry-over.
A token NEVER enters the block.

Probe-confirmed winner (normal tick):

```json
{
  "name": "Qwen3.8-Flash-Next",
  "server_id": "srv-45abb4e8",
  "url": "https://strata.samwarth.com",
  "auth_set": true,
  "engine_model": "qwen3.8-flash-next-iq3_s",
  "catalog_source": "probed",
  "fallback_targets": [
    {
      "server_id": "srv-f1c85327",
      "url": "https://scanbot.samwarth.com",
      "engine_model": "qwen3.8-flash-next-q2_0"
    }
  ],
  "context_length": 262144,
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"]
}
```

The incident shape (every pair contradicted, pin kept, caps carried):

```json
{
  "name": "Qwen3.8-Flash-Next",
  "server_id": "srv-45abb4e8",
  "url": "https://strata.samwarth.com",
  "auth_set": true,
  "engine_model": "qwen3.8-flash-next-iq3_s",
  "catalog_source": "declared",
  "fallback": true,
  "degraded": true,
  "fallback_targets": [
    {
      "server_id": "srv-f1c85327",
      "url": "https://scanbot.samwarth.com",
      "engine_model": "qwen3.8-flash-next-q2_0"
    }
  ],
  "context_length": 262144,
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"]
}
```

(`catalog_source` keeps its honest #64 union: a contradicted pair never
claims `probed`; `degraded` + the pair marker name WHY it rides
`declared`.)

## Deviations from the brief (with justification)

1. Caps carry-over reads a per-(row, model) `lastGoodCaps` map fed by
   every successful probe, not `lastProbed` directly. `lastProbed`
   REPLACES its whole list per row on every success, so on a mismatch
   tick it by construction no longer names the contradicted model — a
   direct read could never satisfy the brief's own (b) ("caps ride").
   `lastGoodCaps` is the model-keyed twin of the #67 last-good map for
   the CARRY-OVER ONLY: `probedModels()`, #67 pin legality, and the
   serverView inventory stay exactly `lastProbed`, byte-for-byte.
2. A blank-url pair is now a pair-level `dropped` marker (the brief's
   explicit dropped list) instead of the old post-winner alias skip: an
   alias with a blank-url winner now falls through to its other pairs
   instead of vanishing — strictly the D1 posture.
3. The event rate-limiter keys off the `now` `buildAliasBlock` already
   receives (from `probeCatalog`'s `Date.now()`); `probeCatalog`'s public
   signature is NOT widened. The 15-min test ages the in-memory limiter
   map through a cast — the established pattern for private state in
   these suites (`detectors` in engine-groups.test.ts).
4. Amended existing assertions where D1 mandates the flip (old ALL-dead
   test, #87 declared-omit phase, engine-groups whole-block token-style
   assertion) — behavior of the D2 chain itself is untouched and (f)
   pins it.

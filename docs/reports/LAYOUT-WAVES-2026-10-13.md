# Layout waves 1–4 (owner ask 2026-10-13) — the hierarchy rendered and navigated

Four dashboard-only waves landed the same day: `19059a4`, `d21ad83`, `1c63bff`,
`af7f035`. Zero wire changes across all four — no new keys, no server/client
change, no data reworded. The read-side joins from `lib/hierarchy.ts`
(fleet-hierarchy.md D3, resources-hierarchy report) are the substrate; these
waves lay it out and make it walkable. Gates after each wave: dashboard tests
68/68 → 72/72 → 77/77 → 85/85, `tsc --noEmit` clean, `npm run build` green,
dist committed (the bundle-drift gate stays honest).

## Wave 1 — Machines rows + master-detail split (`19059a4`)

The `minmax(300px)` card grid retires: each machine is ONE full-width row
(shadow-none Card, hairline dividers). Left column: identity, exceptions,
coarse counts, update-intents + the ONE `i_control` update write (local row),
the url, the #79/#86 peer-metrics expand. Right column carries the two
SOURCES side by side (wide) or stacked (narrow), NEVER merged: "hosted here —
declared on this arbiter" (live local truth, never dims) and "reported by that
machine" (one snapshot block, one honest dim when stale). New per-row SUMMARY
line — N engines here · N agents · N sessions — by new PURE joins in
`lib/hierarchy.ts` (`machineClients`, `machineSummary`: hostedServers bucket +
published `agent_roster` sums over the machine's clients, a roster-less client
contributes an honest 0 + session rows by `client_id` exact). A 0 here is the
truth (population complete per machine), unlike the tiles' em-dash posture.
+4 hierarchy tests (unnamed-client belongs to NO machine, the urza-shape
summary with a roster-less client, the local row, machines-without-clients
all-zeros).

## Wave 2 — Inference servers banded by host (`d21ad83`)

New PURE `serverBands(st)` partitions declared rows into render bands: This
Machine first, peer bands by name (localeCompare), a trailing "host not named"
band for rows the joins cannot name — the same `hostedServers()`/`hostOfServer()`
join, never re-derived. NEVER-HIDE law: every declared row lands in exactly one
band, an unnamed row is shown whole rather than vanished. FLAT-FALLBACK law: a
single band (the common single-machine case) renders exactly today's header-free
grid. The card body is hoisted into ONE renderer so flat and banded branches can
never drift; ServerCard internals byte-identical, the footer host chip stays,
tiles/editor/dialogs/write flows untouched. +4 tests (urza fixture order,
no-peers single band, the unhosted partition fence, empty = []).

## Wave 3 — Agents roster disclosure (`1c63bff`)

Profiles that OWN sessions are open by default; the user's toggle is the only
stickiness (pure `lib/roster-disclosure.ts`: overrides map first, else the live
has-children verdict — collapsed stays collapsed across count changes). A
childless untouched profile is never a button and shows no chevron — its row is
exactly what it was (exception-only). The name becomes a real button
(aria-expanded, chevron rotates, focus-visible ring, Enter/Space native); the
`{n}` count doubles as the collapsed affordance; a header hint appears ONLY
while nesting is real; an opened slot whose children vanished renders the honest
dim line naming the provenance-stamp requirement. SessionSubRow internals and
the exact provenance join untouched — interaction and density only. +5 pure
tests.

## Wave 4 — Cross-tab deep-links (`af7f035`)

The tree becomes navigable. Pure `lib/hash-nav.ts` owns the hash grammar (bare
view id / bare resources sub-tab / `<subtab>/focus/<key>`) and the ONE key
scheme `machine/<name>` + `server/<id>` minted there and nowhere else; total
parse, never throws (try/catch decode, pre-decode + decoded caps, junk focus
segments degrade to `(tab, null)` so the tab is always navigable). App owns the
focus (prefix-gated; cleared by any normal pick); `consumeFocus` rewrites the
hash to the bare sub-tab via `replaceState` (no history spam, no hashchange
echo, no stale refresh flash). A hosted-engine row on a Machines row jumps to
that card on the Inference servers tab; a card's "on urza" chip jumps to that
machine's row — scrollIntoView once + ~1.5s hairline ring, timers cleared on
timeout AND unmount; a focus naming nothing just opens the tab, no error
chrome. `pickResTab` mirrors the sub-tab into the hash so the URL bar always
reopens exactly the view shown. +8 hash-nav tests (round-trips, unencoded-slash
re-join, junk degradation, caps incl. a 5k flood pre-guard, view-id precedence).

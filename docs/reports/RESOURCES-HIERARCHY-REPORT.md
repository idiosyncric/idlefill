# Resources hierarchy — machines host engines, agents own sessions (owner ask 2026-10-12)

The ask: re-evaluate every Resources sub-tab for a better display informed
by the resource HIERARCHY — "urza is actually hosting both strata-urza and
llama-swap-urza and both should be shown as part of the machine card for
urza"; "sessions should also be sub-items of the agents to which they
belong". This is the display slice of the owner's `fleet-hierarchy.md`
target tree (D3: "children are joined in the view, no FK re-shape") — a
read-side projection only, plus ONE honest wire ADD-key that makes the
session→agent join possible.

## The hierarchy the arbiter can PROVE (lib/hierarchy.ts, pure, tested)

Every join is EXACT — a hostname to the character, a group label to the
character, a provenance profile to the character. Nothing fuzzy, never a
guess:

- **engine → machine** (ordered rules):
  1. loopback url (`127.x` / `localhost` / `::1`) → This Machine;
  2. url hostname === a mesh peer's url hostname → that peer (`url-host`) —
     `llama-swap-urza` @ `100.105.225.1` = urza's mesh host;
  3. the row's engine-group id/label EXACTLY equals a machine's name →
     that machine (`group-label`) — the D3 same-host mutual-exclusion plane
     ALREADY says strata-urza and llama-swap-urza share urza, and the group
     is literally named `urza`; `strata-urza` @ `strata.samwarth.com` joins
     by that rule, not by a name-similarity guess;
  4. no peers declared at all → every row rides This Machine (one arbiter,
     one machine, no other candidate — the single-machine page keeps every
     row);
  5. otherwise: NO verdict = UNHOSTED — the Machines tab shows no card for
     it and NAMES the rows under the grid instead of guessing a host.
- **client → machine**: loopback ip / observed_ip === a peer's host.
- **session → agent**: ONLY the new `hermes_meta.profile` provenance stamp
  (below) + the session's `client_id` belonging to a machine's daemons.

## The one wire ADD-key: `hermes_meta.profile`

The session→agent edge had NO published source: the ledger row carries no
profile, and inferring one from the model/token/name is the exact-match
culture's forbidden fuzzy join. The provenance is OBSERVABLE at the client:
the connector knows which profile's ledger it fetched.

- **client** (`hermes-gateway.ts`): `rowToMeta(row, profile?)` stamps the
  configured profile the row was READ FROM — the listing round threads a
  `LedgerRowEntry { profile, row }` so the same-id cross-profile winner
  carries ITS provenance; the #83 single-session probe stamps the route
  that answered. `profile` joins the last-known-wins member merge.
- **arbiter** (`cleanReportedHermesMeta`): same bounded-string shape
  (trim, ≤64); an absent member never stamps, never clears (the #73
  last-known-wins posture stands untouched).
- The `/api/state` + `/api/sessions` spreads carry it automatically.

## What each Resources page now shows (the re-evaluation)

- **Resources landing**: "Machines" counted MACHINES (this one + every mesh
  peer) instead of clients — the count that was wrong against the tree;
  an Agents row added (the published roster profiles).
- **Machines**: each card carries a "hosted here — declared on this
  arbiter" block — the engine rows THIS arbiter declares that host on THAT
  machine, each dot tooltip naming the join rule (`VIA_NOTE`). urza's card
  shows strata-urza AND llama-swap-urza beside urza's own snapshot row;
  scanbot's carries strata-scanbot; This Machine dims to loopback only
  (oMLX). Declared rows the arbiter can host-name are listed under the
  grid by name — never silently dropped.
- **Inference servers**: every card footer names its machine (`on urza` /
  `on this machine`) with the join rule in the tooltip — the flat grid
  inherits the tree without regrouping (the group editor stays the write
  surface that OWNS the same-host fact).
- **Agents**: the roster gains session sub-items — a session nests under a
  profile ONLY on exact provenance + same-machine client; the profile row
  counts them; the sub-row is a read-only glance (liveness dot, short
  token, ledger title, model, state word) — every write (gate/pin/lifecycle)
  stays on the Sessions tab. Absent stamp (old client, ledger miss, or an
  arbiter predating this sanitizer) = no nesting, which is exactly what the
  live mac shows TODAY (old builds in the field — honest until the update
  wave lands).
- **Sessions**: a row names its agent (`@profile`) only when stamped, and
  the token tooltip carries the ledger title when known.
- **Models / Overview / Projects**: evaluated, deliberately unchanged —
  Models already nests alias→pair→engine and inherits the machine names
  through the Servers plane; Overview is the glance surface (the tree is a
  drill-down, not a headline); Projects' worker→client join is already the
  machine edge the tree wants, and per-machine Projects is the fleet doc's
  separate S2 slice, not this display pass.

## Not done here (named, from fleet-hierarchy.md)

Peer AGENT rosters on the mesh snapshot (D4) and peer session nesting on
remote cards are a snapshot-key slice; this pass nests the machine this
page serves. No Containers/SysRes/fleet-settings chrome (D5/D6/D7). No
state-file nesting (D3 — the tree stays a view).

## Evidence

- New pure lib + **8 hierarchy tests** (the urza two-engine case verbatim,
  the no-fuzzy fence `100.105.225.10 ≠ 100.105.225.1`, the `urza-ish`
  group-refusal, the no-peers single-machine rule, client joins, the
  provenance nesting fence incl. `web-dev` never nesting `web-dev-orca`).
- Wire tests: +2 client (provenance stamp shape + the connector round
  publishing `default`/`web-dev` provenance), +1 server (register
  sanitize: trim, ≤64 bound, absent never stamps).
- **Measured: 1006/1006 green across workspaces (server 494, client 273,
  dashboard 56→64, cli 99, rest unchanged), tsc green per package,
  `npm run build` green, `dashboard/dist` regenerated + committed.**
- LIVE on the dev server against the production arbiter (screenshots):
  `RESOURCES-HIERARCHY-MACHINES.png` — urza's card carries BOTH engines
  under "HOSTED HERE", This Machine hosts only oMLX; the Servers tab shows
  `on urza` / `on scanbot` / `on this machine` chips; the Agents tab
  renders the roster with zero nesting (old clients publish no stamp — the
  honest absent posture, live).
- One pre-existing console warning (nested `<li>` in the sidebar
  breadcrumbs) observed untouched — not this change's surface.

## Deviations / honesty bounds

- `profile` provenance = "the profile whose ledger the router READ the row
  from" — for a session id present in TWO profiles' ledgers it names the
  round winner (newer `last_active`), documented at the type.
- Group-label hosting joins a row onto a machine the OPERATOR named via the
  group; renaming the group un-names the host (the tooltip names the rule
  so a mis-label is visible, not silently trusted).
- A session's `@profile` chip rides only the last-known-wins block: a
  profile re-map shows after the next reachable round, never mid-air.
- Live nesting lights up per machine as the build wave reaches it (the
  build-gap counter from 738f784 names exactly which machines still miss
  the stamp) — the mac's own session (this dashboard's own model row)
  will nest under `web-dev` the moment the mac arbiter + daemon boot on
  this commit.

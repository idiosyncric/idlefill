# #82 — Connector: bound the Hermes ledger map

**Status:** delivered on branch `issue-82` (base `main`). Not merged (owner gate).

## The gap (re-verified before building)

`mergeLedgerRows` only ever added or replaced entries: the connector's last-known ledger (`session id → HermesSessionMeta`) grew for the daemon's whole uptime (LaunchAgent / systemd lifetime), with no path that ever removed one. The sibling gate structure (`sessionIdIndex`, `session-gate.ts`) has an explicit LRU cap; the Hermes ledger had none. Ended rows (and rows Hermes later prunes) answered `metaFor` forever.

## What was built

`client/src/hermes-gateway.ts` — `HermesGatewayConnector.pruneLedger`, called from `poll()` after a REACHABLE round only:

- Bookkeeping: a parallel `lastSeenRound` map (session id → the reachable-round counter that reported it) + an `ageRound` counter. The published `HermesSessionMeta` shape and the wire format are UNTOUCHED — pure client-side bookkeeping.
- Rule 1 (age-out): an entry whose stored meta carries `ended_at` (a number OR an explicit null — both mean the Hermes row ended; an ended session can never re-activate its ledger row) that has not appeared in `LEDGER_EVICTION_GRACE_ROUNDS = 20` consecutive reachable rounds is dropped. A transient page miss inside the grace never evicts (the last-known-wins posture stands).
- Rule 2 (hard cap): if the map is still over `LEDGER_MAX_ENTRIES = 5000`, the least-recently-seen entries drop to the cap — the `SESSION_ID_INDEX_MAX` oldest-eviction posture.
- Outage rule: an unreachable round advances NOTHING — a down gateway never ages the ledger. (Found by the harness: `metaFor` gates on reachability by pre-existing design — down ⇒ no meta — so the "ledger stands" probe asserts `ledgerSize`, not `metaFor`.)

## Why eviction is safe on the wire

Fail-quiet direction, identical to the gate index: an evicted id makes `metaFor` answer undefined ⇒ `hermes_meta` rides the register heartbeat ABSENT ⇒ an absent key never clears the arbiter's stored block (client-truth discipline, `cleanHermesMeta` / `types.ts`). Client-side eviction cannot erase what a better poll already published.

## Harness + build output

Two new tests in `client/test/hermes-gateway.test.ts` (hand-rolled stub servers whose ledgers toggle per round):

- an ended row absent for GRACE reachable rounds is dropped (round 21 evicts; a live row keeps enriching);
- an outage does not age the ledger (40 unreachable rounds leave `ledgerSize` 1; after recovery the grace restarts from zero — round 19 still stands, round 20 drops).

`tsx --test test/hermes-gateway.test.ts`: 16/16 pass. `npm test --workspace client`: 179/179. `npx tsc --noEmit -p client/tsconfig.json`: clean. Combined with `issue-81` (merge, one constants-block conflict resolved by keeping both): 19/19 connector tests, 182/182 client suite, `npm run build` exit 0.

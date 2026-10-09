# #52 slice 4 — the strata auth gap (D4 busy predicate can never fire)

## Credential source (shared by feed + load)
Both the strata activity-feed adapter and the load collector authenticate
from ONE place: the row's `auth_token` (`ServerConnection.auth_token`,
`server/src/types.ts:334`) — a write-only field set via `POST /api/servers`
(`server/src/api.ts:793-814`, `server/src/arbiter.ts:2576-2579`).
- Feed: `index.ts:154` → `IdleDetector.auth_token` → `fetchRawJson(url,
  auth)` (`idle.ts:146-152`) sends `Authorization: Bearer ***` only when set.
- Load: `index.ts:107` → `LoadCollector.auth_token` → `read()`
  (`load.ts:362`) sends the SAME header only when set.
So the feed and the load read use the SAME credential for the SAME row.
It is NOT "the feed authenticates, the load collector does not." Neither
does: the live strata rows (`srv-45abb4e8`, `srv-f1c85327`) carry no
`auth_token`, so NEITHER sends a credential and strata's `/metrics` answers
401 for both. The operator must set the token.

## Root cause (the real asymmetry)
Even once the operator sets a token, the two planes pick it up differently:
- The feed DETECTOR is rebuilt on every row upsert (`arbiter.ts:2587`), so a
  new `auth_token` takes effect immediately.
- The load COLLECTOR was cached by `(provider, url)` only (`index.ts:97`),
  so a token set after the row existed was NEVER picked up — the collector
  kept sending the old (missing) credential. THAT is the gap the D4
  predicate could not fire.

## The fix
1. **Collector staleness** (`index.ts`): the collector meta now includes
   `auth_token`; a token change rebuilds the collector on the next tick, so
   the row credential rides the load read the moment it is set (same source
   as the feed — no new secret invented).
2. **Honest failure** (`load.ts`): a 401/403 on a credential-gated kind
   (strata `/metrics`, oMLX `/health`) records a NAMED operator-readable
   reason on the collector (`lastFailReason`, ADD key `load_fail_reason`)
   instead of silently resolving null. The engine's own 401 message rides
   verbatim (strata's `authentication_error`) and the reason names the action:
   "set auth_token on this server row (the D4 busy predicate can never fire
   until it does)." A successful read clears it (last-success-wins). Non-auth
   failures (404, 5xx) and data-absent 200s stay SILENT exactly as pre-#52 —
   the verdict plane is byte-identical (D2 rule 3).
3. `load_fail_reason` is a display-only ADD key on the signal block
   (`types.ts`) and the #51 sample line (`metrics.ts`); the mesh snapshot
   stays byte-for-byte. The dashboard's `loadRead` returns null when
   `load_source` is absent, so a reason-only view renders nothing.

## Live proof (real endpoint, no arbiter, no guessed secret)
`server/scratch/strata-auth-live.mts` runs the real `LoadCollector` against
the live `http://10.10.10.6:8080/metrics` with NO credential (the live row):
the endpoint answers **401 `authentication_error` (missing or wrong API
key)**, and the collector now names the gap — the D4 predicate returns true
for a fresh `generating` and false for `idle` once the credential is set
(pinned by test). The operator must supply the strata key; nothing here
guesses or reads a secret.

## Tests + build (real counts)
- 6 new tests in `server/test/load-capture.test.ts` (strata WITH/without
  credential, D4 true/false, data-absent 200, 404 silent, success-clears).
- `NODE_ENV=test npm run test`: server 362/362; all workspaces 579/579; 0 fail.
- `NODE_ENV=test npx tsc --noEmit -p server/tsconfig.json`: clean (exit 0).

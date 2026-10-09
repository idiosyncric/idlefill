# #55 slice 11 — fleet-side pairing ceremony hardening

Branch `issue-55-fleet-ceremony` (cut from main `f735517`). Slices 1–10 shipped;
slice 10 wired the arbiter half (`FleetClient.mintPairCode/redeemPairCode/unpairEdge`,
`server/src/pairing.ts`, the `POST /api/mesh/pair` routes). This slice hardens the
**ceremony contract itself on the fleet service** and pins it with one named refusal
per acceptance line.

## What changed

### `fleet/src/store.ts` — the ceremony is now total and refuses by name

`mint_pair_code` (`mintPairCode`):
- Returns `MintPairCodeResult = {ok:true, code, expires_at} | {ok:false, error:'unknown_minter'}`.
  Previously a minter the fleet does not know silently defaulted to `fleet_id='home'`
  and minted a code that could never form an edge. Now a ghost minter is a **named
  refusal**, and the real `fleet_id` is used.
- A non-positive/non-finite TTL falls back to `PAIR_CODE_TTL_MS` (5 min) instead of
  minting a code that is expired the instant it is minted.
- The code is stored HASHED, single-use, TTL-carrying — the enrollment token's posture.

`redeem_pair_code` (`redeemPairCode`) — the refusal set is complete, and **no refusal
burns the code** (the single-use `UPDATE` is the last step):

| situation | named error |
|---|---|
| code the service has never seen | `invalid_code` |
| signer is not a fleet instance | `unknown_redeemer` |
| redeemer == minter | `self_pair` |
| already redeemed | `code_used` |
| clock >= `expires_at` | `code_expired` |
| the minter row is gone | `unknown_minter` (was silently `invalid_code` **after** consuming the code) |

Order matters: `unknown_redeemer` / `self_pair` / `unknown_minter` are checked **before**
the code is consumed, so an operator's typo or a wrong machine never destroys a
one-time code the intended pair can still use. The edge INSERT stays
`ON CONFLICT DO NOTHING` — re-pairing the same A → B is one row, not three.

`drop_edge` (`unpairEdge`) — unchanged semantics, renamed result type
(`DropEdgeResult`): the caller must be one of the two ends; only the named direction
is deleted; a non-end or an already-gone direction is `unknown_edge`. Because the
row is deleted from the `edges` table, `roster()` publishes no edge for **either**
endpoint, so a later roster pull cannot re-create a record the operator deleted.

`roster()` keeps carrying the edge on **both** endpoints' rows (the `edges` ADD key)
regardless of whether either machine has ever heartbeated a url.

### `fleet/src/index.ts`
- `POST /pair/code` handles the mint refusal (400 `unknown_minter`) instead of
  destructuring a result that can now fail. Auth (`bad_signature`,
  `nonce_replayed`, `unknown_instance`) stays the 401 before any ceremony runs —
  no ceremony route answers an unsigned call.

### `server/src/api.ts` — bug fixed
`POST /api/mesh/unpair` dropped the edge on the service side using
`arbiter.instanceId()` — the **locally-minted mesh id** (mesh.md D2). The fleet
directory keys edges by the **fleet-issued id** (the namespace the roster rows and
the ceremony use, see `server/src/index.ts` `localInstanceId`). The two namespaces
are different, so the drop named an edge the directory never held: `unpairEdge`
answered `unknown_edge`, the edge survived in SQLite, and the next roster pull
re-created the local record the operator had just deleted — the revocation silently
did not stick. Fixed to `arbiter.fleetInstanceId() ?? arbiter.instanceId()`.

### `server/src/pairing.ts` — bug fixed
`osName()` used `require('node:os')` inside an ESM module: `require is not defined`,
so the `catch` swallowed it and every arbiter without a `mesh_name` enrolled under
the literal name `arbiter` instead of its hostname. Replaced with the `node:os`
import. Verified with a standalone repro (`require` throws, the fallback fires).

### `fleet/test/ceremony.test.ts` (new) — 18 tests
Real HTTP server, real ed25519 crypto, real SQLite file, injected clock — no mocks:
mint single-use + TTL (`ttl_s` + the stored `expires_at`), ghost minter refused by
name, non-positive TTL falls back, redeemer-is-controller direction verified against
the raw `edges` table, idempotency (three ceremonies → one row), every refusal by
name (`code_expired`, `code_used`, `bad_signature` from a wrong key + a garbage
signature + a missing signature, `self_pair`, `unknown_redeemer`), the exclusive TTL
boundary (redeems at TTL−1 ms), no ceremony route answers an unsigned call, a replayed
nonce is `nonce_replayed`, `drop_edge` removes both rows and survives three later
pulls, a non-end drop is refused and leaves the edge standing, directionality, a
paired machine with **no url at all** still carries the edge on its own row (and its
public key), and the plaintext code never lands in the db file.

## Test counts

`npm run test -w fleet`: **54 / 54 pass, 0 fail** (36 shipped + 18 new).
`npm run test` (all workspaces): **676 tests, 0 fail** — server 414, client 182,
career-ops 17, noop 2, shell-ui 3, dashboard 4, fleet 54.
`npx tsc --noEmit -p server/tsconfig.json` and `-p fleet/tsconfig.json`: exit 0.

Note: a clean worktree needs `npm install` first — `client/test/version-handshake.test.ts`
asserts `node_modules/.bin/tsx` exists and fails with "tsx missing" on a fresh checkout.

## Deferred
No arbiter-side slice-11 test was added to `server/test/pairing.test.ts` (the
`POST /api/mesh/unpair` namespace fix is code-verified by tsc + the existing
`unpairOnService` test; a route-level test against a live fleet service is the next
slice's job). Key rotation, deployment (D7) and the live proof script are untouched.

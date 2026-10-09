# #55 slice 10 — the arbiter redeems a code and writes the local edge record

Branch `issue-55-pair-client`. The fleet service ran the ceremony since slice
6. No arbiter ever redeemed a code, so no machine ever wrote its own
`mesh_edges.json` record from it. The #39 per-edge routes stayed fail-closed
(pairing.md D8) for every real peer, even when the fleet directory knew about
the edge. This slice closes that half.

## What changed

`server/src/fleet-client.ts` — the ceremony transport, signed with the #55 D1
identity exactly like `signedRoster`, never throwing:

- `mintPairCode()` — this instance mints a single-use code and becomes the
  CONTROLLED end.
- `redeemPairCode(code)` — this instance redeems a peer's code and becomes the
  CONTROLLER; returns the peer id, public key and name.
- `unpairEdge(from, to)` — drop the directed edge in the directory.

`server/src/pairing.ts` (new) — `PairingClient`, the ceremony client wired to
the LOCAL `EdgeStore`. A successful redeem writes the peer with direction
`i_control` (pairing.md D5: pairing A to B makes A the controller of B).
Idempotent — the store keys by peer id and `created_at` is durable, so a second
ceremony refreshes the key without resetting the creation time. No fleet config
= null client, every call answers `fleet_not_configured`, byte-for-byte inert.

`server/src/api.ts` — two admin-plane routes: `POST /api/mesh/pair/code` and
`POST /api/mesh/pair` (`{ code }`). Every failure is named: 400
`fleet_not_configured` / `bad_code` / `code_used` / `code_expired` /
`invalid_code` / `self_pair`; 401 `bad_signature` / `unknown_instance` /
`nonce_replayed`; 502 on transport failure.

`POST /api/mesh/unpair` now also removes the edge on the SERVICE side. Root-
cause fix: local deletion alone was defeated by the next roster pull, which
re-created the record the operator had just deleted. Fail-quiet — a service
failure never blocks the local revocation (pairing.md D6).

`server/src/arbiter.ts` — `fleetInstanceId()` reads the fleet-issued id from
`fleet_enrollment.json`, and `index.ts` feeds it to `localInstanceId`. Real bug:
roster rows and the ceremony speak fleet-issued ids while the arbiter's locally
minted `instance_id` (mesh.md D2) is a different namespace. The edge filler
compared the wrong id, so the controlled side never got its record.

`server/src/mesh.ts` — `sanitizeRoster` keeps a row with no urls but with edges.
A paired machine that has not heartbeated a url yet must not lose its pairing.

## Tests

`npm run test` at HEAD: **653 tests, 0 fail** — server 414 (404 + 10 new),
client 177, fleet 17, shell 2, ui 3, web 4. `tsc --noEmit -p
server/tsconfig.json` exit 0.

New: the record carries the peer real public key and the D5 direction, the edge
file stays 0600 and holds no private key; the denial flips on the right side
only; the controlled end gets `controls_me` from the roster pull; a second
ceremony is idempotent; a used code answers `code_used` and writes nothing; bad
code, self-pair and empty code are refused by name; no fleet config is inert; an
unreachable service returns a named error and never throws; `unpairOnService`
stops the next pull re-filling a deleted record; an edge-only roster row is kept.

## Live proof (`scripts/issue55-pair-client-live.mts`)

Real fleet service :8911, two real `server/src/index.ts` entries as children on
:8912 and :8913, each in its own directory.

```
A redeemed: 200 {"ok":true,"paired_with":"m-b232d5427d740563",
  "peer_name":"arbiter-b","direction":"i_control"}
fleet edges: [{"from_instance_id":"m-1d5733f98d23c639",
               "to_instance_id":"m-b232d5427d740563"}]
B local edge records (from the roster): [{"peer_instance_id":"m-1d5733f98d23c639",
  "direction":"controls_me","peer_name":"arbiter-a"}]
signed control request to B -> 200 {"ok":true,"action":"pause",
  "target":"proof-client","override":"pause",
  "source_instance_id":"m-1d5733f98d23c639"}
unpaired stranger -> 403 {"reason":"unknown_instance_id"}
VERDICT: PASS
```

The relayed pause landed on B's own row and audited as `mesh_control`. Children
killed, service closed, temp dir removed; nothing on :8787 touched.

## Gotchas

- `identityFileOf()` strips the basename and uses `identity.json` next to the
  state file. Two instances seeded from one directory share one keypair, and
  the fleet reads the ceremony as `self_pair`. Give each instance its own
  directory.
- Fleet-issued ids and locally minted mesh ids are different namespaces. Any
  roster or ceremony comparison must use the fleet one.

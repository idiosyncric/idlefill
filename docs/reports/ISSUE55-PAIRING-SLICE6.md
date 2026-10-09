# BUILD REPORT — issue #55 slice 6: the pairing ceremony (fleet service)

**Doc:** `docs/architecture/pairing.md` (D1–D6, shape (b) one-time code, directional
edges). Build wave. Nothing pushed or merged by this report; it describes the
branch commit. No secret is committed anywhere.

## What was built

**Fleet service (`fleet/src/store.ts`, `fleet/src/index.ts`).** Three new routes
on the existing signed-nonce auth, no new transport:

- `POST /pair/code` — B mints a one-time pairing code. The code binds to B's
  authenticated `instance_id`, is stored **hashed** (sha256), single-use, TTL
  5 min. The plaintext is returned once and never stored. Same posture as the
  enrollment token.
- `POST /pair/redeem` — A redeems B's code. The signer is the **controller**
  (`from`); the minter is the **controlled** instance (`to`). The edge row is
  inserted idempotent and the response carries B's public key so A can write its
  local edge record immediately.
- `POST /pair/unpair` — deletes exactly one direction, callable by either edge
  end. The other direction is untouched (D5, directional).

`store.ts` gains two tables, `pair_codes` and `edges`. Self-pairing is rejected.
`sanitizeRoster` publishes each instance's edges as an **ADD key** on the roster.

**Arbiter side (`server/src/mesh.ts`, `server/src/index.ts`).** `pullRoster`
now fills the LOCAL side of every edge the roster names. The writer is a seam
(`FederationOptions.edgeFiller`), and the production writer is **ADD-only**: a
record this machine already holds for a peer is the operator's local truth and is
never rewritten by the roster. Pairing.md D6 puts the enforcement point on the
local side, so that is the rule. Process-lifetime dedupe stops a 15-second
re-pull from touching the edge store. A missing local instance id, a missing
peer key, or a throwing writer all fail closed: no record, no crash.

**Audit (`server/src/arbiter.ts`, `server/src/types.ts`).** A newly written
local edge record appends the event kind `mesh_edge_formed` with the peer
instance id and the direction from the local side. No `source_instance_id`: no
peer signed that write, the roster is a pull, not a request.

## Boundary honored

The service is a **directory, never a pipe**. It forms the edge and publishes it.
After the ceremony, A and B talk directly over the mesh, authenticated against
each side's own stored record. No control traffic crosses the fleet service.

## Verified (real output)

- `fleet` workspace: **30 tests pass, 0 fail** (14 enrollment/roster + 16 new
  pairing: mint, redeem, wrong-signer rejection, self-pair rejection, replay of
  a used code, expiry, unpair one direction only, re-pair after unpair, code
  plaintext never in the db file).
- `server` workspace: **355 pass, 0 fail**, including 22 new edge-fill tests.
- `tsc --noEmit` clean for `server` and `fleet`.

## Not proven here

- The end-to-end ceremony between two real arbiters on the tailnet. The ceremony
  is tested against an in-process fleet app; no second machine was paired live.
- Key rotation. Re-pairing after an unpair is the tested recovery path; an
  in-place rotation is pairing.md open question 3 and is still the owner's call.

## Owner decisions still open

1. The pairing code TTL (5 min here, named `pairCodeTtlMs`) is PROPOSED.
2. Whether the roster should publish edges at all, or only serve them on an
   explicit request (publish is what shipped).
3. Rotation semantics, as above.

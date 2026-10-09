# ISSUE39-CONTROL-RELAY — the mesh control relay, ceremony-agnostic (#39 slice 2)

**Scope:** slice 2 of #39's per-edge plane (`docs/architecture/pairing.md`): the relayed
control actions (D4), the replay defense (nonce single-use + ts skew window), the D6
unpair admin route, the D7 `mesh_control` audit. **Edge formation is NOT built** — the
ceremony shape (request/approve vs a one-time code) is the owner's open decision (#55
D4); this slice does not re-open it.

## What this slice built

- **`POST /api/mesh/control`** — the relay. The target applies the action to its OWN
  client or session row via the existing verbs (`setClientOverride` /
  `setSessionOverride`, the operator's own semantics). `pause`/`force`/`clear` map
  directly; `resume` is the relay alias for clear. Auth chain, each step fail-closed
  and named: signature under the stored peer public key (no edge → 403
  `unknown_instance_id` (D8); bad → 403 `bad_signature`), D5 `controls_me` direction
  (reverse → 403 `direction_denied`), then the admission below. Malformed bodies and
  unknown target rows are 400, told not swallowed; a refused action appends no audit
  and mutates nothing.
- **The replay defense** — `NonceReplayStore` (bounded, in-memory: 256 nonces per
  requester id, FIFO; pruned by the skew window) enforces the single-use nonce;
  `EDGE_TS_SKEW_MS` (**PROPOSED** width, 15 min, marked in the comment) bounds the
  signed ts. Named denials 403 `nonce_replayed` / `stale_ts`. A rejected request
  records nothing (the nonce stays spendable on retry; a stale request cannot starve
  the store). All three per-edge routes share the admission.
- **`POST /api/mesh/unpair`** (D6) — the local admin plane (a valid `api_token`;
  `peer_token` and a peer signature are 401 on it). Deletes THIS machine's edge record
  for the controller: immediate, no propagation (the `revokeClientKey` precedent —
  deletion + the named `mesh_edge_unpaired` event, no `source_instance_id`: the
  operator acted, not a requester). The next signed request from that peer is 403
  `unknown_instance_id`.
- **The D7 audit** — every APPLIED relayed action appends a `mesh_control` event to the
  TARGET's log carrying the requesting `instance_id` as the `source_instance_id`
  **ADD key** (marked **PROPOSED** in the comment; the event kind is LOCKED).
  `EventRecord` gains the optional field (old records unchanged); the arbiter owns the
  write (`logMeshControl`) — the route never touches `store.events`.
- **No edge-formation endpoint, no handshake invented.** The edge record is filled via
  the substrate (`EdgeStore.upsert`). The relay reads only the stored edge + the
  signed envelope, so it works identically under any ceremony shape: (a) a
  request/approve handshake, (b) the service-mediated one-time code (#55 D4's
  recommended form), (c) operator-minted edge records — all three land the same
  `mesh_edges.json` record.

## Coarse plane untouched + tests

`GET /api/mesh` keeps its exact coarse shape and auth; `/api/state` gains no keys
(one new event KIND + one optional event field); the existing override routes are
unchanged. `server/test/mesh-control.test.ts` — 15 new tests (real ed25519 crypto,
real loopback sockets): a signed pause/force/clear/resume on a client AND a session
applies to the target's own row + is audited with `source_instance_id`; a replayed
nonce is 403 `nonce_replayed` (not applied twice); a stale ts (past and future) is
403 `stale_ts` and records nothing; the store bound (FIFO + window prune); D5
reverse denial; D8 no-edge 403 named; unpair revokes immediately (next attempt 403);
the coarse plane + the slice-1 read routes stay byte-for-byte intact.

Gates (branch `issue-39-mesh2`): `NODE_ENV=test npm run test -w server` — 331/331,
0 fail; `NODE_ENV=test npm run test` (root) — server 331/331 + client 172/173 (the
one client failure is the `--version (dev path)` test's own prerequisite — "tsx
missing — npm install in the repo first" — reproduced identically on clean main,
not a slice-2 change); `NODE_ENV=test npx tsc --noEmit -p server/tsconfig.json` — clean.

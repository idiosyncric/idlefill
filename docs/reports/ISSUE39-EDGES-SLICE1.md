# ISSUE39-EDGES-SLICE1 — mesh edge records + the fail-closed per-edge posture (#39 slice 1)

**Scope:** the shape-independent substrate of #39's per-edge plane
(`docs/architecture/pairing.md`): the edge record store, the signature
verification path, and the fail-closed posture the per-edge routes lean
on. **Not the ceremony** — the handshake shape (request/approve vs a
one-time code) is still an owner decision (#55 D4), and slice 2 (the
relayed control actions) waits on it.

Decision citations (all LOCKED in `docs/architecture/pairing.md`):
D1 asymmetric per-edge credential (the requester signs with its own
ed25519 key from the #55 D1 substrate — `server/src/identity.ts` — and
the target verifies against the peer's PUBLIC key stored in the edge
record), D2 sibling `mesh_edges.json` (0600, atomic tmp+rename, never in
`state.json`), D5 directional edges (`controls_me` / `i_control`,
initiator is the controller), D6 revocation = immediate local deletion
on the controlled side, D8 fail-closed when no pairing exists.

## What this slice built

- **`server/src/edges.ts`** — the substrate:
  - `EdgeStore`: persists `mesh_edges.json` next to the state file
    (0600, atomic tmp+rename — the state-file and `identity.json`
    posture). Each record holds the peer `instance_id`, the peer's
    public key, the direction, and `created_at`. Missing file = no
    edges (the normal first-boot state, left in place); an empty file
    loads empty and stays put; a corrupt file is moved aside as
    `.corrupt-*` (never deleted) and the store loads empty — under D8
    that means everything stays denied, and the arbiter never crashes.
    Shape-invalid records (unknown direction, unbounded strings,
    non-finite timestamps) make the whole file corrupt — a
    partially-trusted edge file is worse than no edge file. An
    unparseable public key is shape-valid: the record loads and that
    peer is denied at verification (fail-closed, never a trap).
  - `signEdgePayload` (outbound half) + `verifyRequester` (the single
    check the per-edge routes perform): the requester signs a canonical
    `{ instance_id, path, ts, nonce }` body; the target re-derives the
    body from the request and verifies it under the stored public key
    for the claimed `instance_id`. The path binding means a signature
    minted for `/api/mesh/detail` is not reusable on
    `/api/mesh/control-preview`. Every denial is NAMED
    (`unknown_instance_id` / `bad_signature` / `missing_instance_id`) —
    a bare 403 is a bug here, because the operator must be able to tell
    an unpaired peer from a mismatched key.
    `ts`/`nonce` ride the signature now; the accepted-skew window and the
    recently-seen-nonce replay check land with the ceremony (slice 2).
- **`server/src/arbiter.ts`** — `edges()`: the lazy accessor beside
  `identity()` (sibling file next to the state file, the same
  mint-on-first-use posture). No state-file changes — the edge material
  never touches `state.json` (D2).
- **`server/src/api.ts`** — two read-only routes, wired inert until an
  edge exists (D8):
  - `GET /api/mesh/detail` — the detailed queue projection a paired
    edge reads beyond the coarse snapshot (D3): the target's LOCAL
    clients + their `queue_preview` rows (job_id/title/company/score/
    attempts), bounded, no transitivity, no payloads.
  - `GET /api/mesh/control-preview` — the read-only posture for D4: the
    named action set (`pause`, `resume`, `force`, `clear`, `reorder`)
    and the target's current override posture per client. Inert by
    construction — there is no `POST /api/mesh/control` route yet and
    nothing on this route mutates the target.
  - Auth: the per-edge signature envelope (`X-Idlefill-Instance-Id`,
    `X-Idlefill-Signature`, `X-Idlefill-Nonce`, `X-Idlefill-Ts`).
    Neither route answers to a token: the fleet `peer_token` and the
    local admin tokens get 401 (no signature envelope) — a peer is a
    peer, and a local operator reads their own machine via `/api/state`.
    D5: only a `controls_me` edge admits the request; a reverse
    (`i_control`) edge is 403 `direction_denied`. D8: no edge → 403
    `unknown_instance_id`. D6: deleting the edge denies the next signed
    request immediately.
  - The coarse read plane is untouched: `GET /api/mesh` keeps its
    exact shape and its `peer_token`/admin auth; `/api/state` gains no
    keys; the only wire additions are the two new GET routes (ADD) and
    the four `X-Idlefill-*` request headers.

## Deferred to the owner's ceremony decision (explicitly NOT built)

- **The edge-formation ceremony itself** (pairing A to B): request/
  approve vs a one-time code, and the directional-vs-symmetric edge
  choice. #55 D4's surface; this slice does not re-open it. Until the
  ceremony lands, the only way to fill `mesh_edges.json` is the local
  `EdgeStore.upsert` (tests + future admin surface).
- **`POST /api/mesh/control`** (the relayed actions, D4) and
  `POST /api/mesh/unpair` (the D6 admin route — deletion is tested at
  the store level here). Slice 2.
- **The `mesh_control` audit event** (D7: `source_instance_id` ADD key +
  new event kind) — it lands with the relay it audits.
- **Nonce replay enforcement + the ts skew window** — the fields ride
  the signature now; the recently-seen store lands with the ceremony.

## Tests (real crypto, real sockets)

`server/test/edges.test.ts` — 24 tests, all green:

- EdgeStore substrate: missing/empty/corrupt files, 0600 on disk,
  reload survival, immediate removal, malformed-record rejection at the
  door, D5 `allows()` direction policy.
- `verifyRequester` with real ed25519 keypairs (the #55 `Identity`
  substrate, `node:crypto`): a genuine signature verifies; a tampered
  payload (nonce/ts/path) fails; a signature from a DIFFERENT key fails;
  an unknown `instance_id` is rejected (D8) with the named reason even
  under a perfectly valid signature; a missing `instance_id`, a
  garbage/truncated signature, and an unparseable stored key are all
  rejected without throwing.
- The routes over a real Fastify app on loopback: both routes 403 with
  a NAMED reason when no edge exists (a valid signature cannot open
  what pairing never closed); unreachable with `peer_token` and with an
  admin token; 401 without an envelope; with a real edge — 200 carrying
  the queue detail (job ids + titles cross; the coarse plane never
  carries them) and the inert action set; D5 reverse-direction denial;
  D6 immediate revocation; and the coarse plane + anonymous
  `/api/state` shape proven unaffected.

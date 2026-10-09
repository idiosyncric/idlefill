# fleet

The idlefill fleet service. Enrollment + roster + the pairing ceremony
(#55 slices 3 + 6, D4 shape (b)).

It answers enrollment and roster queries. It never sits in the data
path. A peer pulls `GET /roster`, then pulls the arbiter directly over
the tailnet. The service is the directory, not the pipe.

Locked decisions honored: D1 per-instance ed25519 keys (client-minted;
the service verifies the public key only), D2 one-time enrollment
token (single-use, 15 min TTL default, TTL configurable, stored hashed),
D5 machine identity only (`fleet_id` seam, default `home`, no human
login), D6 SQLite as a file (`node:sqlite` runtime built-in — no new
dependency, no database server), D7 dependency-free Node (node:http
only, no fastify).

## Endpoints

- `POST /token` — operator mints an enrollment token. The plaintext
  token is returned once. Only the sha256 hash is stored.
- `POST /enroll` — body `{token, public_key, name}`. Returns
  `{instance_id, credential, nonce}`. A bad, used, or expired token is
  a 401 with a named reason.
- `POST /heartbeat` — body `{instance_id, nonce, signature, urls[],
  presence}`. The instance signs the nonce with its ed25519 key. A bad
  signature or a replayed nonce is a 401.

**Payload shape, read carefully.** The fleet service signs the bare
nonce string (`fleet/src/store.ts:252`). The mesh edge plane signs a
canonical `{instance_id, path, ts, nonce}` envelope
(`server/src/edges.ts`). Two planes, two shapes. A helper written for
one fails closed on the other: safe, but not obvious.
- `GET /roster?instance_id&nonce&signature` — the full fleet. Each
  row: `{instance_id, name, public_key, urls[], last_seen, edges[]}`.
  `edges` is an ADD key (the pairing ceremony, D4): the directed edges
  the row's instance takes part in, `{from, to}` — `from` controls
  `to`. Absent on a pre-ceremony service = no edges.

`urls` and `presence` are ADD keys: absent means keep the stored
value.

### Pairing ceremony (D4, shape (b) — PROPOSED)

One-time code, directional edges, the initiator is the controller
(pairing.md D5; fleet-service.md D4's recommended form for the personal
fleet). All three routes authenticate with a signed nonce like
`/heartbeat`; the authenticated `instance_id` is authoritative.

- `POST /pair/code` — B mints a one-time pairing code. Body: optional
  `target_name` (a display hint for A, never stored). Response:
  `{code, ttl_s}` (PROPOSED TTL 5 min, `pair_code_ttl_ms`). The code is
  single-use, stored hashed, plaintext shown once — the enrollment
  token's exact posture.
- `POST /pair/redeem` — A redeems B's code. Body: `{code}`. Response:
  `{edge: {from: A, to: B}, peer_public_key, peer_name}` — the
  CONTROLLER's side gets the controlled peer's public key to write its
  local edge record. Named denials (400): `invalid_code` / `code_used`
  / `code_expired` / `self_pair` (a machine cannot pair to itself).
- `POST /pair/unpair` — an edge end removes the directed edge. Body:
  `{edge: {from, to}}`. Directional: the reverse direction is a
  separate edge. 404 `unknown_edge` when the named direction is not
  (or no longer) recorded.

The service is the DIRECTORY, never the relay: it records the edge and
publishes it in both rosters. After that, A and B talk directly — the
mesh control relay (`POST /api/mesh/control`, #39) authenticates each
side against its own locally-stored edge record. A machine that pulls
the roster fills its local `mesh_edges.json` record from the roster
(last-known-keys posture — the service-down rule survives; a service
outage freezes edge formation, never breaks an existing pairing).

## Run

This workspace is part of the repo npm workspaces. From the repo
root:

```sh
npm install          # one-time, pulls the shared deps
npm test -w idlefill-fleet
npm run dev -w idlefill-fleet    # listens on :8789
```

Standalone (no workspace install):

```sh
cd fleet
npm install
npm test
npm run dev
```

Config: `FLEET_CONFIG` env (a JSON string) or `config.json` next to
the entry point. Keys: `listen` (8789), `db_file` (`./fleet.db`),
`token_ttl_ms` (900000), `pair_code_ttl_ms` (300000 — PROPOSED). The db
file is local state, never committed.

## Not built here

Deployment (D7: urza routing, the `fleet.samwarth.com` host, the
tailnet posture). The three PROPOSED D3 cadence values: heartbeat 60 s,
control-staleness 24 h, roster pull 15 s — named defaults in
`src/store.ts`, marked PROPOSED. Key rotation (the recovery path is
re-pairing: unpair + re-pair mints a fresh edge; a rotated peer key
refreshes on the next roster pull's re-pair — pairing.md open question 3).

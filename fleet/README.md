# fleet

The idlefill fleet service. Enrollment + roster only (#55 slice 3).

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
- `GET /roster?instance_id&nonce&signature` — the full fleet. Each
  row: `{instance_id, name, public_key, urls[], last_seen}`.

`urls` and `presence` are ADD keys: absent means keep the stored
value.

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
`token_ttl_ms` (900000). The db file is local state, never committed.

## Not built here

Pairing (D4: the owner picks shape (a) or (b) and edge direction).
Deployment (D7: urza routing, the `fleet.samwarth.com` host, the tailnet
posture). The three PROPOSED D3 cadence values: heartbeat 60 s,
control-staleness 24 h, roster pull 15 s — named defaults in
`src/store.ts`, marked PROPOSED.

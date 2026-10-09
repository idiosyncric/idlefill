# Issue #55 — Fleet service, slice 3: enrollment + roster

Slice 3 builds the fleet service skeleton. It answers enrollment and
roster queries only. It never sits in the data path.

## What was built

- `fleet/` workspace: `package.json`, `tsconfig.json`, `src/index.ts`,
  `src/store.ts`, `src/config.ts`, `test/enroll.test.ts`, `README.md`.
- Endpoints:
  - `POST /token` — operator mints an enrollment token (runtime only).
  - `POST /enroll` — token + public key + name to a session credential.
  - `POST /heartbeat` — instance_id + signed nonce + urls[] + presence.
  - `GET /roster` — the full fleet, signed-nonce auth.
- Auth (D2): the instance signs a server nonce with its ed25519 key.
  No shared fleet secret. A bad signature or a replayed nonce is a 401.

## Decisions honored

- D1: ed25519 via `node:crypto`. The service verifies the public key.
- D2: one-time enrollment token. Single-use. 15 min TTL default. TTL is
  configurable. Stored hashed (sha256). The plaintext token is minted at
  runtime and never stored or committed.
- D5: machine identity only. The `fleet_id` seam defaults to `home`.
- D6: SQLite as a file. Driver is `node:sqlite` (DatabaseSync), a
  runtime built-in on node v26. No new dependency. No database server.
- D7: dependency-free Node. `node:http` only, no fastify.
- Wire keys are ADD keys. Absent means unset.

## Tests — 14 pass, run for real (`fleet/test/enroll.test.ts`)

- a BAD token is rejected (401 `invalid_token`)
- a USED token is rejected (401 `token_used`) — single-use
- an EXPIRED token is rejected (401 `token_expired`) — TTL
- an INVALID signature is rejected (401 `bad_signature`)
- the roster returns the enrolled instance with its public key + urls

Plus: nonce replay + unknown instance refused, a malformed key does not burn the token, the token plaintext never lands in the db file.

## Verification

- `npm test -w idlefill-fleet`: 14 pass, 0 fail.
- `NODE_ENV=test npx tsc --noEmit -p fleet/tsconfig.json` and
  `-p server/tsconfig.json`: both clean.
- `NODE_ENV=test npm run test` from the root (all workspaces): server 292,
  client 173, career-ops 17, noop 2, fleet 14. 0 fail. Exit 0.
- `fleet` is registered as an npm workspace. Installs cleanly offline
  from the npm cache. No network. No new dependency.

## Deferred

- Pairing (D4): the owner must pick shape (a) or (b) and the edge
  directionality. Nothing pairing-related is built here.
- Deployment (D7): the urza routing, the `fleet.samwarth.com` host, and
  the tailnet-only posture. No infra files, no docker changes.
- The three PROPOSED D3 cadence values (named defaults in `src/store.ts`):
  heartbeat 60 s, control-action staleness ceiling 24 h, roster pull 15 s.
  The service locks no value.

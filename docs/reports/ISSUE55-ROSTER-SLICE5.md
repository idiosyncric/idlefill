# Issue #55 — slice 5: fleet roster pull on the mesh read plane (D3)

The arbiter can now pull its peer list from the fleet roster. The roster
is the directory, never the pipe: a pulled row is pulled from its own
`/api/mesh` on the normal cadence, exactly like a configured peer.
Read-only seam. No pairing built.

## What was built

- `server/src/mesh.ts`: `MeshFederation.pullRoster(rosterFetcher, now)`
  pulls `GET /roster` from the configured fleet service and merges its
  rows into the peer map. `RosterRow`, `RosterFetcher`,
  `makeRealRosterFetcher`, `sanitizeRoster` (untrusted-input discipline:
  row caps, identity exact not clamped, http(s) urls only), and
  `ROSTER_PULL_MS` (PROPOSED default 15 s, the poll tick). Tick order:
  `pullRoster` then `refresh` — a merged peer is pulled the same tick.
- `server/src/config.ts` + `types.ts`: `fleet_url` + `fleet_roster_pull_ms`
  (PROPOSED) as ADD keys on `ServerConfig`.
- `server/src/index.ts`: the tick calls `pullRoster` before `refresh`.
- `server/test/mesh.test.ts`: 7 new tests. 28 → 35.

## The merge rule (PROPOSED — marked in the code)

ADD-only. A roster row adds a peer at its usable urls. An explicit
`mesh_peers` entry wins over a roster row for the same `instance_id`
(judged by ORIGIN — a configured peer's observed id is null until its
first fetch — never by the observed id). A roster row never removes or
rewrites an existing entry. No `fleet_url` = the pull never happens.

## Service-down posture (the hard rule)

- No `fleet_url`: peer set is the static config, byte-for-byte.
  `pullRoster` is a no-op; the roster fetcher is never called.
- Unreachable service: the pull fails silently. The last-known peer set
  stands. The read plane keeps pulling with `peer_token` (the mesh read
  plane auth is untouched).
- Malformed row: dropped individually, never trusted.

## Cadence

`ROSTER_PULL_MS = 15_000` (PROPOSED, D3 owner choice 3). Configurable via `fleet_roster_pull_ms` (PROPOSED). One pull per interval.

## Tests — run for real

- `server/test/mesh.test.ts`: 35 pass (28 existing unchanged + 7 new).
- Root `NODE_ENV=test npm run test`: server 338, client 177, career-ops
  17, noop 2, shell-ui 3, dashboard 4, fleet 14. 0 fail. Exit 0.
- `NODE_ENV=test npx tsc --noEmit -p server/tsconfig.json`: clean.

## Deferred (open owner decisions)

- **Pairing (D4) is still an open owner decision.** The owner picks
  shape (a) request/approve or (b) one-time code, and directional or
  symmetric edges. This slice does NOT build it. `docs/architecture/
  pairing.md` is untouched.
- The three PROPOSED D3 cadence values (heartbeat 60 s, control-stale
  24 h, roster pull 15 s) are named defaults. The owner picks. The
  arbiter-side D2 signed-nonce client (mint + sign the server nonce for
  `GET /roster`) is the next seam; `makeRealRosterFetcher` is where it
  lands. `fleet_url` unset = no pull, so it is inert until wired.

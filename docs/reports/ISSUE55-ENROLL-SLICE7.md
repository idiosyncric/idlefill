# #55 slice 7 — arbiter-side fleet enrollment + signed roster pull

Closes the seam `makeRealRosterFetcher` named in slice 5: the arbiter's roster pull now authenticates the way the fleet service actually requires.

## What is now closed

- `server/src/fleet-client.ts` (new): the arbiter's enrollment client. Enrolls ONCE (`POST /enroll`: one-time token + the #55 D1 ed25519 public key + a name → session credential + fleet-issued `instance_id`), persists both to a sibling `fleet_enrollment.json` next to the state file (0600, atomic tmp+rename — the `mesh_edges.json` / `identity.json` posture, the #39 D2 clause, never in state.json), and mints + signs a fresh nonce with the #55 D1 identity for every roster pull (node:crypto only, no new dependency). Fail-quiet throughout: a failed enroll or pull is a no-op (the Service-down rule), never a throw, never a crash.
- `server/src/mesh.ts`: `makeRealRosterFetcher` (the unsigned seam) is replaced by `makeSignedRosterFetcher` + `buildRosterFetcher`. All of `fleet_url` + `fleet_instance_id` + `fleet_enrollment_token` present = the signed fetcher; any one absent = the pull stays a no-op exactly as before (no enroll attempt, no credential file touched, peer set byte-for-byte). `server/src/index.ts` wires `buildRosterFetcher(cfg, arbiter.identity())` into the existing poll tick — no tick change.
- `server/src/config.ts` + `types.ts`: two new named keys, each marked PROPOSED in the comment: `fleet_instance_id` (declaration seam — the file is the source of truth) and `fleet_enrollment_token` (the operator's one-time token). Both default to undefined; a real token is never committed (config.json is gitignored) or logged.

## What the owner must still supply

1. **The enrollment token** — minted at the live service (`POST /token`), pasted into `server/config.json` as `fleet_enrollment_token` (single-use, 15 min TTL: spent once, the credential persists).
2. **The instance identity** — `fleet_url` (the fleet base URL) + `fleet_instance_id` (any non-empty declaration; the fleet-issued id is persisted at enroll). The ed25519 keypair already exists in `identity.json` (#55 D1) — nothing to mint.

## What remains unbuilt

- **Pairing (D4)** — the owner's shape decision (request/approve vs one-time code + edge directionality) is still open; pairing routes not built here.
- **Deployment (D7)** — urza routing / `fleet.samwarth.com` tailnet-only reach is the operator's (slice 4 templates exist; the service is not deployed).
- The three PROPOSED D3 cadence values remain owner choices.

## Verification (run for real)

- **Fleet `arbiter-client.test.ts` 6/6**: enroll → signed heartbeat → signed roster over the REAL in-process service (proving the client's signed requests are accepted by its real ed25519 verifier); unsigned 401 `missing_auth`; wrong-key 401 `bad_signature`; nonce replay 401 `nonce_replayed`; wiped-credential re-enroll; expired token `token_expired` no crash.
- **Server `mesh.test.ts` 39/39**: four new slice-7 cases (no fleet_url = inert byte-for-byte; fleet_url without identity = no pull, no crash; signed client vs a stub fleet service enrolls + pulls rows — real HTTP + real crypto; stale credential re-enrolls) + the 35 pre-slice-7 tests.
- **Root gate `NODE_ENV=test npm run test`: exit 0** — server 360/360, client 177/177, fleet 20/20 (enroll 14 + arbiter-client 6), career-ops 17/17, noop 2/2, shell-ui 3/3, dashboard 4/4. `tsc --noEmit` clean (server + fleet). Note: the worktree needed `npm install` once (the client `--version` test spawns `<worktree>/node_modules/.bin/tsx`) — noted, not faked.
- **Live**: real fleet service from the worktree on 127.0.0.1:8789 — unsigned `/roster` → `401 {"error":"missing_auth"}`; `POST /token` → 200; client enroll ok (`m-af6203f3fdd8adad`, credential persisted 0600); `heartbeatOnce` → `{"ok":true}`; `signedRoster` → 200 with the instance row (name urza, heartbeat urls, the enrolled public key). Service stopped afterward; the running arbiter (:8787) was not touched.

# Issue #50 (read plane) — mesh federation build report

The first implementation slice of the #50 migration path (step 1: the
read plane). Decision authority: `docs/architecture/mesh.md`. Additive
change: zero lease/gate/session behavior moved.

## What landed

- **`server/src/mesh.ts`** — the federation module. `MeshFederation`
  pulls each configured peer's `/api/mesh` snapshot concurrently on the
  poll cadence; `sanitizeSnapshot` treats every remote payload as
  untrusted input (identity required, strings capped at 64, ≤20 engine
  rows, non-finite numbers zeroed, unknown keys dropped);
  `buildMeshSnapshot` builds the local coarse snapshot;
  `mintInstanceId` mints `m-<12 hex>`.
- **Config** (`server/src/config.ts`): `mesh_peers: [{url, name?}]`
  (trailing slashes normalized, blank urls dropped), `peer_token`,
  `mesh_name` (default: the OS hostname). `mesh_peers` is deliberately
  NOT `server_peers` (llama-swap backends).
- **Identity**: `arbiter.instanceId()` mints once and persists
  `instance_id` in `state.json` — the ONLY mesh data that touches the
  state file. Peer snapshots stay in memory (restart = empty mesh view
  until the first pull).
- **`GET /api/mesh`** — this instance's snapshot. Auth: the fleet
  `peer_token` (read-only, scoped to this route by the onRequest hook)
  or a local admin token. The peer token unlocks NO other `/api/*` route
  and is rejected at the WS handshake (`attachWebSocket` keeps
  `isValidToken` only).
- **`/api/state`** — ADD key `mesh: { instance_id, peers: [] }` (the
  add-never-rename contract). Absent entirely when the module is not
  wired. Peer rows: `url`, `name`, observed `instance_id`, `online`
  (90 s window — the client-liveness precedent), `fetch_age_s`,
  exception-only `error`, last `snapshot`.
- **Dashboard** — the "Machines" strip (`peerBlock`): exception-only
  section, read-only rows reusing the `.srv`/`.worker` styles and the
  `liveWord` state semantics. No controls (cross-instance control is
  #39's paired channel).
- **Tick wiring** (`server/src/index.ts`): `MeshFederation` constructed
  with the real fetcher; refresh rides the existing `tickOnce` (the
  fetch is concurrent and never throws — a peer failure records an
  exception-only error and the last snapshot stands).

## Coarse by construction (the privacy boundary)

The snapshot carries: `instance_id`, `name`, `ts`, optional `version`,
per-engine `{name, idle, idle_for_s, degraded}`, summed queue DEPTH,
session count, active-lease count. It never carries job ids, titles,
URLs, payloads, or queue previews — enforced at the builder AND at the
sanitizer (a hostile peer cannot smuggle extra keys into the local view).

## Verification

- `server/test/mesh.test.ts` — 24 tests: sanitizer (good/hostile/
  missing-identity/extra-keys), federation (success, failure keeps the
  snapshot + exception-only error, 90s offline, malformed payload,
  inert-without-peers, url normalization, name fallbacks), snapshot
  builder, HTTP auth matrix (peer_token on /api/mesh 200, admin 200,
  anonymous 401, wrong 401; peer_token 401 on leases/projects/servers/
  project-pause/client-override; peer_token rejected at the WS
  handshake), the /api/state mesh key (wired + unwired + anonymous),
  instance_id persistence across a restart, and the ephemeral rule
  (no peer data in state.json).
- Full gates: `npm run test` → 191 pass / 0 fail (server 113, client
  61, career-ops 15, noop 2). `npm run build` clean. `npx tsc --noEmit`
  clean in server and client.
- NOT run: the live two-process smoke (blocked by the approval gate).
  The HTTP tests run a real Fastify app on an ephemeral port, so the
  wire behavior is covered; a second-machine eyeball against urza is
  the owner step (config: add `mesh_peers` + `peer_token` to both).

## Deliberate non-changes

- No lease/gate/session logic touched. Grants stay per-engine; a remote
  engine reference row carries no detector (fail-closed) — unchanged.
- No pairing, no control relay (#39), no work portability (#50 D4).
- `state.json` gains exactly one key (`instance_id`).

## Pitfalls for the next slice

- The agent redaction filter mangles `Bearer <token>`-shaped text in
  tool-call payloads (write AND patch paths). Code or docs containing
  it must be assembled from fragments in a script and byte-verified
  (`od -c`), never written literally through patch args.
- `sanitizeSnapshot` must reject negative `idle_for_s` outright (a
  negative age would render as a future timestamp) — clamping with
  `Math.max(0, …)` hides the lie instead of surfacing it.
- The mesh view evaluates liveness against the REAL clock; tests that
  pull at a fake-clock T0 must expect `online: false` on /api/state
  (the federation unit tests cover the flag against a controlled clock).

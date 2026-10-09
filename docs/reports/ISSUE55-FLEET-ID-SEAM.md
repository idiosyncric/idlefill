# ISSUE 55 — slice 2: the `fleet_id` seam on the instance row

**Branch:** `issue-55-seam` (off main HEAD `86e427e`) · **Card:** #55 slice 2 —
`docs/architecture/fleet-service.md` D5 (LOCKED): "Machine identity only.
Record the seam, build nothing human-facing."

## What shipped

One ADD key — `fleet_id` — on the arbiter's instance row. The whole slice:

- **`server/src/types.ts`** — `ServerConfig.fleet_id?: string` (config input;
  a display label, never a credential) and `ArbiterState.fleet_id?: string`
  (persisted on the instance row, ADD-key sibling of `instance_id`).
- **`server/src/config.ts`** — reads the `fleet_id` key from config;
  absent/blank → `''` (unset).
- **`server/src/arbiter.ts`** — new `Arbiter.fleetId()`: precedence is
  config (non-blank, the operator's standing declaration) → the persisted
  state row (survives a config edit that drops the key) → the D5 default
  `home`. Written through the state store, so it lands in `state.json`
  next to `instance_id` (the identity store).
- **`server/src/mesh.ts`** — `MeshSnapshot.fleet_id?: string` ADD key,
  published by `buildMeshSnapshot(..., fleetId?)` (present when the
  publisher has one, absent when it has none) and sanitized by
  `sanitizeSnapshot` (untrusted input, length-capped like the rest of the
  snapshot). **Absent on an old snapshot = unset — it parses fine, never a
  crash.**
- **`server/src/api.ts`** — `GET /api/mesh` passes `arbiter.fleetId()`
  through (the local instance's label rides its own snapshot).
- **`server/test/mesh.test.ts`** — four new tests (below).

## The four card tests (all passing)

1. A config with `fleet_id` set produces the value on the instance row
   (`state.json` carries `fleet_id` next to `instance_id`) and on the
   snapshot.
2. No config key (and no persisted row) produces `home`; the default is
   persisted, and a reload reads the same answer with no config involved.
3. An old-shaped snapshot without the field parses fine — `fleet_id`
   stays `undefined` (unset), not a crash, not `home`.
4. Two instances with different `fleet_id` values are distinguishable in
   the snapshot reader (`MeshFederation` view shows `alpha-fleet` vs
   `beta-fleet` per peer), and a pre-seam peer among them simply reads
   unset.

## What this is NOT

Per D5 (LOCKED): **no accounts, no sessions, no roles were built.** This is
machine identity only — one column that records the seam and defers the
rest. Explicitly not in this slice:

- No login, no auth, no user table, no operator identity surface.
- No pairing ceremony and no edge semantics — that is #39 (a different
  worker owns it); `pairing.md` and the mesh edge code are untouched.
- No fleet service, no roster, no enrollment, no deployment — D2/D3/D4/D7
  remain deferred (the service does not exist yet).
- No client-facing surface: the dashboard reads the snapshot shape it
  already reads; `fleet_id` is an ADD key old readers ignore, so existing
  readers are byte-for-byte unaffected.
- No secret anywhere: `fleet_id` is a label, not a credential;
  `client/src/session-gate.ts`, `client/src/proxy.ts`,
  `plugins/hermes-idlefill`, `server/src/load.ts` are untouched.

## Verification (real runs, this worktree, Node 22, TypeScript strict)

- `NODE_ENV=test npx tsc --noEmit` (server): exit 0, no diagnostics.
- `NODE_ENV=test npm run test` (root, all workspaces):
  - **idlefill-server: 286 tests, 286 pass, 0 fail** (includes the four
    new `fleet_id` tests; `mesh.test.ts` alone: 28/28).
  - idlefill-mcp: 17/17; adapter-noop: 2/2; dashboard: no test script.
  - **idlefill-client: 159 tests, 158 pass, 1 fail — PRE-EXISTING, not
    this slice.** The failure is `--version (dev path): tsx src/index.ts
    --version …`, which requires `node_modules/.bin/tsx` at the repo
    root. This fresh worktree has no `node_modules` (never
    `npm install`ed), so the guard throws `tsx missing — npm install in
    the repo first`. It reproduces identically on clean `86e427e` with all
    slice-2 changes stashed; no client file in this slice's diff.

## Files

`server/src/types.ts`, `server/src/config.ts`, `server/src/arbiter.ts`,
`server/src/mesh.ts`, `server/src/api.ts`, `server/test/mesh.test.ts`,
plus this report and the README index line.

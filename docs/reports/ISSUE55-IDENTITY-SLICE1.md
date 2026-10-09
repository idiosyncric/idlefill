# Issue #55 — slice 1: per-instance identity substrate

**Status:** shipped (branch `issue-55-identity`). **Scope:** the local
identity substrate only — D1 from
`docs/architecture/fleet-service.md` (LOCKED). No service, no network,
no enrollment.

## What shipped

**`server/src/identity.ts`** (new) — the per-instance ed25519 keypair:

- Minted at first use via `node:crypto` `generateKeyPairSync('ed25519')`
  (no new dependency). Public key: 44 DER bytes = 59 chars base64url.
  Private key: 48 DER bytes = 64 chars base64url. Signature: 64 bytes.
  Signing uses the null-hash form (`crypto.sign(null, payload, key)` /
  `crypto.verify(null, ...)`) — verified live on node v26.10.0;
  `createSign('RSA-SHA256')` is rejected for ed25519 KeyObjects in this
  runtime, and `KeyObject.getPublicKey()` does not exist (the halves are
  cross-checked by round-tripping a probe signature instead).
- Persisted in a **sibling `identity.json`** next to the state file
  (`identityFileOf(cfg.state_file)`), schema `v: 1` with
  `public_key` / `private_key` / `created_at`.
- **0600, atomic tmp+rename** — the exact posture of `state.ts:save()`
  (`server/src/state.ts:134-140`): owner-only on the tmp file *before* the
  rename, plus a forced `chmodSync(tmp, 0o600)` for a stale wider tmp.
- The **private key never enters `state.json`** (D1 rule) — it lives only
  in the sibling file. Nothing secret rides every atomic state save.
- **Failure posture mirrors the state file:** a corrupt / unreadable /
  mismatched identity.json never crashes the arbiter — a fresh keypair is
  minted on demand, a `WARNING` lands on stderr, and the stale file is
  moved aside as `identity.json.corrupt-<ts>` (never silently deleted).
  A *missing* file is the normal first-boot path: minted silently, like a
  fresh state file.
- `Arbiter.identity()` (`server/src/arbiter.ts`) mints lazily on first
  call and caches the instance for the process lifetime.

**Mesh snapshot** (`server/src/mesh.ts`, `server/src/api.ts`) — the
public key + the existing `instance_id` are published:

- `public_key?: string` is an **ADD key** on `MeshSnapshot`: present when
  the publisher carries an identity, **absent = unset** otherwise.
  Existing peers that ignore the new field are byte-for-byte unaffected —
  proven by a test asserting an old-shaped snapshot sanitizes to exactly
  the pre-#55 field set.
- `sanitizeSnapshot` length-caps a peer's `public_key` (64) — untrusted
  input, same discipline as `version` / `name`.
- `GET /api/mesh` now includes the publisher's key
  (`arbiter.identity().publicKeyB64url`). `/api/state` gains no keys.

**`server/test/identity.test.ts`** (new, real crypto) — 15 tests:
mint shapes (59/64 base64url), sign/verify round trip, tampered payload
fails, cross-key failure, garbage-input safety (never throws),
persistence + restart stability, **0600 mode**, private key absent from
state.json, rotated keypair → different public key + old signature fails,
corrupt / half-written / mismatched identity.json → fresh mint without
throwing (stale file preserved as `.corrupt-*`), ADD-key absent/present
semantics, and the old-shaped-snapshot compatibility proof.

## What is explicitly deferred (later slices)

- **Enrollment (D2):** needs the fleet service — the one-time enrollment
  token, POST of public key + display name, session credential bound to
  the key. Not built; this slice keeps the keypair local-only.
- **Roster (D3):** `GET /roster`, heartbeat cadence, `fleet_url` config,
  the merge rule over static `mesh_peers`. No network in this slice.
- **Pairing (D4):** the #39 ceremony — request/approve edges, signed
  requests, `mesh_edges.json` adjacency. The ed25519 keypair is the
  substrate it will pair against.
- **Deployment:** no wire auth using the key yet — `peer_token` remains
  the mesh read-plane auth (this slice is the identity substrate, not a
  transport change). The public key on the snapshot is display/verification
  material for later slices.
- **`instance_id` ↔ key binding in the roster:** the snapshot carries both
  independently today; binding happens when the service exists.

## Verification (real output, node v26.10.0, 2026-10-09)

- `cd server && npx tsc --noEmit` → clean (exit 0).
- `NODE_ENV=test npm run test` (root, all workspaces) → green; server
  suite includes the 15 new identity tests (all pass).
- `node:crypto` ed25519 sign/verify probed live before implementing:
  64-byte signature, tamper fails, key re-encoding round-trips.

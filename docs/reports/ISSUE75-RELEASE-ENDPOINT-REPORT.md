# RELEASE-ENDPOINT REPORT — owner decisions locked + first signed release (issue #75)

**Doc:** `docs/architecture/shell-updater.md` — now ALL LOCKED (Q-e settled by the owner 2026-10-09: option (a), the operator host signs; no key on the CI runner). The two owner steps were locked as decided and executed on the operator host (this Mac). Main `2de1b9c`.

## What shipped

1. **Key generation:** `cargo-tauri signer generate` on the operator host, empty passphrase (release.sh sets no `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the doc names no passphrase). Private key `~/.config/idlefill/tauri-signing.key` (0600, outside the repo, keyid `4C6A8353BA55E637`). Public key landed in `tauri.conf.json` `plugins.updater.pubkey` (content) — the channel gate opens.
2. **Version:** root `package.json` bumped `2` → `4` (the tag-collision correction: `v1`/`v2`/`v3` exist from the numbered-release era; the first updater release is N=4). Tag `v4` cut at `2de1b9c` and pushed to origin (never to the github mirror — release tags are Forgejo-side per AGENTS.md).
3. **Release #4 published** by `scripts/release.sh` (signed pass): `Release #4` (tag `v4`, updater SemVer `1.0.4`, marker `2de1b9c`) carries `latest.json` + `Idlefill.app.tar.gz` (4.89 MiB). Feed: `https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json`. Carry-forward staging created: `~/idlefill-release-staging/` (pair + `.sig`).

## Corrections the first signed run forced (both shipped on main)

- **`tauri/build.sh` — the TAURI_CONFIG seam was fake at the CLI level.** tauri-cli 2.12.1 only WRITES `TAURI_CONFIG` (`helpers/config.rs:170`, for the build.rs ACL plane) and never reads it from the env; only `tauri-utils` `acl/build.rs:427` reads it. The bundler config seam is `-c/--config` (inline JSON). Every prior build (edge-main included) silently bundled the committed `1.0.0` and no updater artifacts. Fix: the patch now goes to `-c`; `TAURI_CONFIG` stays exported for the ACL plane. Verified: `Idlefill.app.tar.gz (updater) (4.89 MiB)` + `.sig` emitted; `--version` prints `idlefill 2de1b9c`.
- **`scripts/release.sh` — the auth header was dropped by curl.** `AUTH="$B: $TOKEN"` → header `Bearer: <token>`; even corrected to `Bearer <token>` the value had no `Authorization:` name, so curl's `-H` dropped it and every write went anonymous (GETs worked — public repo — while create/delete 401'd). This Forgejo also rejects `Bearer` ("token is required"). Fix: `AUTH="Authorization: token $TOKEN"` (the fragment trick kept, so no token-shaped literal). Verified: `/api/v1/user` echoes `web-dev`.

## Verified (real output, this run)

- `release.sh` full signed pass exit 0: `feed OK: version 1.0.4 platform darwin-aarch64 present`, `live bundle GET -> 200` (anonymous).
- Anonymous feed GET parses: `version 1.0.4`, `pub_date` present, `platforms.darwin-aarch64.url` = the `latest` pseudo-tag bundle URL, `signature` == the local `.sig` file content (one base64 line).
- Downloaded bundle sha256 == the local `target/release/bundle/macos/Idlefill.app.tar.gz` (byte-identical: `b0197fc7…`).
- **minisign verify OK**: the feed signature validates over the downloaded bundle with `minisign-verify 0.2.5` — the same crate `tauri-plugin-updater` uses — against the pubkey committed in `tauri.conf.json` (keyids match). The full chain (config pubkey → manifest signature field → bundle bytes) verifies.
- Gates before the main advance: `npm run test` 7 suites fail 0, `npm run build` exit 0, `cargo check` clean, `cargo test --lib` 59 pass.

## State after

The updater channel is LIVE: an installed shell at `1.0.0` (or any `1.0.<4`) pointing at the feed sees `1.0.4` in Settings → "Check for updates…" (the only trigger, D6). Future releases: `release.sh N` on this host with `TAURI_SIGNING_PRIVATE_KEY=~/.config/idlefill/tauri-signing.key` + the profile's `FORGEJO_TOKEN` (the key never lands on urza — Q-e LOCKED). Losing `tauri-signing.key` breaks the channel until a new keypair + rebuilt baseline (D4); there is no backup copy outside `~/.config/idlefill/`.

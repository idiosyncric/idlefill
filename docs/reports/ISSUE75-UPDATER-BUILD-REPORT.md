# BUILD REPORT — Tauri shell signed updater: build wave (issue #75)

**Branch** `issue-75-updater` (off `main` 16eac11). **Doc:** `docs/architecture/shell-updater.md` (D1–D6 LOCKED, Q-e PROPOSED). Build wave. No secret written; nothing pushed or merged. The two owner steps (key generation, first signed run) are the only things not done.
## What was built
- **`tauri/src-tauri` (Rust plane).** `Cargo.toml`: `tauri-plugin-updater="2"` + `semver="1"`. New `src/updater.rs`: pure verdicts (`check_verdict`, `status_line`, `latest_json`, `is_sig_b64`) + thin executors. The D4 gate is fail-closed: an empty `plugins.updater.pubkey` makes the channel INERT — the commands refuse before any feed request. `latest_json` pins the D3 shape (the `.sig` field = base64 of the `.sig` file content; verified against the `tauri-plugin-updater 2.13.2` client + `tauri-cli 2.12.1`). `src/lib.rs`: the plugin is registered always; `update_check`/`update_install` are the D6 GUI verbs (NO launch check, NO timer); `update_install` emits `updater-progress` to the settings window (the download status line). `build.rs` + `capabilities/default.json`: the two commands get `allow-update-check`/`allow-update-install` (local windows only; the remote arbiter page gets NO IPC). The plugin's own JS commands are NOT granted to any window.
- **`tauri.conf.json`:** `plugins.updater` — `endpoints` = the `latest` pseudo-tag feed URL (D2), `pubkey: ""` (committed key-free posture; the owner drops the public key here).
- **`tauri/ui` (settings UI, D6).** `settings.tsx` Update section, matching the sibling rows: "Check for updates…" is the ONLY trigger; the "Install and restart" row renders ONLY when found (exception-only); the download status line rides the `updater-progress` event. `lib/ipc.ts` gains the `UpdateState`/`UpdateProgress` types + the two verbs.
- **`tauri/build.sh`:** `IDLEFILL_UPDATER_ARTIFACTS=1` merges `bundle.createUpdaterArtifacts: true` into `TAURI_CONFIG` (D4: on the release pass ONLY, never committed).
- **`scripts/release.sh`:** the artifact stages. Fail-closed on an absent private key OR an empty config pubkey (a named error, NO publish, before any network). Then: build (artifacts on) → collect the bundle + `.sig` (fail-closed if the `.sig` is absent) → assemble `latest.json` → attach → carry-forward → anonymous live verification (feed 200 + parse + version match + bundle 200). `--dry-run` assembles + validates `latest.json` from stand-in artifacts; publishes NOTHING.
- **`tauri/ui/test/updater-manifest.test.ts`:** the no-key dry-run harness (deliverable 4): assembles `latest.json` from stand-in artifacts, validates the D3 shape (exactly `version`/`pub_date`/`notes`/`platforms`; each platform exactly `url`/`signature`; the signature is one base64 line that decodes to the multi-line minisign box). Wired into the `tauri/ui` `test` script, so the root `npm test` gate runs it.
## What is verified (real output)
- `bash -n scripts/release.sh` → OK.
- `bash scripts/release.sh --dry-run` → assembles + validates `latest.json` (version 1.0.1, platform darwin-aarch64), "nothing was published".
- `release.sh` fail-closed: no key → `exit 1` + named error; empty config pubkey → `exit 1` + named error. Both publish nothing.
- `cargo check` in `tauri/src-tauri` → clean.
- `cargo test --lib` in `tauri/src-tauri` → 59 pass, 0 fail (includes the 5 new `updater::tests`).
- `NODE_ENV=test npm run test` (root) → 515 pass, 0 fail; includes the new `updater-manifest` suite.
- `tsc --noEmit` in `tauri/ui` → clean.
## Blocked on the owner
- **Key generation:** `cargo-tauri signer generate` on the operator host. Private key → `~/.config/idlefill/tauri-signing.key` (0600). Public key → `tauri.conf.json` `plugins.updater.pubkey`. (Q-e: the signing host is PROPOSED, not LOCKED.)
- **The first signed run:** the first `release.sh` pass with the key (emit the bundle + `.sig`, assemble `latest.json`, publish, verify live).

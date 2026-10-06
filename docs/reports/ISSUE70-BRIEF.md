## Build wave — the `tauri/` tree to parity (decision doc #69 LOCKED; do not re-decide)

Decision doc: `docs/architecture/tauri-cutover.md` (read it FIRST, it is the spec). Spike evidence: `docs/reports/ISSUE69-GRILL-REPORT.md`. Owner locks: D1-D9 + Q-a auto-reload once per dead→live edge, Q-b NO release artifacts (edge.yml retires at the deletion commit, not now), Q-c single tray click = glance, Q-d one LaunchAgent `com.sam.idlefill.app` at the cutover (not installed by this wave).

## Scope of THIS wave (D8 phase 1 only)

Build `tauri/` in-repo to functional parity, gated by tests + a headless acceptance run. **Nothing in `desktop/` or `menubar/` changes. No CI changes. No install to /Applications. No LaunchAgent install (scratch-label tests only, per repo harness discipline). The live machine keeps running the Swift planes.** The deletion commit + live label cutover are a SEPARATE owner-gated step (supervisor fence, issue #69 comment 497).

Allowed paths: `tauri/**` (new tree), `docs/reports/ISSUE70-REPORT.md`, `docs/reports/ISSUE70-BRIEF.md` mirror stays read-only. Must NOT touch: `desktop/`, `menubar/`, `server/`, `client/`, `adapters/`, `scripts/`, `.gitea/`, `package.json`, any config.json.

## Required deliverables

1. `tauri/src-tauri/` (Rust) + `tauri/settings-ui/` (tiny local HTML/CSS/JS for the settings window — no framework) + `tauri/build.sh` (the marker discipline: `IDLEFILL_BUILD_MARKER` env → `option_env!`/`env!` baked + `tauri.conf.json` bundle version, mirroring desktop/build.sh + menubar/build.sh conventions; `--version` argv check prints `idlefill <marker>`).
2. Window parity: runtime `WebviewWindowBuilder` + `WebviewUrl::External` from `client/config.json` `server_url`; `initialization_script` token injection (runtime read, write-only — never printed, never logged, never in any report line); close-to-tray (`CloseRequested` → `prevent_close`); D6 blank-origin trio: pid-line liveness on the 5s tick, exception-only tray `stopped` word + `Relaunch arbiter` item (kickstart WITHOUT -k), auto-`reload()` exactly once per dead→live edge (Q-a).
3. Tray parity per D1 as locked: single click = glance only (no double-click gesture), borderless positioned glance window (blur-dismiss; the named fallback = plain tray menu — if you take the fallback, record the switch and why), `Open Desktop` = show+focus window, Settings, Quit. Glance CONTENT ported pin-for-pin from `glanceStatusRow` + `panelActionRows` (minus the update row) as PURE Rust with cargo tests.
4. Lifecycle parity per D4: Rust launchctl port of e737411's semantics (liveness = the `pid =` line; kickstart without -k; bootstrap/bootout; render-before-bootout) with cargo tests over canned `launchctl print` output — port the exact fixtures from arbiter-test.sh / desktop's Settings rows. Settings window (local bundled UI, Rust IPC commands): daemon/menubar/arbiter toggles, `runs:` lines, repo path. NO update block (retired).
5. Deep links per D5: `tauri-plugin-deep-link` + single-instance, `hashView` map ported to pure Rust with cargo tests, plist `CFBundleURLTypes` verified IN THE BUILT BUNDLE via plutil. Functional deep-link round-trip is DEFERRED to the cutover (do NOT steal `idlefill://` from the live Swift desktop by registering during this wave — run the binary directly, note this in the report).
6. Install script `tauri/install.sh` mirroring menubar/install.sh discipline: render-before-bootout, scratch label (`IDLEFILL_APP_LABEL`/`_PLIST_DIR`/`_LOG_DIR` overrides), real labels byte-identical before/after — plus `tauri/install-test.sh` proving it on a scratch label. NOT run against the real label in this wave.
7. D9 retirement map: every pin in the retired Swift harnesses gets a cargo test or an honest "no replacement needed" row. CI gates are NOT flipped in this wave (they flip at the owner-gated deletion commit) — say so in the report.

## Gates (paste actual output)

1. `cargo test` (workspace under `tauri/src-tauri`) — all green, and list each test name in the report (the pin map).
2. `cargo clippy -- -D warnings` (or report the exact warning list if you dispute a lint — do not silently allow).
3. `bash tauri/build.sh` with a marker + `--version` prints `idlefill <marker>`; default prints `idlefill dev` (or your chosen default, pinned in the report).
4. `cargo-tauri tauri build --debug` produces the .app bundle; `plutil -extract CFBundleURLTypes json` on it shows the `idlefill` scheme; ATS/plist merge present.
5. Live acceptance (headless, additive-only): run the built binary pointed at the REAL arbiter `http://127.0.0.1:8787` with the real `client/config.json`; prove via log lines + proof channel (page-load Finished observed; pid-line liveness correct; the dead→live auto-reload edge fires exactly once — prove by kickstarting the ARBITER on a scratch label, NEVER the production arbiter: run a scratch arbiter on a scratch port instead and point the app config at it via a scratch config copy, never editing the real client/config.json).
6. Zero writes outside: `git show --stat` per commit shows only allowed paths; report the diff of the scratch config copy vs real one proving the real one untouched (md5 before/after).

## Process

- Commit on main (repo convention), identity web-dev@agents.samwarth.com, `git add` only your paths, never `-A`, never push. One commit per coherent slice (scaffold, window, tray, lifecycle, settings, install, tests/docs) is fine — sibling style, subjects like `feat: #70 tauri tree — <slice> (...)`, final commit `docs: #70 report — ...`.
- If cargo/network stalls, retry once, then report the exact error honestly.
- Tokens/keys: never printed, never in logs, never in the report.
- ASD-STE100 in the report.

End with exactly one line: `TAURI-BUILD-DONE rc=<0|1>`

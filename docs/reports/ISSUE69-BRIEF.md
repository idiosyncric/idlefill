# Issue #69 brief (mirror of the Forgejo issue body)

## Ask (owner, 2026-10-06)

Full cut-over of the two Swift shell apps (`desktop/IdlefillDesktop.swift`, `menubar/IdlefillMenubar.swift`) to **one Tauri v2 artifact**, built and run from the repo. No auto-updater solution is to be built: the Sparkle machinery, the edge-channel plumbing, the appcast/signing pipeline, and the update UI retire as part of this cutover. "Run the latest" means build + install from the checkout.

## Locked by the owner (do not re-decide)

1. One artifact: the window app and the menubar companion collapse into a single Tauri app (window + tray).
2. Tauri v2 (installed here: cargo 1.99, @tauri-apps/cli 2.9.2, wry 0.52.2 / tao 0.35.2, Xcode present).
3. Built and run from the repo — no Sparkle, no tauri-plugin-updater, no appcast feed. The update channel in the Settings surface retires.
4. The page stays the surface: the arbiter's live origin is loaded, never a bundled copy of `index.html` (#61 rule survives the shell swap).
5. Lifecycle stays native: launchd controls never move into the page (#61 lock).

## What the single artifact must match (parity inventory, verified 2026-10-06)

From `desktop/IdlefillDesktop.swift` (2,187 lines):

- WKWebView loading the live origin from `client/config.json` `server_url`, plus the ATS exception for plain-HTTP loopback.
- Token injection: the gate token read at runtime from `<repo>/client/config.json`, injected at `.documentStart` into the page's own localStorage key (write-only rule: never baked, never printed, never logged).
- Slim native toolbar: origin display, exception-only `arbiter stopped` row with kickstart Relaunch (the loaded-but-exited semantics of commit e737411: liveness = the `pid =` line, `launchctl kickstart` without -k), Reload, settings disclosure.
- Settings disclosure re-hosts what the arbiter can never know: daemon/menubar/arbiter launchd toggles from REAL `launchctl print` state on a 5s tick, `runs:` lines, the menubar stale marker, repo path. The update-channel block RETIRES (locked item 3).
- Deep links: `idlefill://` URL scheme, every host routes the one webview onto the page's default view or `#<view>` via the pure `AppModel.hashView(for:)` map (state→#overview, sessions→#sessions, projects→#projects, usage→#usage, else default).
- Blank-origin posture (the class of bug that motivated this decision): when the origin is unreachable, today the webview paints blank and the toolbar's arbiter-stopped row is the only honest signal. The cutover must decide the retry/relaunch behavior — see the grill.

From `menubar/IdlefillMenubar.swift` (3,118 lines, demoted at #61 step 4):

- Tray/status item: state word glance, single-click popover with status rows, `Open Desktop` row (`idlefill://open`), exception-only update row.
- The update-check machinery (cadence config, log) RETires entirely with locked item 3.

## What retires (with the repo rule: harnesses retire WITH the code they pin)

- `desktop/`: `IdlefillDesktop.swift`, `build.sh`, `update.sh`, `arbiter-test.sh`, `edge-test.sh`, Sparkle vendor bits.
- `menubar/`: `IdlefillMenubar.swift`, `build.sh`, `install.sh`, the plist template, `panel-test.sh`, `uc-test.sh`, `uc-update-test.sh`, `sessions-test.sh`, `staleness-test.sh`, `edge-test.sh`, `install-test.sh`.
- CI: the `swiftc -parse` gates in `test.yml` (×2), `edge.yml`, `release.yml` swap to the Tauri gates (cargo test / clippy / build).
- Release plumbing: the desktop+menubar artifact zips, the `generate_appcast` step, and the ed25519 Sparkle key usage in `scripts/release.sh` + `scripts/edge-release.sh`. What stays (plain zips for manual install) versus what goes (appcast, signing, appcast-staging guards) is a grill decision with an owner question.
- The live launchd label `com.sam.idlefill.menubar` retires at cutover completion (the tray lives inside the app now); the daemon + arbiter labels are NOT touched.

## Hard fences

- `server/`, `client/`, `adapters/`, `scripts/` idlefill-control/daemon scripts: untouched.
- `server/public/index.html` (the page): untouched — the shells host it, they do not rewrite it.
- Tokens/keys: write-only rule everywhere, and config files keep their posture.
- Mesh/aggregate/alias decision docs stay LOCKED and unchanged (aggregate-endpoint.md, model-aliases.md). This doc amends only the shell plane.

## Grill required first (docs-only decision doc)

`docs/architecture/tauri-cutover.md` — locked decisions with live-cited mechanics for at least:

- D1 single artifact shape: window + tray, plus the tray menu contents (glance parity minus the update row).
- D2 page load mechanism: how a Tauri v2 window loads a RUNTIME-configured remote origin (window created at runtime from `client/config.json`, not a build-time `frontendDist`), CSP allowances for `/api/*` + the loopback client-proxy port, and the ATS-equivalent for plain HTTP loopback.
- D3 token injection: the initialization-script seam equivalent to the `.documentStart` user script, with the runtime read from `client/config.json` and a write-only proof gate.
- D4 lifecycle parity: Rust commands shelling `launchctl` with the e737411 pid-line liveness semantics (loaded ≠ live, kickstart without -k), plus the settings surface shape (second window vs toolbar) honoring the launchd-never-in-the-page lock.
- D5 deep links: `idlefill://` registration via the Tauri deep-link story, with the pure `hashView` map ported to Rust under unit tests.
- D6 blank-origin behavior: detection + exception-only Relaunch parity + retry/backoff policy on load failure (owner question: auto-reload when the origin returns?).
- D7 updater retirement scope: what release/edge plumbing stays (manual zips) versus goes (appcast, Sparkle key, update UI), with README desktop + menubar sections rewritten at cutover (a stale control list is a convention break).
- D8 migration order + tree plan: a new `tauri/` tree built and gated to parity FIRST, both Swift trees deleted in a separate commit after live acceptance, plus the live-label install/uninstall steps at cutover.
- D9 CI + test plan: cargo test + clippy gates, the pin-for-pin retirement map from the retired Swift harnesses to Rust-side replacements, and the live-install acceptance run kept out of CI (as today).

Open questions for the owner get a named section. The issue closes only when they are answered.

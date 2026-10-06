# Issue #71 — Tauri close-to-tray: the red close button was a no-op

## What was wrong

`tauri/src-tauri/src/lib.rs` `on_window_event` caught `CloseRequested` on the
main window and called `api.prevent_close()` — and nothing else. The D1
close-to-tray rule (`docs/architecture/tauri-cutover.md` D1:94-103) needs
BOTH halves: prevent the destroy, then hide the window. With only the
prevent half, the red X did literally nothing visible: the window neither
closed nor hid, and the tray kept running. The comment above the handler
even named the intent ("close-to-tray"), so this was the missing half of an
already-LOCKED decision, not a new one.

## What was built

The D1 window rule moved to a pure spec, then the handler executes it:

- `WindowEventKind` (CloseRequested / Blurred / Other) — abstracted because
  tauri's `WindowEvent` is `#[non_exhaustive]` and `CloseRequestApi` is not
  constructible outside the crate (verified against tauri-2.12.1
  `src/app.rs:131-141`).
- `window_directive(label, kind) -> WindowDirective`: main+close ->
  `CloseToTray` (prevent AND hide), glance+blur -> `Dismiss`, everything
  else -> `NoAction`. The settings window keeps its plain close (D1 pins
  only the main window; `show_settings` rebuilds it on demand).
- The `on_window_event` closure now asks the spec and performs the
  directive. `CloseToTray` fires `prevent_close()` then `window.hide()`.

Why a pure spec: the bug class was a handler no test could reach. Same
"the cargo tests assert what ships" rule the tree already pins for the
glance rows.

## Decisions honored

- D1 stays LOCKED and unchanged: close must not quit the app; the app
  keeps running behind the tray. This fix makes that shape actually work.
- Quit paths untouched: tray Quit (`lib.rs`), app menu "Quit idlefill"
  ⌘Q, glance Quit row — all `app.exit(0)`.
- Dock re-open untouched (`RunEvent::Reopen` -> `show_main`): after
  close-to-tray, the Dock icon click and tray "Open Desktop" both re-show
  the window.
- D8 fence holds: nothing in `desktop/` or `menubar/` changed; no
  production launchd label was bootout/booted (the `.app` label kickstart
  below is the app's OWN label, the accepted install path).

## Gates (real output)

- `cargo test` (tauri/src-tauri): **49 passed, 0 failed** (45 before + 4
  new: `main_window_close_goes_to_tray`, `glance_blur_dismisses`,
  `settings_window_close_is_plain`, `no_other_label_or_pair_reacts`).
- `cargo clippy -- -D warnings`: clean.
- `cargo fmt --check`: 30 drift hunks at HEAD BEFORE this change (a
  rustfmt-version drift, reproduced by stash), 30 after — zero new.
- `npm run test` + `npm run build` (CI gates): green.

## Live verification

- `bash build.sh` with `IDLEFILL_BUILD_MARKER=2bd76df` rebuilt the bundle:
  `idlefill 2bd76df`, plist gate passed.
- `launchctl kickstart -k gui/<uid>/com.sam.idlefill.app` restarted the
  app (old PID 90334 -> new 26971) from the same bundle path.
- App stderr after the restart: `PAGE_LOAD Started/Finished
  http://127.0.0.1:8787/` and `LAUNCHD arbiter loaded=1 running=1` — the
  window loaded and the arbiter/daemon labels kept their PIDs across the
  app restart (`.server` 79677, `.client` 79521 unchanged).
- Owner step: click the red X on the desktop window. It now hides, the
  tray icon stays, and the Dock click / tray "Open Desktop" bring it back.

Commit: `2bd76df` on main, pushed to origin + github.

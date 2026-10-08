---
name: idlefill-tauri
description: Live dev-tooling for the idlefill Tauri shell plane.
version: 0.1.0
author: Sam (urza), Hermes Agent
license: MIT
platforms: [macos]
---

# idlefill Tauri shell — gates + dev-tool plane

## When to Use

Any work in `tauri/` (the Tauri v2 shell: `src-tauri/`, `ui/` + `settings-ui/`,
build/install/acceptance scripts), or any agent that needs live eyes on the
running shell (DOM snapshots, clicks, eval, IPC monitoring) while iterating.

## The bundled-view UI plane (tauri/ui, added 2026-10-07)

The two bundled views (settings + glance) are React 19 + Vite + Tailwind v4 +
vendored shadcn components (Radix-backed: `button`, `switch`,
`separator` in `src/components/`, all re-skinned to the DESIGN.md tokens)
in `tauri/ui/` (root npm workspace `tauri/ui`).
- `tauri/ui/` is the SOURCE; `tauri/settings-ui/` is the COMMITTED BUILD
  OUTPUT (frontendDist; kept committed so `bash tauri/build.sh` works with no
  npm step — the build-from-checkout rule, Q-b). After editing `tauri/ui/src`,
  run `npm run build` (root or tauri/ui) BEFORE build.sh / cargo-tauri, or the
  bundle embeds stale views.
- Multi-entry: `index.html` -> settings window, `glance.html` -> glance
  (`WebviewUrl::App` names in lib.rs unchanged). `base:"./"` for the
  tauri:// protocol. Entry files MUST call `createRoot(...).render(...)`
  themselves — a component-only export gets tree-shaken out of the bundle
  (the glance JS vanished once this way: #root stayed empty).
- Theme: DESIGN.md tokens in `src/styles.css` (Tailwind v4 CSS-first `@theme`),
  shadcn semantic vars mapped onto the Primer ramp; glance.css is entry-scoped.
- Root `npm run build` (--workspaces) now typechecks+builds the UI in CI
  (test.yml needed no edit); `npm test --workspaces` skips it (no test script).
- npm 12 blocks esbuild/fsevents postinstalls: `npm install-scripts approve
  esbuild fsevents` (approval now in root package.json `allowScripts`).
- Live-proof recipe (works despite the no-`unsafe-eval` CSP): stop
  `com.sam.idlefill.app` (launchctl kill TERM), rm the si socket, launch the
  debug bundle, `cliclick dd:<tray x>,<y>` (tray pos via System Events),
  `tauri-pilot snapshot -i --window glance`, `click @eN`, then
  `assert visible '#root h2' --window settings`. Pilot `screenshot`/`eval`
  fail with CSP refusal (that is the posture, not a bug).

## Prerequisites

- Read `docs/architecture/tauri-cutover.md` FIRST — the LOCKED decision doc
  (D1–D9, owner locks Q-a..Q-d). Do not re-decide any clause.
- Rust stable + `cargo-tauri` CLI (`~/.cargo/bin/cargo-tauri`); the pilot CLI
  via `cargo install tauri-pilot-cli` (lands on PATH at `~/.cargo/bin/tauri-pilot`).
- Node gates need the `NODE_ENV=` prefix: Hermes terminals export
  `NODE_ENV=production`, which makes npm silently skip devDependencies
  (AGENTS.md trap).

## Gates (in `tauri/src-tauri`)

- `cargo fmt --check` reports ~30 PRE-EXISTING drift hunks at main (rustfmt
  version skew vs the formatter that shipped the tree). Demand ZERO NEW:
  count hunks before (`git stash`) and after your change, not zero absolute.
- `cargo clippy -- -D warnings` — clean pin.
- `cargo test` — green pin.
- Bundle via `cargo-tauri tauri build`; a bare `cargo build` emits no `.app`
  — and do NOT run one "to warm the deps" first: the CLI's build context
  differs, so the warm-up compiles the whole dep tree the CLI then
  compiles AGAIN (~70s of pure waste, measured 2026-10-08; the pre-warm
  was dropped from `tauri/build.sh` in e1b7b26). `tauri/build.sh` is the
  only entry (marker + version env discipline).

## Dev-tool usage (debug builds only)

Both plugins are compiled into DEBUG builds only (`cfg(debug_assertions)`
dep gate + the `#[cfg(debug_assertions)]` registration block in `lib.rs`);
release builds compile them out and `tauri-pilot ping` against the INSTALLED
(release) app is EXPECTED to fail — there is no pilot server there.

- tauri-pilot: Unix-socket server inside the app
  (`/tmp/tauri-pilot-com.sam.idlefill.app.sock`, auto-discovered by the CLI):
  `tauri-pilot ping | snapshot -i | click @e3 | fill @e2 TEXT | press Enter |
  assert text @e1 EXPECTED | wait --selector SEL | eval "JS" | eval - <<'EOF'`
  The capability carries `pilot:default` — without it the CLI fails with
  `eval timed out after 10s`.
- MCP bridge (`tauri-plugin-mcp-bridge`, binds 127.0.0.1 ONLY — the plugin
  default is 0.0.0.0, never acceptable): MCP server side via
  `npx -y @hypothesi/tauri-mcp-server` (npm, stdio). Hermes:
  `hermes -p <p> mcp add tauri --command /opt/homebrew/bin/npx --args -y
  @hypothesi/tauri-mcp-server`. pi: `pi mcp add tauri -- npx -y
  @hypothesi/tauri-mcp-server` (repo-local `.pi/mcp.json` is pre-wired).
  Bridge tools: webview DOM snapshots, screenshots, IPC monitoring, window
  state, console logs.

## Fences (D8 / Q-b)

- The two Swift shell trees retired with the #69 cutover (2026-10-08):
  `desktop/` and `menubar/` no longer exist. `tauri/` is the only shell
  plane; nothing outside it (server/, client/, adapters/, the deploy
  scripts) is touched by shell work.
- Production launchd labels (`com.sam.idlefill.server`, `.client`, and the
  live `com.sam.idlefill.app` unless the owner directs an install/update)
  are never kickstarted by tests — scratch labels only
  (`IDLEFILL_TAURI_TEST_LABEL_*` hooks).
- No release/update artifacts (Q-b LOCKED: the update flow is `./update.sh`
  — pull + rebuild; there is no updater plane).
- `permissions/autogenerated/` is committed on purpose (tauri build output
  that is the ACL source of truth).

## Pointers

- Decision authority: `docs/architecture/tauri-cutover.md`.
- Acceptance harness: `tauri/acceptance-test.sh` — headless proof via the
  app's stderr markers `PAGE_LOAD` / `LAUNCHD` / `AUTO_RELOAD`.
- Live install/update cycle: `tauri/build.sh` + `tauri/install.sh`
  (scratch-label test path: `tauri/install-test.sh`).

## Pitfalls

- The debug build is a SECOND instance of the same app identity: the installed
  release app holds the single-instance lock
  (`/tmp/com_sam_idlefill_app_si.sock`). A debug launch while it runs
  forwards-and-exits (exit 0, zero output). Stop the installed app first,
  and remove the si socket if its holder died. Re-kickstart
  `com.sam.idlefill.app` when the debug session ends.
- Pilot `screenshot --window settings` can die with `JavaScript error:
  [object Event]` even though snapshot/assert/html work; `html` is the
  reliable DOM read on the bundled views (dump it, grep for data-slot
  attrs). Tray position via System Events: coerce both coords with
  `as string` before joining — `position & "," & position` yields a
  spaced list that cliclick rejects.
- Pilot `eval` on the BUNDLED views fails with the CSP refusal
  (`'unsafe-eval' ... not an allowed source of script`) — that CSP is the
  security posture; do not add `'unsafe-eval'` to chase it. The non-eval
  surface (snapshot/click/fill/press/html/title/state/assert/screenshot)
  works fine against bundled views. `eval timed out after 10s` is the
  DIFFERENT failure: the target window is remote-origin (main).
- Pilot's `ipc` command routes through webview eval too, so it ALSO times
  out against the remote main window. Drive bundled views; open them via
  the tray (real mouse click on the status item via cliclick — AXPress
  fires the wrong gesture) or the glance's Settings row.
- Glance element refs go stale between commands (the 5s tick re-renders the
  rows). Run `snapshot` then the `click`/`fill` back-to-back in one command.
- `tauri/build.sh --debug` builds the plugin-carrying bundle to
  `target/debug/bundle/macos/Idlefill.app` through the same gates.
- `tauri.conf.json` CSP (`default-src 'self'`) scopes the BUNDLED
  settings/glance views only — the external arbiter page is its own origin
  with its own headers; do not chase a "CSP blocks pilot" theory against
  the remote page.
- Without `pilot:default` in the capability, pilot connects but every eval
  hangs and dies at `eval timed out after 10s`.
- The pilot socket belongs to whichever debug instance grabbed it first —
  if a stale `target/debug` build is running, the CLI drives IT, not your
  new one. Kill stale instances before `ping`.
- A debug build of the shell claims `idlefill://` while running — deep-link
  tests from a debug build need it to be the installed claimant (D8 caveat).
- `cargo build --release` still COMPILES the debug-gated deps into the
  dependency graph (cargo's `cfg(debug_assertions)` target-dep is a
  manifest warning, not a compile-time exclusion); the runtime gate is the
  `#[cfg(debug_assertions)]` block in `lib.rs`, which keeps the plugins
  out of the shipped code path.

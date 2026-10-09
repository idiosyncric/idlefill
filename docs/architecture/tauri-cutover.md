# Tauri v2 cut-over — issue #69 (grill, 2026-10-06)

## What this doc amends

This doc retires the Swift shell plane and the updater plane. It amends
issue #61's shape: the same one-surface architecture (the arbiter's live
page IS the product), a different shell. One Tauri v2 artifact replaces
both `desktop/IdlefillDesktop.swift` (2,187 lines) and
`menubar/IdlefillMenubar.swift` (3,118 lines). The artifact ships with no
auto-updater of any kind. No Sparkle, no tauri-plugin-updater, no appcast.

The doc changes nothing else. `server/`, `client/`, `adapters/`,
`scripts/`, and `server/public/index.html` stay byte-for-byte untouched.
The mesh, aggregate, and alias decision docs stay LOCKED
(`aggregate-endpoint.md`, `model-aliases.md`). The daemon LaunchAgent and
the arbiter LaunchAgent labels stay. Only the shell plane moves, plus the
`com.sam.idlefill.menubar` label at cutover completion.

Verified toolchain, on this machine, actual output:

```
$ ~/.cargo/bin/cargo-tauri --version
tauri-cli 2.11.4
$ cargo --version
cargo 1.99.0 (5f94df478 2026-08-27) (Homebrew)
$ rustc --version
rustc 1.99.0 (b940084d7 2026-09-28) (Homebrew)
```

The spike resolved crates (from the spike's `Cargo.lock`, cited per
decision): tauri 2.12.1, tauri-runtime 2.12.1, tauri-runtime-wry 2.12.1,
wry 0.57.0, tao 0.37.1, tray-icon 0.25.1, tauri-build 2.7.1,
tauri-plugin-deep-link 2.6.1, tauri-plugin-single-instance 2.5.2. The
spike lives in `/tmp/idlefill-tauri-spike` (never in the repo tree). The
report `docs/reports/ISSUE69-GRILL-REPORT.md` carries its outputs.

## AMENDMENT (2026-10-09, issue #75 grill — the shell updater plane)

Scope: this amendment supersedes two clauses inside D7 below. Every
other clause of this doc stays LOCKED and unchanged.

1. SUPERSEDED — the D7 opening line: "LOCKED: no updater of any kind
   in the artifact." The Tauri shell gains a signed updater channel
   (`tauri-plugin-updater`, Tauri v2), fed by the existing Forgejo
   release endpoint. The daemon and the arbiter carry no updater.
2. SUPERSEDED — Q-b's artifact clause inside D7: "NOTHING on
   releases. No app zip, no appcast, no signing." A Forgejo release
   now carries the shell's two updater artifacts: `latest.json` and
   the signed `Idlefill.app.tar.gz`. Q-b's checkout clause stands for
   the daemon and the arbiter, and `update.sh` stays the shell's
   manual/checkout path. It no longer stands as the shell's only
   path.

Stands unchanged and is reaffirmed here: D1 (one artifact, and the window close keeps the app alive), D2 (the runtime external page),
D3 (the document-start token seam), D4 (lifecycle parity and the
settings shape), D5 (deep links), D6 (the blank-origin behavior and
the Q-a auto-reload), D7's retirement inventory (every retired Swift
plane stays retired, and the `--version` marker contract survives),
D8, D9, Q-c (the single tray click), and Q-d (one LaunchAgent).

The new plane and its decisions live in
`docs/architecture/shell-updater.md` (its D1-D7 and Q-e, all LOCKED;
Q-e settled 2026-10-09: the operator host signs, no key on the CI
runner). This doc cites that doc as the inherited constraint. It
does not restate it.

## The rules this doc inherits

- The page is the surface (#61). The app loads the LIVE origin from
  `client/config.json` `server_url`, never a bundled copy of
  `index.html`. The desktop header states the why: "a copied page
  re-creates the drift bug inside the bundle"
  (`desktop/IdlefillDesktop.swift:12`).
- Lifecycle stays native. launchd controls never move into the page
  (owner lock, ISSUE69-BRIEF "Locked by the owner").
- The token is write-only: read at runtime from
  `<repo>/client/config.json`, "never baked into this file, the bundle,
  or the binary, never printed, and never displayed in any view or
  written to any log line" (`desktop/IdlefillDesktop.swift:53-55`).
- Exception-Only (DESIGN.md): the arbiter-stopped row and the Relaunch
  button render only in the failure state.
- Harnesses retire WITH the code they pin (repo rule, ISSUE69-BRIEF
  "What retires").

## Parity inventory — what the two shells do today

Desktop (`desktop/IdlefillDesktop.swift`), the live residue a Tauri build
must match:

| Surface | Today (file:line) |
|---|---|
| Window hosts the live page | `WindowGroup` + WKWebView, `:2135-2145`, `:1114-1119` |
| URL from runtime config | `serverURL()` reads `client/config.json` `server_url` at `:1131-1137`. `dashboardURL()` appends the deep-link hash at `:1989-1994` |
| Token injection | `gateTokenScript()` builds a JSON-string-literal `localStorage.setItem` script at `:1974-1982`, armed at `.atDocumentStart` on every (re)load at `:1999-2009` |
| Slim toolbar: origin display, exception-only "arbiter stopped" + Relaunch, Reload, settings disclosure | `:2024-2079` (stop row `:2047-2055`, Reload `:2062`) |
| Settings: daemon / menu bar / arbiter toggles from REAL `launchctl print` on a 5s tick, `runs:` lines, menubar stale marker, arbiter stopped/Relaunch row | `:160-199`, `:256-265`, `:1223-1247`, `:1687-1714`, `:1735-1770` |
| launchd machinery: `launchctl print` loaded view, `pid =` liveness parse, kickstart-without-`-k` relaunch, bootstrap/bootout install with the "already loaded" no-op | `:1196-1213`, `:1267-1275`, `:1555-1563`, `:1326-1343` |
| Remote-arbiter refusal + foreign-port refusal before installing the arbiter agent | `setArbiter` `:1502-1527`, `isArbiterRemote` `:1531+`, `foreignPortOwner` `:1431+` |
| Deep links: `idlefill://` → page view | `AppModel.hashView(for:)` `:1063-1072` (state→overview, sessions→sessions, projects→projects, usage→usage, else nil), plus `handleDeepLink` `:1082-1098` and `.onOpenURL` `:2142` |
| ATS: `NSAllowsArbitraryLoads` baked by build.sh | `desktop/build.sh:144-152` |
| Marker + `--version` | `__DESKTOP_BUILD__` substituted by `desktop/build.sh:66-84`. Live-proven: `idlefill 1.0` default, `idlefill edge-test-abc123` with `IDLEFILL_DESKTOP_BUILD` set |
| Sparkle plane | `import Sparkle` `:60`, `SPUStandardUpdaterController` `:274-303`, channel/pin/watchdog `:201-250` — RETIRES (locked) |

Menubar (`menubar/IdlefillMenubar.swift`, post-#61-step-4 shape):

| Surface | Today (file:line) |
|---|---|
| Status item + transient NSPopover glance | header `:4`, `:3015-3033` |
| Click routing: single = popover, double = open desktop | `MenuBarRouter.action(clickCount:)` `:166-170` |
| Glance content: state word row | `AppModel.glanceStatusRow` `:807` |
| Action rows: Open Desktop (always), Install Update <v> (exception-only) | `panelActionRows` `:778-785`, `desktopRowTag` `:762-764` |
| Open Desktop = `idlefill://open`, fallback `open /Applications/Idlefill.app` | `DesktopApp` `:150-158`, `:2975-2990` |
| State source: HTTP `/api/state` with `Authorization: Bearer <token>`, parsed config `ClientConfig` (token + server_url + client_name, parsed ONCE at launch) | `:1001-1003`, `:177-238`, `:714-720` |
| LaunchAgent `com.sam.idlefill.menubar` install/take-over machinery | `LaunchAgent` enum `:2565+`, `:2141` |
| Update-check machinery (`UpdatePlan`, `updateAvailable`) | `:735`, `:25` — RETIRES (locked) |

Correction of one belief circulating in earlier notes: the token is NOT in
the macOS Keychain anywhere. Grep of both files for `keychain` and
`find-generic-password` returns zero hits. Both shells read the token
from the gitignored `client/config.json` — the desktop at call time
(`:1123-1129`), the menubar once at launch (`:177-238`). D3's storage
plan rests on that verified fact.

## D1 — Single artifact shape: window + tray

LOCKED. One Tauri app owns both surfaces:

- The window: one labeled `WebviewWindow` (`WebviewWindowBuilder::new`,
  `tauri-2.12.1/src/webview/webview_window.rs:101`). Closing it must not
  quit the app. Pin: `on_window_event` (`:1643`) catches
  `WindowEvent::CloseRequested`, and `prevent_close()` (`app.rs:103`)
  keeps the app running behind the tray, the analog of today's
  WindowGroup app that keeps running behind the toolbar. The dock icon
  stays (the desktop is a `.regular` app, Swift `:2152`).
- The tray: `TrayIconBuilder` with `icon`, `menu`, `tooltip`,
  `on_menu_event`, `on_tray_icon_event` (`tauri-2.12.1/src/tray/mod.rs`
  — verified present in the installed crate: builder `:203+`,
  `set_menu` `:512`, `set_tooltip` `:523`). The `tray-icon` feature is
  enabled by default in tauri's feature list (`tauri/Cargo.toml:47`).
- Tray click routing: `TrayIconEvent::Click` and `TrayIconEvent::DoubleClick`
  both exist (`tray/mod.rs:71-131`, each carrying `position` and `rect`).
  `show_menu_on_left_click(false)` (`:319`) keeps the left click free for
  routing instead of opening a native menu. OWNER LOCK 2026-10-06 (Q-c):
  SIMPLIFIED — single click = glance only. The Swift single/double split
  (`MenuBarRouter.action` `:166-170`) retires. The `DoubleClick` event
  arm stays unused, and no window-focus gesture exists. The window
  opens from the glance's `Open Desktop` row or from deep links.

Honest degradation, stated not hidden: **Tauri has no NSPopover
equivalent.** The Swift glance is a transient `NSPopover` anchored to the
status item (`menubar/IdlefillMenubar.swift:3022-3033`). Tauri's tray
offers a native `Menu` or an ordinary `WebviewWindow` positioned from the
event's `rect`/`position`. DECISION for the glance: a borderless,
non-activating, always-on-top small window shown at the tray rect and
hidden on blur. It is NOT a popover. Two costs are accepted: (1) the
blur-dismiss and the anchored arrow are hand-written behavior, not
platform behavior. (2) macOS focus-ring differences may make it read
slightly different from the current popover. The glance CONTENT ports
pin-for-pin from the pure specs (`glanceStatusRow` `:807`,
`panelActionRows` `:778` minus the `Install Update` row). If the
popover-shaped window proves unshippable during implementation, the
named fallback is a plain tray menu (rows as menu items, click opens the
window). Record the switch before shipping.

Tray menu contents (glance parity minus the update row): the state word,
status rows, `Open Desktop` (inside one artifact: show + focus the
window — the `idlefill://open` URL-scheme dance and its `/Applications`
fallback retire, `:2975-2990`), Settings, Quit.

## D2 — Page load: runtime remote origin, CSP, ATS

LOCKED mechanism: **runtime-created window with
`WebviewUrl::External`**, verified live three ways.

1. Source: `tauri-utils-2.10.1/src/config.rs:77-86` —
   `WebviewUrl::External(Url)`, "Must use either the `http` or `https`
   schemes." Plain `http` is allowed by the type.
2. Spike: `WebviewWindowBuilder::new(app, "main",
   WebviewUrl::External(url))` with `url = http://127.0.0.1:18099` read
   at runtime from a scratch config file. Output:
   `PAGE_LOAD Started http://127.0.0.1:18099/` +
   `PAGE_LOAD Finished http://127.0.0.1:18099/`. The same code path also
   loaded the real local arbiter at `http://127.0.0.1:8787` (Started +
   Finished) on this machine.
3. The build config: `build.frontendDist` accepts a URL
   (`tauri-utils-2.10.1/src/config.rs:3699-3706`, `Url(url)` variant —
   "No assets are embedded in the app in this case"). The spike built
   with `"frontendDist": "http://127.0.0.1:18099"` and no local dist
   directory at all. DECISION: point `build.frontendDist` at the tiny
   LOCAL settings UI (shell chrome, below), and create the MAIN window
   at runtime in `setup` from `client/config.json` with
   `WebviewUrl::External`. The binary embeds settings markup, never a
   copy of the page. The "never a bundled copy" rule stays structural
   for the product surface.

CSP. Tauri injects `security.csp` into served assets. Tauri's injected
CSP does not reach a REMOTE page: the spike set
`"csp": "default-src 'self'"` in `tauri.conf.json`, loaded a remote page
full of inline scripts, and the page ran fully. Proof line:
`tok-ok:api-ok-1:proxy-ok-hdr:set` (init-script token present, same-origin
`/api/state` fetched, cross-origin loopback fetch with `x-idlefill-edit`
succeeded). A stronger control (`script-src 'none'`) also failed to block
the remote page's inline script — same proof line. So the config CSP is
not the guard rail for the loaded page, and it will not break the page
either. The real page needs NO CSP allowances: the arbiter serves no CSP
(grep of `server/` for `content-security-policy` returns nothing), and
the page is self-contained. DECISION: leave `security.csp` unset. No
amendment needed for `/api/*` (same-origin) or the loopback client-proxy
port (the client's own CORS answers the preflight —
`client/src/client-projects.ts:71-75` echoes the request origin and
allows `content-type, x-idlefill-edit`, `:194-199`). The spike's
`proxy-ok-hdr:set` line proves that exact preflight+header chain works
from a Tauri webview.

ATS (plain HTTP). Verified by removal, not by belief:

- Bundle run against loopback `http://127.0.0.1:18099` with the ATS key
  REMOVED from the built Info.plist: proof line still
  `tok-ok:api-ok-1:proxy-ok-hdr:set`. ATS does not block loopback.
- Same keyless bundle against the LAN origin `http://10.10.10.28:18098`:
  proof line `remote:api-ok-1`. ATS did not block that load on this
  macOS + WebKit.

DECISION: the Tauri build still ships `NSAppTransportSecurity` →
`NSAllowsArbitraryLoads: true` via `bundle.macOS.infoPlist` merge
(`tauri-utils-2.10.1/src/config.rs:669` — `MacConfig::info_plist`, "Path to a
Info.plist file to merge with the default Info.plist"). The spike proved
the merge: the built bundle's Info.plist carried the ATS dict, and
`bundle.macOS.exception_domain` is documented as the narrow alternative
("lowercase, without port and protocol domain name"). Shipping the
exception keeps behavior identical to `desktop/build.sh:144-152` for any
operator whose macOS build enforces ATS on a remote plain-HTTP arbiter
(urza). The doc records the empirical result: loopback needs no
exception. The exception is shipped for the remote-host case, matching
the Swift shell exactly.

## D3 — Token injection: the .documentStart seam

LOCKED seam: `WebviewWindowBuilder::initialization_script`
(`tauri-2.12.1/src/webview/webview_window.rs:1008`). The same seam exists
on `WebviewBuilder::initialization_script` `webview/mod.rs:943` and on
`initialization_script_for_all_frames` (`:1053` and `:1002`). The wry sink on
macOS proves the timing: wry 0.57.0 `src/wkwebview/mod.rs:646-648` feeds
every `initialization_script` into `fn init` (`:780-791`), which builds a
`WKUserScript` with `WKUserScriptInjectionTime::AtDocumentStart` and
`addUserScript`. That is the same API the Swift shell uses
(`desktop/IdlefillDesktop.swift:2004`). Byte-level parity, not
equivalence.

The script content ports the existing pure function. Swift today:
`gateTokenScript` JSON-encodes the token into a string literal, then
emits `(function(){try{localStorage.setItem("idlefill.token", <literal>);}catch(e){}})();`
(`:1974-1982`). The Rust port does the same with `serde_json::to_string`
(the spike used exactly that, proof line `tok-ok`). Re-arm rule: the token is
re-read from `client/config.json` on EVERY reload so a rotated token
takes effect, matching "re-armed on every (re)load" (`:1112-1113`). A nil
/empty token emits no script (page stays read-only + its own hint works,
`:1972-1973`).

Write-only proof gate, ported: the Rust port gets the same pure-function
test (encode, escape, never log). The gate that proves the binary carries
no token: `strings` on the built artifact must not match the live token
value, and the arbiter access log shows the page's writes authenticated.
Both gates exist for the Swift shape. The Rust versions move with the
code (D9). The storage story: the token stays in `client/config.json`
only. There is no Keychain anywhere today (verified above), so no
migration exists and no second store appears.

## D4 — Lifecycle parity: launchctl in Rust, settings shape

The launchd semantics are pinned by e737411 (commit `e737411` on this
repo, "detect the loaded-but-exited arbiter and relaunch it"). They port
verbatim as Rust:

- Loaded check: `launchctl print gui/<uid>/<label>` exit 0 (Swift
  `launchctlPrint` `:1196-1213`). Rust: `std::process::Command`, stdout
  captured to a temp file — keep the temp-file capture (the 64 KB pipe
  deadlock class, `:1194-1195` and `:1277-1281`).
- Liveness: the `pid =` line. `AppModel.pidLine` (`:1267-1275`) is a pure
  parse: trimmed `pid = <n>` line, `n > 0`, else nil, fail closed. Port
  it as a pure Rust function under unit tests (D9). A loaded service with
  no pid line is the blank-dashboard state.
- Relaunch: `launchctl kickstart gui/<uid>/<label>` WITHOUT `-k`
  (`relaunchArbiter` `:1555-1563`). Under `KeepAlive
  SuccessfulExit=false`, kickstart starts the exited job and is a no-op
  while running (live-proven 2026-10-05 against a scratch label, cited
  at `:194-196`).
- Install: write plist → `launchctl bootstrap gui/<uid> <plist>`. A
  "Bootstrap failed: 5: Input/output error" on an already-loaded label is
  a clean no-op (`:1336-1343`). Uninstall: `bootout`.
- The guards port: the remote-arbiter refusal `isArbiterRemote`
  (`:1502-1513`, `:1531+`) and the foreign-port refusal via `lsof` vs the
  label's own pid (`foreignPortOwner` `:1431+`, parity with
  `install-server-agent.sh`'s `check_port_foreign`). The `runs:` display
  = first `ProgramArguments` entry of the print dump (`firstArgument`
  `:1250-1259`). The menubar stale marker retires with the menubar label
  (D8). The daemon toggle keeps its `runs:` line.
- Tick: 5 seconds, the only native poll (`init` `:256-265`). Port as a
  `std::thread` loop or a `tauri::Interval`. State publishes to the
  settings surface over events.

Settings surface shape. LOCKED: native, not in the page (owner lock).
DECISION: keep the desktop's in-window disclosure shape — the toolbar
strip (origin + exception row + Reload + settings toggle) above the
webview, settings rendering between the strip and the webview, the
webview never tearing down (`:2067-2079`). In Tauri that is the same
window: a small React/TSX strip above a second webview is NOT available
(one window, one URL). So the settings disclosure becomes a SECOND
webview window (the settings window) opened from the toolbar equivalent —
but the toolbar itself must be native chrome because the page must not
own lifecycle. Two options were weighed and the decision is named:

DECISION D4-shape: **a native titlebar/toolbar area is not available in
Tauri for an External page. Use the tray + a dedicated settings window.**
The main window carries only the page (no strip). The exception-only
"arbiter stopped" signal moves to the tray (state word turns red,
`stopped` row) and to a small always-available tray menu item
"Relaunch arbiter" that renders only in the loaded-but-exited state
(Tauri menus support `remove`/insert at runtime — re-render the menu from
the 5s tick). Settings (the three toggles, `runs:` lines, repo path)
becomes a second, small, LOCAL webview window — the bundled settings UI,
the app's own `frontendDist` (tiny, own CSP — it holds no arbiter data,
so it does not violate "the page is the surface": that rule is about the
product page, not about shell
chrome). The launchd verbs stay native Rust commands. The settings
window calls them over the standard IPC with a locked-down capability
(`core:ipc`, no fs/shell permissions — commands are app-internal). The
capability posture is verified and desired: a capability only reaches
remote origins when it explicitly sets `remote.urls`
(https://v2.tauri.app/reference/acl/capability/ — "This setting is
optional and defaults to not being set"). With `remote` unset, the
arbiter's page (a remote origin) has NO IPC access at all, and only the
local settings window can invoke the lifecycle commands. That is the
"launchd never in the page" lock enforced by the platform, not by
convention.

That is a shape change from the Swift strip, stated plainly: the strip
dies because Tauri gives no native toolbar over an External page. Every
FACT the strip carried survives: origin display (title bar), token
status, arbiter-stopped exception + Relaunch (tray), Reload (window menu
+ ⌘R via the Tauri `Menu` API), Settings (menu + tray).

## D5 — Deep links: idlefill:// + hashView in Rust

Verified stack, live-built in the spike:

- `tauri-plugin-deep-link` 2.6.1 + `tauri-plugin-single-instance` 2.5.2
  with the `deep-link` feature. Desktop config:
  `plugins.deep-link.desktop.schemes = ["idlefill"]` (docs:
  https://v2.tauri.app/plugin/deep-linking/ — desktop custom schemes).
- macOS static registration: the plugin generates the Info.plist entry.
  Proof from the spike bundle:
  `CFBundleURLTypes → [{CFBundleURLName: "com.sam.idlefill.spike idlefill",
  CFBundleURLSchemes: ["idlefill"]}]` — identical in shape to
  `desktop/build.sh:133-143`.
- Events while running: `app.deep_link().on_open_url(|event| …)` (the
  spike wired it, and the deep-link page documents `onOpenUrl` plus
  `getCurrent`).
  Cold start: the argv path through the single-instance plugin callback.
- Caveat the docs pin: on macOS, deep links trigger only for the
  INSTALLED application (`register_all` is Linux/Windows only). The
  cutover must install before testing deep links. Today's Swift shell
  has the same LaunchServices behavior. The menubar's
  `/Applications/Idlefill.app` fallback (D1) is what that caveat produced.

`hashView` ports as a pure Rust function with unit tests. The map is
verbatim from `AppModel.hashView(for:)` (`:1063-1072`). The scheme must
be `idlefill`. `state` maps to `overview`, `sessions` to `sessions`,
`projects` to `projects`, and `usage` to `usage`. Anything else (including `open`,
`dashboard`, `logs`, unknown, empty) → `None` = the page's default view.
The page owns hash reading (`HASH_VIEW_RE`,
`server/public/index.html:1571` — untouched). The Rust side appends
`#<view>` to the live origin and calls `WebviewWindow::navigate`
(`webview_window.rs:2511`), matching `handleDeepLink` + `reloadDashboard`
(`:1082-1098`, `:1989-1994`): store the requested hash so a later Reload
keeps the view. One-window focus + closing extras ports to the
single-instance plugin guarantee (one instance, activate + navigate).

## D6 — Blank-origin behavior

The incident that motivated #69 (2026-10-06): the webview painted its
canvas fill over an unreachable origin, and every "loaded" check read
healthy. The Swift answer is e737411's trio: pid-line liveness, the
exception-only strip row `arbiter stopped` + Relaunch
(`:2047-2055`, Settings twin `:1735-1770`), and the Reload button.

Tauri facts, verified: `on_page_load` fires `Started` then `Finished`
(`webview_window.rs:421`, `PageLoadEvent::Started|Finished` —
`tauri-runtime-2.12.1/src/webview.rs:87-92`). Spike
negative control: with the probe server dead (port confirmed free), the
window emitted NO `PAGE_LOAD` event at all, and the page's proof fetch
never arrived. So **a missing `Finished` (or a `Finished` too early to
have run the page's own poll) is the programmatic blank-page signal** —
no custom protocol, no injected heartbeat needed beyond the page itself.
The stronger signal stays the pid-line check (the D4 port), because a
dead origin and a loaded-but-exited agent are the same event from the
shell's side.

DECISION, parity with e737411: the 5s launchd tick already knows
`arbiterLoaded && !arbiterRunning`. That state drives the tray word
(`stopped`, red) and the exception-only "Relaunch arbiter" tray item
(kickstart without `-k`, then `WebviewWindow::reload`,
`webview_window.rs:2516` — the same one-button fix). Reload stays manual
by default (the ⌘R menu item + tray), exactly Exception-Only. No
full-window error island: the canvas-fill blank is the arbiter host's
job (the page is the arbiter's own), and the shell's honest signal is
the tray word + tray item. That matches the issue's verified note ("the
toolbar's arbiter-stopped row is the only honest signal") with the row
re-homed to the tray per D4.

Owner question Q-a — LOCKED 2026-10-06: auto-reload YES, with the
one-shot rule as designed — when the pid line re-appears after a
known-dead state, issue exactly one `reload()` per transition (no timer
loop, no reload storm). Reason recorded: today's Swift shell requires the
operator to press Relaunch/Reload. A dead-then-started arbiter leaves the
blank canvas until then, which caused re-filed confusion. The one-shot
reload keeps Exception-Only (the transition edge is the event) and
cannot storm because transitions are edges.

## D7 — Updater retirement

LOCKED: no updater of any kind in the artifact. Retires with the shells:

- Sparkle: `import Sparkle`, `SPUStandardUpdaterController`
  (`:274-303`), `SUFeedURL`/`SUPublicEDKey` plist entries
  (`desktop/build.sh:59,128-131`), the vendored `desktop/vendor/sparkle`
  tree, `desktop/update.sh`.
- The channel machinery: `updateChannel` / `updateBranch` / `updatePin` /
  `edgePending` / `updateProgress` / check watchdog
  (`:201-250`, Settings rows `:1814-1853`). The Tauri Settings window has
  NO update block (locked).
- The menubar update plane: `UpdatePlan` / `updateAvailable` /
  `Install Update <v>` row (`menubar:735,762-785`), `uc-test.sh`,
  `uc-update-test.sh`, self-swap (`:2051+`), both `edge-test.sh`
  harnesses.
- Release plumbing: `scripts/release.sh`'s appcast generation
  (`GEN_APPCAST`/`APPCAST`, `:74-84`), the ed25519 key usage, the
  carry-forward guards. `scripts/edge-release.sh`'s marker-named zips +
  sidecars.
- The `--version` marker contract SURVIVES the pipeline's death:
  `tauri.conf.json > version` / `macOS.bundle_version`
  (`tauri-utils-2.10.1/src/config.rs:628`, "Translates to the
  bundle's CFBundleVersion"), plus a Rust `--version` argv check that
  prints `idlefill <marker>` — the build.sh analog passes the marker as
  an env var to `cargo` (`env!("IDLEFILL_BUILD_MARKER")`). Live-proof of
  why it matters is in the report (gate: `idlefill 1.0` default,
  `idlefill edge-test-abc123` override, both from real runs).

README desktop + menubar sections get rewritten at cutover (a stale
control list is a convention break). Not this doc's edit — flagged here
as required cutover work, same posture as #61 step 4's README rewrite.

Owner question Q-b — LOCKED 2026-10-06: NOTHING on releases. No app
zip, no appcast, no signing — the app is built from the checkout
everywhere, toolchain required on each machine (verified present on
this Mac). Verified scope of the retirement: `edge.yml` publishes ONLY
the desktop + menubar zips (its steps: gate, swiftc parse, publish —
`.gitea/workflows/edge.yml:38,70,74`), and no TS code fetches release
or edge artifacts, so the whole edge workflow retires with the Swift
planes. `scripts/release.sh` sheds the desktop/menubar artifact, appcast,
and key stages (the arbiter stays a checkout-run launchd service —
release notes for server/client versions remain as text/tags). The
worker's contrary recommendation (keep plain zips for toolchain-less
machines) is overruled and recorded here for the trade-off it names.

## D8 — Migration order + tree plan

DECISION, ordered:

1. New `tauri/` tree in-repo (`tauri/src-tauri/`, `tauri/settings-ui/`,
   `tauri/build.sh` mirroring the marker/version discipline). Built and
   gated to parity FIRST. Nothing in `desktop/` or `menubar/` changes
   during this phase. The two live planes keep running side by side.
   Deep-link collision caveat: both the Swift desktop and the Tauri
   artifact claim `idlefill://`. Testing deep links from the Tauri build
   requires it to be the installed claimant at that moment (or the Swift
   app uninstalled in the test window). The cutover acceptance run is
   where that ownership transfers.
2. Live acceptance (out of CI, as today): install the Tauri artifact on
   this Mac, take the tray, prove the D9 pin list, prove deep links
   against the installed artifact, prove the three launchd toggles
   against the REAL labels (before/after `launchctl print` identical,
   the arbiter-test.sh discipline).
3. ONE separate commit deletes both Swift trees whole: `desktop/` (all:
   Swift, `build.sh`, `update.sh`, `arbiter-test.sh`, `edge-test.sh`,
   `vendor/`), `menubar/` (all: Swift, `build.sh`, `install.sh`, the
   plist template, `panel-test.sh`, `uc-test.sh`, `uc-update-test.sh`,
   `sessions-test.sh`, `staleness-test.sh`, `edge-test.sh`,
   `install-test.sh`). Harnesses retire WITH the code they pin.
4. Live label cutover inside step 3's install steps: `launchctl bootout
   gui/<uid>/com.sam.idlefill.menubar` (the menubar label retires — the
   tray lives inside the app now). The app's own autostart story is
   owner question Q-c/Q-d below. The daemon (`com.sam.idlefill.client`)
   and arbiter (`com.sam.idlefill.server`) labels are NOT touched. The
   app's autostart is LOCKED (Q-d): ONE LaunchAgent
   `com.sam.idlefill.app` (RunAtLoad) installed by the app's install
   script, replacing the menubar label. The desktop app has no
   LaunchAgent today (it restores as a normal GUI app), so this agent is
   net-new for the combined app.
5. CI flips in the same commit as the deletion: `test.yml` (`:47-51`),
   `edge.yml` (`:69-70`), `release.yml` (`:72-73`) drop the
   `swiftc -parse` gates. Tauri gates arrive (D9). `edge.yml` retires
   entirely with the edge channel (Q-b LOCKED: no app artifacts
   anywhere).

## D9 — CI + test plan

Gates replacing `swiftc -parse` (three sites today:
`test.yml:47,50`, `edge.yml:69`, `release.yml:72`):

- `cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test` on
  `tauri/src-tauri`.
- `cargo build` (debug) on CI as the bundle-plumbing smoke. The `.app`
  bundle build stays on the release path.

Pin-for-pin retirement map (every retired harness → its Rust-side
replacement, or the honest "no replacement needed"):

| Retired harness | Pins today | Rust replacement |
|---|---|---|
| `desktop/arbiter-test.sh` (24 checks over 202 lines: pid-line parse, remote rule, bootstrap/kickstart on a scratch label, rendered-plist shape, "no token ever") | e737411 semantics | `cargo test` unit tests for the ported pure functions: `pid_line`, `is_arbiter_remote`, `first_argument`, plist render, plus a scratch-label launchctl integration test behind the same `IDLEFILL_DESKTOP_TEST`-style env gate |
| `desktop/edge-test.sh` | edge markers, pin follow, download | **No replacement** — the edge channel retires (Q-b recommendation keeps plain zips, and a 2-line release-zip check replaces the harness) |
| `menubar/uc-test.sh`, `menubar/uc-update-test.sh` | update check + update code | **No replacement** — the update plane retires (locked) |
| `menubar/panel-test.sh` | glance rows (`glanceStatusRow`, `panelActionRows`, `desktopRowTag`) minus the update row | `cargo test` for the ported pure glance spec, and the row list renders from it |
| `menubar/sessions-test.sh` | sessions-at-a-glance rows | `cargo test` for the sessions row projector over canned `/api/state` payloads |
| `menubar/staleness-test.sh` | code-staleness tag | `cargo test` for the behind-release note (the `--version` marker vs the release list, if Q-b keeps zips). Else no replacement |
| `menubar/install-test.sh` | menubar install.sh render-before-bootout cycle | the ONE app's install script (Q-d) keeps the same discipline, and the render-refusal test ports to the script itself |
| `menubar/edge-test.sh` | marker self-install/update | **No replacement** — retires with the update plane |
| `menubar/scope-test.sh` | (already retired at #61 step 4) | — |

The live-install acceptance run stays OUT of CI (as today's live eyeball
rule): the acceptance list is the D1–D6 surface on the real labels, run
once by the operator/supervisor at cutover.

## Rules (restated crisp)

1. One artifact. One `idlefill://` claimant. One tray. One window.
2. The page loads from `client/config.json` `server_url` at runtime, via
   `WebviewUrl::External` on a runtime-built window. No bundled page copy.
3. The token rides `initialization_script` (document-start, wry-proven)
   into the page's own `idlefill.token` key. Read-time only, never baked,
   never printed. Re-armed every reload.
4. loaded ≠ live. The pid line decides. kickstart without `-k`. Temp-file
   capture for launchctl output.
5. The glance is a small positioned window, not an NSPopover. Stated
   degradation, pinned fallback (tray menu).
6. Harnesses retire with the code. CI: fmt + clippy + cargo test.
7. The updater plane is gone. `--version` marker survives.

## What changes vs what stays untouched

Changes: the shell plane (`desktop/`, `menubar/` → `tauri/`), the three
CI workflows, the release plumbing per Q-b, the README desktop + menubar
sections at cutover, and the `com.sam.idlefill.menubar` label at
completion.

Untouched: `server/`, `client/`, `adapters/`, `scripts/idlefill-control.mjs`
and the daemon scripts, `server/public/index.html` (the page), DESIGN.md
(grep: zero mentions of the desktop or menubar apps — nothing to edit),
PRODUCT.md (only mentions the Node CLIs, which stay), every architecture
doc (aggregate-endpoint.md and model-aliases.md: zero menubar/desktop
mentions found by grep), the daemon + arbiter LaunchAgents.

## Open questions (owner input)

ALL FOUR ANSWERED by the owner 2026-10-06 — LOCKED:

- **Q-a LOCKED — auto-reload YES (D6).** One `reload()` per dead→live
  transition edge. No timer loop, no reload storm.
- **Q-b LOCKED — release artifacts: NOTHING (D7).** No app, no zip, no
  appcast, no signing on Forgejo releases. The app is built from the
  checkout everywhere. Accepted consequence, stated by the owner over
  the worker's objection: every machine that installs the app needs the
  Rust + Xcode toolchain (present on this Mac — cargo 1.99,
  cargo-tauri v2, Xcode). `scripts/release.sh` + `scripts/edge-release.sh`
  lose the desktop/menubar artifact paths entirely, and `edge.yml`
  retires with the edge channel. The `--version` marker contract still
  survives (the build.sh analog bakes it) — checkout builds must still
  self-identify.
- **Q-c LOCKED — tray gesture: SIMPLIFIED.** Single click = glance only.
  Double-click retires as a gesture — no window-focus binding (the
  `TrayIconEvent::DoubleClick` arm stays unused). The window opens from
  the glance's `Open Desktop` row or from deep links. The Swift
  two-gesture split (`MenuBarRouter.action` `:166-170`) retires — the
  README click-routing section gets rewritten at cutover, a stale
  gesture list is a convention break.
- **Q-d LOCKED — autostart: ONE LaunchAgent.** `com.sam.idlefill.app`,
  RunAtLoad, installed by the app's install script mirroring the menubar
  `install.sh` pattern (render-before-bootout, scratch-label tests, real
  labels untouched in tests). `com.sam.idlefill.menubar` retires at the
  cutover step.

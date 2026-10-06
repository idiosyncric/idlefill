# Issue #69 grill — verification report (2026-10-06)

Companion to `docs/architecture/tauri-cutover.md`. This file records what
was verified live, with real command output, and the parity mapping from
each Swift shell surface to the pinned Tauri mechanism. No repo code was
touched by this slice. The spike lived only in `/tmp/idlefill-tauri-spike`
(never in the repo tree. The cargo target dir is under `/tmp`).

## Toolchain — actual output

```
$ ~/.cargo/bin/cargo-tauri --version
tauri-cli 2.11.4
$ cargo --version
cargo 1.99.0 (5f94df478 2026-08-27) (Homebrew)
$ rustc --version
rustc 1.99.0 (b940084d7 2026-09-28) (Homebrew)
$ node --version
v26.10.0
```

`cargo-tauri` is at `~/.cargo/bin/cargo-tauri` as the issue states. Crate
docs came from the installed registry sources (version-locked, stronger
than docs.rs): `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`
(tauri 2.11.2 and 2.12.1, tauri-runtime 2.12.1, tauri-utils 2.10.1,
wry 0.55.1 and 0.57.0, tray-icon 0.23.1 and 0.25.1, tauri-build 2.7.1,
tao 0.37.1). Citations below pin the spike-resolved versions (tauri
2.12.1, tauri-utils 2.10.1, tauri-runtime 2.12.1, wry 0.57.0, tray-icon
0.25.1). The registry cache rotated older copies mid-session, so every
line number was re-checked against the on-disk source that actually
compiled the spike. One web doc was fetched:
https://v2.tauri.app/plugin/deep-linking/ (full page read). The docs.rs
extractor returned "page does not exist" for the WebviewUrl struct page.
the installed sources replaced it.

Marker-contract evidence (the `--version` bar the Tauri build must
reproduce). Run against the repo's CURRENT desktop build script BEFORE
this doc was written — it rebuilt the gitignored `desktop/Idlefill.app`
bundle. No tracked file changed (verified: `git status` after shows no
tracked change under `desktop/`):

```
$ bash desktop/build.sh                     # exit 0
==> built /Users/sam/Software/idlefill/desktop/Idlefill.app (version 1.0, marker 1.0, SUPublicEDKey absent)
$ ./desktop/Idlefill.app/Contents/MacOS/Idlefill --version
idlefill 1.0
$ IDLEFILL_DESKTOP_BUILD=edge-test-abc123 bash desktop/build.sh   # exit 0
$ ./desktop/Idlefill.app/Contents/MacOS/Idlefill --version
idlefill edge-test-abc123
```

## The spike — shape

Throwaway crate at `/tmp/idlefill-tauri-spike/src-tauri`. Deps resolved by
cargo (from the spike's `Cargo.lock`): tauri 2.12.1, tauri-runtime 2.12.1,
wry 0.57.0, tray-icon 0.25.1, tauri-build 2.7.1, tauri-plugin-deep-link
2.6.1, tauri-plugin-single-instance 2.5.2 (deep-link feature). The spike:

- Reads a scratch config JSON (`SPIKE_CONFIG` env) at RUNTIME:
  `server_url` + `token` (fake token value, never a repo secret).
- Builds the window at runtime:
  `WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))`
  with `.initialization_script(script)` where the script is the same
  shape as `gateTokenScript` (JSON-string-literal
  `localStorage.setItem("idlefill.token", …)`), plus
  `.on_page_load` logging.
- Builds a tray: `TrayIconBuilder::new().icon(…).menu(…).
  show_menu_on_left_click(false).on_menu_event(…).on_tray_icon_event(…)`.
- Wires `tauri_plugin_single_instance` (first plugin) +
  `tauri_plugin_deep_link` with `plugins.deep-link.desktop.schemes =
  ["idlefill"]`.
- `tauri.conf.json` sets `"build": { "frontendDist":
  "http://127.0.0.1:18099" }` and `"app": { "windows": [] }` — proving a
  config with NO local frontend assets compiles and bundles.
- `src-tauri/Info.plist` carries the ATS dict merge (see ATS results).

Builds: `cargo build` finished clean (after one `Image::from_bytes` →
`Image::new_owned` correction — `tauri::image::Image` has no PNG decoder.
the tray icon must come in as RGBA bytes). `~/.cargo/bin/cargo-tauri
tauri build --debug` produced
`src-tauri/target/debug/bundle/macos/idlefill-spike.app`.

Proof channel (no screenshot needed): a scratch page on
`http://127.0.0.1:18099` runs three checks and reports them to the server
by fetch (`GET /proof?r=…`), which writes `/tmp/.../proof.txt`. Check 1:
is `idlefill.token` present in localStorage (presence only, value never
printed). Check 2: same-origin `fetch('/api/state')`. Check 3:
cross-origin `fetch('http://127.0.0.1:18100/ping', {headers:
{'x-idlefill-edit': …}})` against a sibling server whose CORS mirrors
`client/src/client-projects.ts:71-75,194-199` exactly (echo the request
origin, allow `content-type, x-idlefill-edit`, preflight OPTIONS).

## Results, seam by seam

D2 — remote origin (VERIFIED live):

```
PAGE_LOAD Started http://127.0.0.1:18099/
PAGE_LOAD Finished http://127.0.0.1:18099/
```

Proof line, debug binary and bundled app both:
`tok-ok:api-ok-1:proxy-ok-hdr:set`. The init script landed (token
present), same-origin API fetch worked, and the cross-origin loopback
fetch with the `x-idlefill-edit` header passed the real CORS preflight
chain. The same bundle then loaded the REAL local arbiter:

```
PAGE_LOAD Started http://127.0.0.1:8787/
PAGE_LOAD Finished http://127.0.0.1:8787/
```

(the local arbiter serves its own page. The load events prove a Tauri
webview hosts the actual product origin with zero config changes).

D2 — CSP (VERIFIED live): with `security.csp = "default-src 'self'"` set
in `tauri.conf.json`, the REMOTE page (inline scripts, both fetches) ran
fully — same proof line. Escalated control: `"script-src 'none'"` on top
of `"default-src 'self'"` — the remote page's inline script STILL ran.
Conclusion pinned: Tauri's configured CSP is injected into served
assets, not into a remote External page. It cannot break the arbiter's
page, and it cannot guard it either (the arbiter serves no CSP today,
that is a server fact, unchanged by this issue).

D2 — ATS (VERIFIED live by removal):

- Built bundle, ATS dict PRESENT: loopback load fine.
- `plutil -remove NSAppTransportSecurity` on the built bundle: loopback
  load STILL fine (`tok-ok:api-ok-1:proxy-ok-hdr:set`).
- Same keyless bundle against a NON-loopback origin (`http://10.10.10.28:18098`,
  this Mac's en0 address): `PAGE_LOAD Finished` + proof `remote:api-ok-1`.
  ATS did not block that plain-HTTP remote load on this macOS/WebKit.

The merge mechanism itself is also proven: the bundled Info.plist contained
`NSAppTransportSecurity → NSAllowsArbitraryLoads` plus the deep-link
entry (below), from `bundle.macOS.infoPlist`. The cut-over still ships
the ATS exception (parity with `desktop/build.sh:144-152`) for machines
where WebKit enforces ATS on a remote host. Loopback needs nothing.

D5 — deep links (VERIFIED at the bundle level):

```
$ plutil -p .../idlefill-spike.app/Contents/Info.plist | grep -A6 CFBundleURLTypes
"CFBundleURLTypes" => [ { "CFBundleTypeRole" => "Editor",
  "CFBundleURLName" => "com.sam.idlefill.spike idlefill",
  "CFBundleURLSchemes" => [ "idlefill" ] } ]
```

The plugin generated the entry from the config (identical shape to
`desktop/build.sh:133-143`). Live open-testing was NOT done: the official
docs pin that on macOS deep links trigger only for the installed
application. The cutover acceptance run does that.

D6 — load-failure signal (VERIFIED): negative control with the probe
server dead (port free first, verified via `lsof`):

```
SPIKE-TITLE idlefill-spike          # NO PAGE_LOAD line at all, and no proof file written
```

A dead origin fires no load events (wry emitted neither Started nor
Finished for the refused connection). So "no Finished event" is the
programmatic signal, and the page's own liveness (the proof fetch
pattern) is the second one. Note one earlier muddled control: a stale
probe server kept port 18099 and produced Finished despite a missed
`pkill` pattern. The clean control is the one above (killed by PID, port
confirmed free via `lsof`, then run).

D3 — document-start timing (VERIFIED in source): wry feeds
`initialization_script` into `WKUserScript` with
`WKUserScriptInjectionTime::AtDocumentStart` (wry 0.57.0,
`src/wkwebview/mod.rs:646-648` → `fn init` `:780-791`). Same WebKit call
the Swift shell makes (`desktop/IdlefillDesktop.swift:2004`). The spike
proof line (`tok-ok`) shows the value was in localStorage before the
page's script read it.

D1 — tray (VERIFIED present + compiles + runs): `TrayIconEvent::Click`
and `DoubleClick` variants with `position`/`rect` (tauri 2.12.1
`src/tray/mod.rs:71-131`), `show_menu_on_left_click` `:319`, `set_menu`
`:512`, `set_tooltip` `:523`. The spike ran with a tray icon and menu on
this Mac without clicking them. NOT verified: the popover-substitute
behavior (blur-dismiss, anchoring) — that is implementation work, stated
as such in the decision doc.

## Cited sources

- https://v2.tauri.app/plugin/deep-linking/ — desktop schemes config,
  single-instance `deep-link` feature chain, macOS "installed
  application only" caveat, `onOpenUrl`/`getCurrent`.
- tauri-utils 2.10.1 `src/config.rs`: `WebviewUrl::External` `:77-86`
  ("Must use either the `http` or `https` schemes"), `FrontendDist::Url`
  `:3699-3706` ("No assets are embedded in the app in this case"),
  `MacConfig::info_plist` `:669`, `exception_domain` `:653`,
  `bundle_version` `:628`, `SecurityConfig::csp` `:3045`.
- tauri 2.12.1 `src/webview/webview_window.rs`: `new` `:101`,
  `on_page_load` `:421`, `initialization_script` `:1008`,
  `initialization_script_for_all_frames` `:1053`, `navigate` `:2511`,
  `reload` `:2516`, `eval` `:2576`.
- tauri 2.12.1 `src/tray/mod.rs`: tray builder `:203+`,
  `TrayIconEvent` `:71-131`, `set_menu` `:512`, `set_tooltip` `:523`.
- tauri-runtime 2.12.1 `src/webview.rs:87-92`: `PageLoadEvent` =
  `Started | Finished` (no Failed event).
- wry 0.57.0 `src/lib.rs:2588-2593` (same enum),
  `src/wkwebview/mod.rs:646-648,780-791` (document-start user scripts).
- e737411 (this repo): the pid-line liveness parse
  (`desktop/IdlefillDesktop.swift:1267-1275`), kickstart-without-`-k`
  (`:1555-1563`), the "Bootstrap failed: 5" no-op (`:1340-1343`), the
  24-check `desktop/arbiter-test.sh`, the README launchd rewrite. All
  live-cited in the decision doc.

## Corrections found while verifying

1. **No Keychain anywhere.** Earlier notes claimed the menubar read the
   gate token from the login Keychain. Grep of both Swift files for
   `keychain` and `find-generic-password`: zero hits. Both shells read
   `client/config.json` (desktop at call time `:1123-1129`, menubar once
   at launch `:177-238`). The cut-over therefore has NO token-storage
   migration to design — the file stays the only store.
2. **The CSP question in the issue is weaker than framed.** Tauri's CSP
   config does not apply to a remote External page (proven). The page
   needs no allowances. The only CSP surface is the settings window's
   own bundled HTML, which is shell-local.
3. **ATS is not required for loopback on this macOS/WebKit** (proven by
   removal). The shipped plist exception stays for remote-origin parity,
   and `exception_domain` is the documented narrow alternative.
4. **wry/tauri expose no page-load Failed event.** Detection is the
   missing `Finished` plus the launchd pid-line check, not a native
   failure callback.

## Parity inventory check — each Swift surface → pinned mechanism

| Swift surface (file:line) | Pinned Tauri mechanism | Status |
|---|---|---|
| WKWebView loads live origin (`:1989-2009`) | runtime `WebviewWindowBuilder` + `WebviewUrl::External` | live-proven (loopback, LAN, real arbiter) |
| ATS plist (`build.sh:144-152`) | `bundle.macOS.infoPlist` merge | live-proven (plist merge), parity shipped |
| `.documentStart` token script (`:1974-2004`) | `initialization_script` → wry AtDocumentStart | source-pinned + live-proven presence |
| Toolbar strip: origin, stopped row, Relaunch, Reload, settings (`:2024-2079`) | no native toolbar over External pages → tray word + exception tray item + menu ⌘R + settings window | degradation stated in D4 |
| launchctl print / pid line / kickstart / bootstrap / bootout (`:1196-1343`, e737411) | `std::process::Command` port of the pure parsers + the same verbs, temp-file capture | semantics pinned by e737411, port plan D4 |
| Settings toggles + `runs:` + guards (`:1687-1770`, `:1431-1527`) | second (local) settings window + Rust IPC commands | port plan D4 |
| `idlefill://` scheme + `.onOpenURL` + `hashView` + `handleDeepLink` (`:1063-1098`, `:2142`) | tauri-plugin-deep-link + single-instance, plugin-generated CFBundleURLTypes, `on_open_url` → `navigate(origin#view)` | bundle-level proven, live-open at acceptance |
| `NSStatusItem` glance + NSPopover (`menubar:3015-3033`) | `TrayIconBuilder` + positioned small window (fallback: tray menu) | tray live-ran. popover substitute = implementation risk, named |
| Single/double click routing (`menubar:166-170`) | `TrayIconEvent::Click` / `DoubleClick`, `show_menu_on_left_click(false)` | source-pinned, event not clicked live |
| Glance content specs (`glanceStatusRow` `:807`, `panelActionRows` `:778`) | pure Rust port + `cargo test` | port plan D9 |
| Marker + `--version` (`build.sh:66-84`) | env-var `option_env!` marker + argv check, `macOS.bundle_version` | Swift contract live-proven. Rust port plan |
| Sparkle plane, edge plane, update rows | retired (owner lock) — no replacement | locked |

## Gates run for this slice

- `git diff --cached --stat` before the commit: only
  `docs/architecture/tauri-cutover.md` and
  `docs/reports/ISSUE69-GRILL-REPORT.md`.
- ASD-STE100 semicolon gate: no `;` outside fenced code blocks and inline
  code spans in either file (grep run before commit).
- No `npm` gates run (no TypeScript touched). No repo build run for this
  doc (the one repo build above ran BEFORE the doc, rebuilt only
  gitignored artifacts, and its output is cited as evidence).

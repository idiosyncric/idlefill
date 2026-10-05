# One surface per machine: desktop app hosts the arbiter web UI

Owner decision 2026-10-05: one surface to interact with idlefill per machine.
This issue operationalizes mesh.md D5's "the desktop app is a thin client of
the LOCAL arbiter origin" — the thin client becomes a real embedded view.

## Why there are two today (the honest answer)

Historical accident, not design. The web page belongs to the arbiter, and
until #60 no arbiter ran on the Mac — the desktop app connected to urza's
arbiter over the tailnet and had to render its own UI. Two homes grew two
UIs. Then both evolved: the dashboard added Sessions, Machines, Cycles,
Usage, throttled-jobs, per-server keys (1,907 lines of HTML, current); the
desktop re-implemented each feature by hand in Swift (2,951 lines, and it
has ZERO of Cycles/Machines/Usage — drift measured in git log). #60 moved
the premise: every machine now runs its own arbiter serving its
version-matched page on loopback :8787. The separation no longer has a
reason to exist.

## The shape

- The arbiter-served page (`server/public/index.html`) becomes THE surface.
  One source of UI truth, rendered in a browser or the app window — same
  page, same API version, always.
- The desktop app becomes: native window + `WKWebView` pointed at
  `http://127.0.0.1:8787/`. WKWebView is system-provided: no Tauri, no
  Electron, no new runtime; `swiftc -O` + ad-hoc codesign + Sparkle all
  stay exactly as they are.
- The app injects the arbiter token from `client/config.json` into the page
  at load (script message / evaluateJavaScript). The pasted "gate token"
  combobox retires; auth becomes automatic.
- The app must NOT bundle a copy of index.html. It loads the live origin —
  a copied page re-creates the drift bug inside the bundle.
- Native stays native: launchd toggles, Sparkle update, log folder, repo
  path settings, menubar handoff. The arbiter cannot know about launchd —
  lifecycle controls never move into the page. They render as a slim native
  sidebar/toolbar around the webview.
- The five SwiftUI tab panels (state, sessions, logs, projects, settings)
  retire section-by-section as parity is verified — not one big-bang delete.
- Menubar app demotes to an ambient glance + handoff (open the window). Its
  buttons (daemon start/stop, project gates, knobs) move to the one window.
  FLAG: this is the supervisor's reading of "one surface to interact with" —
  owner confirms or the menubar keeps its controls.
- Linux: the same page in a browser, no native shell (already the locked
  posture; nothing forks).

## Migration order (safe, reversible)

1. Webview window loading the live origin + token injection. Old tabs stay
   visible behind a toggle — a parallel period for the parity audit.
2. Parity audit: every control the old tabs had (session pause/resume,
   project gate + knob editors, unthrottle, server edit + API keys, queue
   view/search, logs tray) proven in the page. The web page already has
   more than the desktop app; gaps get fixed IN the page.
3. Delete the retired SwiftUI panels; the app shrinks to shell + lifecycle.
4. Menubar demotion (glance + open window).

## Acceptance

- One app window shows everything #60's dashboard shows (Servers incl.
  oMLX/strata + keys, Projects incl. cycles, Sessions, Usage, Machines).
- No feature regression from the retired desktop tabs (checklist above).
- Token never pasted; writes work from first launch on a clean install.
- Build story unchanged: bare swiftc, ad-hoc codesign, update.sh installs.
- Desktop harnesses (`sessions-test.sh`, drift/launchd drivers) survive or
  retire honestly with the code they test.

Related: #60 (the local arbiter is what makes this possible), #9 D (Sessions
tab owner intent — it moves INTO the one window, it does not go away),
product-vision record ("no Tauri rewrite" — honored).

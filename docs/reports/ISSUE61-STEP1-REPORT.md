# ISSUE61-STEP1 REPORT — desktop window hosts the arbiter web UI (WKWebView + token injection)

Date: 2026-10-05. Repo: idlefill @ main. Scope: step 1 of the brief's
migration order ONLY — the webview surface, token injection, the parallel
period. No Swift panel deleted; no server/page contract changed.

## What landed

`desktop/IdlefillDesktop.swift`:

- **`DASHBOARD` tab, first + default.** A `WKWebView` (system WebKit, zero
  new dependencies) hosted through `NSViewRepresentable`. It loads the
  arbiter's LIVE origin — `server_url` from `client/config.json` (0600) +
  `/` — never a hardcoded host, never a bundled copy of `index.html`. One
  webview instance lives on `AppModel` (`dashboardWebView`), so a tab
  switch re-hosts the same live page instead of reloading it.
- **Token injection through the page's OWN mechanism.** The dashboard's
  write gate reads `localStorage["idlefill.token"]` (`GATE_TOKEN_KEY`,
  `gateToken()` — read at index.html:1258 before wiring anything). The app
  injects a `WKUserScript` at `.documentStart` — BEFORE the page's inline
  script ever runs — setting exactly that key from `client/config.json`'s
  token. The token rides as a JSON-quoted literal (no breakout); nil/empty
  token injects nothing and the page keeps its own honest "needs a token"
  behavior. The page's own token box stays fully functional — the
  injection is additive, the live run proves it ("stored ✓").
- **Parallel period honored.** The five Swift tabs stay; deep links keep
  their settled routing (`idlefill://open` → State, `sessions` → Sessions,
  `logs` → Logs, `projects` → Projects); a new `idlefill://dashboard` host
  lands on the webview. Tab order: `dashboard, state, sessions, logs,
  projects, settings`.
- **Native chrome untouched.** launchd toggles, Sparkle, log folder,
  settings, menubar handoff — all unchanged. The slim native strip above
  the webview shows the live origin host + a Reload affordance only.
- `Pal.canvasNS` added (the AppKit NSColor twin of the canvas token) for
  the webview's under-page fill — `underPageBackgroundColor` rejects the
  SwiftUI `Color`.

`desktop/sessions-test.sh`: adapted, not deleted. The tab-order/routing
checks were updated to the six-tab order + the new host, and a new pure
section `(i)` proves the injection: nil/empty token → nil script; the
script targets the page's exact key; the token is JSON-escaped (quotes,
newlines, tabs stay inside the literal); the key constant matches the page
contract.

## Decisions honored

- WKWebView only — no Tauri/Electron/new runtime; build story unchanged
  (bare `swiftc -O` + ad-hoc codesign; `swiftc -parse` CI gate green).
- The app hosts the arbiter's version-matched page — no bundled copy
  (the brief's drift argument).
- No `server/public/index.html` change at all — the injection fits the
  page's existing localStorage contract; the ADD-keys rule never fired.
- Lifecycle controls stayed native (they are not in the page).

## Harness output (real runs, this checkout)

- `swiftc -parse desktop/IdlefillDesktop.swift` — OK (the CI Swift gate).
- `desktop/sessions-test.sh` — `SESSIONS-DT-HARNESS-PASS` (stub + dead-port
  legs), including the new `(g)` six-tab routing + `(i)` injection checks.
- `desktop/staleness-test.sh` — `STALENESS-DT-ALL-PASS`.
- `desktop/edge-test.sh` — 64 PASS, `EDGE-DT-ALL-PASS`, drift leg
  `EDGE-DT-DRIFT-PASS`.
- `npm run test` — server 144 / client 83 / career-ops 17 / noop 2, fail 0.
- `npm run build` — OK. `npx tsc --noEmit -p server/tsconfig.json` — OK
  (client untouched by this change).

Note: these Node gates ran against a working tree that ALSO carried another
worker's uncommitted `server/src` changes. This commit touches only
`desktop/` + docs + README — the TS surface is untouched by it.

## Live verification (the eyeball pass, per the harness doc)

Build via `desktop/build.sh`, install via `desktop/update.sh`, window
captured BY CGWINDOWID (Swift `CGWindowListCopyWindowInfo` snippet →
`screencapture -x -o -l<winID>`), asserted before vision:

- **Page renders live, not a stub:** header `idlefill · arbiter`,
  INFERENCE SERVERS rows **oMLX (Idle, url http://127.0.0.1:8000)**,
  strata + strata-scanbot (Degraded rows — faithful to the arbiter),
  MACHINES row **urza (Online, queued 445 · 2 sessions)**, PROJECTS
  **career-ops (445 queued)**, SESSIONS, USAGE · last 7 days, the LOGS
  tray. The Cycles section renders nothing here because it is an
  **exception-only section** (`#cycles-section` stays `display:none` until
  a worker publishes a non-empty cycles block — career-ops has none);
  its presence in the hosted page is the point, its rows are data-gated.
  ATS proof: the plain-HTTP loopback load RENDERED live data — the
  bundle's existing `NSAllowsArbitraryLoads` exception covers the webview
  (proven by the run, not assumed). Bundle proof: `find
  /Applications/Idlefill.app -name '*.html'` → **0** (no bundled page
  copy; the live origin is the only page).
- **Token injected, zero pasting:** the page's own gate-token hint reads
  **"stored ✓"** — that line only renders when `gateToken()` returns a
  non-empty value. No paste ever touched the field (it stays empty; the
  injection writes the same localStorage key before the page boots).
- **Write path WITHOUT the token box:** drove the real page in the real
  webview via the accessibility tree (`AXManualAccessibility` + AXPress /
  AXValue probes — WebKit exposes the page's AX tree): opened oMLX
  "edit connection", changed ONLY the label `oMLX → oMLX-61s1`, pressed
  Save — the page answered **"oMLX updated"**; arbiter truth confirmed by
  an API read (`srv-watched | oMLX-61s1`); reverted the same way back to
  **oMLX** (arbiter read-back: `srv-watched | oMLX` — the only residue is
  the row's `changed` timestamp). No gate/knob/pause touched: career-ops
  untouched, engine gate untouched, no session override sent. (The engine
  gate already read paused BEFORE this run — arbiter truth, not a change
  from this work.)
- **Old tabs still function:** STATE switched via the tab strip (AX press),
  rendered its native panel (arbiter idle, queue 445, today 0 ok · 0
  failed); a "daemon behind" tag shows — the honest staleness flag
  (working-tree drift during the concurrent #60 WIP), not a regression.
- Screenshot: `docs/reports/ISSUE61-step1-window.png` (DASHBOARD active,
  live origin strip "token auto-injected", the sections above).

## The edge-channel clobber (live incident, honest note)

Mid-verification the running app auto-updated from the **edge channel**
(marker `edge-main-0e8da66`) and replaced the dev bundle — the window
briefly went back to the five legacy tabs. That is the desktop's own
edge-update path doing its job against an unpushed dev build, not a defect
in this change. After this lands on main, the edge build of main WILL
carry DASHBOARD, so the same auto-update becomes the delivery path.
(`update.sh` re-installed the dev build and verification continued.)

## Follow-ups

- **Step 2 (parity audit):** prove every retired-tab control in the page —
  per-session pause/resume, project gate + knob editors, unthrottle,
  server edit + per-server keys, queue view/search, logs tray. Gaps get
  fixed IN the page. The page already has more than the Swift panels
  (Cycles/Machines/Usage are page-only).
- **Step 3:** delete the retired Swift panels; the app shrinks to shell +
  lifecycle. The five-tab harnesses retire with the code they test.
- **Step 4:** menubar demotion (glance + open window).
- Minor step-1 polish candidates (deliberately not smuggled in): a
  connection-failure placeholder when the arbiter origin is unreachable
  (the webview shows WebKit's error page), and a per-webview zoom control.

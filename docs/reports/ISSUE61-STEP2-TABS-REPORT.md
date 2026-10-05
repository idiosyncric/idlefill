# #61 step 2 (part 1) — the dashboard becomes a tabbed surface

Owner ask 2026-10-05: the desktop DASHBOARD tab hosts the arbiter's live page
(#61 step 1) but the page itself is one long scroll — the operator asked for
the retired Swift tabs back as views. This slice reshapes the single page
into four views behind a tab bar. It lands BEFORE the Swift-tab deletion:
the page now covers the tab structure the retired panels gave the operator.

## What changed

`server/public/index.html` (the one UI source; no new files, no framework):

- A **view-tab bar** under the header: **Overview · Projects · Sessions ·
  Usage**, styled with the logs-tray tab rules (canvas fill, 4px radius,
  slate-filled active tab, 11px/600/+1px uppercase label — DESIGN.md
  "Logs Tray" + "Panels"). No animation: the switch is a display flip
  (DESIGN.md: the tray chevron is the page's only transition).
- Every `<section>` carries a `data-view` attribute:
  - **Overview** — Inference servers, Machines (mesh), Cycles, Throttled
    jobs. The machine + fleet view.
  - **Projects** — the Projects pane + Queue search. The work view.
  - **Sessions** — the Sessions pane (interactive traffic).
  - **Usage** — the #51 metrics charts.
- The **view switch is a class flip** (`main section.vthide`,
  `display:none !important`), never inline style. Inline `display` stays the
  property the exception-only sections own (hidden-while-empty); the class
  must beat it, not fight it. This keeps the Exception-Only Rule intact
  inside a tab: an empty Sessions view shows nothing, not a fake row.
- **Exception-only tab badges**: the Sessions tab carries a count ONLY while
  sessions are queued at the gate; the Projects tab carries one ONLY while
  jobs are throttled. No badge is the healthy state.
- **Per-view empty line**: the exception-only sections hide themselves, so a
  tab can open onto a blank canvas. One italic line (DESIGN.md "Empty
  States") names the null case per view; `syncViewEmpty()` re-checks after
  every refresh, because the sections toggle underneath the open tab.
- **Selection persists** (`idlefill.viewTab`, same localStorage family as the
  tray tab) and **queue search jumps to its view** on focus (results live in
  Projects).
- The queue detail route (`/[project]/[worker]/queue`) keeps its single-
  section layout: `body.queuepage #view-tabs { display: none }` hides the
  bar there. Deep links and the breadcrumb back to overview are untouched.
- The logs stay the bottom **dock** (not a tab): Events/Leases must remain
  reachable while any view is open.

## Why tabs in the page, not in the Swift shell

The page is the single source of UI truth (#61 lock). A tab bar built in the
native shell would fork the structure into a second surface — the drift bug
#61 exists to end. Browser and WKWebView get the identical split.

## Verification (all run)

- Inline-script parse: extracted `<script>` → `node --check` → clean (the
  page stays outside tsc; this is the standing pitfall, checked every slice).
- `node --test test/api.test.ts` → **33 pass** (includes the new test
  `dashboard carries the view-tab structure (#61 step 2)`: tab bar present,
  four views assigned, the class-flip mechanism, the queuepage hide rule).
- **Live, Orca embedded browser, the real Mac arbiter (loopback :8787):**
  clicked through all four tabs by script; visible sections per view match
  the assignment exactly (overview → servers + mesh; projects → Projects;
  sessions → sessions-section; usage → usage-section); selection survives a
  reload (`idlefill.viewTab` persisted); queue route → tab bar hidden +
  queue section shown; empty query keeps the queue-search section
  `display:none` (exception-only preserved inside the tab system).
- Screenshots: `ISSUE61-step2-tab-{overview,projects,sessions}.png`.

## What this slice does NOT do

- It does not delete the Swift tab panels (that is #61 step 2/3 proper: the
  parity audit + retirement). The webview page now has the tab structure the
  retired panels had; the audit of each retired control against the page is
  the next piece of #61.
- No new API surface, no server changes in this slice.

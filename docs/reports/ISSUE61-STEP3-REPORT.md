# Issue #61 step 3 — close the page parity gaps, then retire the Swift tabs

Branch `issue-61-step3` (base `main` @ `f266c33`). Two slices, two commits:
`1ea6f8a` (slice A — page parity), `cb7d18c` (slice B — desktop shrinks to
shell + lifecycle). This is the third commit (docs).

## What changed — slice A (server + client + page)

Wire discipline held end-to-end: ADD keys only, the client computes the
display data, publishes it on the register heartbeat, the arbiter's
register sanitizer bounds and stores it verbatim, `projectView`/`/api/state`
echo exception-only — the exact version/revision/gate_posture/proxy_port
pattern.

**A1 — `daemon behind` in the page.** The comparison needs LOCAL facts, and
only the client has both (its boot revision + the live HEAD of the checkout
it runs from). `client/src/index.ts`: `daemonBehind()` re-reads
`resolveRevision()` every heartbeat and prefix-tolerant-compares against the
boot SHA; publishes add-key `daemon_behind` — `true` only when both sides
resolve and differ, the key OMITTED when either side cannot resolve,
`false` CLEARS the stored marker (a restart clears the tag within one
heartbeat), absent leaves the row. `server/src/arbiter.ts` sanitizes it
like gate_posture (drop-don't-reject); `server/src/api.ts` echoes it
exception-only on the client + worker rows. `server/public/index.html`:
exception-only warn tag on the worker row with the toolhint naming the fix
("this daemon runs code older than its own checkout — restart it (native
toolbar, or launchctl kickstart) to pick up the current tree").

**A2 — client log tail in the page.** `RotatingLog` keeps an in-memory ring
at the write site (120 lines, 300-char per-line cap, oldest first — the log
FILE is never re-read). Published as add-key `client_log` ONLY when
`isLoopbackUrl(this.cfg.server_url)` — the mesh never carries log payloads;
a remote arbiter gets the key omitted. The arbiter bounds it (non-array
drops the key whole; a cleaned empty tail deletes it; ≤120 lines × 300
chars stored) and keeps it bounded in state.json. The logs dock gains a
third tab **Events / Leases / Client log** (`tab-clientlog`/`pane-clientlog`):
one block per client, newest at the bottom, auto-follow only when already
at bottom (`CLOG_AT_BOTTOM_SLOP`, the Swift LogViewer's rule), Exception-
Only (no tail → no tab; an operator sitting on the tab falls back to
Events when the tail disappears). The selected dock tab persists via
`idlefill.logsTab`.

**A3 — local project-config editor in the page.** New module
`client/src/client-projects.ts` (292 lines) serves `GET`/`PUT
/client/projects` on the SAME loopback proxy server (no new bind), wired
through `startLlmProxy({clientProjects})` BEFORE the session/passthrough
paths. Guard ladder (fail-closed): Host must be `127.0.0.1`/`localhost`
(rebinding guard, 400); a carried `Origin` must be a loopback origin any
port (403; no-Origin non-browser clients allowed); `X-Idlefill-Edit` must
constant-time-match the client's OWN config token (401) — the desktop
webview already injects that token into the page, so zero pasting holds;
no config FILE (env-config launch) → 503, never invents a path. `PUT`
validates every entry with the launch-time config rules (`validateProjectsBody`)
and rejects the WHOLE body with 400 on any invalid entry ("row N: …") —
never a partial write. A good write preserves EVERY other config key (the
token included) and the file's `0600` mode, tmp-then-rename, and answers
`{restart_required:true}` — the restart stays native (no self-restart).
OPTIONS answers loopback-allow CORS for the cross-port fetch. The page
(Projects view) renders the editor per client ONLY when the page origin is
loopback AND the client reports `proxy_port` (five editable fields +
Add/Remove project); the toggle carries `data-port` so the fetch targets
the right client. Deep links: the page honours `location.hash` via
`HASH_VIEW_RE` (`#overview/#projects/#sessions/#usage`) so
`idlefill://projects` lands on the right view for slice B.

## What changed — slice B (desktop shrinks to shell + lifecycle)

Swift 3,353 → 2,187 lines (−1,282, `git show --stat`):
`116 insertions(+), 1997 deletions(-)` across 3 files.

- **Deleted:** StatePanel, SessionsPanel (+ the pure
  `SessionsView.project`/`overrideRequest` read/write sites), LogViewer,
  ProjectsPanel and their AppModel state — `daemonBehind`/
  `currentCheckoutRevision` (the client publishes the verdict now),
  `sessions`/`pendingSessionTokens`/`sessionsNote`, the log-tail machinery
  (`logLines`/`logPath`/`logOffset`/`logSeq`/`maxLogLines`/`followTail`/
  `pollLogs`/`appendLog`/`resolveLogPath` + the 2.5s timer), 
  `projRows`/`saveProjects`/`validateProjects`/`loadProjects`/`projNote`/
  `restartDaemon`, the whole `/api/state` poll (`poll`/`apply`/
  `injectStatePayload`), `Conn`, `MainTab`, `LogoView`, `KVRow`,
  `proxyPort()`/`configuredClientName()` (no longer used),
  `SentinelKey`/`ViewportKey`.
- **The window IS the one surface:** a slim native toolbar over the webview
  (the #61 shape) — origin + "token auto-injected" + the exception-only
  `arbiter stopped` + Relaunch (kept; `arbiter-test.sh` still pins it) +
  the **settings ▾ disclosure** re-hosting the machinery the arbiter can
  NEVER know (daemon/menubar/arbiter launchd toggles + `runs:` lines + the
  menubar stale marker + the arbiter stopped/Relaunch row, repo path, the
  releases/branch update channel with pin/progress/edge-install/confirm —
  the SettingsPanel content kept, re-hosted; the webview never tears down
  around the disclosure) + Reload.
- **Deep links re-route onto the page:** pure `AppModel.hashView(for:)` —
  `idlefill://state` → `#overview`, `sessions` → `#sessions`, `projects` →
  `#projects`, `usage` → `#usage`; `""`/`open`/`dashboard`/`logs`/unknown →
  the page's default view (the logs DOCK is a dock, not a hashable view).
  `handleDeepLink` stores the hash and `reloadDashboard()` loads
  `<origin>#<view>`; the page's `HASH_VIEW_RE` (slice A) lands it.
  `idlefill://projects` keeps working.
- **Harness honesty:** `desktop/sessions-test.sh` + `desktop/staleness-test.sh`
  compiled the real Swift and pinned the RETIRED panels — deleted with the
  code. Verified zero call sites: `.gitea/workflows/*.yml` never referenced
  them (grep — the workflows only run `swiftc -parse desktop/…`). KEPT and
  green by actual run: `desktop/arbiter-test.sh`, `desktop/edge-test.sh`
  (all legs), `desktop/build.sh`.

## Decisions honored

- The client computes staleness (the only process with both facts); the
  arbiter stores the verdict verbatim.
- `false` clears the marker within one heartbeat; absent leaves prior state
  (pre-step-3 clients unaffected, rows byte-identical — asserted).
- Client logs NEVER cross to a non-loopback arbiter (`isLoopbackUrl` gate
  at the producer, not the store).
- The local editor is hosted by the CLIENT (it owns `client/config.json`);
  loopback Host/Origin/token guards; 503 fail-closed when no config path;
  `restart_required:true` — the restart stays a native/launchd action.
- Exception-Only everywhere on the new surfaces (no tag, no tab, no section
  when healthy/absent).
- Menubar demotion (step 4) NOT touched — `menubar/` untouched (owner lock).
- Settings stays native (the arbiter cannot know launchd).

## Gates — real output

### Slice A

`tsc --noEmit` both workspaces: clean (`TSC-OK`).

Page inline script extracted → `node --check`: `PAGE-SYNTAX-OK`
(102,312 chars checked).

`npm run build` (both workspaces): exit 0.

Full `npm run test` (final run, after the fixture servers were killed —
see "interference note"): **FINAL-TEST-EXIT=0**

```
ℹ tests 184   ℹ pass 184   ℹ fail 0     (server: idle, feed-off, server-key,
                                            provider-kinds, arbiter, api, mesh, metrics)
ℹ tests 101   ℹ pass 101   ℹ fail 0     (client: proxy, client-projects, session-gate,
                                            lease-loop, priority-order, sigint, group-kill,
                                            version-handshake, revision, adapter-registry,
                                            rebuild-scheduler, dev-cycle, cycle-driver, cycle-publish)
ℹ tests 17    ℹ pass 17    ℹ fail 0     (adapter career-ops)
ℹ tests 2     ℹ pass 2     ℹ fail 0     (adapter noop)
```

New harness additions (all in the existing families):
`server/test/api.test.ts` — `daemon_behind (#61 A1)` store/echo/clear,
non-boolean drop + absent-leaves-row, `client_log (#61 A2)` verbatim/bound/
clear/absent, `legacy register (#61)` byte-identical rows, and the required
dashboard-shape test `dashboard carries the #61 step 3 surfaces` (tag +
toolhint, dock tab + pane, `CLOG_AT_BOTTOM_SLOP`, `lcfg-section` +
`x-idlefill-edit` + `pageOriginLoopback`, `HASH_VIEW_RE`).
`client/test/client-projects.test.ts` (new, 10 tests, real proxy sockets):
401 token ladder, OPTIONS loopback-CORS, Host rebinding 400 (raw request —
`fetch` forbids a manual Host header), non-loopback Origin 403, whole-body
400 with the file untouched, token/sibling-key/0600 preservation + tmp
renamed, 503 without a config file, `/client/projects` never shadows the
LLM passthrough (`/v1` still 502s against a dead target), and the two pure
helpers.

**Interference note (honesty):** the FIRST full `npm run test` run showed
3 `client/lease-loop.test.ts` failures + a hang. Reproduced in isolation
against base (16/16 pass) and against my changes (16/16 pass) — the batch
failures were MY throwaway fixture servers from the live acceptance holding
port 11999 while the suite ran concurrently. After killing them: client
suite 101/101 twice, full workspaces green (FINAL-TEST-EXIT=0 above). No
production port was ever taken over (the real client kept 11435 throughout;
the fixture proxy deliberately bound 11999).

### Live acceptance (throwaway arbiter on :8797, NEVER :8787)

Throwaway arbiter from this worktree on loopback :8797 (`IDLEFILL_CONFIG`
env, worktree code). curl assertions (token pulled from the throwaway
config by a script — never inline in a command):

```
== 1. register fixture carrying daemon_behind + client_log + proxy_port ==
{"client_id":"c-296558d7","created":true}
== 2. /api/state echoes the new keys ==
client row daemon_behind: True
client row client_log: ["[2026-10-05T12:00:00.000Z] registered as c-fx", "[2026-10-05T12:00:20.000Z] ws connected"]
worker row daemon_behind: True
worker row proxy_port: 11435
== 3. daemon_behind:false heartbeat CLEARS the marker ==
daemon_behind present after false: False
client_log still rides (independent key): True
== 4. legacy register (no new keys) leaves rows byte-identical ==
legacy row byte-identical across heartbeats (last_seen stripped): True
no new keys on legacy row: True
```

A3 against a fixture client proxy on :11999 (real routes, scratch config):

```
GET /client/projects → {"projects":[{...fixture row...}]}
PUT (model edit)     → {"restart_required":true}
file after PUT: token preserved / client_name preserved / model=edited-model /
  estimated=600 / timeout=1200 / mode after PUT: 0o600 / no stray .tmp
bad entry            → {"error":"row 2: name is required"} + file md5 unchanged
wrong token          → status 401
```

Orca embedded browser (`orca tab create --url http://127.0.0.1:8797/#projects`):

```
{"view":"projects","workerTags":["daemon behind"],
 "behindTitle":"this daemon runs code older than its own checkout — restart it
  (native toolbar, or launchctl kickstart) to pick up the current tree",
 "clientlogTabVisible":true,
 "clientlogLines":"[2026-10-05T12:00:00.000Z] registered as c-fx\n[... ws connected]",
 "lcfgSection":"","lcfgToggle":"▲fixture-mac · 127.0.0.1:11435"}
```

The `#projects` deep link landed the view on load (HASH_VIEW_RE). The local
config editor opened CROSS-PORT against the fixture client (:11999) with
the page's stored token, round-tripped its inputs
(`name=career-ops model=edited-model queue_file=../data/q.jsonl
estimated_seconds=600 timeout_seconds=1200`), and a page-clicked Save
answered "saved — restart the daemon to apply" while the FILE picked up
`estimated_seconds: 777` (the browser CORS path proven, not just curl).

Exception-only absence pass (second throwaway EMPTY arbiter on :8798):

```
{"behindTag":"none","clientlogTabHidden":true,"lcfgDisplay":"none"}
```

And on :8797 after the fixture's keys were cleared + it aged offline:
`workers tags []`, `clientlogTabHidden:true` — absent fixtures render
nothing.

Screenshots (next to this report): `ISSUE61-step3-projects-view.png`
(tag on the row), `ISSUE61-step3-local-config-editor.png` (the editor open
with the fixture's live data), `ISSUE61-step3-clientlog-dock.png` (row tag
+ Client log dock open with the fixture tail + the LOCAL CLIENT CONFIG
strip — vision-checked: exactly one "daemon behind" tag, dock titled
fixture-mac with the two lines).

Cleanup verified: throwaway arbs + fixture proxy killed, `8797: free`,
`8798: free`, `11999: free`; the browser tab created by this task closed;
the Orca session's other tabs untouched.

### Slice B gates

```
$ swiftc -parse desktop/IdlefillDesktop.swift   → PARSE-OK
$ bash desktop/build.sh                          → BUILD-EXIT=0
$ find desktop/Idlefill.app -name "*.html" | wc -l
       0                                          ← bundle proof holds (step 1)
$ bash desktop/arbiter-test.sh
  (24 PASS lines: pidLine parse ×4, remote rule ×5, scratch-label install/
   death/relaunch/toggle ×8, plist shape ×5, + loaded/untouched proofs)
  ARBITER-DT-ALL-PASS
  ARBITER-DT-EXIT=0
  scratch label print rc after teardown=113 (113 = gone)
  REAL LABELS UNTOUCHED: identical before/after
$ bash desktop/edge-test.sh
  64 PASS / 0 FAIL
  EDGE-DT-ALL-PASS / EDGE-DT-EXIT=0
  EDGE-DT-DEADPORT-PASS / EDGE-DT-DEADPORT-EXIT=0
  PASS selfquit: the app quit itself on READY + the swap landed
  EDGE-DT-SELFQUIT-EXIT=1   (= the harness's success flag; RC4 path clean)
  EDGE-DT-DRIFT-PASS / EDGE-DT-DRIFT-EXIT=0
  EDGE-EXIT=0
```

## Production isolation (the point of the worktree)

The PRODUCTION arbiter (`com.sam.idlefill.server`, :8787) was never
touched: no kickstart on the real label (arbiter-test's before/after
`launchctl print` of ALL real labels is byte-identical), no port takeover
(the fixture used :11999; the real client kept :11435 — verified listening
by pid before the fixture ever started), no config writes under
`/Users/sam/Software/idlefill`. The REAL client on this machine still
registers against the REAL arbiter on :8787; this work landed on the
branch ONLY, so nothing production changes until the owner merges.
:8787 verified answering 200 at the end of the session.

## What is NOT done

- Step 4 (menubar demotion to glance + open-window) — later slice by owner
  lock; `menubar/` untouched in this task.
- The live window eyeball of the new native shell — optional per the brief
  (the harnesses + bundle proof are the gate; the owner eyeballs
  post-merge).
- Nothing was pushed; no PR; `main` untouched.

## Docs touched

- README.md — the desktop section rewritten (one surface + slim toolbar,
  the re-routed `idlefill://` host map, the retired-tab parity map), the
  gate-state surface list, and the menubar "Show Logs" handoff wording.
- DESIGN.md — the Logs Tray rule now names the third (Exception-Only)
  Client log tab.

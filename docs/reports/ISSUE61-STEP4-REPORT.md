# Issue #61 step 4 — menubar demotion: glance + open window

Branch `issue-61-step4`, 2026-10-06. The last item of the locked
migration order: the menubar stopped being a control surface. The panel
now answers one question — "is the box healthy, and is an update
waiting?" — and carries one row that opens the one window.

## What the panel is now (KEEP)

- **The state word** — the arbiter's global verdict for the box
  (`Conn.word`, color-coded): unchanged.
- **The machine status row** — always THIS machine (the payload's client
  row whose `name` equals the config's `client_name`). It shows the
  liveness posture: today's read of the row's `last_seen` inside the
  arbiter's 90s window (`stopped` when outside it), or the
  missing-token / bad-token fact, or the state word. The row is now a
  pure spec (`AppModel.glanceStatusRow`) so the harness proves exactly
  what renders — the same convention as `panelActionRows`.
- **The revision row + the exception-only `daemon behind` tag**
  (issue #49): kept. They answer "is the box healthy" — a running
  daemon predating the checkout is an exception the glance must name.
- **The exception-only sessions block** (#9): kept. The count line
  renders only while sessions exist, and the one-liners carry only the
  exception states (paused / forced / queued / stale). This matches the
  KEEP rule's own word: the glance carries `last_seen`-style liveness
  facts. `sessions-test.sh` pins that projection and stays green
  untouched.
- **The exception-only update indicator + Install Update <v>** —
  unchanged machinery, unchanged tag behavior, all update harnesses
  green.
- **One OPEN WINDOW row** — `Open Desktop` (the existing pattern, kept
  as the single nav row): `NSWorkspace.open` of `idlefill://open` with
  the app-path fallback, through the same shared helper the double-click
  router calls. It is now the FIRST row of the action block.
- **The icon arc's spin** — tied to this machine's active leases. The
  one live element of the glance. The `leases` fact feeding it stays in
  the model. The row that used to name the leases is gone, the motion
  stays.

## What retired (RETIRE), and where each capability now lives

| Retired | Now lives at |
| --- | --- |
| machine × project scope pickers (viewMachines, PickRow, selectMachine/selectProject, reproject + the picker model state) | the page's four views — "the page is the place to look at any machine" |
| per-scope stats rows: queue depth, today's finished/failed, tokens out with cap, the running-lease rows, the queue peek | the page's four views (Overview/Sessions/Projects/Usage) |
| exception-only scope controls: project pause gate, grant knobs, worker pause/force override (+ `postJSON`, `urlEncode`, `pickedProject*`, `viewMachineOverride`, `scopeWorkerControlLabel`) | the page's controls (parity proven in step 2/3) |
| `Start` / `Stop` / `Restart` panel rows | the desktop app's Settings disclosure (launchd toggles, #61 step 3) + the control CLI `scripts/idlefill-menubar.mjs` |
| `Open Dashboard` row | the single `Open Desktop` row — step 3 re-points every `idlefill://` deep link onto the page's default view anyway |
| `Show Logs` row | the same: the logs DOCK is not a hashable view, so a second nav row could only land where `Open Desktop` already lands |
| `restart()` (the function) | deleted with its last caller — `updateCode()` drives `stop()`/`start()` directly, and the Settings disclosure drives launchd |
| the `stale (N min)` status branch + `lastSeenS` | dead under the pinned scope: with the glance always this machine, an out-of-window row IS `stopped` — the branch could never fire |

## Keep/RETIRE calls made against the default (with reasons)

1. **Kept the revision row, the `daemon behind` tag, and the sessions
   glance.** They appear in neither the brief's KEEP list nor its
   RETIRE list. They are read-only exception displays, not controls,
   and they feed the glance's one question. `sessions-test.sh` and
   `staleness-test.sh` pin both paths, and the task pins those
   harnesses green untouched — deleting the rows would have contradicted
   the harness rule.
2. **Kept `start()`/`stop()`/`daemonPIDs()` in the model.** The brief
   retires the panel ROWS, not the daemon machinery: `updateCode()`'s
   stop/start steps (proven by `uc-update-test.sh`) still drive them.
3. **Retired `restart()` outright** rather than keeping it unused —
   the step-3 precedent deleted retired panels with zero call sites,
   and an unreachable control path in a glance app is drift bait.
4. **Retired the `stale (N min)` branch.** See the table row above.
   `lastSeenS` retired with it (its only reader was that branch).
5. **Added one pure spec, `AppModel.glanceStatusRow`.** The task
   requires panel-test.sh to prove "the glance block renders". The
   repo's convention for that proof is a pure spec the view renders
   (`panelActionRows`/`desktopRowTag`), so the status-row branches moved
   into one, and the view now calls it.
6. **`clientPkgDir` stays.** Its `Show Logs`-fallback reader retired,
   but `daemonCommand()` (the kept start path) reads the same path —
   no orphan.

## What stayed structurally, and why

`ScopeView` + all its row structs stay as the projection the model
consumes on every poll. The pickers retired, so `apply()` pins the
projection to its DEFAULT selection (`unsetMachineKey` → the
name-matched "this machine" row, `allProjectsKey` aggregate). The
sessions block, the lease set, and the `daemon behind` comparison all
read that pinned projection. `sessions-test.sh` and `staleness-test.sh`
drive the same read sites and pass against the demoted source unchanged.
Swift source: 3,522 → 3,118 lines (−404).

## Harness deltas (the repo rule: harnesses retire or update WITH the code they pin)

- **`panel-test.sh` — rewritten to the demoted row set.** Old: 40
  assertions (row set + tag, cadence-pure, cadence-config, launch-log).
  New: 56 assertions, regrouped. Group 1 proves the demoted row set:
  Open Desktop present, Install Update exception-only, the retired
  nav/control rows asserted ABSENT, Update Code/Quit still absent,
  exact-list equality guards against creep. Group 2 proves the Open
  Desktop tag behavior IDENTICAL to before (verbatim value, nil means
  no tag). Group 3 is NEW: the glance status-row spec — token branches
  first, out-of-window means stopped, in-window means the state word.
  Group 4 keeps the cadence and launch-clamp-note assertions unchanged.
- **`scope-test.sh` — DELETED** (the picker + controls + stats it
  pinned retired). Call-site grep before deleting: zero hits in
  `.gitea/workflows/`, zero in any script/config. The only mentions
  were header comments in sibling harnesses. CI runs no menubar
  harness at all. `.gitea/workflows/test.yml` only runs
  `swiftc -parse menubar/IdlefillMenubar.swift` (the parse gate, still
  green) and `edge.yml` builds artifacts. Both keep working.
- **`sessions-test.sh` / `staleness-test.sh` — kept and green, per the
  task ("leave them alone — deleting them is a separate owner call").**
  The only touch is two header COMMENT lines that pointed at the now-
  deleted `scope-test.sh` as the pattern reference (stale pointers are
  the repo's named convention break). All their assertions are
  unchanged: SESSIONS 44 PASS, STALENESS 13 PASS.
- **`uc-test.sh` / `uc-update-test.sh` / `install-test.sh` /
  `edge-test.sh` — run against the demoted source, unchanged.** The
  update machinery was untouched by the demotion. One honest note in
  the gate section below about `uc-update-test.sh`.

## Gates (actual output, pasted)

Gate 1 — the CI parse gate:

```
GATE1 swiftc -parse:
GATE1-RC=0
```

Gates 2–6 — every menubar harness + the real build, one sequential
run. Each line is the harness RC plus its own marker lines, pasted
verbatim:

```
GATE2 panel-test:
GATE2-RC=0 tail: PANEL-ALL-PASS PANEL-EXIT=0
GATE3a uc-test:
GATE3a-RC=0 tail: UC-ALL-PASS UC-EXIT=0
GATE3b uc-update-test:
GATE3b-RC=1 tail: FAIL daemon-PIDs: exactly the production pair ([12238, 12403, 12444, 24743, 24829]) UC11-FAILURES 1 UC11-EXIT=1
GATE3c install-test:
GATE3c-RC=0 tail: INSTALL-TEST-ALL-PASS
GATE3d edge-test:
GATE3d-RC=0 tail: EDGE-MB-ALL-PASS EDGE-MB-EXIT=0 EDGE-MB-DEADPORT-EXIT=0
GATE4 build.sh:
GATE4-RC=0 tail: run it with: open .../IdlefillMenubar.app ... version check: .../IdlefillMenubar --version
GATE5 sessions-test:
GATE5-RC=0 tail: SESSIONS-ALL-PASS SESSIONS-EXIT=0
GATE6 staleness-test:
GATE6-RC=0 tail: STALENESS-ALL-PASS STALENESS-EXIT=0
```

PASS/FAIL counts from the same run: panel-test 56/0, uc-test 28/0,
uc-update-test 63/1 (the one FAIL is the environmental pin below),
install-test 20/0, edge-test 48/0, sessions-test 44/0, staleness-test
13/0.

Gate 3b is the honest exception, and it is environmental — proven, not
assumed. `uc-update-test.sh` pins `AppModel.daemonPIDs()` to return
EXACTLY the production client daemon's process pair. That pin reads the
live process table, and this host carries extra client processes (a
launchd-managed agent plus leftover harness daemons — PIDs
12238/12403/12444, older than either worktree). The SAME script fails
with EXACTLY the same line on the UNMODIFIED main tree
(`/Users/sam/Software/idlefill`, commit `803c0c4`):

```
BASE(main tree) RC=1
63
FAIL daemon-PIDs: exactly the production pair ([12238, 12403, 12444, 24743, 24829])
```

Both runs report the identical five-PID set. `daemonPIDs()` in this
branch is byte-identical to main (diffed). Its 63 other assertions pass
against the demoted source. The failure is a host-state pin, not this
slice. It clears when the extra daemons stop.

Gate 4 addendum — the built bundle is real and version-baked:

```
$ menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar --version
idlefill-menubar 2
$ codesign -dv menubar/IdlefillMenubar.app
Identifier=com.sam.idlefill.menubar  (Signature=adhoc)
```

Gate 5 (zero TS touched) — `git show --stat` on both commits: every
path is `menubar/**` or one of the allowed docs.

## Where the docs moved

- `README.md` "The menu bar app (macOS)": the section lead re-written to
  the demoted shape. The Handoff-rows bullet became a
  Retired-by-the-demotion bullet that names where each capability now
  lives. The **Scope (machine × project)** bullet became a **Config**
  bullet (the config facts kept, the scope machinery retired with
  pointers). The daemon-control bullet now says the paths stay for the
  update machinery but the panel no longer exposes them. The desktop
  section's "its re-routed rows" line now names the one
  `Open Desktop` row.
- `DESIGN.md`: **no edit needed** — checked every menu/click/scope/picker
  mention. DESIGN.md describes the arbiter-served PAGE only. It contains
  no menubar control list and no click-routing note, and its
  Exception-Only rule and tag vocabulary still hold for the demoted
  panel. Editing it would have invented a contradiction.
- This report + one index line in `docs/reports/README.md` + one step 4
  status line in `docs/reports/ISSUE61-BRIEF.md`.

## Live install — not in this slice

`menubar/install.sh` was NOT run. The live menubar app and its launchd
label (`com.sam.idlefill.menubar`) are untouched — the owner installs
the demoted build through the release/update path. Acceptance for this
slice is headless: the harness suite + `menubar/build.sh` (the real
bundle compiled, version-baked, ad-hoc signed, `--version` answering
`idlefill-menubar 2`). The owner's live eyeball of the demoted popover
follows the merge, as with the step-3 desktop window.

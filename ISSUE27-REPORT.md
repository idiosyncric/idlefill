# Issue #27 — menu bar panel rework (report)

Branch `issue-27-menubar-panel` (base main tip `35bc472`). Commits:

- `406b693` menubar: the panel rework — Open Desktop row (shared
  openDesktopApp helper + exception-only update tag), Update Code/Quit
  rows removed, update_check_minutes cadence (issue #27)
- `05ef486` docs: the shipped panel, update_check_minutes config docs,
  example config carries the full update surface

## What changed

### `menubar/IdlefillMenubar.swift`

1. **`Open Desktop` row (always-on).** The action block now renders a
   pure spec — `AppModel.panelActionRows(updateAvailable:daemonRunning:)`
   — and `ContentView` iterates it, so the headless harness asserts the
   exact list the panel draws. Row set:
   `Open Dashboard · Show Logs · Start/Stop · Restart · Open Desktop ·
   Install Update <v>` (exception-only). The `Open Desktop` action is
   `MenuBarAppState.openDesktopApp()` — the ONE shared helper
   (`idlefill://open` → fallback `open /Applications/Idlefill.app`) that
   the double-click router (`AppDelegate.statusItemClicked`) now also
   calls, so row and router cannot drift. `MenuBarRouter` itself is
   unchanged.
2. **Exception-only right-half indicator.** `AppModel.desktopRowTag`
   (pure): `updateAvailable` VERBATIM (`1`, `0.0.2`,
   `edge-main-a9787a7`) in the panel's tag color (`Pal.warn` — the
   exception color the paused/budget tags use); nil → NO tag (label-only
   row). `actionRow` gained a `tag:` render option (the PickRow
   pattern).
3. **`Update Code` + `Quit` rows removed** — the `actionRow("Update
   Code")` / `actionRow("Quit")` calls and their switch cases
   (`m.updateCode()`, `NSApplication.shared.terminate`). Machinery
   untouched: `updateCode()`, `UpdatePlan`, the `deployedRevision` row,
   the log-append behavior, `uc-update-test.sh` all stay (no dead-code
   deletion).
4. **`update_check_minutes`.** `ClientConfig` gains
   `updateCheckMinutes: Int` (+ `updateCheckClampedFrom: Int?` carrier),
   parsed once at launch with the standing discipline. Pure
   `UpdateCheck.resolveCadence(raw)`: absent/empty/non-numeric/
   non-integer/JSON-bool → 360; below 5 → 5 + `clampedFrom`. The
   repeating timer schedules from `config.updateCheckMinutes * 60`
   (no live re-read). A clamped value logs ONE line at launch to
   `logs/idlefill-menubar.log` via `UpdateLog.append` (never the panel).
   `UpdateCheck.cadenceSeconds` is replaced by
   `cadenceMinutesDefault`/`cadenceMinutesMin` (no refs left anywhere).
5. **Header comment block** updated (actions summary + the shared-helper
   note).

### `menubar/panel-test.sh` (new harness)

Same pattern as `scope-test.sh`: real source minus `@main` + a driver,
`swiftc -O`, run under `env -i PATH=/usr/bin:/bin` with
`IDLEFILL_CONFIG_FILE` at a scratch repo and `IDLEFILL_UPDATE_BASE` at a
dead port. Asserts: the action-block row set (Open Desktop present, no
Update Code, no Quit, always-on rows intact, Start/Stop flip,
Install Update exception-only); the tag (verbatim for release number /
legacy semver / edge marker; nil → no tag; tag rides the Open Desktop
row in the spec); `resolveCadence` + `ClientConfig.load` (absent → 360,
set → value, floor 5 passes, below-5 → 5 + carrier, string/bool/
non-integer → 360); and a REAL `AppModel()` launch with
`update_check_minutes: 1` writing the clamp note exactly once to the
menubar log (a no-clamp launch writes nothing).

### Docs

- **README** "The menu bar app (macOS)": panel row list rewritten to the
  new block; new **Open Desktop row** bullet (shared helper, verbatim
  tag, Exception-Only rule, rows-gone + exit-path note, `panel-test.sh`
  pointer); Update-check bullet now says "every `update_check_minutes`"
  with a **Cadence (configurable)** note (default 360, floor 5, clamp
  logged once at launch, read once at launch); the **Update Code**
  bullet keeps its full behavior description with a lead-in noting the
  panel row is gone and the machinery stays tested; Scope bullet lists
  the full `ClientConfig` surface; the desktop pin paragraph's "6-hour
  automatic check" reworded to the configured cadence.
- **`client/config.example.json`**: adds `update_channel`, `update_pin`,
  `update_check_minutes` + `_docs` entries for all three (the example
  previously lacked the #26/#38 keys — the issue asked for the full
  current config surface). Verified the daemon's TS loader whitelists
  keys, so the extra keys are inert for it; JSON parses.
- **Swift header comment** (actions summary, ~lines 31–40): matches the
  shipped panel.

## Gates (actual output)

1. `swiftc -parse menubar/IdlefillMenubar.swift` →
   `PARSE CLEAN rc=0` (no output, exit 0).
2. `bash menubar/uc-test.sh` →
   ```
   PASS c: untampered zip bytes vs published hash -> match
   UC-ALL-PASS
   UC-EXIT=0
   ```
3. `bash menubar/uc-update-test.sh` →
   ```
   UC11-ALL-PASS
   UC11-EXIT=0
   ==> production daemon PIDs (after): 10361 10367
   ==> production node_modules mtime: 1790738183 -> 1790738183
   ```
   (Update Code core survives; production daemon/node_modules untouched.)
4. `bash menubar/scope-test.sh` →
   ```
   PASS b6: a decoy process quoting the entry path is NOT matched
   SCOPE-ALL-PASS
   SCOPE-EXIT=0
   ```
5. `bash menubar/panel-test.sh` (new) → 43 checks, all PASS:
   ```
   PASS launch clamp note: logged exactly once
   PASS launch clamp note: the model's cadence is the clamped 5
   PASS no-clamp launch: no clamp note in the log
   PASS no-clamp launch: cadence is the configured 45
   PANEL-ALL-PASS
   PANEL-EXIT=0
   ```
   Bonus (not in DoD): `bash menubar/edge-test.sh` →
   `EDGE-MB-DEADPORT-PASS / EDGE-MB-DEADPORT-EXIT=0` (the #26 channel
   work still green against the changed source).
6. `unset NODE_ENV && npm run test && npm run build` →
   ```
   ℹ tests 66  ℹ pass 66  ℹ fail 0   (server)
   ℹ tests 30  ℹ pass 30  ℹ fail 0   (client)
   ℹ tests 4   ℹ pass 4   ℹ fail 0   (adapter)
   TEST-RC=0
   > idlefill-server@0.1.0 build
   > tsc -p tsconfig.json
   BUILD-RC=0
   ```
7. README + header comments + `config.example.json` match the shipped
   panel (see Docs above).

## Deviations / decisions

- **Row set made pure + rendered from the spec.** The DoD asks the
  harness to "assert the action-block row set"; a driver cannot read a
  SwiftUI body, so the row list moved into `AppModel.panelActionRows`
  and `ContentView` renders THAT list (ForEach over the spec). The
  assertion is therefore on the shipped panel, not a mirror the view
  could drift from. Same argument for `desktopRowTag` (the tag the row
  renders).
- **Tag color = `Pal.warn` (amber).** DESIGN.md names amber as the
  exception/tag color (paused/budget-full/forced); an available update
  is an exception under the Exception-Only rule.
- **Invalid-value handling in `resolveCadence`**: JSON booleans box as
  NSNumber in JSONSerialization, so the resolver explicitly rejects
  bools and non-integer numbers (→ default 360) rather than coercing
  them; a string like `"45"` is not a number → default. Proven in the
  harness.
- **`config.example.json` carries `update_channel`/`update_pin` as empty
  strings** — both parsers treat empty as absent, so the example stays
  byte-equivalent to the default behavior while documenting the surface.
- No CI workflow change: `test.yml` only runs `swiftc -parse` on the
  menubar source (it never ran the harness scripts); the new harness is
  run the same way its siblings are (locally / by the reviewer).

## Tree state

`git status --short` empty after the two commits + this report commit.
Not pushed, not merged, no PR (per task rules).

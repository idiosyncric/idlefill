# Issue #23 — update paths must re-point the LaunchAgent (report)

Branch `issue-23-agent-repoint` (based on main tip `337162c`). Five commits:

| commit | what |
|---|---|
| `497a76a` | menubar: both update paths RE-POINT the LaunchAgent (the core change) |
| `e0e7cc1` | menubar: install.sh --reinstall renders BEFORE the bootout + install-test.sh |
| `b2566ed` | desktop: Settings rows show the running executable + exception-only stale marker + --drift harness |
| `741207f` | menubar: uc-update-test.sh (G) case + uc-test.sh release re-point + edge-test.sh call sites |
| `0d8be34` | docs: README (install, Update Code, Settings toggles) |

## What changed

**`menubar/IdlefillMenubar.swift`**
- `UpdatePlan.Input`: `thisIsLabelBinary` (exact compare against *this process's* binary) replaced by two facts: `labelRunsBundle` (the loaded label's `ProgramArguments.0` == this checkout's built bundle executable — the thing the update actually builds) and `labelUnderRepo` (that executable lives inside the repo being updated).
- `UpdatePlan.Step.repairAgent`: a loaded label inside this repo that is NOT on the bundle gets a repair STEP (render the committed template + bootout + bootstrap), never the old "relaunch it" note. A label outside this repo is another checkout's agent → note only, never killed or re-pointed.
- New `LaunchAgent` enum (shared by the Update Code executor and `UpdateCheck.install`): `takeOver` = kick (already on the bundle) / repair (stale inside this repo) / foreign / notLoaded / failed. `repair` renders to a **temp file**, byte-verifies, and only then bootouts + bootstraps (fail closed). `UpdateLog.appendCommand` logs every launchctl command into the update log.
- Post-take-over VERIFY (both paths): `launchctl print` must show `ProgramArguments.0` == the bundle executable; a mismatch is surfaced as a failure note, not a success.
- `UpdateCheck.install` takes `repoRoot` + `label`, performs the take-over after the sha256-verified swap, and returns `.installed` / `.notLoaded` / `.agentFailed(why)` / `.refused` (enum now `Equatable` for the harness). `installUpdate()` maps them to the panel notes (`relaunched` / `agent not loaded: run menubar/install.sh` / `agent NOT re-pointed: …`).
- Test hooks (inert in production): `IDLEFILL_MENUBAR_LABEL`, `IDLEFILL_MENUBAR_PLIST_DIR`.

**`menubar/install.sh`**
- `--reinstall` order fixed: **render → bootout → bootstrap** (was bootout → render → bootstrap, which left the agent DOWN on a render refusal).
- The render now lands via `$PLIST.render.tmp` and only `mv`s over the live plist after the byte-verify passes — a refusal cannot even corrupt the on-disk plist of a loaded agent.
- The already-loaded no-op reports drift (live binary != this checkout's built bundle → points at `--reinstall`).

**`desktop/IdlefillDesktop.swift`**
- `refreshLaunchdState()` does one `launchctl print` per label and derives loaded-ness AND the running executable from the same LOADED view (`daemonRuns` / `menubarRuns` — parsed `ProgramArguments.0`, not the on-disk plist).
- `menubarStale = menubarLoaded && (menubarRuns != menubarBundleExecutable())` — exception-only. Settings rows render `runs: <path>` under each toggle and a `stale` marker (warn color + one-line explanation) only on drift.
- `menubarBinaryPath()` (the toggle's plist target) corrected from the bare `menubar/IdlefillMenubar` to the bundle executable — matching the bundle-era build output and the committed template.

**Tests**
- `menubar/uc-update-test.sh`: stub build produces the real bundle shape; scratch repos carry the committed plist template + bundle-era `.gitignore` entries; new case **(G)** (below); pure-plan cases updated (kick vs repair vs foreign-note) + `pathUnderRepo` units.
- `menubar/uc-test.sh`: the (c) release-install case now runs with a scratch label loaded on a stale path inside the scratch repo — asserts `.installed`, `launchctl print` shows the swapped bundle executable, and the rendered plist carries it.
- `menubar/edge-test.sh`: install call sites updated for `repoRoot` (label not loaded → the notLoaded path stays exercised).
- `menubar/install-test.sh` (new): the fail-closed proof (below).
- `desktop/edge-test.sh`: new `--drift` run (below).

## Acceptance criteria → evidence

1. **Stale-label repro (Update Code)** — uc-update-test.sh case (G): scratch label `com.sam.idlefill.uc11-scratch` bootstrapped on `$T/G/work/menubar/IdlefillMenubar` (a different path INSIDE the scratch repo), Update Code with a delta:
   ```
   PASS (G) merge applied
   PASS (G) build ran (stub produced the bundle)
   PASS (G) NO relaunch-it note (the repair is a step, not a note)
   PASS (G) the take-over note (restarting menu bar with new code)
   PASS (G) log shows the bootout + bootstrap re-point
   PASS (G) the LOADED agent now runs the rebuilt bundle (launchctl print)
   PASS (G) the rendered scratch plist carries the bundle executable
   PASS (G) deployedRevision = new sha
   ```
2. **Release install on the same stale state** — uc-test.sh:
   ```
   ==> scratch label com.sam.idlefill.uc-scratch loaded on the STALE path /tmp/uc-test.MX6z3k/repo/menubar/IdlefillMenubar
   PASS c: correct sidecar -> verified + swapped in place
   PASS c: outcome is .installed (agent verified on the swapped bundle)
   PASS c: the stale label was RE-POINTED — launchctl print shows the bundle executable
   PASS c: the rendered plist (from the committed template) carries the bundle executable
   ```
3. **install.sh --reinstall end-to-end (scratch label)** — install-test.sh:
   ```
   PASS install: fresh install exits 0 / agent loaded / runs the scratch program
   PASS reinstall: clean --reinstall exits 0
   PASS reinstall: the render-first order is what ran
   PASS reinstall: agent loaded after --reinstall
   PASS reinstall: the re-bootstrapped agent runs the scratch prog
   PASS reinstall: the rendered plist ProgramArguments.0 == the expected bin
   PASS reinstall: the rendered plist Label == the scratch label
   ```
4. **--reinstall with a failing render leaves the agent RUNNING** — install-test.sh (a COPY of install.sh + a deliberately corrupted template — the Label value changed, so the render's Label byte-verify refuses):
   ```
   PASS fail-closed: --reinstall with a bad render exits non-zero
   PASS fail-closed: the refusal is the render byte-verify
   PASS fail-closed: the previously-loaded agent is STILL LOADED
   PASS fail-closed: the agent still runs the OLD program (untouched)
   PASS fail-closed: the on-disk plist still carries the old program
   PASS missing-template: --reinstall exits non-zero
   PASS missing-template: agent STILL LOADED
   ```
5. **Headless coverage in uc-update-test.sh** — the (G) case above (criterion 1 IS this one).
6. **Settings panel drift marker** — desktop/edge-test.sh `--drift` run (scratch labels via the app's own `IDLEFILL_DESKTOP_TEST` + label-override hooks):
   ```
   PASS drift: the scratch menubar label is loaded
   PASS drift: the scratch daemon label is loaded
   PASS drift: the row shows the menubar agent's ACTUAL running path (the stale one)
   PASS drift: the row shows the daemon agent's actual running path
   PASS drift: the stale marker is ON (exception fires on drift)
   PASS drift: the expected bundle path is this checkout's built bundle executable
   PASS drift: after the re-point the agent runs the bundle executable
   PASS drift: the stale marker CLEARS after the re-point
   PASS drift: healthy -> no marker (Exception-Only rule)
   ```
   Live GUI eyeball: owner's step — checklist at the bottom.

## Definition-of-done gates (actual output)

1. Parse gates:
   ```
   swiftc -parse menubar/IdlefillMenubar.swift  -> MENUBAR-PARSE-OK
   swiftc -parse desktop/IdlefillDesktop.swift  -> DESKTOP-PARSE-OK
   bash -n menubar/install.sh                   -> INSTALL-SH-OK
   bash -n menubar/install-test.sh              -> INSTALL-TEST-SH-OK
   ```
2. `bash menubar/uc-update-test.sh` → `UC11-ALL-PASS` / `UC11-EXIT=0` (57 PASS lines incl. the (G) case; tail shown above).
3. `bash menubar/uc-test.sh` → `UC-ALL-PASS` / `UC-EXIT=0` (21 PASS incl. the re-point assertions).
   `bash menubar/scope-test.sh` → `SCOPE-ALL-PASS` / `SCOPE-EXIT=0`.
   `bash menubar/panel-test.sh` → `PANEL-ALL-PASS` / `PANEL-EXIT=0` (green — untouched by the plan change; it drives `panelActionRows`/`desktopRowTag`, not `UpdatePlan.Input`).
   `bash menubar/edge-test.sh` → `EDGE-MB-ALL-PASS` + `EDGE-MB-DEADPORT-PASS` (both EXIT=0).
4. `bash menubar/install-test.sh` → `INSTALL-TEST-ALL-PASS` (20 PASS, tail above).
5. `bash desktop/edge-test.sh` → `EDGE-DT-ALL-PASS` + `EDGE-DT-DEADPORT-PASS` + `EDGE-DT-DRIFT-PASS` (all EXIT=0; the harness then proves both scratch labels are booted out).
6. `unset NODE_ENV && npm run test` → server 66/66, client 30/30, adapter 4/4, `TEST-RC=0`. `npm run build` → `BUILD-RC=0`.
7. README updated (install bullet, Update Code launchd step, release-install description, Settings drift-marker bullet).
8. Production untouched — see below.

## Production-untouched proof

Before every harness run and after all of them:

- `launchctl print gui/501/com.sam.idlefill.menubar` → rc 0 before and after; the two dumps (`/tmp/pre-menubar.txt` 94 lines, `/tmp/post-menubar.txt` 94 lines) are **byte-identical** (`diff` clean → `MENUBAR-PRINT-IDENTICAL`). Still `state = running`, `pid = 80999`, `arguments = { /Users/sam/Software/idlefill/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar }`.
- `launchctl print gui/501/com.sam.idlefill.client` → rc 0 before and after; dumps **byte-identical** (`CLIENT-PRINT-IDENTICAL`).
- Daemon PIDs `10361` + `10367` identical before/after (`PIDS-IDENTICAL`); the uc-update-test harness itself also asserts the production pair and the main-checkout `node_modules` mtime unchanged (`1790738183 -> 1790738183`).
- Every launchd write in every harness used scratch labels (`com.sam.idlefill.uc11-scratch`, `com.sam.idlefill.uc-scratch`, `com.sam.idlefill.install-test`, `com.sam.idlefill.dt-drift-mb`, `com.sam.idlefill.dt-drift-daemon`) with plists in scratch dirs; each harness boots them out (EXIT trap + explicit proof they are gone). No scratch agent or residual process remains.
- `/Applications/Idlefill.app` and the main checkout were never touched (the drift fixtures live under `$T`; the desktop edge-swap target stays the scratch bundle via `IDLEFILL_DESKTOP_EDGE_TARGET`).

## Deviations (with rationale)

- **`UpdateCheck.Outcome` made `Equatable`.** The uc-test.sh re-point assertion compares `o1 == .installed`; Swift requires the conformance. All cases carry only `String` payloads — synthesis is trivial. No behavior change.
- **install.sh render goes through a temp file** (`$PLIST.render.tmp` → verified → `mv`). The task only required render-before-bootout; the temp-file step additionally prevents a *refused* render from corrupting the on-disk plist of a loaded agent (the fail-closed rule taken to its end). Proven by the "on-disk plist still carries the old program" check.
- **install-test.sh corrupts a COPY of the template** (Label value → `com.sam.idlefill.WRONG`) rather than the ProgramArguments entry: the PROG substitution rewrites the template's binary line regardless, so a corrupted bin line would still render "correctly"; the Label substitution is the honest, deterministic render-failure lever.
- **The desktop plist target moved to the bundle executable** (`menubarBinaryPath()` → `menubarBundleExecutable()`). The README already described the bare path (pre-bundle era); the drift marker's healthy-state compare only makes sense against what `menubar/build.sh` + the committed template actually produce. This also fixes the Settings toggle writing a plist that points at a non-bundle path.
- **uc-update-test.sh scratch `.gitignore` gained `menubar/IdlefillMenubar` + `menubar/IdlefillMenubar.app/`** — mirroring the real repo (the pitfall note: scratch `.gitignore` must mirror the real one), otherwise the (G) case's stale binary / rebuilt bundle would make the scratch tree look dirty and gate (a) would refuse.
- **`desktop/edge-test.sh` boots the drift scratch labels out explicitly before the gone-proof** (the EXIT trap repeats it): launchd's bootout is synchronous but the trap only fires at script exit, and the proof runs mid-script.

## Owner eyeball checklist (Settings drift marker, live GUI)

1. Build + run the desktop app (`desktop/build.sh`, `open desktop/Idlefill.app`), open **Settings**.
2. Healthy state: the **menu bar** toggle shows `runs: /Users/sam/Software/idlefill/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar` and **no** `stale` marker.
3. Create drift: `launchctl bootout gui/$(id -u)/com.sam.idlefill.menubar`, bootstrap a plist pointing at any other executable (e.g. `/bin/sleep 3600`), wait ≤5s.
4. The row now shows `runs: /bin/sleep` + the amber **stale** marker with the one-line explanation. The daemon row is unaffected.
5. Clear it: `bash menubar/install.sh --reinstall` (or Update Code / Install Update from the menu bar app). Within 5s the marker disappears and `runs:` shows the bundle path again.
6. Toggle **menu bar** OFF then ON: the toggle's own plist now points at the bundle executable (the corrected target) — the row comes back healthy, no marker.

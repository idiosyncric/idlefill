#!/usr/bin/env bash
# Headless test for the menubar panel (issue #27 rows, demoted by issue
# #61 step 4): compile the REAL source (minus @main) + a driver, run under
# env -i (the GUI environment) — the same harness pattern as uc-test.sh.
#
# What is proven:
#   1. The action block's ROW SET (AppModel.panelActionRows — the pure
#      spec ContentView renders, so the assertions are on what ships):
#      the DEMOTED panel — Open Desktop (the ONE nav row) present;
#      Install Update <v> stays exception-only; the RETIRED rows are
#      ABSENT (Open Dashboard, Show Logs, Start, Stop, Restart, plus the
#      pre-#27 Update Code / Quit).
#   2. The Open Desktop row's exception-only indicator (desktopRowTag):
#      a canned updateAvailable -> the tag carries the value VERBATIM
#      (a release number, a legacy semver, an edge marker); nil -> NO tag
#      (label-only row — DESIGN.md Exception-Only rule). UNCHANGED by the
#      demotion (the brief's acceptance: tag behavior identical).
#   3. The glance block's STATUS ROW (AppModel.glanceStatusRow — the pure
#      spec the glance renders): token branches first (no token / bad
#      token name the config path), out-of-window liveness -> "stopped",
#      in-window -> the arbiter's state word. The demoted glance is
#      always THIS machine — no picker, no scope label.
#   4. update_check_minutes (ClientConfig + UpdateCheck.resolveCadence):
#      absent -> 360; set -> that value; below 5 -> 5 AND the clamp logged
#      ONCE at launch to <repo>/logs/idlefill-menubar.log (a real AppModel()
#      launch under env -i writes the note); invalid (string / bool /
#      non-integer) -> 360.
#
# Nothing networked, nothing real is touched: the scratch repo's config
# points the update base at a dead port (IDLEFILL_UPDATE_BASE hook) and the
# server_url at a closed loopback port — the check fails quiet offline.
set -euo pipefail
T="$(mktemp -d /tmp/panel-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_CONFIG_FILE points here) -----------------------
mkdir -p "$T/repo/client"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "0.1.0" }
EOF

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'static func panelActionRows' "$T/menubar-under-test.swift" || { echo "error: panelActionRows lost in the strip"; exit 1; }
grep -q 'static func glanceStatusRow' "$T/menubar-under-test.swift" || { echo "error: glanceStatusRow lost in the strip"; exit 1; }
grep -q 'struct ClientConfig' "$T/menubar-under-test.swift" || { echo "error: ClientConfig lost in the strip"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation
import SwiftUI

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}

let REPO = "__REPO__"
let cfgPath = REPO + "/client/config.json"
let logPath = REPO + "/logs/idlefill-menubar.log"

func writeCfg(_ json: String) {
  try? json.write(toFile: cfgPath, atomically: true, encoding: .utf8)
}
func loadCfg() -> ClientConfig { ClientConfig.load(path: cfgPath) }

// ==========================================================================
// (1) the action block's row set (the pure spec ContentView renders) —
//     the DEMOTED panel (#61 step 4): one nav row + the exception-only
//     update row. Every control row the window now owns must be ABSENT.
// ==========================================================================
func labels(_ rows: [AppModel.PanelActionRow]) -> [String] { rows.map(\.label) }

let rowsUp = AppModel.panelActionRows(updateAvailable: "1")
let upNames = labels(rowsUp)
check("rows(update available): Open Desktop present (the ONE nav row)",
      upNames.first(where: { $0 == "Open Desktop" }) != nil)
check("rows(update available): Install Update <v> exception-only row present",
      upNames.first(where: { $0 == "Install Update 1" }) != nil)
check("rows: NO Update Code row (pre-#27, still absent)",
      upNames.first(where: { $0 == "Update Code" }) == nil)
check("rows: NO Quit row (pre-#27, still absent)",
      upNames.first(where: { $0 == "Quit" }) == nil)
check("rows: NO Open Dashboard row (#61 step 4 — every deep link lands on the default view anyway)",
      upNames.first(where: { $0 == "Open Dashboard" }) == nil)
check("rows: NO Show Logs row (#61 step 4 — the logs dock is not a hashable view)",
      upNames.first(where: { $0 == "Show Logs" }) == nil)
check("rows: NO Start row (#61 step 4 — the Settings disclosure hosts the launchd toggles)",
      upNames.first(where: { $0 == "Start" }) == nil)
check("rows: NO Stop row (#61 step 4)",
      upNames.first(where: { $0 == "Stop" }) == nil)
check("rows: NO Restart row (#61 step 4)",
      upNames.first(where: { $0 == "Restart" }) == nil)
check("rows(update available): exactly the two rows (nothing else crept in)",
      upNames == ["Open Desktop", "Install Update 1"])

let rowsIdle = AppModel.panelActionRows(updateAvailable: nil)
let idleNames = labels(rowsIdle)
check("rows(no update): Open Desktop is always-on",
      idleNames.first(where: { $0 == "Open Desktop" }) != nil)
check("rows: NO Install Update row while no update is available",
      idleNames.first(where: { $0.hasPrefix("Install Update") }) == nil)
check("rows(no update): exactly the one nav row",
      idleNames == ["Open Desktop"])
check("rows: still no control rows in the no-update state",
      idleNames.first(where: { $0 == "Start" || $0 == "Stop" || $0 == "Restart"
                             || $0 == "Open Dashboard" || $0 == "Show Logs" }) == nil)

// ==========================================================================
// (2) the Open Desktop row's exception-only indicator (UNCHANGED by the
//     demotion)
// ==========================================================================
func tagText(_ t: (text: String, color: Color)?) -> String? { t?.text }
check("tag: release number verbatim", tagText(AppModel.desktopRowTag(updateAvailable: "1")) == "1")
check("tag: legacy semver verbatim", tagText(AppModel.desktopRowTag(updateAvailable: "0.0.2")) == "0.0.2")
check("tag: edge marker verbatim",
      tagText(AppModel.desktopRowTag(updateAvailable: "edge-main-a9787a7")) == "edge-main-a9787a7")
check("tag: nil update -> NO tag (label-only row)", AppModel.desktopRowTag(updateAvailable: nil) == nil)

// The tag rides the Open Desktop row in the spec (right half), and the row
// carries it for every canned updateAvailable value.
for v in ["1", "0.0.2", "edge-main-a9787a7"] {
  let r = AppModel.panelActionRows(updateAvailable: v)
      .first(where: { $0.label == "Open Desktop" })
  check("spec: Open Desktop tag carries \(v) verbatim", r?.tag != nil && tagText(r?.tag) == v)
}
let noUpRow = AppModel.panelActionRows(updateAvailable: nil)
    .first(where: { $0.label == "Open Desktop" })
check("spec: Open Desktop row has NO tag when up to date", noUpRow?.tag == nil)

// ==========================================================================
// (3) the glance block's STATUS ROW (the pure spec the glance renders).
//     Always THIS machine — the branches carry the token facts, the 90s
//     liveness verdict, and the arbiter's state word. No scope label:
//     the picker retired with the control surface.
// ==========================================================================
let cp = "/r/client/config.json"
check("glance: no token -> names the missing token + the config path",
      AppModel.glanceStatusRow(conn: .noToken, daemonRunning: false, configPath: cp)
        == "no token — set the arbiter token in \(cp)")
check("glance: bad token -> distinct from a dead box + names the path",
      AppModel.glanceStatusRow(conn: .unauthorized, daemonRunning: true, configPath: cp)
        == "bad token — the arbiter rejected it (\(cp))")
check("glance: token branch wins over liveness (no token is never \"stopped\")",
      AppModel.glanceStatusRow(conn: .noToken, daemonRunning: false, configPath: cp) != "stopped")
check("glance: out-of-window client row -> stopped",
      AppModel.glanceStatusRow(conn: .idle, daemonRunning: false, configPath: cp) == "stopped")
for c in [Conn.idle, Conn.busy, Conn.working, Conn.degraded, Conn.unreachable] {
  check("glance: in-window -> the arbiter's word (\(c.word))",
        AppModel.glanceStatusRow(conn: c, daemonRunning: true, configPath: cp) == c.word)
}

// ==========================================================================
// (4) update_check_minutes — parse + clamp (pure + via the real config load)
// ==========================================================================
func cad(_ raw: Any?) -> (Int, Int?) {
  let r = UpdateCheck.resolveCadence(raw)
  return (r.value, r.clampedFrom)
}
check("cadence: absent -> default 360", cad(nil) == (360, nil))
check("cadence: set -> that value (45)", cad(45) == (45, nil))
check("cadence: exactly the floor (5) passes through", cad(5) == (5, nil))
check("cadence: below the floor (1) -> 5 + clamp note", cad(1) == (5, 1))
check("cadence: below the floor (0) -> 5 + clamp note", cad(0) == (5, 0))
check("cadence: negative -> 5 + clamp note", cad(-10) == (5, -10))
check("cadence: string -> default 360 (invalid)", cad("45") == (360, nil))
check("cadence: empty string -> default 360", cad("") == (360, nil))
check("cadence: bool -> default 360 (JSON bool boxes as NSNumber)", cad(true) == (360, nil))
check("cadence: non-integer number -> default 360", cad(2.5) == (360, nil))
check("cadence: large value passes (1440)", cad(1440) == (1440, nil))

// The same facts through the REAL config parse (ClientConfig.load).
writeCfg("{ \"server_url\": \"http://127.0.0.1:1\", \"client_name\": \"panel-test\" }")
check("config: absent update_check_minutes -> 360", loadCfg().updateCheckMinutes == 360)
check("config: absent -> no clamp carrier", loadCfg().updateCheckClampedFrom == nil)
writeCfg("{ \"update_check_minutes\": 45 }")
check("config: set -> 45", loadCfg().updateCheckMinutes == 45)
check("config: set -> no clamp carrier", loadCfg().updateCheckClampedFrom == nil)
writeCfg("{ \"update_check_minutes\": 1 }")
check("config: below floor -> 5", loadCfg().updateCheckMinutes == 5)
check("config: below floor -> clamp carrier = 1", loadCfg().updateCheckClampedFrom == 1)
writeCfg("{ \"update_check_minutes\": \"45\" }")
check("config: invalid (string) -> 360", loadCfg().updateCheckMinutes == 360)
writeCfg("{ \"update_check_minutes\": true }")
check("config: invalid (bool) -> 360", loadCfg().updateCheckMinutes == 360)
writeCfg("{ \"update_check_minutes\": 2.5 }")
check("config: invalid (non-integer) -> 360", loadCfg().updateCheckMinutes == 360)

// ==========================================================================
// (4b) the clamp note: a REAL AppModel() launch with a below-floor config
//      logs it ONCE to <repo>/logs/idlefill-menubar.log (the panel shows
//      nothing — the note belongs in the log).
// ==========================================================================
try? FileManager.default.removeItem(atPath: logPath)
writeCfg("{ \"server_url\": \"http://127.0.0.1:1\", \"client_name\": \"panel-test\", \"update_check_minutes\": 1 }")
let m = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(2.0))
let logText = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? ""
check("launch clamp note: written to the menubar log",
      logText.contains("update_check_minutes 1 below floor 5 — clamped to 5"))
check("launch clamp note: logged exactly once",
      logText.components(separatedBy: "update_check_minutes").count - 1 == 1)
check("launch clamp note: the model's cadence is the clamped 5", m.config.updateCheckMinutes == 5)

// A no-clamp launch appends NOTHING (the note is clamp-only).
try? FileManager.default.removeItem(atPath: logPath)
writeCfg("{ \"server_url\": \"http://127.0.0.1:1\", \"client_name\": \"panel-test\", \"update_check_minutes\": 45 }")
let m2 = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(2.0))
let logText2 = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? ""
check("no-clamp launch: no clamp note in the log", !logText2.contains("update_check_minutes"))
check("no-clamp launch: cadence is the configured 45", m2.config.updateCheckMinutes == 45)

if failures > 0 {
  print("PANEL-FAILURES \(failures)")
  exit(1)
}
print("PANEL-ALL-PASS")
exit(0)
EOF

sed -e "s|__REPO__|$T/repo|g" "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/panel-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/panel-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  "$T/panel-test" || RC=$?
echo "PANEL-EXIT=$RC"
exit $RC

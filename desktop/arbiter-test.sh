#!/usr/bin/env bash
# Headless test for the LOCAL ARBITER agent row (loaded-but-exited
# detection + kickstart relaunch) on the desktop app. Same harness shape
# as desktop/staleness-test.sh: compile the REAL source (minus @main) + a
# driver, run under env -i (the GUI environment) with a scratch repo.
#
# What is proven:
#   1. The pure parse (AppModel.pidLine): a `pid = <n>` line -> the pid;
#      an exited-but-loaded dump (state lines, NO pid line) -> nil;
#      garbage value -> nil (fail closed).
#   2. The pure refusal rule (AppModel.isArbiterRemote): loopback + no
#      server config -> local allowed; a server/config.json present ->
#      allowed regardless of server_url; remote server_url AND no config
#      -> remote (refuse).
#   3. The REAL shipped path against a SCRATCH launchd label (the
#      IDLEFILL_DESKTOP_TEST hook — never a real label):
#        setArbiter(on: true)   -> installed + loaded + running (pid),
#        kill the job's pid      -> loaded && NOT running (the exception
#                                   state that blanked the dashboard),
#        relaunchArbiter()      -> running again under the same label,
#        setArbiter(on: false)  -> booted out; a second OFF is a clean
#                                   no-op (note stays nil).
#   4. The rendered arbiter plist (non-test render fn) carries the tsx
#      entry under THIS checkout, WorkingDirectory server/, KeepAlive
#      SuccessfulExit=false, ThrottleInterval 30, NODE_ENV production —
#      and no token ever reaches it.
#   5. Production untouched: `launchctl print` of BOTH real labels
#      (com.sam.idlefill.client, com.sam.idlefill.menubar) and the real
#      server label captured before/after the run and reported identical.
set -uo pipefail
T="$(mktemp -d /tmp/arbiter-dt-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/desktop/IdlefillDesktop.swift"
VENDOR="$REPO/desktop/vendor/sparkle"
UID_NUM="$(id -u)"
DT_LABEL="com.sam.idlefill.dt-arb-test"

echo "==> workdir: $T"

# ---- pre-flight: the real labels' state, captured for the untouched proof
real_state() {
  for L in com.sam.idlefill.client com.sam.idlefill.menubar com.sam.idlefill.server; do
    launchctl print "gui/$UID_NUM/$L" >/dev/null 2>&1
    printf '%s rc=%s\n' "$L" "$?"
  done
}
BEFORE="$(real_state)"
echo "real labels before:"; echo "$BEFORE" | sed 's/^/   /'

# ---- scratch repo (client config present so the model reads a fused shape)
mkdir -p "$T/repo/server" "$T/repo/client" "$T/plists"
printf '{ "name": "idlefill-scratch", "version": "0.1.0" }\n' > "$T/repo/package.json"
printf '{ "listen": 8787 }\n' > "$T/repo/server/config.json"
printf '{ "server_url": "http://127.0.0.1:8787", "client_name": "arb-dt-test", "token": "arbiter-fixture-token" }\n' > "$T/repo/client/config.json"

# ---- compile the REAL source (minus @main) + the driver
sed '/^@main$/,/^}$/d' "$SRC" > "$T/desktop-under-test.swift"
if grep -q '@main' "$T/desktop-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'static func pidLine' "$T/desktop-under-test.swift" || { echo "error: pidLine lost in the strip"; exit 1; }
grep -q 'static func isArbiterRemote' "$T/desktop-under-test.swift" || { echo "error: isArbiterRemote lost in the strip"; exit 1; }
grep -q 'func relaunchArbiter' "$T/desktop-under-test.swift" || { echo "error: relaunchArbiter lost in the strip"; exit 1; }
# The wired surface (the visual pass is the eyeball step):
grep -q 'arbiter stopped' "$T/desktop-under-test.swift" || { echo "error: the dashboard marker is not wired"; exit 1; }
grep -q 'loaded but not running' "$T/desktop-under-test.swift" || { echo "error: the Settings exception row is not wired"; exit 1; }
grep -q '"com.sam.idlefill.server"' "$T/desktop-under-test.swift" || { echo "error: the server label is missing"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}
func pump(_ secs: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(secs)) }

// ==========================================================================
// (1) the pure pid-line parse (the shape `launchctl print` prints)
// ==========================================================================
let runningDump = """
service = com.sam.idlefill.server
\tstate = running
\tpid = 83174
\t\tstate = active
job state = running
"""
let exitedDump = """
service = com.sam.idlefill.server
\tstate = not running
\tlast exit code = 0
\t\tstate = active
job state = exited
"""
check("pidLine: running dump -> the pid", AppModel.pidLine(runningDump) == 83174)
check("pidLine: exited-but-loaded dump -> nil (the blank-dashboard shape)", AppModel.pidLine(exitedDump) == nil)
check("pidLine: garbage value -> nil (fail closed)", AppModel.pidLine("\tpid = -2\n") == nil)
check("pidLine: empty dump -> nil", AppModel.pidLine("") == nil)

// ==========================================================================
// (2) the pure remote-refusal rule
// ==========================================================================
check("remote: loopback + no server config -> local allowed",
      !AppModel.isArbiterRemote(clientServerURL: "http://127.0.0.1:8787", hasServerConfig: false))
check("remote: localhost host -> allowed",
      !AppModel.isArbiterRemote(clientServerURL: "http://localhost:8787", hasServerConfig: false))
check("remote: server config present -> allowed regardless of server_url",
      !AppModel.isArbiterRemote(clientServerURL: "http://100.105.225.1:8787", hasServerConfig: true))
check("remote: remote server_url AND no config -> remote (refuse)",
      AppModel.isArbiterRemote(clientServerURL: "http://100.105.225.1:8787", hasServerConfig: false))
check("remote: unparseable url -> remote (refuse, fail closed)",
      AppModel.isArbiterRemote(clientServerURL: "not a url", hasServerConfig: false))

// ==========================================================================
// (3) the shipped path end-to-end against a SCRATCH label
// ==========================================================================
let m = AppModel()
pump(0.3)
check("start: scratch label not loaded", !m.arbiterLoaded && !m.arbiterRunning)

m.setArbiter(on: true)
check("install: toggle ON bootstraps the scratch label (loaded)", m.arbiterLoaded)
pump(0.8)  // RunAtLoad starts the job async; the pid line appears within ~ms
m.refreshLaunchdState()
check("install: job running (pid line present)", m.arbiterRunning && (m.arbiterPid() ?? 0) > 0)

let pid0 = m.arbiterPid() ?? 0
kill(Int32(pid0), SIGTERM)   // the incident: the job exits, KeepAlive rules decide nothing here
pump(0.8)
m.refreshLaunchdState()
check("death: STILL loaded (the plain loaded-check would read healthy)", m.arbiterLoaded)
check("death: NOT running -> the exception state fires", !m.arbiterRunning && m.arbiterPid() == nil)

m.relaunchArbiter()          // kickstart, no -k: start the exited job under the same label
pump(0.8)
m.refreshLaunchdState()
let pid1 = m.arbiterPid() ?? 0
check("relaunch: running again (new pid, same label)", m.arbiterRunning && pid1 > 0 && pid1 != pid0)
check("relaunch: no error note", m.arbiterNote == nil)

m.setArbiter(on: false)      // bootout
pump(0.3)
check("toggle OFF boots the job out", !m.arbiterLoaded && !m.arbiterRunning)
m.setArbiter(on: false)      // double-OFF = clean no-op
check("double-OFF: clean no-op, no note", !m.arbiterLoaded && m.arbiterNote == nil)

// ==========================================================================
// (4) the rendered non-test plist (shape only — label is the scratch one)
// ==========================================================================
let xml = m.arbiterPlistXML()
check("plist: runs tsx on this checkout's server entry",
      xml.contains("server/src/index.ts") && xml.contains("<string>tsx</string>"))
check("plist: WorkingDirectory is server/", xml.contains("<key>WorkingDirectory</key>"))
check("plist: KeepAlive SuccessfulExit=false (mirrors the shipped template)", xml.contains("SuccessfulExit"))
check("plist: ThrottleInterval 30", xml.contains("<key>ThrottleInterval</key>"))
check("plist: NODE_ENV production (mirrors the shipped template)", xml.contains("NODE_ENV"))
check("plist: NO token ever rendered", !xml.contains("arbiter-fixture-token"))

if failures > 0 {
  print("ARBITER-DT-FAILURES \(failures)")
  exit(1)
}
print("ARBITER-DT-ALL-PASS")
exit(0)
EOF

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/arbiter-dt-test" \
  "$T/desktop-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI \
  -F "$VENDOR" -framework Sparkle \
  -Xlinker -rpath -Xlinker "@loader_path/Frameworks" 2>&1 | grep -E "error:" || true
[ -x "$T/arbiter-dt-test" ] || { echo "error: driver did not build"; rm -rf "$T"; exit 1; }

mkdir -p "$T/Frameworks"
ln -s "$VENDOR/Sparkle.framework" "$T/Frameworks/Sparkle.framework"

echo "==> run (env -i = the GUI environment; scratch label + scratch plist dir)"
RC=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_REPO_PATH="$T/repo" \
  IDLEFILL_DESKTOP_TEST="$T/plists" \
  IDLEFILL_DESKTOP_TEST_LABEL_ARBITER="$DT_LABEL" \
  "$T/arbiter-dt-test" || RC=$?
echo "ARBITER-DT-EXIT=$RC"

# ---- teardown proof: scratch label gone, real labels untouched
launchctl bootout "gui/$UID_NUM/$DT_LABEL" 2>/dev/null || true
launchctl print "gui/$UID_NUM/$DT_LABEL" >/dev/null 2>&1
echo "scratch label print rc after teardown=$? (113 = gone)"
AFTER="$(real_state)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "REAL LABELS UNTOUCHED: identical before/after"
else
  echo "REAL LABELS CHANGED — before:"; echo "$BEFORE"
  echo "after:"; echo "$AFTER"
  RC=$((RC + 1))
fi
# No residual sleep job from the scratch label
pgrep -x sleep >/dev/null && echo "note: a /bin/sleep process exists (check it is not ours)"
rm -rf "$T"
exit $RC

#!/usr/bin/env bash
# Gate 5 (issue #70): live acceptance, headless, additive-only.
#
# Proof channels (all from the app's own stderr — the app carries a
# proof log line set, no UI is needed):
#   PAGE_LOAD Finished                — the window loaded the scratch origin
#   LAUNCHD arbiter loaded=1 running=1 — pid-line liveness, live edge
#   LAUNCHD arbiter loaded=1 running=0 — pid-line liveness, dead edge
#   AUTO_RELOAD                       — exactly one line per dead->live edge
#
# Fences (the brief, gate 5): the scratch arbiter runs on a SCRATCH PORT
# under a SCRATCH launchd label with a scratch state file + scratch
# api_tokens (IDLEFILL_CONFIG env on the scratch job). The production
# arbiter (port 8787, com.sam.idlefill.server) is NEVER kickstarted and
# NEVER touched. The app reads a SCRATCH config copy via
# IDLEFILL_REPO_PATH; the real client/config.json is never edited (md5
# before/after). The app watches the SCRATCH arbiter label via the app's
# own test hook (IDLEFILL_TAURI_TEST + IDLEFILL_TAURI_TEST_LABEL_ARBITER).
# The app runs the BUILT BUNDLE's binary directly — no LaunchAgent
# install, no idlefill:// registration.
set -uo pipefail
T="$(mktemp -d /tmp/tauri-acceptance.XXXXXX)"
REPO="/Users/sam/Software/idlefill"
BIN="$REPO/tauri/src-tauri/target/release/bundle/macos/Idlefill.app/Contents/MacOS/idlefill-app"
UID_NUM="$(id -u)"
PORT=18790
LABEL="com.sam.idlefill.app70test.server"
SCRATCH_TOKEN="$(openssl rand -hex 16)"
failures=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else failures=$((failures+1)); echo "FAIL $name"; fi
}

APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

MD5_BEFORE="$(md5 -q "$REPO/client/config.json")"

arbiter_pid() { launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'; }

# ---- scratch client config (copy shape, NEVER the real file) ------------
mkdir -p "$T/scratch-repo/client"
python3 - "$T/scratch-repo/client/config.json" "$PORT" "$SCRATCH_TOKEN" <<'PY'
import json, sys
path, port, tok = sys.argv[1], int(sys.argv[2]), sys.argv[3]
json.dump({"server_url": f"http://127.0.0.1:{port}/", "token": tok,
           "client_name": "acceptance70"}, open(path, "w"))
PY

# ---- scratch arbiter under a SCRATCH launchd label ----------------------
# Same shape the app renders (KeepAlive SuccessfulExit=false +
# ThrottleInterval 30): a kill produces a REAL launchd dead->live edge.
# IDLEFILL_CONFIG gives it a scratch port + scratch tokens + scratch state.
mkdir -p "$T/arbiter-logs"
cat > "$T/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>$REPO/server/src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO/server</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>IDLEFILL_CONFIG</key>
        <string>{"listen": $PORT, "api_tokens": ["$SCRATCH_TOKEN"], "state_file": "$T/scratch-state.json", "projects": []}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$T/arbiter-logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$T/arbiter-logs/launchd.err.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$UID_NUM" "$T/$LABEL.plist" || { echo "FAIL: scratch arbiter bootstrap"; exit 1; }

# Wait for the scratch arbiter to listen.
for _ in $(seq 1 40); do lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 1; done
check "scratch arbiter listens on $PORT" lsof -nP -iTCP:$PORT -sTCP:LISTEN
check "scratch arbiter answers /api/state with the scratch token" \
  curl -sf -H "Authorization: Bearer $SCRATCH_TOKEN" "http://127.0.0.1:$PORT/api/state"

# ---- run the built app against the scratch repo + scratch label ---------
IDLEFILL_REPO_PATH="$T/scratch-repo" \
IDLEFILL_TAURI_TEST="$T" \
IDLEFILL_TAURI_TEST_LABEL_ARBITER="$LABEL" \
"$BIN" > "$T/app.log" 2>&1 &
APP_PID=$!
sleep 10   # window up + first tick + first PAGE_LOAD + first LAUNCHD edge

# ---- (1) page-load proof ------------------------------------------------
check "PAGE_LOAD Finished on the scratch origin" grep -q "PAGE_LOAD Finished http://127.0.0.1:$PORT" "$T/app.log"

# ---- (2) pid-line liveness: live edge (loaded=1 running=1) --------------
check "LAUNCHD edge loaded=1 running=1" grep -q "LAUNCHD arbiter loaded=1 running=1" "$T/app.log"

# ---- (3) edge 1: kill the scratch arbiter, wait for the tick to see it
# ---- dead, wait for launchd's restart (ThrottleInterval 30) to land.
p1="$(arbiter_pid)"; [ -n "$p1" ] && kill -9 "$p1"
for _ in $(seq 1 10); do grep -q "LAUNCHD arbiter loaded=1 running=0" "$T/app.log" && break; sleep 2; done
check "LAUNCHD edge running=0 (dead edge seen)" grep -q "LAUNCHD arbiter loaded=1 running=0" "$T/app.log"
for _ in $(seq 1 40); do [ -n "$(arbiter_pid)" ] && break; sleep 2; done
for _ in $(seq 1 10); do grep -q "AUTO_RELOAD" "$T/app.log" && break; sleep 2; done

# ---- (4) edge 2: kill again, same wait, second AUTO_RELOAD --------------
p2="$(arbiter_pid)"; [ -n "$p2" ] && kill -9 "$p2"
for _ in $(seq 1 40); do [ -n "$(arbiter_pid)" ] && break; sleep 2; done
for _ in $(seq 1 15); do [ "$(grep -c AUTO_RELOAD "$T/app.log")" -ge 2 ] && break; sleep 2; done

# ---- (5) exactly one AUTO_RELOAD per edge --------------------------------
n="$(grep -c AUTO_RELOAD "$T/app.log")"
check "AUTO_RELOAD fired exactly twice for two edges (got $n)" test "$n" -eq 2

# ---- (6) production untouched -------------------------------------------
MD5_AFTER="$(md5 -q "$REPO/client/config.json")"
check "real client/config.json byte-identical (md5)" test "$MD5_BEFORE" = "$MD5_AFTER"
check "production arbiter label still loaded" launchctl print "gui/$UID_NUM/com.sam.idlefill.server"
check "production arbiter still answers 8787" \
  curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/state

echo "---- app.log proof lines ----"
grep -E "PAGE_LOAD|LAUNCHD|AUTO_RELOAD" "$T/app.log" | head -40

cleanup
if [ "$failures" -gt 0 ]; then echo "ACCEPTANCE-FAILURES $failures"; exit 1; fi
echo "ACCEPTANCE-ALL-PASS"

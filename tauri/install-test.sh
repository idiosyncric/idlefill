#!/usr/bin/env bash
# Headless test for tauri/install.sh (issue #70 deliverable 6). The
# render-before-bootout check families on the app label: the
# --reinstall cycle is RENDER-BEFORE-BOOTOUT (fail closed — a render
# refusal must NEVER leave the previously-loaded agent unloaded), and a
# clean --reinstall completes end-to-end leaving the agent loaded.
#
# ALL launchd work uses a SCRATCH label + scratch plist dir via the
# install.sh overrides (IDLEFILL_APP_LABEL/_PLIST_DIR/_PROG/_LOG_DIR).
# The REAL labels (com.sam.idlefill.app — installed at the #69 cutover —
# plus the live com.sam.idlefill.client / com.sam.idlefill.server labels)
# are NEVER touched; the run ends with a production-untouched +
# cutover-state proof.
set -uo pipefail
T="$(mktemp -d /tmp/tauri-install-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$REPO/tauri/install.sh"
TEMPLATE="$REPO/tauri/IdlefillApp.plist"
UID_NUM="$(id -u)"
LABEL="com.sam.idlefill.app-install-test"

failures=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else failures=$((failures+1)); echo "FAIL $name"; fi
}
is_loaded() { launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; }
runs_of() { # the LOADED service's ProgramArguments.0
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null \
    | awk '/arguments = \{/{f=1;next} f && /^[[:space:]]*}/{exit} f && NF {gsub(/^[ \t]+|[ \t]+$/,""); print; exit}'
}
runs_of_app() { # the REAL (cutover-installed) app label's ProgramArguments.0
  launchctl print "gui/$UID_NUM/com.sam.idlefill.app" 2>/dev/null \
    | awk '/arguments = \{/{f=1;next} f && /^[[:space:]]*}/{exit} f && NF {gsub(/^[ \t]+|[ \t]+$/,""); print; exit}'
}
plist_bin() { plutil -extract ProgramArguments.0 raw "$1" 2>/dev/null || true; }

# Leave NO scratch agent behind, whatever happens.
trap 'launchctl bootout "gui/'"$UID_NUM"'/'"$LABEL"'" 2>/dev/null || true; rm -rf "$T"' EXIT

export IDLEFILL_APP_LABEL="$LABEL"
export IDLEFILL_APP_PLIST_DIR="$T/plists"
export IDLEFILL_APP_PROG="/bin/sleep 3600"
export IDLEFILL_APP_LOG_DIR="$T/logs"

echo "==> workdir: $T (scratch label $LABEL)"

# ---- (1) fresh install (the baseline: agent loaded on the scratch prog) --
rc=0; bash "$INSTALL_SH" > "$T/install1.log" 2>&1 || rc=$?
check "install: fresh install exits 0" test "$rc" -eq 0
check "install: agent loaded after fresh install" is_loaded
check "install: loaded agent runs the scratch program" test "$(runs_of)" = "/bin/sleep"
check "install: the scratch log dir was created" test -d "$T/logs"

# ---- (2) plain re-run on a loaded label = clean no-op, NO writes -------
BEFORE="$(cksum "$T/plists/$LABEL.plist" | awk '{print $1}')"
rc=0; bash "$INSTALL_SH" > "$T/install2.log" 2>&1 || rc=$?
check "noop: re-run exits 0" test "$rc" -eq 0
check "noop: re-run says already loaded" grep -q 'already loaded' "$T/install2.log"
AFTER="$(cksum "$T/plists/$LABEL.plist" | awk '{print $1}')"
check "noop: the on-disk plist is byte-identical" test "$BEFORE" = "$AFTER"

# ---- (3) criterion 4: --reinstall with a FAILING render leaves the agent
# ---- LOADED (render-before-bootout proven). The failing render runs from
# ---- a COPY of install.sh + a deliberately corrupted template (the real
# ---- committed template is never touched). Corruption: the template's
# ---- Label value changes, so the Label substitution no longer matches —
# ---- the Label byte-verify refuses (exit 1) BEFORE any bootout.
mkdir -p "$T/copy"
cp "$INSTALL_SH" "$T/copy/install.sh"
sed 's|<string>com.sam.idlefill.app</string>|<string>com.sam.idlefill.WRONG</string>|' \
    "$TEMPLATE" > "$T/copy/IdlefillApp.plist"
grep -q 'com.sam.idlefill.WRONG' "$T/copy/IdlefillApp.plist" || { echo "error: template corruption did not apply" >&2; exit 1; }
rc=0; bash "$T/copy/install.sh" --reinstall > "$T/reinstall-fail.log" 2>&1 || rc=$?
check "fail-closed: --reinstall with a bad render exits non-zero" test "$rc" -ne 0
check "fail-closed: the refusal is the render byte-verify" grep -q 'rendered plist Label is not' "$T/reinstall-fail.log"
check "fail-closed: the previously-loaded agent is STILL LOADED" is_loaded
check "fail-closed: the agent still runs the OLD program (untouched)" test "$(runs_of)" = "/bin/sleep"
check "fail-closed: the on-disk plist still carries the old program" \
  test "$(plist_bin "$T/plists/$LABEL.plist")" = "/bin/sleep"

# ---- (4) criterion 3: --reinstall with the REAL script + committed
# ---- template completes end-to-end and leaves the agent loaded.
rc=0; bash "$INSTALL_SH" --reinstall > "$T/reinstall-ok.log" 2>&1 || rc=$?
check "reinstall: clean --reinstall exits 0" test "$rc" -eq 0
check "reinstall: the render-first order is what ran" grep -q 'render + bootout + bootstrap' "$T/reinstall-ok.log"
check "reinstall: agent loaded after --reinstall" is_loaded
check "reinstall: the re-bootstrapped agent runs the scratch prog" test "$(runs_of)" = "/bin/sleep"
check "reinstall: the rendered plist ProgramArguments.0 == the expected bin" \
  test "$(plist_bin "$T/plists/$LABEL.plist")" = "/bin/sleep"
check "reinstall: the rendered plist Label == the scratch label" \
  test "$(plutil -extract Label raw "$T/plists/$LABEL.plist" 2>/dev/null)" = "$LABEL"

# ---- (5) the render refusal with a MISSING template also leaves the
# ---- agent loaded (the early guard fires before any bootout).
rm "$T/copy/IdlefillApp.plist"
rc=0; bash "$T/copy/install.sh" --reinstall > "$T/reinstall-notpl.log" 2>&1 || rc=$?
check "missing-template: --reinstall exits non-zero" test "$rc" -ne 0
check "missing-template: agent STILL LOADED" is_loaded

# ---- (6) the REAL labels untouched + cutover-state proof: the live agent
# ---- labels still print; the retired menubar label is GONE (booted out +
# ---- plist removed at the #69 cutover); and if the cutover installed the
# ---- app (the /Applications bundle), the real app label is live.
check "production: the retired com.sam.idlefill.menubar label is gone" \
  test "$(launchctl print "gui/$UID_NUM/com.sam.idlefill.menubar" >/dev/null 2>&1; echo $?)" -ne 0
check "production: com.sam.idlefill.client still prints (untouched)" \
  launchctl print "gui/$UID_NUM/com.sam.idlefill.client"
check "production: com.sam.idlefill.server still prints (untouched)" \
  launchctl print "gui/$UID_NUM/com.sam.idlefill.server"
APP_BIN="/Applications/Idlefill.app/Contents/MacOS/idlefill-app"
if [ -x "$APP_BIN" ]; then
  # The cutover ran on this machine: the ONE app's label is live.
  check "cutover: com.sam.idlefill.app label is live" \
    launchctl print "gui/$UID_NUM/com.sam.idlefill.app"
  check "cutover: the app label runs the /Applications bundle" \
    test "$(runs_of_app)" = "$APP_BIN"
else
  echo "NOTE: /Applications/Idlefill.app not present — skipping the app-label checks (cutover not run here)"
fi

# ---- cleanup: boot out the scratch label (the trap repeats it — idempotent)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
check "cleanup: scratch label booted out (print now fails)" \
  test "$(launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; echo $?)" -ne 0

if [ "$failures" -gt 0 ]; then echo "INSTALL-TEST-FAILURES $failures"; exit 1; fi
echo "INSTALL-TEST-ALL-PASS"
exit 0

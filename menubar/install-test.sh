#!/usr/bin/env bash
# Headless test for menubar/install.sh (issue #23 DoD criteria 3 + 4):
# the --reinstall cycle is RENDER-BEFORE-BOUTOUT (fail closed) — a render
# refusal must NEVER leave the previously-loaded agent unloaded — and a
# clean --reinstall completes end-to-end leaving the agent loaded.
#
# ALL launchd work uses a SCRATCH label + scratch plist dir via the
# install.sh overrides (IDLEFILL_MENUBAR_LABEL/_PLIST_DIR/_PROG/_LOG_DIR).
# The real com.sam.idlefill.menubar / com.sam.idlefill.client labels are
# NEVER touched (the script's own guardrail + the scratch overrides); the
# run ends with a production-untouched proof.
set -uo pipefail
T="$(mktemp -d /tmp/install-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$REPO/menubar/install.sh"
TEMPLATE="$REPO/menubar/IdlefillMenubar.plist"
UID_NUM="$(id -u)"
LABEL="com.sam.idlefill.install-test"

failures=0
# check <name> <cmd…> — runs the command, records PASS/FAIL, never aborts.
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else failures=$((failures+1)); echo "FAIL $name"; fi
}
is_loaded() { launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; }
runs_of() { # the LOADED service's ProgramArguments.0
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null \
    | awk '/arguments = \{/{f=1;next} f && /^[[:space:]]*}/{exit} f && NF {gsub(/^[ \t]+|[ \t]+$/,""); print; exit}'
}
plist_bin() { plutil -extract ProgramArguments.0 raw "$1" 2>/dev/null || true; }

# Leave NO scratch agent behind, whatever happens.
trap 'launchctl bootout "gui/'"$UID_NUM"'/'"$LABEL"'" 2>/dev/null || true; rm -rf "$T"' EXIT

export IDLEFILL_MENUBAR_LABEL="$LABEL"
export IDLEFILL_MENUBAR_PLIST_DIR="$T/plists"
export IDLEFILL_MENUBAR_PROG="/bin/sleep 3600"
export IDLEFILL_MENUBAR_LOG_DIR="$T/logs"

echo "==> workdir: $T (scratch label $LABEL)"

# ---- (1) fresh install (the baseline: agent loaded on the scratch prog) --
rc=0; bash "$INSTALL_SH" > "$T/install1.log" 2>&1 || rc=$?
check "install: fresh install exits 0" test "$rc" -eq 0
check "install: agent loaded after fresh install" is_loaded
check "install: loaded agent runs the scratch program" test "$(runs_of)" = "/bin/sleep"

# ---- (2) criterion 4: --reinstall with a FAILING render leaves the agent
# ---- RUNNING (render-before-bootout proven). The failing render runs from
# ---- a COPY of install.sh + a deliberately corrupted template (the real
# ---- committed template is never touched). The corruption: the template's
# ---- Label value is changed, so the render's Label substitution no longer
# ---- matches and the rendered plist carries the WRONG label — the Label
# ---- byte-verify refuses (exit 1) BEFORE any bootout.
mkdir -p "$T/mencopy"
cp "$INSTALL_SH" "$T/mencopy/install.sh"
sed 's|<string>com.sam.idlefill.menubar</string>|<string>com.sam.idlefill.WRONG</string>|' \
    "$TEMPLATE" > "$T/mencopy/IdlefillMenubar.plist"
grep -q 'com.sam.idlefill.WRONG' "$T/mencopy/IdlefillMenubar.plist" || { echo "error: template corruption did not apply"; exit 1; }
rc=0; bash "$T/mencopy/install.sh" --reinstall > "$T/reinstall-fail.log" 2>&1 || rc=$?
check "fail-closed: --reinstall with a bad render exits non-zero" test "$rc" -ne 0
check "fail-closed: the refusal is the render byte-verify" grep -q 'rendered plist Label is not' "$T/reinstall-fail.log"
check "fail-closed: the previously-loaded agent is STILL LOADED" is_loaded
check "fail-closed: the agent still runs the OLD program (untouched)" test "$(runs_of)" = "/bin/sleep"
# The on-disk scratch plist was NOT corrupted by the failed render pass
# (render goes to a temp file; only a VERIFIED render replaces the live
# plist) — it still carries the old program.
check "fail-closed: the on-disk plist still carries the old program" \
  test "$(plist_bin "$T/plists/$LABEL.plist")" = "/bin/sleep"

# ---- (3) criterion 3: --reinstall with the REAL script + committed
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

# ---- (4) the render refusal with a MISSING template also leaves the agent
# ---- loaded (the early guard fires before any bootout).
rm "$T/mencopy/IdlefillMenubar.plist"
rc=0; bash "$T/mencopy/install.sh" --reinstall > "$T/reinstall-notpl.log" 2>&1 || rc=$?
check "missing-template: --reinstall exits non-zero" test "$rc" -ne 0
check "missing-template: agent STILL LOADED" is_loaded

# ---- (5) the REAL labels untouched proof: both still print rc=0 and the
# ---- menubar one still runs the main-checkout bundle executable.
check "production: com.sam.idlefill.menubar still prints (untouched)" \
  launchctl print "gui/$UID_NUM/com.sam.idlefill.menubar"
launchctl print "gui/$UID_NUM/com.sam.idlefill.menubar" > "$T/real-mb.txt" 2>&1 || true
check "production: the real menubar label still runs the main-checkout bundle" \
  grep -q '/Users/sam/Software/idlefill/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar' "$T/real-mb.txt"
check "production: com.sam.idlefill.client still prints (untouched)" \
  launchctl print "gui/$UID_NUM/com.sam.idlefill.client"

# ---- cleanup: boot out the scratch label (the trap repeats it — idempotent)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
check "cleanup: scratch label booted out (print now fails)" \
  test "$(launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; echo $?)" -ne 0

if [ "$failures" -gt 0 ]; then echo "INSTALL-TEST-FAILURES $failures"; exit 1; fi
echo "INSTALL-TEST-ALL-PASS"
exit 0

#!/usr/bin/env bash
# One command to update the installed idlefill app. The Tauri shell has NO
# auto-updater (decision D7 in docs/architecture/tauri-cutover.md locks
# build-from-checkout everywhere), so an update is: pull, rebuild, restart.
#
#   ./update.sh            git pull --ff-only, rebuild, restart the agent
#   ./update.sh --no-pull  rebuild THIS checkout, restart the agent
#
# Steps, each fail-closed; the agent restart happens ONLY after a green build:
#   1. refuse to move a checkout with uncommitted tracked changes
#   2. fast-forward main (--no-pull skips steps 1-2: rebuild at the current
#      commit, e.g. after a manual checkout/pin)
#   3. tauri/build.sh with IDLEFILL_BUILD_MARKER=<short sha> so
#      `idlefill-app --version` reports the commit the bundle was built from
#      (build.sh's own gate 4 byte-verifies the bundle's Info.plist)
#   4. rsync the bundle to /Applications/Idlefill.app so the app shows in
#      Launchpad/Spotlight/Finder like a normal Mac app
#   5. tauri/install.sh --reinstall with IDLEFILL_APP_PROG pointed at the
#      /Applications copy (render-before-bootout fail-closed, then bootstrap;
#      touches ONLY the com.sam.idlefill.app label — never the daemon's or
#      the arbiter's)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    *) echo "usage: ./update.sh [--no-pull]" >&2; exit 2 ;;
  esac
done

if [ "$PULL" -eq 1 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "refusing: uncommitted changes in $HERE — commit or stash first" >&2
    exit 1
  fi
  git pull --ff-only
fi

MARKER="$(git rev-parse --short HEAD)"
echo "==> building Idlefill.app at $MARKER"
IDLEFILL_BUILD_MARKER="$MARKER" bash tauri/build.sh

# Stage the bundle in /Applications so the app sits in the Applications
# folder like a normal Mac app (Launchpad/Spotlight/Finder). The swap is a
# rename, never an in-place write: an rsync/cp over the binary of a RUNNING
# app fails with ETXTBSY, a rename never does (the live process keeps the
# old inode until it exits). /Applications needs no sudo on this machine;
# if it isn't writable, say so instead of half-updating.
SRC_APP="$HERE/tauri/src-tauri/target/release/bundle/macos/Idlefill.app"
DEST_APP="/Applications/Idlefill.app"
[ -d "$SRC_APP" ] || { echo "error: build produced no bundle at $SRC_APP" >&2; exit 1; }
[ -x "$DEST_APP/Contents/MacOS/idlefill-app" ] || [ -w /Applications ] \
  || { echo "error: /Applications not writable and $DEST_APP missing — copy it in manually once" >&2; exit 1; }
echo "==> staging $DEST_APP"
TMP_APP="/Applications/.Idlefill.app.new.$$"
rm -rf "$TMP_APP"
cp -R "$SRC_APP" "$TMP_APP"
"$TMP_APP/Contents/MacOS/idlefill-app" --version >/dev/null \
  || { echo "error: staged copy fails --version" >&2; rm -rf "$TMP_APP"; exit 1; }
OLD_APP="/Applications/.Idlefill.app.old.$$"
rm -rf "$OLD_APP"
if [ -d "$DEST_APP" ]; then mv "$DEST_APP" "$OLD_APP"; fi
mv "$TMP_APP" "$DEST_APP"
rm -rf "$OLD_APP"

echo "==> restarting com.sam.idlefill.app"
# install.sh --reinstall = render + bootout + bootstrap, but its bootstrap
# line is unchecked: launchd's bootout teardown is async, so a bootstrap
# fired immediately after sometimes fails with "Bootstrap failed: 5:
# Input/output error" while install.sh still exits 0. Always verify the
# label afterwards; when launchd refused, the render already landed and
# the label is booted-out — retry the bootstrap alone until it takes.
LABEL="com.sam.idlefill.app"
# Run the agent from the /Applications copy (install.sh honours
# IDLEFILL_APP_PROG as ProgramArguments). The plist's WorkingDirectory and
# log paths stay in the checkout — only the program moves.
PROG_BIN="$DEST_APP/Contents/MacOS/idlefill-app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
IDLEFILL_APP_PROG="$PROG_BIN" bash tauri/install.sh --reinstall || true
# Settle on launchd's job PID, NOT on the process path. After the rename
# swap the old process and the new binary share the SAME path, so a
# path-based pgrep passes the instant the swap lands even when the new
# process is gone (the app's single-instance plugin exits a second
# instance at the existing lock — observed live 2026-10-08: update.sh
# reported "updated" while the old binary kept serving). launchd's
# "pid = <N>" line is the identity only the NEW process carries. While
# nothing new is running, the label is either still draining or launchd
# refused the bootstrap — a bootstrap onto a draining label errors
# harmlessly, onto a drained one takes.
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  jobpid="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3; exit}')"
  if [ -n "$jobpid" ] && kill -0 "$jobpid" 2>/dev/null; then ok=1; break; fi
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  sleep 2
done
[ "$ok" -eq 1 ] || { echo "error: the label's job is not running the new binary — check $PLIST and logs/app.launchd.err.log" >&2; exit 1; }

echo "updated: idlefill $MARKER"

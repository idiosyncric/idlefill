#!/usr/bin/env bash
# Build the idlefill desktop app from this checkout and install/update it.
#
#   desktop/update.sh          → build + install (or update) /Applications/Idlefill.app
#   desktop/update.sh /SomeDir → same, into a different target dir
#
# What it does, in order:
#   1. build the .app (swiftc -O + Info.plist + ad-hoc sign)
#   2. quit any running Idlefill (clean SIGTERM; a GUI app has no leases to
#      tear down — the daemon is a separate process)
#   3. replace the installed bundle (fresh copy — no stale files), or install
#      a first copy if none exists
#   4. relaunch
#
# It does NOT `git pull`: the app builds from the checkout you run it in
# (a worktree is fine). A dirty tree is only a warning — you may be
# deliberately building work-in-progress.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TARGET="${1:-/Applications}/Idlefill.app"

if git -C "$REPO" status --porcelain -- desktop/ 2>/dev/null | grep -q .; then
  echo "==> warning: uncommitted changes in desktop/ — building what's on disk"
fi

"$HERE/build.sh"

# Quit running instances (match the process name; SIGTERM = clean quit for
# a GUI app). rc=1 just means nothing was running.
if pkill -x Idlefill 2>/dev/null; then
  echo "==> quit running Idlefill"
  # let the process exit before we replace its bundle
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x Idlefill >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

mkdir -p "$(dirname "$TARGET")"
if [ -d "$TARGET" ]; then
  echo "==> replacing $TARGET"
  rm -rf "$TARGET"
else
  echo "==> installing to $TARGET (first install)"
fi
cp -R "$HERE/Idlefill.app" "$TARGET"

open "$TARGET"
echo "==> done — $TARGET is running"

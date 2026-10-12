#!/usr/bin/env bash
# Install / update the idlefill operator CLI on PATH (owner ask 2026-10-12).
# The CLI is NOT inside the Tauri bundle — the cli.md D8 lock stands. The
# product model is build-from-checkout (tauri-cutover D7), so this checkout's
# cli/dist IS the product and the install writes a LINKED SHIM:
# ~/.local/bin/idlefill exec'ing <repo>/cli/dist/index.js. The shim updates
# for free on every ./update.sh (which rebuilds cli/ and re-runs this).
#
#   scripts/install-cli.sh    idempotent: write | clean no-op | named refusal
#
# Discipline (the tauri/install.sh house rules, ported):
#   a. derive the repo root from this script's location (scripts/ -> ..)
#   b. render the shim to a TEMP file, embedding this checkout's ABSOLUTE
#      repo path and the scripts/idlefill-daemon.mjs fallback chain:
#      executable cli/dist/index.js -> node; else repo tsx on cli/src;
#      else a named error telling the operator to build, then exit 1.
#   c. decide BEFORE writing:
#        target missing                        -> write
#        target byte-identical                 -> named no-op, zero writes
#        our shim for a DIFFERENT repo path    -> refuse by name, touch nothing
#        target without our marker line        -> refuse by name, touch nothing
#      (our marker, same repo, different bytes = the template moved: refresh)
#   d. chmod 755 + atomic mv into place, then byte-verify by RE-READING the
#      target (grep the marker line).
#
# Overrides (the scratch-dir proof — default is the real value):
#   IDLEFILL_CLI_BIN_DIR  where the shim lands (default $HOME/.local/bin)
#
# Exit codes: 0 written or clean no-op; 1 refusal or failed verify; 2 usage.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BINDIR="${IDLEFILL_CLI_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BINDIR/idlefill"
MARKER="idlefill-cli-shim"

if [ "$#" -ne 0 ]; then
  echo "usage: $0 (no arguments; override the dir with IDLEFILL_CLI_BIN_DIR)" >&2
  exit 2
fi

mkdir -p "$BINDIR"
TMP_SHIM="$TARGET.render.tmp.$$"
trap 'rm -f "$TMP_SHIM"' EXIT

# Render: the quoted heredoc keeps the shim's own $vars literal; the awk
# string-substitution discipline (no regex, same as tauri/install.sh) swaps
# the @REPO@ token for this checkout's absolute path.
cat > "$TMP_SHIM.in" <<'SHIM'
#!/bin/sh
# idlefill-cli-shim v1 — rendered by scripts/install-cli.sh; do not edit.
# To re-point this command, run the installer from the checkout that should
# own it: bash <repo>/scripts/install-cli.sh
IDLEFILL_CLI_REPO="@REPO@"
DIST="$IDLEFILL_CLI_REPO/cli/dist/index.js"
TSX="$IDLEFILL_CLI_REPO/node_modules/.bin/tsx"
SRC="$IDLEFILL_CLI_REPO/cli/src/index.ts"
if [ -x "$DIST" ]; then
  exec node "$DIST" "$@"
elif [ -x "$TSX" ]; then
  exec "$TSX" "$SRC" "$@"
else
  echo "idlefill: no cli entry found — run \`npm install && npm run build\` at $IDLEFILL_CLI_REPO" >&2
  exit 1
fi
SHIM
awk -v repo="$REPO" '{
  while ((i = index($0, "@REPO@")) > 0)
    $0 = substr($0, 1, i - 1) repo substr($0, i + 6)
  print
}' "$TMP_SHIM.in" > "$TMP_SHIM"
rm -f "$TMP_SHIM.in"

if [ -e "$TARGET" ]; then
  if cmp -s "$TMP_SHIM" "$TARGET"; then
    echo "idlefill shim already current: $TARGET (byte-identical — clean no-op, zero writes)"
    echo "  serves: $REPO"
  else
    if grep -q "$MARKER" "$TARGET"; then
      LIVE_REPO="$(sed -n 's/^IDLEFILL_CLI_REPO="\(.*\)"$/\1/p' "$TARGET" | head -1)"
      if [ -z "$LIVE_REPO" ]; then
        echo "error: $TARGET carries the $MARKER marker but no IDLEFILL_CLI_REPO line — refusing to touch it" >&2
        exit 1
      fi
      if [ "$LIVE_REPO" != "$REPO" ]; then
        echo "error: $TARGET is an idlefill shim for a DIFFERENT checkout: $LIVE_REPO" >&2
        echo "       refusing to touch it. Remove it (or re-run the installer" >&2
        echo "       from that other checkout), then re-run this one." >&2
        exit 1
      fi
      echo "==> refreshing the idlefill shim (same repo, shim template moved)"
      chmod 755 "$TMP_SHIM"
      mv -f "$TMP_SHIM" "$TARGET"
      grep -q "$MARKER" "$TARGET" \
        || { echo "error: installed shim failed the marker re-read: $TARGET" >&2; exit 1; }
      echo "installed: $TARGET -> $REPO"
    else
      echo "error: $TARGET exists and is NOT an idlefill shim (no $MARKER marker line) — refusing to touch it" >&2
      exit 1
    fi
  fi
else
  chmod 755 "$TMP_SHIM"
  mv -f "$TMP_SHIM" "$TARGET"
  grep -q "$MARKER" "$TARGET" \
    || { echo "error: installed shim failed the marker re-read: $TARGET" >&2; exit 1; }
  echo "installed: $TARGET -> $REPO"
fi

# PATH honesty: the shim landed regardless — a dir off $PATH is a note, not
# a failure (exit stays 0 when the write landed).
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "note: $BINDIR is not on \$PATH — add it to your shell profile to use \`idlefill\` by name" ;;
esac
exit 0

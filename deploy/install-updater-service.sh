#!/usr/bin/env bash
# Install the idlefill host-updater helper systemd USER unit (mesh-update.md
# D3) — the Linux counterpart of the macOS LaunchAgent posture. Same
# fail-closed discipline as install-client-service.sh: render -> byte-verify
# -> move into place; a refusal never damages the installed unit.
#
# What it does:
#   1. sanity: Linux + systemd --user, node on PATH, this repo is a git
#      checkout, and a 0600 helper config (the updater REFUSES to run
#      without one — the installer refuses to install a helper that would
#      immediately refuse, rather than leave a dead unit in place),
#   2. renders deploy/systemd/idlefill-updater.service.template into
#      ~/.config/systemd/user/idlefill-updater.service,
#   3. daemon-reload + (unless --no-start) restart + enable.
#
# Flags:
#   --no-start   install + enable but do not (re)start
#   --dry-run    render + verify + print the plan; touch nothing live
#   --config P   helper config path (default ~/.idlefill/updater.json)
set -euo pipefail

UNIT=idlefill-updater
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/deploy/systemd/idlefill-updater.service.template"
UNITDIR="$HOME/.config/systemd/user"
TARGET="$UNITDIR/$UNIT.service"
CFG="${IDLEFILL_UPDATER_CONFIG:-$HOME/.idlefill/updater.json}"
START=1
DRY=0

for a in "$@"; do
  case "$a" in
    --no-start) START=0 ;;
    --dry-run) DRY=1 ;;
    --config) shift; CFG="${1:?--config needs a path}" ;;
    *) echo "usage: $0 [--no-start] [--dry-run] [--config PATH]" >&2; exit 2 ;;
  esac
done

fail() { echo "install refused: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "this installer is the Linux path; on macOS use a LaunchAgent around scripts/host-updater.mjs"
command -v systemctl >/dev/null || fail "systemctl not found — this box has no systemd"
BUS_OK=0
if systemctl --user show-environment >/dev/null 2>&1; then
  BUS_OK=1
elif [ "$DRY" = 1 ]; then
  echo "note: no systemd --user bus (CI container) — dry-run verifies rendering only" >&2
else
  fail "systemd --user is not available for $USER; log in normally or enable lingering first"
fi
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node not on PATH — the helper is a node script"
NPATH="$(dirname "$NODE_BIN")"
[ -f "$TEMPLATE" ] || fail "template missing: $TEMPLATE"
[ -f "$REPO/scripts/host-updater.mjs" ] || fail "scripts/host-updater.mjs missing in $REPO"
git -C "$REPO" rev-parse HEAD >/dev/null 2>&1 || fail "$REPO is not a git checkout"
[ -f "$CFG" ] || fail "no helper config at $CFG — the helper refuses to run without its 0600 config (arbiter_url + token + command); see the header of scripts/host-updater.mjs"
node -e 'const {statSync}=require("fs"); const m=statSync(process.argv[1]).mode & 0o777; process.exit((m & 0o077) !== 0 ? 1 : 0)' "$CFG" \
  || fail "$CFG is group/world-accessible — chmod 600 it first (it holds the arbiter token)"

RDIR="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-unit.XXXXXX")"
TMP="$RDIR/$UNIT.service"
trap 'rm -rf "$RDIR"' EXIT
sed -e "s|@REPO@|$REPO|g" -e "s|@NPATH@|$NPATH|g" -e "s|@CFG@|$CFG|g" "$TEMPLATE" > "$TMP"
grep -q '@REPO@\|@NPATH@\|@CFG@' "$TMP" && fail "placeholder survived rendering"
grep -q "ExecStart=$NPATH/node $REPO/scripts/host-updater.mjs" "$TMP" || fail "rendered ExecStart does not match this checkout"
grep -q "IDLEFILL_UPDATER_CONFIG=$CFG" "$TMP" || fail "rendered unit does not point at the helper config"
if [ "$BUS_OK" = 1 ]; then
  systemd-analyze --user verify "$TMP" 2>/dev/null || fail "systemd-analyze verify rejected the rendered unit"
fi

if [ "$DRY" = 1 ]; then
  echo "DRY RUN — would install:"
  echo "  unit:      $TARGET"
  echo "  helper:    $NPATH/node $REPO/scripts/host-updater.mjs"
  echo "  config:    $CFG"
  echo "  start:     $([ "$START" = 1 ] && echo yes || echo no)"
  echo "--- rendered unit ---"
  cat "$TMP"
  exit 0
fi

mkdir -p "$UNITDIR"
mv "$TMP" "$TARGET"
trap - EXIT

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1 || true
if [ "$START" = 1 ]; then
  systemctl --user restart "$UNIT"
  sleep 2
  if systemctl --user is-active --quiet "$UNIT"; then
    echo "installed + started: systemctl --user status $UNIT"
  else
    echo "unit installed but NOT active — first failure log follows" >&2
    journalctl --user -u "$UNIT" -n 20 --no-pager >&2 || true
    exit 1
  fi
else
  echo "installed (not started): systemctl --user start $UNIT"
fi

if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  echo "linger already on — the helper starts at boot"
elif sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
  echo "linger enabled — the helper starts at boot"
else
  echo "NOTE: lingering is OFF — the helper runs only while you are logged in."
  echo "      enable it once with: sudo loginctl enable-linger $USER"
fi

echo "logs: journalctl --user -u $UNIT -f"

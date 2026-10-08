#!/usr/bin/env bash
# Install the idlefill client systemd USER unit (issue #54) — the Linux
# analogue of the macOS launchd LaunchAgent (deploy/com.sam.idlefill.client.plist).
#
# Mirrors tauri/install.sh's fail-closed discipline:
#   render -> byte-verify -> move into place. A render/verify refusal
#   never leaves a previously-installed unit damaged. The template is
#   never edited; substitution lands on the rendered copy only.
#
# What it does:
#   1. sanity-checks the environment (Linux, systemd, node/npx, a real
#      checkout with client/config.json and node_modules),
#   2. renders the unit from deploy/systemd/idlefill-client.service.template
#      into ~/.config/systemd/user/idlefill-client.service,
#   3. daemon-reload + (unless --no-start) restart + enable,
#   4. turns on lingering (loginctl enable-linger) so the user unit starts
#      at boot without a login session — with a loud note when it needs a
#      password (sudo -n fails): print the one command, do NOT hang.
#
# Flags:
#   --no-start   install + enable but do not (re)start the daemon
#   --dry-run    render + verify + print the plan; touch nothing live
set -euo pipefail

UNIT=idlefill-client
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/deploy/systemd/idlefill-client.service.template"
UNITDIR="$HOME/.config/systemd/user"
TARGET="$UNITDIR/$UNIT.service"
START=1
DRY=0

for a in "$@"; do
  case "$a" in
    --no-start) START=0 ;;
    --dry-run) DRY=1 ;;
    *) echo "usage: $0 [--no-start] [--dry-run]" >&2; exit 2 ;;
  esac
done

fail() { echo "install refused: $*" >&2; exit 1; }

# ---- environment sanity (refuse before touching anything) -----------------
[ "$(uname -s)" = "Linux" ] || fail "this installer is the Linux path; on macOS use the launchd plist (deploy/)"
command -v systemctl >/dev/null || fail "systemctl not found — this box has no systemd"
BUS_OK=0
if systemctl --user show-environment >/dev/null 2>&1; then
  BUS_OK=1
elif [ "$DRY" = 1 ]; then
  echo "note: no systemd --user bus on this box (CI container) — dry-run verifies rendering only, not the bus/analyze steps" >&2
else
  fail "systemd --user is not available for $USER (no XDG_RUNTIME_DIR / session bus); log in normally or enable lingering first"
fi

NODE_BIN="$(command -v node || true)"
NPX_BIN="$(command -v npx || true)"
[ -n "$NPX_BIN" ] || fail "npx not on PATH — install Node (the daemon runs tsx via npx)"
NPATH="$(dirname "$NPX_BIN")"

[ -f "$TEMPLATE" ] || fail "template missing: $TEMPLATE"
[ -f "$REPO/client/config.json" ] || fail "no client/config.json in $REPO — configure the client first (see client/config.example.json)"
[ -d "$REPO/client/node_modules" ] || [ -d "$REPO/node_modules" ] || fail "node_modules missing — run: npm ci (from $REPO)"
git -C "$REPO" rev-parse HEAD >/dev/null 2>&1 || fail "$REPO is not a git checkout — issue #49's boot revision needs git; clone the repo properly"

# Refuse a running non-systemd client from THIS repo: two daemons under one
# name fight over leases and flood registration heartbeats.
LIVE_PIDS="$(node "$REPO/scripts/idlefill-daemon.mjs" pids 2>/dev/null || true)"
if [ -n "$LIVE_PIDS" ]; then
  fail "a client daemon for this repo is already running outside systemd (pids: $(echo $LIVE_PIDS | tr '\n' ' ')). Stop it first: node scripts/idlefill-daemon.mjs stop"
fi

# ---- render + byte-verify (never edit the template) -----------------------
# systemd-analyze verify parses the FILENAME as the unit name — a mktemp
# file without the .service suffix dies with "Failed to prepare filename:
# Invalid argument". Render into a temp DIR under the real unit name.
RDIR="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-unit.XXXXXX")"
TMP="$RDIR/$UNIT.service"
trap 'rm -rf "$RDIR"' EXIT
sed -e "s|@REPO@|$REPO|g" -e "s|@NPATH@|$NPATH|g" "$TEMPLATE" > "$TMP"

# byte-verify: no placeholder survives, and the substituted paths point at
# the real checkout (the injection the install-test.sh pattern demands:
# corrupt a token the script CANNOT rewrite — here a leftover @-token is
# the poison a naive installer would ship).
grep -q '@REPO@\|@NPATH@' "$TMP" && fail "placeholder survived rendering"
grep -q "ExecStart=$NPATH/npx tsx $REPO/client/src/index.ts" "$TMP" || fail "rendered ExecStart does not match this checkout"
grep -q "WorkingDirectory=$REPO/client" "$TMP" || fail "rendered WorkingDirectory does not match this checkout"
if [ "$BUS_OK" = 1 ]; then
  systemd-analyze --user verify "$TMP" 2>/dev/null || fail "systemd-analyze verify rejected the rendered unit"
fi

if [ "$DRY" = 1 ]; then
  echo "DRY RUN — would install:"
  echo "  unit:    $TARGET"
  echo "  ExecStart: $NPATH/npx tsx $REPO/client/src/index.ts"
  echo "  start:   $([ "$START" = 1 ] && echo yes || echo no)"
  echo "--- rendered unit ---"
  cat "$TMP"
  exit 0
fi

mkdir -p "$UNITDIR"
mv "$TMP" "$TARGET"
trap - EXIT

# ---- enable + start --------------------------------------------------------
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

# ---- lingering (boot without login) ---------------------------------------
if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  echo "linger already on — the unit starts at boot"
elif sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
  echo "linger enabled — the unit starts at boot"
else
  echo "NOTE: lingering is OFF — the unit runs only while you are logged in."
  echo "      enable it once with: sudo loginctl enable-linger $USER"
fi

echo "logs: journalctl --user -u $UNIT -f"

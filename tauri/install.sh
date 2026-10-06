#!/usr/bin/env bash
# Install / update the idlefill app's own LaunchAgent (Q-d LOCKED: ONE
# agent, com.sam.idlefill.app, RunAtLoad). Issue #70 deliverable 6: this
# mirrors menubar/install.sh's discipline exactly. NOT run against the
# real label in wave 1 — the live machine keeps the Swift planes; the
# real-label install is the owner-gated cutover step.
#
#   tauri/install.sh              idempotent install (already loaded -> no-op)
#   tauri/install.sh --reinstall  render + bootout + bootstrap
#   tauri/install.sh --uninstall  bootout only (the plist file stays)
#
# Discipline (the menubar/install.sh rules, ported):
#   a. derive the repo root from this script's location (tauri/ -> ..)
#   b. render <plistdir>/<label>.plist from the committed TEMPLATE
#      (tauri/IdlefillApp.plist), substituting this checkout's repo root,
#      the configured label, program and log dir.
#   c. create the log dir (launchd refuses to start a job whose log paths
#      do not exist).
#   d. label ALREADY loaded -> note + exit: NO double-bootstrap, NO
#      WRITES. The bootout+bootstrap cycle is taken ONLY with --reinstall.
#   e. --reinstall = RENDER BEFORE BOOTOUT (issue #23 fail-closed: a
#      render refusal must never leave the loaded agent down). The render
#      goes to a temp file; only a byte-verified render replaces the live
#      plist.
#
# Test overrides (the scratch-label proof — defaults are the real values):
#   IDLEFILL_APP_LABEL      the launchd label (default com.sam.idlefill.app)
#   IDLEFILL_APP_PLIST_DIR  where the plist lands (default
#                           ~/Library/LaunchAgents)
#   IDLEFILL_APP_PROG       space-separated ProgramArguments (default:
#                           this checkout's built bundle executable)
#   IDLEFILL_APP_LOG_DIR    the StandardOut/Err dir (default <repo>/logs)
#
# Guardrail: this script touches ONLY the app label. Never the daemon's
# (com.sam.idlefill.client), never the arbiter's (com.sam.idlefill.server).
set -euo pipefail

DEFAULT_LABEL="com.sam.idlefill.app"
LABEL="${IDLEFILL_APP_LABEL:-$DEFAULT_LABEL}"
UID_NUM="$(id -u)"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TEMPLATE="$HERE/IdlefillApp.plist"
DEFAULT_BIN="$REPO/tauri/src-tauri/target/release/bundle/macos/Idlefill.app/Contents/MacOS/idlefill-app"
PLISTDIR="${IDLEFILL_APP_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLISTDIR/$LABEL.plist"
LOGDIR="${IDLEFILL_APP_LOG_DIR:-$REPO/logs}"
PROG="${IDLEFILL_APP_PROG:-}"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --reinstall) MODE="reinstall" ;;
    --uninstall) MODE="uninstall" ;;
    *) echo "usage: $0 [--reinstall | --uninstall]" >&2; exit 2 ;;
  esac
done

[ -f "$TEMPLATE" ] || { echo "error: template missing: $TEMPLATE" >&2; exit 1; }

is_loaded() { launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; }
bootout() {
  # SINGLE combined target (the two-arg form fails rc=5). rc 3 "No such
  # process" = not loaded = a clean no-op.
  local rc=0
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    echo "error: bootout failed (rc $rc)" >&2
    return 1
  fi
}

render_plist() {
  # Render the TEMPLATE with this checkout's values (the menubar
  # install.sh string-substitution discipline, no regex):
  #   1. the executable   -> the configured program (default: this
  #      checkout's bundle binary; MUST happen before the repo rewrite)
  #   2. the repo prefix  -> this checkout's repo root
  #   3. the log prefix   -> the configured log dir
  #   4. the Label value  -> the configured label
  # RENDER TO A TEMP FILE; only a byte-verified render moves into place.
  mkdir -p "$PLISTDIR" "$LOGDIR"
  local TMPPLIST="$PLIST.render.tmp"
  awk -v repo="$REPO" -v label="$LABEL" -v logdir="$LOGDIR" -v prog="$PROG" '
    function replacestr(s, old, new,  idx, r) {
      if (old == "" || old == s) return new
      r = ""
      while ((idx = index(s, old)) > 0) {
        r = r substr(s, 1, idx - 1) new
        s = substr(s, idx + length(old))
      }
      return r s
    }
    BEGIN {
      trepo  = "/Users/sam/Software/idlefill"
      tlabel = "<string>com.sam.idlefill.app</string>"
      tbin   = "<string>" trepo "/tauri/src-tauri/target/release/bundle/macos/Idlefill.app/Contents/MacOS/idlefill-app</string>"
    }
    {
      line = $0
      if (prog != "") {
        n = split(prog, args, " ")
        block = ""
        for (i = 1; i <= n; i++) block = block (i > 1 ? "\n\t\t" : "") "<string>" args[i] "</string>"
        line = replacestr(line, tbin, block)
      }
      line = replacestr(line, trepo, repo)
      line = replacestr(line, repo "/logs/", logdir "/")
      if (label != "") line = replacestr(line, tlabel, "<string>" label "</string>")
      print line
    }
  ' "$TEMPLATE" > "$TMPPLIST"
  # Byte-verify (the menubar install.sh rule): assert the RENDERED values
  # — the template literal IS correct when this checkout is the main
  # checkout, so a "no template path" grep would false-fire there.
  if [ "$REPO" = "/Users/sam/Software/idlefill" ]; then
    EXPECTED_BIN="${PROG%% *}"
    [ -n "$PROG" ] || EXPECTED_BIN="$DEFAULT_BIN"
    ACTUAL_BIN="$(plutil -extract ProgramArguments.0 raw "$TMPPLIST" 2>/dev/null || true)"
    if [ "$ACTUAL_BIN" != "$EXPECTED_BIN" ]; then
      rm -f "$TMPPLIST"
      echo "error: rendered plist executable is $ACTUAL_BIN (expected $EXPECTED_BIN)" >&2
      exit 1
    fi
  elif grep -q '/Users/sam/Software/idlefill' "$TMPPLIST"; then
    rm -f "$TMPPLIST"
    echo "error: template path survived rendering in $PLIST" >&2
    exit 1
  fi
  plutil -extract Label raw "$TMPPLIST" | grep -qx "$LABEL" || {
    rm -f "$TMPPLIST"
    echo "error: rendered plist Label is not $LABEL" >&2
    exit 1
  }
  chmod 644 "$TMPPLIST"
  mv "$TMPPLIST" "$PLIST"
}

if [ "$MODE" = "uninstall" ]; then
  if is_loaded; then
    bootout
    echo "uninstalled: booted out gui/$UID_NUM/$LABEL (the plist file stays at $PLIST)"
  else
    echo "nothing to do: gui/$UID_NUM/$LABEL is not loaded"
  fi
  exit 0
fi

if is_loaded; then
  LIVE_BIN="$(plutil -extract ProgramArguments.0 raw "$PLIST" 2>/dev/null || true)"
  if [ "$MODE" = "reinstall" ]; then
    echo "==> gui/$UID_NUM/$LABEL is loaded — --reinstall: render + bootout + bootstrap"
    render_plist
    bootout
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
    echo "reinstalled: $PLIST → gui/$UID_NUM/$LABEL"
  else
    echo "gui/$UID_NUM/$LABEL is already loaded — nothing to do (clean no-op; no files written)."
    echo "  live plist: $PLIST"
    echo "  runs:       ${LIVE_BIN:-<unknown>}"
    if [ "$LIVE_BIN" != "$DEFAULT_BIN" ]; then
      echo "  note: the live agent runs a DIFFERENT binary than this checkout"
      echo "        ($DEFAULT_BIN). Run '$0 --reinstall' to point it here —"
      echo "        or nothing is wrong and the live checkout is simply newer."
    fi
  fi
  exit 0
fi

render_plist
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
echo "installed: $PLIST → gui/$UID_NUM/$LABEL"
if [ -z "$PROG" ] && [ ! -f "$DEFAULT_BIN" ]; then
  echo "NOTE: the bundle binary was missing at install time — the agent will"
  echo "      keep failing until 'bash tauri/build.sh' lands. Re-run with"
  echo "      --reinstall afterwards (or kickstart the label)."
fi

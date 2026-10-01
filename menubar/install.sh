#!/usr/bin/env bash
# Install / update the menubar LaunchAgent (com.sam.idlefill.menubar).
#
#   menubar/install.sh            idempotent install (already loaded → no-op)
#   menubar/install.sh --reinstall  bootout + bootstrap (take a fresh plist)
#   menubar/install.sh --uninstall   bootout only (the plist file stays)
#
# Plain bash, no deps. Steps:
#   a. derive the repo root from this script's location (menubar/ → ..)
#   b. render <plistdir>/com.sam.idlefill.menubar.plist from the committed
#      TEMPLATE (menubar/IdlefillMenubar.plist — a TEMPLATE with hardcoded
#      paths), substituting this checkout's repo root into every path:
#      ProgramArguments (the bundle's executable) + StandardOut/Err
#   c. create the plist's log dir (launchd refuses to start a job whose
#      log paths do not exist)
#   d. label ALREADY loaded (launchctl print gui/<uid>/<label> exit 0) →
#      print a note and exit: NO double-bootstrap AND NO WRITES (the live
#      plist is untouched — this checkout may not be the one it should run
#      from). The bootout+bootstrap cycle is taken ONLY with --reinstall.
#   e. otherwise: render (b) + create the log dir (c), then
#      launchctl bootstrap gui/<uid> <plist>
#
# --reinstall = render FIRST (fail closed — a render refusal never leaves
# the loaded agent unloaded), then bootout (SINGLE COMBINED target
# gui/<uid>/<label>; rc 3 "No such process" is a clean no-op) + bootstrap.
# --uninstall = bootout only.
#
# Guardrail: this script touches ONLY the menubar label — never the
# daemon's (com.sam.idlefill.client).
#
# Test overrides (the scratch-label proof — defaults are the real values):
#   IDLEFILL_MENUBAR_LABEL     the launchd label (default com.sam.idlefill.menubar)
#   IDLEFILL_MENUBAR_PLIST_DIR where the plist lands (default
#                              ~/Library/LaunchAgents)
#   IDLEFILL_MENUBAR_PROG      space-separated ProgramArguments (default: the
#                              bundle's executable — the template's value);
#                              the scratch proof uses "/bin/sleep 3600"
#   IDLEFILL_MENUBAR_LOG_DIR   the StandardOut/Err dir (default <repo>/logs)
#
# launchctl bootstrap registers under the plist's own Label key, so the
# rendered Label MUST equal the label this script bootstraps/bootouts.
set -euo pipefail

DEFAULT_LABEL="com.sam.idlefill.menubar"
LABEL="${IDLEFILL_MENUBAR_LABEL:-$DEFAULT_LABEL}"
UID_NUM="$(id -u)"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TEMPLATE="$HERE/IdlefillMenubar.plist"
DEFAULT_BIN="$REPO/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar"
PLISTDIR="${IDLEFILL_MENUBAR_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLISTDIR/$LABEL.plist"
LOGDIR="${IDLEFILL_MENUBAR_LOG_DIR:-$REPO/logs}"
PROG="${IDLEFILL_MENUBAR_PROG:-}"
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
  # Render the TEMPLATE with this checkout's values. The template hardcodes
  # /Users/sam/Software/idlefill (every path) + the menubar Label + the
  # bundle executable. String-based substitution (no regex surprises):
  #   1. the repo-root prefix → this checkout's repo root
  #   2. the log prefix       → the configured log dir
  #   3. the Label value      → the configured label
  #   4. the executable       → the configured program (default: the bundle)
  # RENDER TO A TEMP FILE and move it into place only after the byte-
  # verify passes: a refused render must not even corrupt the on-disk
  # plist of a loaded agent (issue #23 — fail closed at every level).
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
      tlabel = "<string>com.sam.idlefill.menubar</string>"
      tbin   = "<string>" trepo "/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar</string>"
      tbinOld= "<string>" trepo "/menubar/IdlefillMenubar</string>"
    }
    {
      line = $0
      # The executable substitution must happen BEFORE the repo-prefix
      # rewrite: tbin is the template binary path, and the rewrite would
      # otherwise mangle it first and the match would fail.
      if (prog != "") {
        n = split(prog, args, " ")
        block = ""
        for (i = 1; i <= n; i++) block = block (i > 1 ? "\n\t\t" : "") "<string>" args[i] "</string>"
        line = replacestr(line, tbin, block)
        line = replacestr(line, tbinOld, block)
      }
      line = replacestr(line, trepo, repo)
      line = replacestr(line, repo "/logs/", logdir "/")
      if (label != "") line = replacestr(line, tlabel, "<string>" label "</string>")
      print line
    }
  ' "$TEMPLATE" > "$TMPPLIST"
  # Byte-verify: no template path may survive. The template hardcodes the
  # MAIN checkout's repo root — when THIS checkout is that repo, the
  # rendered paths ARE the template literal (the correct values), so the
  # grep would false-fire; assert the rendered values instead. Any other
  # checkout (a worktree) must not carry the template literal at all.
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
  # And the Label must equal the label this script will bootstrap.
  plutil -extract Label raw "$TMPPLIST" | grep -qx "$LABEL" || {
    rm -f "$TMPPLIST"
    echo "error: rendered plist Label is not $LABEL" >&2
    exit 1
  }
  chmod 644 "$TMPPLIST"
  # Verified — only NOW does the rendered plist replace the live one.
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
    # RENDER BEFORE BOOTOUT (issue #23 — fail closed): the old order was
    # bootout → render → bootstrap, so a render refusal (byte-verify,
    # missing template) left the previously-loaded agent DOWN. Rendering
    # first means any refusal exits with the agent still loaded.
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
  echo "      keep failing until 'bash menubar/build.sh' lands. Re-run with"
  echo "      --reinstall afterwards (or kickstart the label)."
fi

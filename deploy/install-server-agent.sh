#!/usr/bin/env bash
# Install / update the idlefill ARBITER LaunchAgent (com.sam.idlefill.server).
# Issue #60 Slice A: the first Mac-local fused instance (loopback :8787).
#
#   deploy/install-server-agent.sh              idempotent install (already loaded -> no-op)
#   deploy/install-server-agent.sh --reinstall  bootout + bootstrap (take a fresh plist)
#   deploy/install-server-agent.sh --uninstall  bootout only (the plist file stays)
#
# Plain bash, no deps. Same fail-closed shape as tauri/install.sh (which it
# follows): render the committed TEMPLATE to a temp file + byte-verify
# BEFORE any bootout, so a render refusal never leaves a loaded agent down.
#
#   a. derive the repo root from this script's location (deploy/ -> ..)
#   b. render <plistdir>/<label>.plist from deploy/com.sam.idlefill.server.plist
#      (hardcoded paths + label), substituting this checkout's repo root,
#      log dir, and label
#   c. create the log dir + the config's state dir prerequisites are the
#      config's job (StateStore mkdirs its own dir); launchd only needs the
#      LOG dir to exist
#   d. label ALREADY loaded -> note + exit with NO writes (the live plist is
#      untouched; this checkout may not be the one it should run from).
#      The bootout+bootstrap cycle runs ONLY with --reinstall.
#   e. otherwise: bootstrap gui/<uid> <plist>
#
# Guardrails:
#   - touches ONLY the server label — never com.sam.idlefill.client or
#     com.sam.idlefill.menubar.
#   - refuses to bootstrap when the arbiter PORT is already served by a
#     foreign process (a hand-run `npm run dev` arbiter would silently
#     shadow the agent): a plain `GET http://127.0.0.1:<port>/api/state`
#     answering while NO launchd job owns the port = foreign listener ->
#     abort (kill it or pick another port in server/config.json).
#
# Test overrides (the scratch-label proof — defaults are the real values):
#   IDLEFILL_SERVER_LABEL     the launchd label (default com.sam.idlefill.server)
#   IDLEFILL_SERVER_PLIST_DIR where the plist lands (default ~/Library/LaunchAgents)
#   IDLEFILL_SERVER_PROG      space-separated ProgramArguments (default: the
#                             template's tsx entry); the scratch proof uses
#                             "/bin/sleep 3600"
#   IDLEFILL_SERVER_LOG_DIR   the StandardOut/Err dir (default <repo>/server/logs)
#
# launchctl bootstrap registers under the plist's own Label key, so the
# rendered Label MUST equal the label this script bootstraps/bootouts.
set -euo pipefail

DEFAULT_LABEL="com.sam.idlefill.server"
LABEL="${IDLEFILL_SERVER_LABEL:-$DEFAULT_LABEL}"
UID_NUM="$(id -u)"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TEMPLATE="$HERE/com.sam.idlefill.server.plist"
DEFAULT_PROG0="/opt/homebrew/bin/npx"
PLISTDIR="${IDLEFILL_SERVER_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLISTDIR/$LABEL.plist"
LOGDIR="${IDLEFILL_SERVER_LOG_DIR:-$REPO/server/logs}"
PROG="${IDLEFILL_SERVER_PROG:-}"
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
  # Render the TEMPLATE with this checkout's values (string substitution,
  # no regex surprises): repo-root prefix, log prefix, Label, and
  # optionally the whole ProgramArguments block. RENDER TO A TEMP FILE and
  # move into place only after the byte-verify passes (fail closed — the
  # menubar installer's rule, issue #23).
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
      tlabel = "<string>com.sam.idlefill.server</string>"
    }
    {
      line = $0
      line = replacestr(line, trepo, repo)
      line = replacestr(line, trepo "/server/logs/", logdir "/")
      if (label != "") line = replacestr(line, tlabel, "<string>" label "</string>")
      print line
    }
  ' "$TEMPLATE" > "$TMPPLIST"
  if [ -n "$PROG" ]; then
    # Replace the ProgramArguments block wholesale (scratch harnesses run
    # /bin/sleep 3600 under a scratch label).
    local block=""
    local IFS=' '
    for a in $PROG; do block="$block<string>$a</string>"; done
    python3 - "$TMPPLIST" "$block" <<'PY'
import re, sys
path, block = sys.argv[1], sys.argv[2]
src = open(path).read()
# Replace only the FIRST <array>...</array> (ProgramArguments).
out, n = re.subn(r"(<key>ProgramArguments</key>\s*<array>).*?(</array>)",
                 r"\1" + block + r"\2", src, count=1, flags=re.S)
assert n == 1, "ProgramArguments block not found"
open(path, "w").write(out)
PY
  fi
  # Byte-verify: the rendered Label must equal the label we bootstrap, and
  # no foreign-checkout path may survive. The template hardcodes the MAIN
  # checkout's repo root — when THIS checkout IS that repo the rendered
  # paths are the template literal (correct), so assert the rendered
  # VALUES instead of grepping for the literal (the menubar installer's
  # false-fire lesson).
  local got_label
  got_label="$(plutil -extract Label raw "$TMPPLIST" 2>/dev/null || true)"
  if [ "$got_label" != "$LABEL" ]; then
    rm -f "$TMPPLIST"
    echo "error: rendered plist Label is '$got_label' (expected '$LABEL')" >&2
    exit 1
  fi
  if [ "$REPO" != "/Users/sam/Software/idlefill" ] && grep -q '/Users/sam/Software/idlefill' "$TMPPLIST"; then
    rm -f "$TMPPLIST"
    echo "error: rendered plist still carries the template repo path" >&2
    exit 1
  fi
  plutil -lint "$TMPPLIST" >/dev/null || { rm -f "$TMPPLIST"; echo "error: rendered plist is malformed" >&2; exit 1; }
  mv "$TMPPLIST" "$PLIST"
}

port_of_config() {
  # The port the arbiter will bind, from the repo's server/config.json
  # (absent -> the 8787 default). Never prints secrets — only the number.
  python3 - "$REPO/server/config.json" <<'PY' 2>/dev/null || echo 8787
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("listen", 8787))
except Exception:
    print(8787)
PY
}

check_port_foreign() {
  # Refuse to bootstrap when the arbiter port answers but is NOT owned by
  # this label's job (a foreign hand-run arbiter would shadow the agent and
  # the boot would look fine while the wrong code serves the dashboard).
  local port rc pid_label
  port="$(port_of_config)"
  if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  pid_label=""
  # The listening pid's launchd label (empty when the process is not under
  # launchd at all).
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
    if launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -q "pid = $pid"; then
      return 0
    fi
  done
  echo "error: port $port is already served by a process NOT owned by $LABEL" >&2
  echo "       stop the foreign arbiter first (hand-run 'npm run dev'?) or change server/config.json's listen port" >&2
  exit 1
}

case "$MODE" in
  uninstall)
    bootout && echo "booted out $LABEL (plist file kept)"
    ;;
  install)
    if is_loaded; then
      echo "$LABEL already loaded — no writes (use --reinstall to take a fresh plist)"
      exit 0
    fi
    check_port_foreign
    render_plist
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
    echo "bootstrapped gui/$UID_NUM/$LABEL (logs: $LOGDIR)"
    ;;
  reinstall)
    render_plist           # render FIRST (fail closed)
    check_port_foreign     # before the bootout, not after a hole opens
    bootout
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
    echo "reinstalled gui/$UID_NUM/$LABEL"
    ;;
esac

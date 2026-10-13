#!/usr/bin/env bash
# Install the idlefill ARBITER systemd USER unit (Linux) — the native-host
# counterpart of deploy/install-server-agent.sh (the macOS LaunchAgent) and
# of install-client-service.sh for the daemon. This is what a native install
# means for a Linux machine: the arbiter is an ordinary host process of the
# operator user, not a container (docs/architecture/container-ops.md D1).
#
# Same fail-closed discipline as the other installers:
#   render -> byte-verify -> move into place. A render/verify refusal never
#   leaves a previously-installed unit damaged.
#
# What it does:
#   1. sanity: Linux + systemd --user, node/npx on PATH, a real git checkout
#      with a 0600 server/config.json (the arbiter refuses to boot without
#      its config; the installer refuses to install a unit that would
#      immediately die, instead of leaving a dead unit in place),
#   2. renders deploy/systemd/idlefill-server.service.template into
#      ~/.config/systemd/user/idlefill-server.service, pinning the state
#      file path (@STATE@),
#   3. REFUSES when the arbiter port already answers while this unit is not
#      active — that is the cutover fence: a live host-networked container or
#      a hand-run `npm run dev` arbiter would shadow the unit and the boot
#      would look fine while the wrong code serves the dashboard,
#   4. daemon-reload + (unless --no-start) restart + enable,
#   5. turns on lingering when it can (the arbiter must survive logout).
#
# Flags:
#   --no-start      install + enable but do not (re)start
#   --dry-run       render + verify + print the plan; touch nothing live
#   --state PATH    the state.json to pin (default: the config's state_file,
#                   else <repo>/server/state.json). Pass urza's existing
#                   ~/idlefill/data/state.json across the container→native
#                   cutover so the instance id, pairing edges and history
#                   survive.
set -euo pipefail

UNIT=idlefill-server
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/deploy/systemd/idlefill-server.service.template"
UNITDIR="$HOME/.config/systemd/user"
TARGET="$UNITDIR/$UNIT.service"
CFG="$REPO/server/config.json"
STATE="${IDLEFILL_SERVER_STATE:-}"
START=1
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --state) shift; STATE="${1:?--state needs a path}"; shift ;;
    *) echo "usage: $0 [--no-start] [--dry-run] [--state PATH]" >&2; exit 2 ;;
  esac
done

fail() { echo "install refused: $*" >&2; exit 1; }

# ---- environment sanity (refuse before touching anything) -----------------
[ "$(uname -s)" = "Linux" ] || fail "this installer is the Linux path; on macOS use deploy/install-server-agent.sh"
command -v systemctl >/dev/null || fail "systemctl not found — this box has no systemd"
BUS_OK=0
if systemctl --user show-environment >/dev/null 2>&1; then
  BUS_OK=1
elif [ "$DRY" = 1 ]; then
  echo "note: no systemd --user bus on this box (CI container) — dry-run verifies rendering only, not the bus/analyze steps" >&2
else
  fail "systemd --user is not available for $USER (no XDG_RUNTIME_DIR / session bus); log in normally or enable lingering first"
fi

NPX_BIN="$(command -v npx || true)"
[ -n "$NPX_BIN" ] || fail "npx not on PATH — install Node (the arbiter runs tsx via npx)"
NPATH="$(dirname "$NPX_BIN")"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node not on PATH"

[ -f "$TEMPLATE" ] || fail "template missing: $TEMPLATE"
[ -f "$CFG" ] || fail "no server/config.json in $REPO — the arbiter reads its config next to its entry point (see server/config.example.json); the unit carries no secrets"
git -C "$REPO" rev-parse HEAD >/dev/null 2>&1 || fail "$REPO is not a git checkout — the boot revision (build-gap counter) is git-derived"
[ -d "$REPO/node_modules" ] || fail "node_modules missing — run: npm ci (from $REPO)"

# The config holds api_tokens + peer_token: the same 0600 gate the updater
# helper installer demands of its config.
"$NODE_BIN" -e 'const {statSync}=require("fs"); const m=statSync(process.argv[1]).mode & 0o777; process.exit((m & 0o077) !== 0 ? 1 : 0)' "$CFG" \
  || fail "$CFG is group/world-accessible — chmod 600 it first (it holds the arbiter + peer tokens)"

# ---- the state path -------------------------------------------------------
if [ -z "$STATE" ]; then
  STATE="$("$NODE_BIN" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.state_file||"")}catch{console.log("")}' "$CFG")"
  if [ -n "$STATE" ] && [ "${STATE#/}" = "$STATE" ]; then
    # A relative state_file is resolved by the arbiter against its cwd
    # (<repo>/server), so pin it absolutely here rather than shipping a
    # path that means two things.
    STATE="$REPO/server/$STATE"
  elif [ -z "$STATE" ]; then
    STATE="$REPO/server/state.json"
  fi
fi
STATE_DIR="$(dirname "$STATE")"
if [ "$DRY" = 0 ]; then
  mkdir -p "$STATE_DIR" || fail "cannot create the state dir $STATE_DIR"
fi

# ---- the port fence (the cutover's own guard) -----------------------------
PORT="$("$NODE_BIN" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=Number(c.listen||8787);console.log(Number.isInteger(p)&&p>0?p:8787)}catch{console.log(8787)}' "$CFG")"
port_answers() {
  "$NODE_BIN" -e '
    const port = Number(process.argv[1]);
    const req = require("http").get({ host: "127.0.0.1", port, path: "/api/state", timeout: 3000 }, (res) => {
      res.resume();
      process.exit(0);
    });
    req.on("timeout", () => { req.destroy(); process.exit(1); });
    req.on("error", () => process.exit(1));
  ' "$PORT"
}
ACTIVE=0
if [ "$BUS_OK" = 1 ] && systemctl --user is-active --quiet "$UNIT"; then ACTIVE=1; fi
if [ "$ACTIVE" = 0 ] && port_answers; then
  fail "port $PORT already answers /api/state but $UNIT is not active — a foreign arbiter owns it (the host-networked container? a hand-run arbiter?). Stop that first: on the container era that is \`docker stop idlefill\`; then re-run this installer. Nothing was written."
fi

# ---- render + byte-verify (never edit the template) -----------------------
RDIR="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-unit.XXXXXX")"
TMP="$RDIR/$UNIT.service"
trap 'rm -rf "$RDIR"' EXIT
sed -e "s|@REPO@|$REPO|g" -e "s|@NPATH@|$NPATH|g" -e "s|@STATE@|$STATE|g" "$TEMPLATE" > "$TMP"

grep -q '@REPO@\|@NPATH@\|@STATE@' "$TMP" && fail "placeholder survived rendering"
grep -q "ExecStart=$NPATH/npx tsx $REPO/server/src/index.ts" "$TMP" || fail "rendered ExecStart does not match this checkout"
grep -q "WorkingDirectory=$REPO/server" "$TMP" || fail "rendered WorkingDirectory does not match this checkout"
grep -q "Environment=IDLEFILL_STATE=$STATE" "$TMP" || fail "rendered state path does not match the requested state file"
if [ "$BUS_OK" = 1 ]; then
  systemd-analyze --user verify "$TMP" 2>/dev/null || fail "systemd-analyze verify rejected the rendered unit"
fi

if [ "$DRY" = 1 ]; then
  echo "DRY RUN — would install:"
  echo "  unit:      $TARGET"
  echo "  ExecStart: $NPATH/npx tsx $REPO/server/src/index.ts"
  echo "  state:     $STATE"
  echo "  port:      $PORT (answers now: $([ "$ACTIVE" = 1 ] && echo "yes — this unit" || echo no))"
  echo "  start:     $([ "$START" = 1 ] && echo yes || echo no)"
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
  ok=0
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 2
    if port_answers; then ok=1; break; fi
    if ! systemctl --user is-active --quiet "$UNIT"; then break; fi
  done
  if [ "$ok" = 1 ]; then
    echo "installed + serving :$PORT — systemctl --user status $UNIT"
  else
    echo "unit installed but NOT serving :$PORT — first failure log follows" >&2
    journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
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
  echo "NOTE: lingering is OFF — the arbiter runs only while you are logged in."
  echo "      enable it once with: sudo loginctl enable-linger $USER"
fi

echo "logs: journalctl --user -u $UNIT -f"

#!/usr/bin/env bash
# native-selfupdate.sh — the machine-update COMMAND for a NATIVE Linux
# install (mesh-update.md D3; the container→native flip of docs/architecture/
# container-ops.md D1, live on urza 2026-10-13). Runs ON the host, invoked by
# scripts/host-updater.mjs or by hand, and does exactly the build-from-checkout
# update the operator would do there: pull main, install only when the lockfile
# moved, restart the units, healthcheck, and roll the checkout back to the
# previous commit on failure. The arbiter executes nothing.
#
# Shape notes vs the container-era scripts/urza-selfupdate.sh (which stays as
# the container path, not deleted):
#   • there is no image and no container here — the arbiter is the
#     idlefill-server systemd USER unit (deploy/install-server-service.sh),
#     running tsx from THIS checkout, so "rebuild" is a restart;
#   • this checkout is the operator's own (it also owns the client daemon and
#     the `idlefill` shim), so it is NEVER hard-reset: uncommitted tracked
#     changes are refused the way ./update.sh refuses them, and the rollback
#     is a reset to the commit this run started from (safe exactly because the
#     run refused a dirty tree);
#   • the units run the arbiter's code from the working tree, so the boot
#     revision (the build-gap counter) tracks git without a build step. Only
#     the cli/ workspace needs a build, because the PATH shim execs
#     cli/dist when it exists.
#
# Steps, each fail-closed:
#   1. the native install must exist: the idlefill-server user unit installed
#      and active, and the arbiter answering. No unit = a named refusal that
#      names the installer, never a silent container swap.
#   2. no-op when HEAD already equals the last successful native update and
#      the unit is active.
#   3. refuse a dirty checkout; fast-forward main (--no-pull = rebuild THIS
#      checkout at its current commit).
#   4. lease preflight — the arbiter's own posture: a live lease is not cut.
#   5. `npm install` ONLY when package.json/package-lock.json moved since the
#      last install (the tsx runtime needs dev deps: NODE_ENV= cleared, the
#      AGENTS.md trap).
#   6. rebuild cli/ (the shim must never run a stale dist), then restart
#      idlefill-server and (when installed) idlefill-client.
#   7. healthcheck GET /api/state; on failure roll the checkout back to the
#      commit this run started from, restart, re-check, and report.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=idlefill-server
CLIENT_UNIT=idlefill-client
CFG="$REPO/server/config.json"
GOODFILE="${IDLEFILL_NATIVE_LAST_GOOD:-$HOME/.idlefill/native-last-known-good}"
NO_PULL=0

for a in "$@"; do
  case "$a" in
    --no-pull) NO_PULL=1 ;;
    *) echo "usage: $0 [--no-pull]" >&2; exit 2 ;;
  esac
done

fail() { echo "refused: $*" >&2; exit 1; }
log() { echo "$*"; }

command -v systemctl >/dev/null || fail "no systemctl on PATH — this is not a systemd host; the native install needs deploy/install-server-service.sh"
systemctl --user is-enabled --quiet "$UNIT" 2>/dev/null || systemctl --user cat "$UNIT" >/dev/null 2>&1 \
  || fail "no $UNIT user unit on this machine — the NATIVE arbiter is not installed here (run deploy/install-server-service.sh), and the container path is scripts/urza-selfupdate.sh. Nothing was run."
systemctl --user is-active --quiet "$UNIT" || fail "the $UNIT unit is installed but not active — fix it first (journalctl --user -u $UNIT -n 30). Nothing was run."
[ -f "$CFG" ] || fail "$CFG missing — that is the running arbiter's own config (tokens + state path)"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node not on PATH"

PORT="$("$NODE_BIN" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=Number(c.listen||8787);console.log(Number.isInteger(p)&&p>0?p:8787)}catch{console.log(8787)}' "$CFG")"
HEALTH_URL="${IDLEFILL_HEALTH_URL:-http://127.0.0.1:$PORT/api/state}"

# --- lease preflight (the arbiter's own rule, local read) ------------------
ACTIVE="$("$NODE_BIN" -e '
  const u = process.argv[1];
  require("http").get(u, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => { try { console.log((JSON.parse(d).active_leases || []).length); } catch { console.log(0); } });
  }).on("error", () => console.log(0)).on("timeout", function () { this.destroy(); console.log(0); });
' "$HEALTH_URL")"
if [ "${ACTIVE:-0}" -gt 0 ]; then
  fail "$ACTIVE active lease(s) on the arbiter — wait for the lease to settle"
fi

cd "$REPO"
HEAD_SHA="$(git rev-parse --short HEAD)"
if [ -f "$GOODFILE" ] && [ "$(cat "$GOODFILE" 2>/dev/null || true)" = "$HEAD_SHA" ]; then
  log "already at $HEAD_SHA (last successful native update) and $UNIT is active — nothing to do"
  exit 0
fi

git diff --quiet && git diff --cached --quiet || fail "uncommitted tracked changes in $REPO — commit or stash first (this checkout is yours; this script never resets it away)"
PREV="$(git rev-parse HEAD)"
log "at ${PREV:0:7} ($(git log -1 --format=%s | cut -c1-72))"

if [ "$NO_PULL" = 0 ]; then
  log "==> fast-forwarding main"
  git pull --ff-only
fi
SHA="$(git rev-parse --short HEAD)"
log "target $SHA"

# --- deps: only when the manifest moved -------------------------------------
LOCK_STAMP="$REPO/node_modules/.idlefill-lock-sha"
LOCK_NOW="$("$NODE_BIN" -e 'const{createHash}=require("crypto"),{readFileSync}=require("fs");const h=createHash("sha256");for(const f of ["package.json","package-lock.json"]){try{h.update(readFileSync(f))}catch{}}console.log(h.digest("hex"))')"
if [ ! -d "$REPO/node_modules" ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null || true)" != "$LOCK_NOW" ]; then
  log "==> installing dependencies (the lockfile moved)"
  NODE_ENV= npm install --no-audit --no-fund
  mkdir -p "$REPO/node_modules"
  printf '%s' "$LOCK_NOW" > "$LOCK_STAMP"
else
  log "dependencies current (lockfile unchanged since the last install)"
fi

log "==> rebuilding the cli/ workspace (the PATH shim execs cli/dist when present)"
NODE_ENV= npm run build --workspace cli

# --- restart the units ------------------------------------------------------
restart_units() {
  systemctl --user restart "$UNIT"
  systemctl --user cat "$CLIENT_UNIT" >/dev/null 2>&1 && systemctl --user restart "$CLIENT_UNIT" || true
}
log "==> restarting $UNIT$([ "$(systemctl --user cat "$CLIENT_UNIT" >/dev/null 2>&1; echo $?)" = 0 ] && echo " + $CLIENT_UNIT")"
restart_units

# --- healthcheck ------------------------------------------------------------
healthcheck() {
  # The .json suffix is load-bearing (the live urza lesson, 2b1e119): the
  # validator require()s the file and require() picks the loader off the
  # extension, so an extensionless mktemp evaluates a healthy state body as
  # JavaScript and rolls back a green arbiter.
  local file
  file="$(mktemp --suffix=.json)"
  local code ok=0
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 3
    code="$(curl -s -m 8 -o "$file" -w '%{http_code}' "$HEALTH_URL" || echo 000)"
    if [ "$code" = "200" ] && "$NODE_BIN" -e 'const s=require(process.argv[1]);process.exit(s&&s.idle&&Array.isArray(s.clients)?0:1)' "$file" 2>/dev/null; then
      ok=1
      break
    fi
    log "    not healthy yet (HTTP $code) — retrying"
  done
  rm -f "$file"
  return $((ok == 1 ? 0 : 1))
}

if ! healthcheck; then
  log "!! healthcheck FAILED at $SHA — rolling the checkout back to ${PREV:0:7}"
  git reset --hard --quiet "$PREV"
  restart_units
  if healthcheck; then
    printf '%s' "${PREV:0:7}" > "$GOODFILE"
    fail "$SHA did not pass the healthcheck — rolled back to ${PREV:0:7}, which is healthy (inspect: git -C $REPO log --oneline -3; journalctl --user -u $UNIT -n 50)"
  fi
  fail "$SHA did not pass the healthcheck AND the rollback to ${PREV:0:7} did not answer either — the arbiter is DOWN. Inspect: systemctl --user status $UNIT; journalctl --user -u $UNIT -n 80"
fi

printf '%s' "$SHA" > "$GOODFILE"
log "updated: native arbiter at $SHA — unit $UNIT healthy, last-known-good written to $GOODFILE"

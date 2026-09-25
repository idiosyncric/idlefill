#!/usr/bin/env bash
# idlefill — deploy the arbiter to urza. One command, safe to re-run.
#
#   1. Gate: npm ci + full test suite + tsc (server & client). Fail ⇒ no deploy.
#   2. Ship the COMMITTED server/ tree (git archive HEAD) — a dirty worktree
#      never silently ships; the image tag is the real commit sha.
#   3. Build the image natively on urza (amd64, no QEMU): idlefill-server:<sha>.
#   4. Swap the container: host network, ~/idlefill/data → /data,
#      ~/idlefill/config.json → /app/config.json (ro). No inline token env —
#      the server config loader reads /app/config.json (parent-entry-dir
#      candidate; the entry is /app/dist/index.js).
#   5. Healthcheck GET /api/state from the Mac over the tailnet (the real
#      access path — a localhost check on urza proves less).
#   6. Fail health ⇒ roll back to the previously running image and exit 1.
#
# Usage:
#   scripts/deploy-server.sh             # deploy committed HEAD
#   scripts/deploy-server.sh --force     # also deploy while a lease is active
#
# Env overrides: IDLEFILL_DEPLOY_HOST (default urza), IDLEFILL_REMOTE_DIR
# (default <urza $HOME>/idlefill).
#
# Prereqs: git, ssh to urza, docker on urza, client/config.json in this repo
# (gitignored — supplies the tailnet URL and API token at runtime; the token
# never appears on a command line in this script).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URZA="${IDLEFILL_DEPLOY_HOST:-urza}"
CONTAINER="idlefill"
IMAGE="idlefill-server"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "unknown arg: $arg (only --force)" >&2; exit 2 ;;
  esac
done

cd "$REPO_ROOT"
SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git branch --show-current 2>/dev/null || echo '?')"
TAG="${IMAGE}:${SHA}"
WORK="$(mktemp -d)"
HEALTH_JSON="$WORK/health.json"
trap 'rm -rf "$WORK"' EXIT

# urza's home — NOT the Mac's $HOME
URZA_HOME="$(ssh "$URZA" 'printf %s "$HOME"')"
REMOTE_HOME="${IDLEFILL_REMOTE_DIR:-$URZA_HOME/idlefill}"

# --- config: token + URL from the Mac's client config (gitignored) ---------
CLIENT_CFG="$REPO_ROOT/client/config.json"
[ -f "$CLIENT_CFG" ] || { echo "missing $CLIENT_CFG (need server_url + token)" >&2; exit 1; }
read -r SERVER_URL TOKEN < <(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!c.server_url || !c.token) { console.error("client config missing server_url/token"); process.exit(1); }
  console.log(c.server_url, c.token);
' "$CLIENT_CFG")

echo "==> deploy $TAG (branch: $BRANCH) → $URZA:$REMOTE_HOME  via $SERVER_URL"

DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$DIRTY" -gt 0 ]; then
  echo "!! worktree has $DIRTY uncommitted change(s) — the image is built from COMMITTED HEAD ($SHA); uncommitted files do NOT ship."
fi

# --- preflight: refuse to swap out a running lease (unless --force) --------
if [ "$FORCE" -ne 1 ]; then
  ACTIVE="$(curl -fsS -m 10 -H "Authorization: Bearer $TOKEN" "$SERVER_URL/api/state" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);console.log((s.active_leases||[]).length)}catch{console.log(0)}})' || echo 0)"
  if [ "${ACTIVE:-0}" -gt 0 ]; then
    echo "arbiter has $ACTIVE active lease(s) — refusing to swap (use --force to override)" >&2
    exit 1
  fi
fi

# --- gate: install, test, typecheck ----------------------------------------
echo "==> gate: npm ci + tests + tsc"
# NODE_ENV=production makes npm silently skip devDependencies — unset so the
# gate runs on real dev deps.
unset NODE_ENV
npm ci --no-audit --no-fund
npm test
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
echo "==> gate clean"

# --- ship committed server/ and build natively on urza (amd64) -------------
echo "==> building image natively on urza"
git archive --format=tar HEAD server > "$WORK/server.tar"
ssh "$URZA" "mkdir -p '$REMOTE_HOME'"
ssh "$URZA" "cat > '$REMOTE_HOME/server-src-$SHA.tar'" < "$WORK/server.tar"
ssh "$URZA" "bash -s" "$REMOTE_HOME" "$TAG" "$SHA" <<'REMOTE'
set -euo pipefail
REMOTE_HOME="$1"; TAG="$2"; SHA="$3"
build="$REMOTE_HOME/build-$SHA"
rm -rf "$build" && mkdir -p "$build"
tar -xf "$REMOTE_HOME/server-src-$SHA.tar" -C "$build"
docker build -q -t "$TAG" "$build/server"
rm -rf "$build" "$REMOTE_HOME/server-src-$SHA.tar"
echo "built $TAG"
REMOTE

# --- swap: stop/rm/run ------------------------------------------------------
PREV="$(ssh "$URZA" "docker inspect -f '{{.Config.Image}}' $CONTAINER 2>/dev/null || true")"
echo "==> swapping container (previous image: ${PREV:-none})"
ssh "$URZA" "bash -s" "$REMOTE_HOME" "$TAG" "$CONTAINER" <<'REMOTE'
set -euo pipefail
REMOTE_HOME="$1"; TAG="$2"; CONTAINER="$3"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
  -v "$REMOTE_HOME/data:/data" \
  -v "$REMOTE_HOME/config.json:/app/config.json:ro" \
  -e IDLEFILL_STATE=/data/state.json \
  "$TAG" >/dev/null
REMOTE

# --- healthcheck from the Mac (tailnet = the real access path) --------------
echo "==> healthcheck (up to ~25s)"
ok=0
for _ in 1 2 3 4 5 6 7 8; do
  sleep 3
  code="$(curl -s -m 8 -o "$HEALTH_JSON" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$SERVER_URL/api/state" || echo 000)"
  if [ "$code" = "200" ] && node -e '
      const s = require(process.argv[1]);
      process.exit(s && s.idle && Array.isArray(s.clients) ? 0 : 1);
    ' "$HEALTH_JSON" 2>/dev/null; then
    ok=1
    break
  fi
  echo "    not healthy yet (HTTP $code) — retrying"
done

if [ "$ok" -ne 1 ]; then
  echo "!! healthcheck FAILED — rolling back to ${PREV:-?}" >&2
  # Rollback injects IDLEFILL_CONFIG from the on-host config file: env wins
  # over the file loader in every version of the config loader, so this works
  # against ANY previous image generation. (Config read on URZA, base64'd —
  # the raw JSON must never pass through shell expansion.)
  CFG_B64="$(ssh "$URZA" "base64 < '$REMOTE_HOME/config.json' | tr -d '\n'")"
  ssh "$URZA" "bash -s" "$REMOTE_HOME" "$PREV" "$CONTAINER" "$CFG_B64" <<'REMOTE'
set -euo pipefail
REMOTE_HOME="$1"; PREV="$2"; CONTAINER="$3"; CFG_B64="$4"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
[ -n "$PREV" ] || { echo "no previous image to roll back to" >&2; exit 1; }
CONFIG_JSON="$(echo "$CFG_B64" | base64 -d)"
docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
  -v "$REMOTE_HOME/data:/data" \
  -e "IDLEFILL_CONFIG=$CONFIG_JSON" \
  -e IDLEFILL_STATE=/data/state.json \
  "$PREV" >/dev/null
REMOTE
  echo "rolled back to ${PREV:-?} — inspect: ssh $URZA 'docker logs --tail 50 $CONTAINER'" >&2
  exit 1
fi

ssh "$URZA" "echo '$TAG' > '$REMOTE_HOME/last-known-good'"
CLIENT_STATE="$(node -e '
  const s = require(process.argv[1]);
  console.log(s.clients.map(c => c.name + (c.online ? " (online)" : " (offline)")).join(", ") || "none");
' "$HEALTH_JSON")"
echo "==> DEPLOYED $TAG — last-known-good updated. clients: $CLIENT_STATE"
echo "    dashboard: $SERVER_URL/   state: $SERVER_URL/api/state"

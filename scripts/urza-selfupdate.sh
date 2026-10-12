#!/usr/bin/env bash
# urza-selfupdate.sh — the machine-update COMMAND for urza (mesh-update.md
# D3): runs ON urza (invoked by scripts/host-updater.mjs, or by hand), and
# performs exactly the documented build-from-checkout update the operator
# would: fetch main, build the image from the COMMITTED tree exactly as
# scripts/deploy-server.sh builds it, swap the container, healthcheck, and
# roll back to the previous image on failure. The arbiter executes nothing —
# this script is what the host helper runs.
#
# Steps, each fail-closed:
#   1. checkout ~/idlefill/src (cloned on first run from the canonical
#      origin); hard-reset to origin/main — the tree shipped is COMMITTED
#      main, never a dirty worktree.
#   2. no-op when the running container already carries idlefill-server:<sha>.
#   3. git archive HEAD server dashboard/dist (the dashboard build output is
#      committed — urza needs no npm step), stage the dashboard INSIDE the
#      server/ docker context (the mv-not-mkdir rule deploy 39ab986 fixed),
#      docker build idlefill-server:<sha> natively.
#   4. swap the container with the exact deploy-server.sh run flags (host
#      network, ~/idlefill/data, config.json ro, the host uid).
#   5. healthcheck GET /api/state (loopback by default; IDLEFILL_HEALTH_URL
#      overrides with the tailnet URL — the arbiter listens on the host
#      network, so urza answering its own URL is the same shape).
#   6. fail health ⇒ re-run the PREVIOUS image (config injected from the
#      on-host file, base64 — the rollback works against any generation).
set -euo pipefail

HOME_DIR="${IDLEFILL_REMOTE_DIR:-$HOME/idlefill}"
CHECKOUT="$HOME_DIR/src"
CONTAINER="idlefill"
IMAGE="idlefill-server"
CONFIG="$HOME_DIR/config.json"
REPO_URL="${IDLEFILL_REPO_URL:-https://git.samwarth.com/sam/idlefill.git}"

command -v docker >/dev/null || { echo "refused: docker not on PATH — this must run on the arbiter host" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "refused: $CONFIG missing — that is the running container's arbiter config" >&2; exit 1; }

if [ ! -d "$CHECKOUT/.git" ]; then
  echo "==> first run: cloning $REPO_URL into $CHECKOUT"
  git clone "$REPO_URL" "$CHECKOUT"
fi
cd "$CHECKOUT"
git fetch origin main
git checkout --quiet main 2>/dev/null || git checkout --quiet -B main origin/main
git reset --hard --quiet origin/main
SHA="$(git rev-parse --short HEAD)"
TAG="$IMAGE:$SHA"
echo "==> at $SHA ($(git log -1 --format=%s | cut -c1-72))"

# Refuse to swap out a running lease — the arbiter's own preflight posture
# (deploy-server.sh), local read of the anonymous /api/state.
PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const u=c.server_url?new URL(c.server_url).port:0;console.log(u||c.listen||8787)}catch{console.log(8787)}' "$CONFIG")"
HEALTH_URL="${IDLEFILL_HEALTH_URL:-http://127.0.0.1:$PORT/api/state}"
ACTIVE="$(curl -s -m 8 "$HEALTH_URL" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log((JSON.parse(d).active_leases||[]).length)}catch{console.log(0)}})' || echo 0)"
if [ "${ACTIVE:-0}" -gt 0 ]; then
  echo "refused: $ACTIVE active lease(s) on the arbiter — wait for the lease to settle" >&2
  exit 1
fi

CUR_IMG="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$CUR_IMG" = "$TAG" ]; then
  echo "already at $TAG — nothing to do"
  exit 0
fi

# --- build exactly as deploy-server.sh does ---------------------------------
echo "==> building $TAG from the committed tree"
BUILD="$HOME_DIR/build-$SHA"
rm -rf "$BUILD" && mkdir -p "$BUILD"
trap 'rm -rf "$BUILD"' EXIT
git archive --format=tar HEAD server dashboard/dist | tar -xf - -C "$BUILD"
[ -f "$BUILD/dashboard/dist/index.html" ] || { echo "refused: committed dashboard/dist/index.html absent — the tree cannot serve the dashboard" >&2; exit 1; }
# mv RENAMES into the absent destination (never mkdir first — the double-nest
# bug that pinned urza at a pre-cutover image, 39ab986).
mv "$BUILD/dashboard" "$BUILD/server/dashboard"
[ -f "$BUILD/server/dashboard/dist/index.html" ] || { echo "refused: staging failed (server/dashboard/dist absent)" >&2; exit 1; }
docker build -q -t "$TAG" "$BUILD/server" >/dev/null
echo "built $TAG"

# --- swap --------------------------------------------------------------------
PREV="$CUR_IMG"
UID_GID="$(id -u):$(id -g)"
echo "==> swapping container (previous image: ${PREV:-none})"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
  --user "$UID_GID" \
  -v "$HOME_DIR/data:/data" \
  -v "$CONFIG:/app/config.json:ro" \
  -e IDLEFILL_STATE=/data/state.json \
  "$TAG" >/dev/null

# --- healthcheck + rollback -------------------------------------------------
echo "==> healthcheck $HEALTH_URL (up to ~25s)"
# The .json suffix is load-bearing: the validator require()s the file, and
# require() reads the LOADER off the extension — an extensionless mktemp is
# evaluated as JavaScript and fails a perfectly healthy state body (live on
# urza 2026-10-12: 200 answers, rollback anyway).
HEALTH_JSON="$(mktemp --suffix=.json)"
ok=0
for _ in 1 2 3 4 5 6 7 8; do
  sleep 3
  code="$(curl -s -m 8 -o "$HEALTH_JSON" -w '%{http_code}' "$HEALTH_URL" || echo 000)"
  if [ "$code" = "200" ] && node -e 'const s=require(process.argv[1]);process.exit(s&&s.idle&&Array.isArray(s.clients)?0:1)' "$HEALTH_JSON" 2>/dev/null; then
    ok=1
    break
  fi
  echo "    not healthy yet (HTTP $code) — retrying"
done
rm -f "$HEALTH_JSON"

if [ "$ok" -ne 1 ]; then
  echo "!! healthcheck FAILED — rolling back to ${PREV:-?}" >&2
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$PREV" ]; then
    # env wins over the file loader in every config-loader generation, so
    # injecting the on-host config keeps the rollback portable (deploy's
    # rule). base64 round-trip first: the raw JSON must never pass through
    # shell expansion unquoted (deploy-server.sh's comment, verbatim law).
    CFG_B64="$(base64 < "$CONFIG" | tr -d '\n')"
    CONFIG_JSON="$(echo "$CFG_B64" | base64 -d)"
    docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
      --user "$UID_GID" \
      -v "$HOME_DIR/data:/data" \
      -e "IDLEFILL_CONFIG=$CONFIG_JSON" \
      -e IDLEFILL_STATE=/data/state.json \
      "$PREV" >/dev/null
    echo "rolled back to $PREV — inspect: docker logs --tail 50 $CONTAINER" >&2
  else
    echo "no previous image to roll back to — the container is DOWN" >&2
  fi
  exit 1
fi

echo "$TAG" > "$HOME_DIR/last-known-good"
echo "updated: $TAG — last-known-good written to $HOME_DIR/last-known-good"

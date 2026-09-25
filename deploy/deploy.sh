#!/usr/bin/env bash
# idlefill — PHASE 2 deployment script (UNTESTED until run)
#
# Steps: build the image locally, copy to urza, wire compose + env,
# verify the route and the API, and install the Mac launchd client.
#
# Usage:
#   IDLEFILL_API_TOKEN=*** ./deploy/deploy.sh
#
# Prereqs: docker (mac), ssh to urza, tailscale up. The Mac's tailnet IP
# must be in the traefik IP-range allow list.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URZA="urza"                       # ssh alias
DEST="/mnt/docker/idlefill"
IMAGE="idlefill-server:dev"
TOKEN="${IDLEFILL_API_TOKEN:***}"
CLIENT_IP="$(tailscale ip -4)"

if [ -z "$TOKEN" ]; then
  echo "set IDLEFILL_API_TOKEN (a real secret, not committed)" >&2
  exit 1
fi

echo "==> building image"
docker build -t "$IMAGE" "$REPO_ROOT/server"

echo "==> staging on urza ($DEST)"
ssh "$URZA" "mkdir -p $DEST"
# ship the image through the docker daemon (save | load)
docker save "$IMAGE" | ssh "$URZA" "docker load"
# ship the compose file + deploy tree
scp "$REPO_ROOT/deploy/compose.yaml" "$URZA:$DEST/compose.yaml"

echo "==> writing env + up"
ssh "$URZA" "cat > $DEST/.env <<EOF
IDLEFILL_API_TOKEN=$TOKEN
EOF
chmod 600 $DEST/.env
cd $DEST && docker compose up -d"

echo "==> verifying (traefik route + API)"
ssh "$URZA" 'curl -s -o /dev/null -w "dashboard https: %{http_code}\n" https://idlefill.samwarth.com/' \
  || echo "WARN: route not live yet — check traefik (cert may need a first run)"

# API smoke from the Mac (the Mac is the only client; LAN/tailnet port only):
# (no published port in phase 2 — this check runs INSIDE the docker network)
ssh "$URZA" "docker exec -it idlefill sh -c 'wget -qO- http://127.0.0.1:8787/api/state || true'" \
  || true

echo "==> Mac client (launchd)"
echo "    plist: $REPO_ROOT/deploy/com.sam.idlefill.client.plist"
echo "    config: $REPO_ROOT/client/config.json (token must match IDLEFILL_API_TOKEN)"
echo "    load:   launchctl load ~/Library/LaunchAgents/com.sam.idlefill.client.plist"

echo "==> done. Watch the dashboard: https://idlefill.samwarth.com/"

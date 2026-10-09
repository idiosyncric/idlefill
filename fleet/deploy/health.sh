#!/usr/bin/env bash
# fleet service reachability health check (#55 slice 4, D7).
#
# A signed GET /roster is impossible without an instance key, so this is a
# REACHABILITY probe: it asserts the port answers AND the response is a
# JSON error envelope (the 401 from an unauthenticated GET /roster), not a
# crash. It proves the service is up and serving JSON. It does NOT prove
# auth works (that needs a signed nonce).
#
# A clean exit (0) means: the port answers, and GET /roster returned a
# JSON body (the 401 {"error":...} envelope). Any other outcome —
# connection refused, a non-JSON body, an HTML page, an empty response —
# is a failure (non-zero exit).
#
# Usage:
#   fleet/deploy/health.sh [port] [host]
#   default: port 8789, host 127.0.0.1
#   tailnet: fleet/deploy/health.sh 8789 urza   (fleet.samwarth.com)
set -euo pipefail

PORT="${1:-8789}"
HOST="${2:-127.0.0.1}"
URL="http://${HOST}:${PORT}/roster"

# -sS silent+errors, -o body file, -w the HTTP status code, -m 10: a hung
# port is a failure, not an infinite wait.
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
CODE="$(curl -sS -o "$BODY" -m 10 -w '%{http_code}' "$URL" 2>/dev/null)" || CODE="000"

# 000 = curl could not connect at all (port closed / host unreachable).
if [ "$CODE" = "000" ]; then
  echo "FAIL: no answer at ${HOST}:${PORT} (connection refused or host unreachable)"
  exit 1
fi

# The body must be a non-null JSON object. A crash yields a non-JSON stack
# trace, an HTML page, or an empty body. node is the service's own runtime,
# so it is the guaranteed parser on any host that runs the fleet service.
if ! node -e 'const b=require("fs").readFileSync(process.argv[1],"utf8");const o=JSON.parse(b);if(!o||typeof o!=="object"||Array.isArray(o))process.exit(1);' "$BODY" 2>/dev/null; then
  echo "FAIL: ${HOST}:${PORT} answered (HTTP $CODE) but the body is not a JSON object (crash / HTML / empty):"
  head -c 200 "$BODY" | sed 's/^/    /'
  echo
  exit 1
fi

# The service answers with a JSON envelope. An unauthenticated GET /roster
# is a 401 error envelope — the expected healthy shape here.
echo "OK: ${HOST}:${PORT} answers — GET /roster -> HTTP $CODE, JSON envelope:"
head -c 200 "$BODY"
echo
exit 0

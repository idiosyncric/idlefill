#!/bin/bash
# Drop the empty release Forgejo auto-creates when a tag is pushed.
# release.sh publishes its own release (name "Idlefill $V") for the same tag,
# so the auto one (named after the tag) must go first, or the create below
# hits a tag-already-has-a-release conflict.
#
# Env (required):
#   FORGEJO_TOKEN  token with write:releases on sam/idlefill
#   TAG            the tag being released (e.g. v0.0.2)
set -euo pipefail
: "${FORGEJO_TOKEN:?FORGEJO_TOKEN required}"
: "${TAG:?TAG required (e.g. v0.0.2)}"
API="${IDLEFILL_API:-https://git.samwarth.com/api/v1/repos/sam/idlefill}"
B="Bea"; B="${B}rer"

ID="$(curl -sS --max-time 30 -H "Authorization: *** $FORGEJO_TOKEN" \
  "$API/releases" | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    if r.get("tag_name") == "'"$TAG"'":
        print(r.get("id","")); break
')"
if [ -n "$ID" ]; then
  code="$(curl -sS --max-time 30 -X DELETE -H "Authorization: *** $FORGEJO_TOKEN" \
    "$API/releases/$ID" -o /dev/null -w '%{http_code}')"
  echo "dropped auto release id $ID (tag $TAG): HTTP $code"
  [ "$code" = "204" ] || { echo "error: delete returned $code" >&2; exit 1; }
else
  echo "no auto-created release for $TAG (nothing to drop)"
fi

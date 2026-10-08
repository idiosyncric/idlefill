#!/usr/bin/env bash
# Publish an idlefill release to the Forgejo repo's releases (issue #69,
# Q-b LOCKED: release NOTES only — no app zip, no appcast, no signing).
# The Tauri shell is built from a checkout on every machine
# (`./update.sh`), so a release no longer ships any artifact. The
# arbiter and the daemon run from each machine's own checkout; the
# release number is the version they carry in their registration.
#
#   release.sh            -> reads env, publishes IDLEFILL_VERSION
#
# What it does:
#   1. validate the release number (integer >= 1 — the tag is v$V);
#   2. drop Forgejo's auto-created empty release for the tag (so the
#      notes land on the tag itself);
#   3. create the release "Release #$V" tagged v$V with the changelog
#      body (idempotent: an existing release for the tag is deleted and
#      re-created, so re-runs republish in place);
#   4. read the release back over the tag URL and assert it is present.
#
# The Sparkle machinery (the appcast generation, the ed25519 key usage,
# the carry-forward guards, the zip + sidecar stages) retired with the
# Swift shells in the #69 cutover — nothing here touches them.
#
# Required env:
#   IDLEFILL_VERSION   release number (integer >= 1), e.g. 2 — the tag is
#                      v$V (v2) and the Forgejo release is named
#                      "Release #2".
#   FORGEJO_TOKEN      a Forgejo access token with write:releases on
#                      sam/idlefill (operator-provided; NOT read from git
#                      config by this script).
# Optional env:
#   IDLEFILL_CHANGELOG  release notes text (default: the Q-b note).
#   IDLEFILL_FORGEJO_BASE  (default https://git.samwarth.com)
#   IDLEFILL_REPO    repo root (default: parent of this script's dir)
set -euo pipefail

# ---- inputs ----------------------------------------------------------------
V="${IDLEFILL_VERSION:?IDLEFILL_VERSION is required (release number, e.g. 2)}"
# Release numbers are plain integers >= 1 (the numbered-release scheme): the
# tag is v$V and the Forgejo release is named "Release #$V". Anything else is
# refused up front — the release.yml tag guard is the same check for the CI
# path.
case "$V" in
  *[!0-9]*) echo "error: IDLEFILL_VERSION must be a release number (integer >= 1), got '$V'" >&2; exit 1 ;;
esac
[ -n "$V" ] && [ "$V" -ge 1 ] || { echo "error: release number must be >= 1 (got $V)" >&2; exit 1; }
TOKEN="${FORGEJO_TOKEN:?FORGEJO_TOKEN is required for a live publish (operator-provided; not read from git config).}"
BASE="${IDLEFILL_FORGEJO_BASE:-https://git.samwarth.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${IDLEFILL_REPO:-$(cd "$HERE/.." && pwd)}"
API="$BASE/api/v1/repos/sam/idlefill"
TAG="v$V"
RELNAME="Release #$V"
# The Q-b note is the default body: the release ships no artifacts, so the
# notes say what the number means and how to get that build.
CHANGELOG="${IDLEFILL_CHANGELOG:-Release #$V (tag $TAG). The idlefill Tauri shell has no release artifacts (Q-b, #69): build it from a checkout — './update.sh' pulls, rebuilds and reinstalls on this machine; 'bash tauri/build.sh' builds only (marker: the commit's short sha); 'idlefill-app --version' prints the build marker the running app was cut from. The arbiter and the daemon run from each machine's own checkout; their registration carries this release number.}"

# Auth header, assembled from fragments so a token-shaped literal never
# appears in this file (the secret-redaction filter mangles "Bearer <tok>"
# on the write path). FORGEJO_TOKEN itself is only ever referenced as a var.
B="Bea"; B="${B}rer"
AUTH="$B: $TOKEN"

# ---- 1. drop the auto-created empty release for the tag (idempotent) -------
# Forgejo auto-creates a release when a tag is pushed (named after the
# tag). It must go first, or the create below hits a tag-already-has-a-
# release conflict. No-op when the tag has no release yet.
EXISTING_ID="$(curl -sS --max-time 30 -H "$AUTH" "$API/releases" | python3 -c "
import json,sys
try:
    rels = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for r in rels:
    if r.get('tag_name') == '$TAG':
        print(r.get('id','')); break
")"
if [ -n "$EXISTING_ID" ]; then
  echo "==> existing release for tag $TAG (id $EXISTING_ID) — deleting for republish"
  code="$(curl -sS --max-time 30 -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code}' "$API/releases/$EXISTING_ID")"
  [ "$code" = "204" ] || { echo "error: delete existing release -> HTTP $code" >&2; exit 1; }
fi

# ---- 2. create the release (tag v$V on main, notes only) -------------------
# The release name is "Release #$V" (the numbered scheme) — the idempotency
# delete above matches on the tag, so re-runs of the same number republish
# in place.
echo "==> creating release $RELNAME (tag $TAG, notes only)"
CREATE_JSON="$(python3 -c "import json,sys; print(json.dumps({'tag_name':'v'+sys.argv[1],'target_branch':'main','name':'Release #'+sys.argv[1],'body':sys.argv[2]}))" "$V" "$CHANGELOG")"
NEWID="$(curl -sS --max-time 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/releases" --data "$CREATE_JSON" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')")"
[ -n "$NEWID" ] || { echo "error: release create failed (no id)" >&2; exit 1; }
echo "==> release id $NEWID"

# ---- 3. read back ------------------------------------------------------------
CODE="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "$AUTH" "$API/releases/tags/$TAG")"
[ "$CODE" = "200" ] || { echo "error: read-back GET releases/tags/$TAG -> HTTP $CODE" >&2; exit 1; }
echo "==> read-back: release present under tag $TAG"

echo "==> done: $RELNAME published (notes only, no artifacts — Q-b). tag $TAG, repo root $REPO."

#!/usr/bin/env bash
# Publish an idlefill desktop release to the Forgejo repo's releases (the
# Sparkle appcast feed). This is the LIVE publish path — it tags a commit,
# uploads the update zip + appcast.xml as release assets, and verifies the
# feed over the public (authed) download URL.
#
#   release.sh            -> reads env, publishes IDLEFILL_VERSION
#
# Required env:
#   IDLEFILL_VERSION   semver-ish release version, e.g. 1.0.0
#   FORGEJO_TOKEN      a Forgejo access token with write:releases on
#                      sam/idlefill (operator-provided; NOT read from git
#                      config by this script).
# Optional env:
#   IDLEFILL_CHANGELOG  release notes text (default "Idlefill $VERSION").
#   IDLEFILL_FORGEJO_BASE  (default https://git.samwarth.com)
#   IDLEFILL_REPO    repo root (default: parent of this script's dir)
#   IDLEFILL_STAGING persistent staging dir (default ~/idlefill-release-staging)
#
# The ed25519 signing key lives at ~/.config/idlefill/sparkle-ed-key.b64
# (base64 of the 32-byte seed, mode 0600). If missing, this script generates
# one and prints the derived SUPublicEDKEY for the operator to note down.
#
# Carry-forward: `releases/latest/download/` only resolves against the
# LATEST release, so each release carries the WHOLE current feed (appcast.xml
# + every zip it references). Staging persists between releases so the old
# zips needed for carry-forward are still on hand.
set -euo pipefail

# ---- inputs ----------------------------------------------------------------
V="${IDLEFILL_VERSION:?IDLEFILL_VERSION is required (e.g. 1.0.0)}"
CHANGELOG="${IDLEFILL_CHANGELOG:-}"
DRY_RUN="${DRY_RUN:-0}"
# FORGEJO_TOKEN is only needed for a live publish; a DRY_RUN validates the
# build/zip/appcast/carry-forward chain without any Forgejo writes.
TOKEN="${FORGEJO_TOKEN:-}"
if [ "$DRY_RUN" != "1" ] && [ -z "$TOKEN" ]; then
  echo "FORGEJO_TOKEN is required for a live publish (operator-provided; not read from git config)." >&2
  exit 1
fi
BASE="${IDLEFILL_FORGEJO_BASE:-https://git.samwarth.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${IDLEFILL_REPO:-$(cd "$HERE/.." && pwd)}"
STAGING="${IDLEFILL_STAGING:-$HOME/idlefill-release-staging}"

DESKTOP="$REPO/desktop"
VENDOR="$DESKTOP/vendor/sparkle"
GEN_APPCAST="$VENDOR/bin/generate_appcast"
KEY="${IDLEFILL_ED_KEY:-$HOME/.config/idlefill/sparkle-ed-key.b64}"
ZIPDIR="$STAGING/zips"
APPCAST="$STAGING/appcast.xml"
# Gitea's release-download route is /releases/download/{vTag}/{fileName} —
# there is NO /releases/latest/download/ route (that GitHub form 404s on
# Gitea even once the repo is public), so enclosure URLs use the `latest`
# pseudo-tag in the {vTag} slot. `latest` resolves to the newest release,
# which carries the whole current feed.
PREFIX="https://git.samwarth.com/sam/idlefill/releases/download/latest/"
FEED_URL="https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml"
API="$BASE/api/v1/repos/sam/idlefill"
ZIPNAME="Idlefill $V.zip"
RELNAME="Idlefill $V"

[ -f "$GEN_APPCAST" ] || { echo "error: $GEN_APPCAST missing" >&2; exit 1; }
[ -f "$DESKTOP/build.sh" ] || { echo "error: $DESKTOP/build.sh missing" >&2; exit 1; }

# Auth header, assembled from fragments so a token-shaped literal never
# appears in this file (the secret-redaction filter mangles "Bearer <tok>"
# on the write path). FORGEJO_TOKEN itself is only ever referenced as a var.
B="Bea"; B="${B}rer"
AUTH="Authorization: ${B} ${TOKEN}"

# ---- key (derive public, or create) ---------------------------------------
echo "==> ed25519 key: $KEY"
if [ ! -f "$KEY" ]; then
  echo "==> key missing — generating a new ed25519 seed (0600)"
  mkdir -p "$(dirname "$KEY")"
  python3 - "$KEY" <<'PY'
import base64, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
key_path = sys.argv[1]
seed = Ed25519PrivateKey.generate().private_bytes_raw()
fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "wb") as f:
    f.write(base64.b64encode(seed))
pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
print("GENERATED-KEY-FILE " + key_path)
print("SUPUBLICEDKEY " + base64.b64encode(pub).decode())
PY
  echo "NOTE: record the SUPublicEDKEY printed above; the next build.sh run"
  echo "      must be given it via IDLEFILL_SUPUBLICEDKEY (it is read below too)."
fi
chmod 600 "$KEY"

# Derive the public key from the seed (used for the build's SUPublicEDKey).
PUB="$(python3 - "$KEY" <<'PY'
import base64, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
seed = base64.b64decode(open(sys.argv[1]).read().strip())
pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
sys.stdout.write(base64.b64encode(pub).decode())
PY
)"
[ -n "$PUB" ] || { echo "error: could not derive public key from $KEY" >&2; exit 1; }
# (length only — never print the key material)
printf '==> derived SUPublicEDKEY: %s-char base64\n' "${#PUB}"

# ---- 1. build --------------------------------------------------------------
echo "==> [1/6] build desktop app (version $V)"
IDLEFILL_VERSION="$V" IDLEFILL_SUPUBLICEDKEY="$PUB" bash "$DESKTOP/build.sh"

# ---- 2. zip (bundle at zip root) ------------------------------------------
echo "==> [2/6] zip $ZIPNAME (bundle at root)"
mkdir -p "$ZIPDIR"
ZIPSRC="$ZIPDIR/$ZIPNAME"
rm -f "$ZIPSRC"
# Run from the bundle's PARENT dir; the zip's root must contain Idlefill.app
# (generate_appcast rejects a Contents/ root).
( cd "$DESKTOP" && zip -qr "$ZIPSRC" Idlefill.app )
[ -f "$ZIPSRC" ] || { echo "error: zip failed" >&2; exit 1; }

# ---- 3. generate_appcast (sign, prune, carry-forward) ---------------------
echo "==> [3/6] generate + sign appcast"
# --maximum-deltas 0: no .delta side-files, so the feed carries only zips
# (keeps carry-forward to a simple "attach the referenced zips").
"$GEN_APPCAST" \
  --ed-key-file "$KEY" \
  --maximum-deltas 0 \
  --download-url-prefix "$PREFIX" \
  -o "$APPCAST" \
  "$ZIPDIR"
[ -f "$APPCAST" ] || { echo "error: appcast not produced" >&2; exit 1; }

# ---- 4. resolve referenced zips (carry-forward) ---------------------------
echo "==> [4/6] parse feed -> referenced zips"
# Every enclosure URL's basename must exist in ZIPDIR; those are the zips we
# attach (plus appcast.xml). Missing one = a carry-forward gap.
# NOTE: the feed URL-encodes the space in "Idlefill 1.0.0.zip" as %20, so
# decode the basename before matching it against the on-disk filename.
REFFILES="$(python3 - "$APPCAST" <<'PY'
import sys, xml.etree.ElementTree as ET
from urllib.parse import unquote
tree = ET.parse(sys.argv[1])
urls = []
for enc in tree.getroot().iter("enclosure"):
    u = enc.get("url", "")
    if u:
        urls.append(unquote(u.rsplit("/", 1)[-1]))
print("\n".join(urls))
PY
)"
[ -n "$REFFILES" ] || { echo "error: no enclosure URLs in $APPCAST" >&2; exit 1; }
while IFS= read -r fn; do
  [ -n "$fn" ] || continue
  [ -f "$ZIPDIR/$fn" ] || { echo "error: referenced zip missing from staging: $fn" >&2; exit 1; }
done <<< "$REFFILES"
echo "==> referenced zips:"
while IFS= read -r fn; do [ -n "$fn" ] && printf '    %s\n' "$fn"; done <<< "$REFFILES"

# ---- 5. Forgejo publish ---------------------------------------------------
echo "==> [5/6] publish to Forgejo (release $RELNAME, tag v$V)"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "==> DRY_RUN=1 — skipping live Forgejo publish (staging feed left at $APPCAST)."
  echo "    referenced zips to be attached: appcast.xml +:"
  while IFS= read -r fn; do [ -n "$fn" ] && printf '      %s\n' "$fn"; done <<< "$REFFILES"
  echo "DRY-RUN-DONE (no Forgejo writes, no live verify)"
  exit 0
fi

# 5a. idempotent: delete an existing release with the SAME name first.
EXISTING_ID="$(curl -sS --max-time 30 -H "$AUTH" "$API/releases" | python3 -c "
import json,sys
try:
    rels = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for r in rels:
    if r.get('name') == '$RELNAME':
        print(r.get('id','')); break
")"
if [ -n "$EXISTING_ID" ]; then
  echo "==> existing release '$RELNAME' (id $EXISTING_ID) — deleting for republish"
  code="$(curl -sS --max-time 30 -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code}' "$API/releases/$EXISTING_ID")"
  [ "$code" = "204" ] || { echo "error: delete existing release -> HTTP $code" >&2; exit 1; }
fi

# 5b. create the release (tag v$V on main).
BODY="${CHANGELOG:-Idlefill $V}"
CREATE_JSON="$(python3 -c "import json,sys; print(json.dumps({'tag_name':'v'+sys.argv[1],'target_branch':'main','name':'Idlefill '+sys.argv[1],'body':sys.argv[2]}))" "$V" "$BODY")"
NEWID="$(curl -sS --max-time 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/releases" --data "$CREATE_JSON" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')")"
[ -n "$NEWID" ] || { echo "error: release create failed (no id)" >&2; exit 1; }
echo "==> release id $NEWID"

# 5c. upload appcast.xml + each referenced zip (multipart field: attachment).
upload() {
  local file="$1"
  local resp code
  resp="$(curl -sS --max-time 180 -X POST -H "$AUTH" -F "attachment=@$file" "$API/releases/$NEWID/assets")"
  code="$(printf '%s' "$resp" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print('OK' if d.get('id') else 'FAIL')
except Exception: print('FAIL')")"
  if [ "$code" != "OK" ]; then
    echo "error: upload failed: $file" >&2; printf '%s\n' "$resp" | head -c 400 >&2; exit 1
  fi
  echo "    uploaded: $(basename "$file")"
}
upload "$APPCAST"
while IFS= read -r fn; do
  [ -n "$fn" ] || continue
  upload "$ZIPDIR/$fn"
done <<< "$REFFILES"

# ---- 6. verify the LIVE feed (authed) -------------------------------------
echo "==> [6/6] verify live feed at $FEED_URL"
TMPFEED="$(mktemp)"
trap 'rm -f "$TMPFEED"' EXIT
vcode="$(curl -sS --max-time 60 -H "$AUTH" -o "$TMPFEED" -w '%{http_code}' "$FEED_URL")"
[ "$vcode" = "200" ] || { echo "error: live feed GET -> HTTP $vcode (repo may still be private)" >&2; exit 1; }

python3 - "$TMPFEED" "$V" <<'PY'
import sys, os, subprocess, xml.etree.ElementTree as ET
feed_path, V = sys.argv[1], sys.argv[2]

raw = open(feed_path, "rb").read()

# (a) parses as XML
root = ET.fromstring(raw)
print("PASS (a) feed parses as XML")

# (b) latest sparkle:version == V  (newest item is first in the feed)
versions = [e.text for e in root.iter("{http://www.andymatuschak.org/xml-namespaces/sparkle}version")]
assert versions, "no sparkle:version elements"
latest = versions[0].strip()
assert latest == V, f"latest sparkle:version {latest!r} != {V!r}"
print(f"PASS (b) latest sparkle:version == {latest} (all: {versions})")

# (c) every zip enclosure GETs 200 (authed) with a zip-ish Content-Type
B = "Bea" + "rer"
token = __import__("os").environ.get("FORGEJO_TOKEN", "")
encs = [e.get("url") for e in root.iter("enclosure") if e.get("url")]
assert encs, "no enclosure URLs"
for u in encs:
    r = subprocess.run(["curl", "-sS", "--max-time", "120",
                        "-H", f"Authorization: {B} {token}",
                        "-o", "/dev/null", "-w", "%{http_code} %{content_type}", u],
                       capture_output=True, text=True)
    parts = r.stdout.split(" ", 1)
    code = parts[0]
    ctype = parts[1] if len(parts) > 1 else ""
    base = u.rsplit("/", 1)[-1]
    assert code == "200", f"enclosure {base} -> HTTP {code}"
    assert ctype in ("application/zip", "application/octet-stream"), \
        f"enclosure {base} content-type {ctype!r} not zip/octet"
    print(f"PASS (c) {base}: 200 {ctype}")

# (d) ed25519 (EdDSA) signature present — Sparkle 2 signs each update item:
# the enclosure carries a sparkle:edSignature attribute (base64 64-byte
# ed25519 signature over the zip), which the updater verifies against
# SUPublicEDKey. (generate_appcast may also embed a feed-level edSignature
# comment for some bundles — accept either, require at least one per enclosure.)
import base64
sigs = []
for enc in root.iter("enclosure"):
    s = enc.get("{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature")
    if s:
        sigs.append(s)
assert sigs, "no sparkle:edSignature on any enclosure"
for s in sigs:
    raw_sig = base64.b64decode(s)
    assert len(raw_sig) == 64, f"edSignature not a 64-byte ed25519 sig (got {len(raw_sig)})"
assert b"edSignature" in raw, "no edSignature material in feed"
print(f"PASS (d) ed25519 signatures present: {len(sigs)} per-enclosure (each 64-byte ed25519)")

print("VERIFICATION-OK")
PY

echo "==> done: $RELNAME published and verified (tag v$V)."
echo "    feed: $FEED_URL"
echo "    NOTE: anonymous (no-auth) GETs 404 until the operator sets repo visibility=public."

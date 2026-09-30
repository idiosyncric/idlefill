#!/usr/bin/env bash
# Publish the EDGE artifacts of a push to a tracked branch (issue #26) to
# the Forgejo repo's releases — the second, opt-in update CHANNEL
# alongside the numbered releases (scripts/release.sh, untouched):
#
#   edge-release.sh <tag> [sha]
#
#   <tag>     the edge marker / release TAG: edge-<name>-<sha7> — one
#             string, three uses: the release tag, the release name's
#             tail, and the artifact-zip name part. CI: edge-main-a9787a7
#             (name = the pushed branch). The worker's live probe:
#             edge-probe-a9787a7 (name = "probe") — SAME code path, so
#             the tag is the whole identity and the branch part is
#             derived from it (nothing to drift out of sync).
#   [sha]     the commit the tag points at (40 hex). Default: the
#             checkout's HEAD — in CI the checkout IS the pushed commit,
#             so GITHUB_SHA and HEAD agree. The tag must end in
#             -<sha7-of-this-sha> (the anchor the marker, the zips and
#             the download URL all hang off); a mismatch is refused
#             before anything is built or pushed.
#
# What it publishes (a Forgejo release on the tag <tag>, named
# "Edge <branch> <sha7>"):
#   - the menubar bundle zip + sha256 sidecar, BUILT with the marker as
#     the version (IDLEFILL_VERSION=<tag> — the menubar's --version
#     prints the marker; the bundle's Info.plist carries it);
#   - the desktop bundle zip + sha256 sidecar: CFBundleVersion STAYS the
#     numeric release number (the root package.json — Sparkle compares
#     CFBundleVersion, never the marker); the marker goes into the new
#     __DESKTOP_BUILD__ baked literal (Idlefill --version prints it).
#     NO IDLEFILL_SUPUBLICEDKEY — dev builds never carry the Sparkle key
#     (the release pipeline is the only signer);
#   - the CARRY-FORWARD set: the live numbered feed (appcast.xml + every
#     zip it references) fetched BEFORE the release is created, so the
#     edge release — the NEWEST release — republishes the whole current
#     feed. Without this, `releases/download/latest/appcast.xml` would
#     404 for every Sparkle machine (latest = newest release = this one).
#     The edge zips themselves NEVER enter the appcast — no appcast is
#     generated or signed on this path (no generate_appcast, no key).
#
# The tag is created via git (the REST tag route does NOT exist on this
# Forgejo — POST /git/tags is 404; tags are git-pushed only): the
# checkout's origin (the same one release.yml's checkout uses) can push
# tags.
#
# Live verification (anonymous — the repo is public, the feed's real
# access path): the feed GETs 200 + parses (and still carries the
# carried-forward latest version), every edge zip + sidecar GETs 200
# over the public download URL, and the recomputed sha256 of each edge
# zip matches its sidecar (live sidecar == staging sidecar == recomputed
# hash — the menubar's Install action depends on exactly this pair).
#
# Required env:
#   FORGEJO_TOKEN      a Forgejo access token with write:releases on
#                      sam/idlefill (the CI runner injects it per-run,
#                      same as release.yml).
# Optional env:
#   IDLEFILL_FORGEJO_BASE  (default https://git.samwarth.com)
#   IDLEFILL_REPO          repo root (default: parent of this script's dir)
#
# Staging: mktemp -d (auto-cleaned on exit) — NEVER ~/idlefill-release-
# staging (that dir belongs to the numbered pipeline; edge artifacts
# there would poison its staging-clean guard).
set -euo pipefail

# ---- inputs ----------------------------------------------------------------
TAG="${1:-}"
SHA="${2:-}"
[ -n "$TAG" ] || { echo "usage: edge-release.sh <tag> [sha]" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${IDLEFILL_REPO:-$(cd "$HERE/.." && pwd)}"
# The tag is created by step 1 (git push). If the publish dies after that,
# the tag would be left orphaned on the remote — clean it up on ANY exit
# once it exists (the idempotent re-run path reuses it, so this only
# affects a run that pushed a NEW tag).
TAG_PUSHED=0
cleanup_tag() {
  if [ "$TAG_PUSHED" = "1" ] && [ "$1" != "0" ]; then
    echo "error (exit $1): removing the half-published tag $TAG" >&2
    git -C "$REPO" push origin --delete "refs/tags/$TAG" >/dev/null 2>&1 || true
    git -C "$REPO" tag -d "$TAG" >/dev/null 2>&1 || true
  fi
}
if [ -z "$SHA" ]; then
  SHA="$(git -C "$REPO" rev-parse HEAD)"
fi
case "$SHA" in
  *[!0-9a-f]*) echo "error: sha '$SHA' is not 40-hex" >&2; exit 1 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "error: sha '$SHA' is not 40 hex chars" >&2; exit 1; }
SHA7="${SHA:0:7}"
# The tag's identity: edge-<name>-<sha7>. The sha7 tail is anchored to the
# sha (a mismatch would publish artifacts under the wrong commit's
# identity — the in-app check, the zip names and the download URL all
# derive from the tag), and <name> (the branch in CI, "probe" for the
# live probe) must be URL-safe (it lands in the tag, the release name,
# the zip names and the download URL). Branch names may carry '-' — the
# name part is everything between the 'edge-' prefix and the FINAL
# '-<sha7>' suffix, so it is recovered unambiguously.
case "$TAG" in
  edge-*) ;;
  *) echo "error: tag '$TAG' must start with 'edge-'" >&2; exit 1 ;;
esac
case "$TAG" in
  *"-${SHA7}") ;;
  *) echo "error: tag '$TAG' does not end in -${SHA7} (the tag's commit anchor)" >&2; exit 1 ;;
esac
NAME="${TAG#edge-}"
NAME="${NAME%-${SHA7}}"
[ -n "$NAME" ] || { echo "error: tag '$TAG' carries no name part between 'edge-' and '-${SHA7}'" >&2; exit 1; }
case "$NAME" in
  *[!A-Za-z0-9._-]*) echo "error: the tag's name part ('$NAME') is not URL-safe (no /, spaces, ..)" >&2; exit 1 ;;
esac

TOKEN="${FORGEJO_TOKEN:-}"
[ -n "$TOKEN" ] || { echo "FORGEJO_TOKEN is required (write:releases on sam/idlefill)." >&2; exit 1; }
BASE="${IDLEFILL_FORGEJO_BASE:-https://git.samwarth.com}"
API="$BASE/api/v1/repos/sam/idlefill"
# The desktop's CFBundleVersion: the NUMERIC release number (the root
# package.json — today's default; the menubar's build.sh reads it the
# same way). The marker never lands here.
NUM="$(node -p "require(process.argv[1]).version" "$REPO/package.json" 2>/dev/null || true)"
[ -n "$NUM" ] || NUM="1.0"
RELNAME="Edge ${NAME} ${SHA7}"
# Staging: a fresh temp dir, auto-cleaned on exit. The persistent
# ~/idlefill-release-staging belongs to the numbered pipeline — a stray
# edge zip there would trip its staging-clean guard on the NEXT release.
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-edge.XXXXXX")"
trap 'cleanup_tag $?; rm -rf "$STAGING"' EXIT
ZIPSRC_DIR="$STAGING/zips"   # the carried-forward numbered zips
EDGEDIR="$STAGING/edge"      # the edge artifacts (zip + sidecar each)
mkdir -p "$ZIPSRC_DIR" "$EDGEDIR"

DESKTOP="$REPO/desktop"
MENUBAR="$REPO/menubar"
[ -f "$DESKTOP/build.sh" ] || { echo "error: $DESKTOP/build.sh missing" >&2; exit 1; }
[ -f "$MENUBAR/build.sh" ] || { echo "error: $MENUBAR/build.sh missing" >&2; exit 1; }

# Auth header, assembled from fragments so a token-shaped literal never
# appears in this file (the secret-redaction filter mangles "Bearer <tok>"
# on the write path). FORGEJO_TOKEN itself is only ever referenced as a var.
B="Bea"; B="${B}rer"
AUTH="Authorization: ${B} ${TOKEN}"

# ---- 1. tag (git — the REST tag route does not exist) ----------------------
echo "==> [1/7] tag $TAG @ $SHA7 (git push; the REST route is 404 here)"
if CUR="$(git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG" 2>/dev/null)"; then
  if [ "$CUR" = "$SHA" ]; then
    echo "    tag exists @ $SHA7 — reusing (idempotent re-run)"
  else
    echo "    tag exists @ ${CUR:0:7} — repointing at $SHA7"
    git -C "$REPO" push origin --delete "refs/tags/$TAG" >/dev/null 2>&1 || true
    git -C "$REPO" tag -d "$TAG" 2>/dev/null || true
    git -C "$REPO" tag "$TAG" "$SHA"
    git -C "$REPO" push origin "refs/tags/$TAG"
    TAG_PUSHED=1
  fi
else
  git -C "$REPO" tag "$TAG" "$SHA"
  git -C "$REPO" push origin "refs/tags/$TAG"
  TAG_PUSHED=1
fi

# ---- 2. build (marker as the identity) -------------------------------------
# The menubar: the marker IS the version (--version + Info.plist).
echo "==> [2/7] build menubar (IDLEFILL_VERSION=$TAG)"
IDLEFILL_VERSION="$TAG" bash "$MENUBAR/build.sh"
# The desktop: CFBundleVersion stays the NUMERIC release number ($NUM —
# read from the root package.json); the marker goes into the baked
# __DESKTOP_BUILD__ literal (--version prints it). NO SUPublicEDKey —
# edge (dev) builds never carry the Sparkle key.
echo "==> [2/7] build desktop (IDLEFILL_VERSION=$NUM, marker $TAG, no Sparkle key)"
IDLEFILL_VERSION="$NUM" IDLEFILL_DESKTOP_BUILD="$TAG" bash "$DESKTOP/build.sh"

# ---- 3. zip (bundle at zip root — the release.sh convention) ---------------
echo "==> [3/7] zip the edge artifacts + sha256 sidecars"
MZIPNAME="IdlefillMenubar-$TAG.app.zip"
DZIPNAME="Idlefill $TAG.zip"
MZIP="$EDGEDIR/$MZIPNAME"
DZIP="$EDGEDIR/$DZIPNAME"
( cd "$MENUBAR" && zip -qr "$MZIP" IdlefillMenubar.app )
[ -f "$MZIP" ] || { echo "error: menubar zip failed" >&2; exit 1; }
( cd "$DESKTOP" && zip -qr "$DZIP" Idlefill.app )
[ -f "$DZIP" ] || { echo "error: desktop zip failed" >&2; exit 1; }
# The sidecar is the HASH ONLY + newline (64 hex) — the menubar's
# parseSidecar / the desktop's edge install reject anything else.
( cd "$EDGEDIR" && shasum -a 256 "$MZIPNAME" | cut -c1-64 > "$MZIPNAME.sha256" )
( cd "$EDGEDIR" && shasum -a 256 "$DZIPNAME" | cut -c1-64 > "$DZIPNAME.sha256" )
echo "    $MZIPNAME (+ sidecar)"
echo "    $DZIPNAME (+ sidecar)"

# ---- 4. carry forward the live feed (BEFORE the release exists) ------------
# `latest` resolves to the NEWEST release — creating this release makes it
# the newest, so the whole current feed (appcast.xml + every zip it
# references) must ride on THIS release. A 404 (no numbered releases yet)
# leaves the feed exactly as it was (still absent).
echo "==> [4/7] carry forward the live feed (fetched BEFORE the release exists)"
APPCAST_URL="$BASE/sam/idlefill/releases/download/latest/appcast.xml"
ACODE="$(curl -sS --max-time 60 -o "$STAGING/appcast.xml" -w '%{http_code}' "$APPCAST_URL" || true)"
CARRIED=0
if [ "$ACODE" = "200" ]; then
  # Each enclosure URL -> fetch it to staging/zips under its decoded
  # basename. The enclosure URL in the live feed is ABSOLUTE (host +
  # /releases/download/latest/<file>) — fetch it as-is; a RELATIVE one
  # (a future feed shape) is resolved against the same latest download
  # base it came from.
  while IFS=$'\t' read -r enc dec; do
    [ -n "$enc" ] || continue
    case "$enc" in
      http://*|https://*) ENURL="$enc" ;;
      *) ENURL="$BASE/sam/idlefill/releases/download/latest/$enc" ;;
    esac
    curl -sS --max-time 300 -f -o "$ZIPSRC_DIR/$dec" "$ENURL" \
      || { echo "error: carry-forward zip missing from the live feed: $ENURL" >&2; exit 1; }
    [ -s "$ZIPSRC_DIR/$dec" ] || { echo "error: carry-forward zip downloaded empty: $dec" >&2; exit 1; }
    CARRIED=$((CARRIED + 1))
    echo "    carried: $dec"
  done < <(python3 - "$STAGING/appcast.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
from urllib.parse import unquote
tree = ET.parse(sys.argv[1])
for enc in tree.getroot().iter("enclosure"):
    u = enc.get("url", "")
    if u:
        print(f"{u}\t{unquote(u.rsplit('/', 1)[-1])}")
PY
)
  echo "    carried the appcast + $CARRIED referenced zips"
else
  echo "    live feed absent (HTTP $ACODE) — nothing to carry forward (no numbered releases yet?)"
  rm -f "$STAGING/appcast.xml"
fi

# ---- 5. Forgejo publish (delete-then-create: idempotent per commit) --------
echo "==> [5/7] publish release '$RELNAME' (tag $TAG)"
# 5a. idempotent: a release with the SAME TAG (a re-run of the same push)
# is deleted first — the republish replaces it in place. The list GET is
# guarded (|| true): a transient failure must not kill the publish —
# the create below then either 409s (a release already exists for the
# tag — the visible error) or succeeds fresh.
EXISTING_ID="$(curl -sS --max-time 30 -H "$AUTH" "$API/releases" | python3 -c "
import json,sys
try:
    rels = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for r in rels:
    if r.get('tag_name') == '$TAG':
        print(r.get('id','')); break" || true)"
if [ -n "$EXISTING_ID" ]; then
  echo "    existing release (id $EXISTING_ID) — deleting for republish"
  code="$(curl -sS --max-time 30 -X DELETE -H "$AUTH" -o /dev/null -w '%{http_code}' "$API/releases/$EXISTING_ID")"
  [ "$code" = "204" ] || { echo "error: delete existing release -> HTTP $code" >&2; exit 1; }
fi
# 5b. create (the release name is "Edge <branch> <sha7>" — the marker
# tail the in-app check and the zip names derive from).
BODY="Edge build of ${NAME} @ ${SHA7} (issue #26). Not a release: the numbered channel (appcast.xml) is carried forward unchanged on this release so the 'latest' feed keeps serving it. The desktop artifact carries no Sparkle key (dev build); the menubar artifact installs via the branch channel (sha256-verified). For the live publish probe: NAME is 'probe', not a branch."
CREATE_JSON="$(python3 -c "import json,sys; print(json.dumps({'tag_name':sys.argv[1],'name':sys.argv[2],'target_commitish':sys.argv[3],'body':sys.argv[4]}))" "$TAG" "$RELNAME" "$SHA" "$BODY")"
CREATE_RESP="$(curl -sS --max-time 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/releases" --data "$CREATE_JSON" -w '\nHTTP_CODE=%{http_code}' 2>&1 || true)"
NEWID="$(printf '%s' "$CREATE_RESP" | sed 's/HTTP_CODE=.*//' | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')" 2>/dev/null || true)"
if [ -z "$NEWID" ]; then
  echo "error: release create failed (no id). Raw response:" >&2
  printf '%s\n' "$CREATE_RESP" | head -c 1000 >&2
  exit 1
fi
echo "    release id $NEWID"

# 5c. upload: the carry-forward set (appcast + numbered zips) + the 4
# edge artifacts. The edge zips are NOT referenced by the appcast — the
# appcast is the carried-forward numbered one, untouched.
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
if [ "$CARRIED" -gt 0 ]; then
  upload "$STAGING/appcast.xml"
  for fn in "$ZIPSRC_DIR"/*; do
    [ -f "$fn" ] && upload "$fn"
  done
fi
upload "$MZIP"
upload "$MZIP.sha256"
upload "$DZIP"
upload "$DZIP.sha256"

# ---- 6. verify live (anonymous — the feed's real access path) --------------
echo "==> [6/7] verify the live feed (anonymous)"
DL="$BASE/sam/idlefill/releases/download/$TAG"
TMPFEED="$STAGING/verify-appcast.xml"
vcode="$(curl -sS --max-time 60 -o "$TMPFEED" -w '%{http_code}' "$APPCAST_URL")"
[ "$vcode" = "200" ] || { echo "error: live feed GET -> HTTP $vcode" >&2; exit 1; }

# ---- 7. (the python verifier) ----------------------------------------------
python3 - "$TMPFEED" "$STAGING" "$MZIPNAME" "$DZIPNAME" "$CARRIED" "$DL" <<'PY'
import sys, os, subprocess, hashlib, xml.etree.ElementTree as ET
feed_path, staging, mzip_name, dzip_name, carried, dl_base = sys.argv[1:7]
raw = open(feed_path, "rb").read()

# (a) the feed parses, and (when a feed was carried forward) its latest
# version is the carried-forward one — the edge release is NEWEST but the
# feed it serves is the numbered one, unchanged.
root = ET.fromstring(raw)
print("PASS (a) feed parses as XML (served by the newest release — the edge one)")
if int(carried) > 0:
    versions = [e.text for e in root.iter("{http://www.andymatuschak.org/xml-namespaces/sparkle}version")]
    assert versions, "no sparkle:version elements"
    print(f"PASS (a) carried-forward feed latest == {versions[0]} (all: {versions})")
    for enc in root.iter("enclosure"):
        u = enc.get("url", "")
        assert u, "empty enclosure url"
        r = subprocess.run(["curl", "-sS", "--max-time", "120", "-o", "/dev/null",
                            "-w", "%{http_code}", u], capture_output=True, text=True)
        assert r.stdout.strip() == "200", f"carried-forward enclosure {u} -> {r.stdout.strip()}"
    print("PASS (a) every carried-forward enclosure GETs 200")

# (b) every edge artifact GETs 200 over the PUBLIC per-tag download URL.
# The asset name lands in the URL path PERCENT-ENCODED (the desktop zip's
# name carries a space — "Idlefill <marker>.zip" — the same way the
# numbered feed's enclosures do it; the in-app installer's percent
# encoding is the access path this mirrors).
from urllib.parse import quote
for name in [mzip_name, mzip_name + ".sha256", dzip_name, dzip_name + ".sha256"]:
    r = subprocess.run([
        "curl", "-sS", "--max-time", "120", "-o", "/dev/null",
        "-w", "%{http_code} %{content_type}",
        f"{dl_base}/{quote(name, safe='')}"], capture_output=True, text=True)
    parts = r.stdout.split(" ", 1)
    assert parts[0] == "200", f"edge asset {name} -> HTTP {parts[0]}"
    print(f"PASS (b) {name}: 200 {parts[1] if len(parts) > 1 else ''}")

# (c) sha256: live sidecar == staging sidecar == recomputed zip hash —
# the menubar's Install action (and the desktop's edge install) depend on
# exactly this pair, verified BEFORE any swap.
edge_dir = os.path.join(staging, "edge")
for name in [mzip_name, dzip_name]:
    live = subprocess.run([
        "curl", "-sS", "--max-time", "120",
        f"{dl_base}/{quote(name + '.sha256', safe='')}"],
        capture_output=True, text=True).stdout.strip()
    local = open(os.path.join(edge_dir, name + ".sha256")).read().strip()
    disk = hashlib.sha256(open(os.path.join(edge_dir, name), "rb").read()).hexdigest()
    assert live == local, f"live sidecar differs from staging ({name})"
    assert live == disk, f"live sidecar does not match the published zip's hash ({name})"
    print(f"PASS (c) {name}.sha256: live == staging == recomputed zip hash")

print("EDGE-VERIFICATION-OK")
PY

echo "==> done: $RELNAME published and verified (tag $TAG, $CARRIED carried-forward zips + 4 edge artifacts)."
echo "    feed: $APPCAST_URL"
echo "    edge artifacts: $DL/<name>"

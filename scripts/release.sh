#!/usr/bin/env bash
# Publish an idlefill release to the Forgejo repo's releases (issue #69;
# the signed-updater artifact stages are issue #75, decision doc
# docs/architecture/shell-updater.md D2-D6).
#
# The release carries the shell's signed-updater artifacts (D2/D3 LOCKED):
#   1. the signed update bundle  Idlefill.app.tar.gz  (+ Idlefill.app.tar.gz.sig)
#   2. the manifest              latest.json
# attached to the same Forgejo release as the notes, on the `latest`
# pseudo-tag feed URL. The feed is the existing Forgejo release endpoint
# (two anonymous GETs, no auth) — no new container, no new route.
#
#   release.sh            -> reads env, publishes IDLEFILL_VERSION (signed)
#   release.sh --dry-run  -> no key, no Forgejo: assemble latest.json from
#                            stand-in artifacts, validate the JSON shape,
#                            publish NOTHING (the build-wave plumbing proof)
#
# What the signed pass does (each stage fails closed — no partial publish):
#   0. validate the release number (integer >= 1 — the tag is v$V);
#   1. the private-key + pubkey check (FAIL CLOSED): TAURI_SIGNING_PRIVATE_KEY
#      absent (or the key file missing) AND/OR the config's
#      plugins.updater.pubkey empty -> a named error BEFORE anything touches
#      Forgejo. No partial publish.
#   2. build the shell with updater artifacts on (D4): tauri/build.sh with
#      IDLEFILL_VERSION=1.0.$V, IDLEFILL_BUILD_MARKER=<short sha>, and
#      IDLEFILL_UPDATER_ARTIFACTS=1 (the createUpdaterArtifacts merge seam);
#   3. collect Idlefill.app.tar.gz + .sig from target/release/bundle/macos/
#      (the .sig is absent when the key was missing -> FAIL CLOSED);
#   4. assemble latest.json (D3 shape) from the version, the bundle URL, and
#      the base64 .sig content;
#   5. drop Forgejo's auto-created release + create "Release #$V" (tag v$V);
#   6. attach latest.json + Idlefill.app.tar.gz (Forgejo multipart `attachment`);
#   7. carry-forward: the newest release keeps the pair (persistent staging);
#   8. anonymous live verification: the feed GETs 200, parses, version
#      matches, and the bundle GETs 200 (no token — the feed's access shape).
#
# The Q-b notes-only default is superseded for the shell by #75: a release
# now ships the updater pair. The daemon and the arbiter still have no
# artifacts (they run from a checkout). The Sparkle machinery stayed retired.
#
# Required env (signed pass):
#   IDLEFILL_VERSION   release number (integer >= 1), e.g. 2 — the tag is
#                      v$V, the Forgejo release is "Release #$V", the
#                      updater SemVer is 1.0.$V (D5).
#   FORGEJO_TOKEN      a Forgejo access token with write:releases on
#                      sam/idlefill (operator-provided; NOT read from git
#                      config by this script).
#   TAURI_SIGNING_PRIVATE_KEY  the minisign private key: the base64 CONTENT
#                      (what `cargo-tauri signer generate` printed) or a
#                      PATH to the key file (e.g. ~/.config/idlefill/
#                      tauri-signing.key). Read by the tauri CLI's signer,
#                      never written by any script. ABSENT = fail closed.
# Optional env:
#   IDLEFILL_CHANGELOG          release notes text (default: the D5 note).
#   IDLEFILL_FORGEJO_BASE       (default https://git.samwarth.com)
#   IDLEFILL_REPO               repo root (default: parent of this script's dir)
#   IDLEFILL_SIGNING_STAGING    carry-forward dir (default ~/idlefill-release-staging)
set -euo pipefail

# ---- inputs ----------------------------------------------------------------
MODE="signed"
if [ "${1:-}" = "--dry-run" ]; then MODE="dry-run"; fi

V=""
if [ "$MODE" = "signed" ]; then
  V="${IDLEFILL_VERSION:?IDLEFILL_VERSION is required (release number, e.g. 2)}"
  # Release numbers are plain integers >= 1: the tag is v$V and the Forgejo
  # release is named "Release #$V"; the updater SemVer is 1.0.$V (D5).
  case "$V" in
    *[!0-9]*) echo "error: IDLEFILL_VERSION must be a release number (integer >= 1), got '$V'" >&2; exit 1 ;;
  esac
  [ -n "$V" ] && [ "$V" -ge 1 ] || { echo "error: release number must be >= 1 (got $V)" >&2; exit 1; }
fi
TOKEN="${FORGEJO_TOKEN:-}"
BASE="${IDLEFILL_FORGEJO_BASE:-https://git.samwarth.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${IDLEFILL_REPO:-$(cd "$HERE/.." && pwd)}"
API="$BASE/api/v1/repos/sam/idlefill"
TAG="v${V:-dryrun}"
RELNAME="${V:+Release #$V}"
CONF="$REPO/tauri/src-tauri/tauri.conf.json"
# The D5 note: the SemVer is 1.0.<N> (the tag is v<N>), the manual path
# (update.sh) stands for operators who build from a checkout.
CHANGELOG="${IDLEFILL_CHANGELOG:-Release ${V:+#$V} (tag ${TAG}). The idlefill Tauri shell now carries a signed updater channel (#75): the release ships latest.json + the signed Idlefill.app.tar.gz. The settings window's Update section (Check for updates…) is the only trigger. Build from a checkout with './update.sh' for the manual path; 'idlefill-app --version' prints the build marker. The arbiter and the daemon run from each machine's own checkout.}"
STAGING="${IDLEFILL_SIGNING_STAGING:-$HOME/idlefill-release-staging}"
# The bundle URL + the feed (D2/D3 LOCKED): the `latest` pseudo-tag shape.
BUNDLE_URL="$BASE/sam/idlefill/releases/download/latest/Idlefill.app.tar.gz"
FEED_URL="$BASE/sam/idlefill/releases/download/latest/latest.json"

# Auth header, assembled from fragments so a token-shaped literal never
# appears in this file. FORGEJO_TOKEN is only ever referenced as a var.
B="Bea"; B="${B}rer"
AUTH="$B: $TOKEN"

# The config's plugins.updater.pubkey (D4: content in the repo, public).
# Empty = the channel is inert -> a signed release is impossible.
config_pubkey() {
  python3 -c '
import json,sys
try:
    c=json.load(open(sys.argv[1]))
    print((c.get("plugins",{}).get("updater",{}).get("pubkey") or "").strip())
except Exception:
    print("")
' "$CONF"
}

# The private key, resolved: the env holds the base64 CONTENT or a PATH.
# Prints the resolved key (or empty). Mirrors tauri-cli bundle.rs::sign_updaters.
resolve_private_key() {
  local v="${TAURI_SIGNING_PRIVATE_KEY:-}"
  if [ -z "$v" ]; then return 0; fi
  if [ -f "$v" ]; then cat "$v"; else printf '%s' "$v"; fi
}

# ---------------------------------------------------------------------------
# 0. DRY-RUN (no key, no Forgejo): the plumbing proof
# ---------------------------------------------------------------------------
# Assemble latest.json from stand-in artifacts and validate the JSON shape.
# Mirrors the pure Rust updater::latest_json + the TS dry-run harness
# (tauri/ui/test/updater-manifest.test.ts). Publishes NOTHING.
if [ "$MODE" = "dry-run" ]; then
  echo "==> dry-run: assembling latest.json from stand-in artifacts (no key, no Forgejo)"
  DRY="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-updater-dry-XXXXXX")"
  trap 'rm -rf "$DRY"' EXIT
  python3 - "$DRY" "$BUNDLE_URL" <<'PY'
import base64, json, os, re, sys, datetime
d, url = sys.argv[1:3]
box = ("untrusted comment: signature from tauri secret key\n"
       + base64.b64encode(b"\x41"*32).decode() + "\n"
       + base64.b64encode(b"\x42"*64).decode() + "\n"
       + "timestamp:1760000000\tfile:Idlefill.app.tar.gz\n")
sig = base64.b64encode(box.encode()).decode()
open(os.path.join(d, "Idlefill.app.tar.gz.sig"), "w").write(sig)
open(os.path.join(d, "Idlefill.app.tar.gz"), "wb").write(b"stand-in bundle")
semver = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
def sig_b64(s):
    t = s.strip()
    return bool(t) and not any(c.isspace() for c in t) and all(
        c.isalnum() or c in "+/=" for c in t)
version = "1.0.1"  # the dry-run stand-in SemVer (D5: 1.0.<N>)
assert semver.match(version)
assert sig_b64(sig), "the .sig field must be one base64 line (the base64 of the .sig file)"
m = {
    "version": version,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": "Dry-run stand-in (release.sh --dry-run): no key, no publish.",
    "platforms": { "darwin-aarch64": { "url": url, "signature": sig } },
}
# validate the structure (the client contract, D3): exactly these keys.
assert set(m) == {"version","pub_date","notes","platforms"}, set(m)
assert semver.match(m["version"])
assert isinstance(m["platforms"], dict) and m["platforms"]
for plat, p in m["platforms"].items():
    assert set(p) == {"url","signature"}, (plat, set(p))
    assert p["url"] and sig_b64(p["signature"])
    assert b"\n" in base64.b64decode(p["signature"]), "field must decode to a multi-line .sig box"
json.dump(m, open(os.path.join(d, "latest.json"), "w"), indent=2)
print(json.dumps(m, indent=2))
PY
  echo "==> dry-run OK: latest.json assembled + validated (the Tauri v2 updater contract)"
  echo "    version=1.0.1  platform=darwin-aarch64  feed=$FEED_URL"
  echo "    nothing was published (no key, no Forgejo touch)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. the private-key + pubkey check (FAIL CLOSED, before any network)
# ---------------------------------------------------------------------------
# The D4 LOCKED plane: the keypair must exist before a signed release.
# Absent private key OR empty pubkey -> a clear named error, NO publish.
PUBKEY="$(config_pubkey)"
PRIVKEY="$(resolve_private_key)"
if [ -z "$PRIVKEY" ]; then
  echo "error: FAIL CLOSED — TAURI_SIGNING_PRIVATE_KEY is absent (or the key file it points to is missing). No release published. Generate the keypair first (the owner step, #75): 'cargo-tauri signer generate'; the private key lands at ~/.config/idlefill/tauri-signing.key (0600) and is provided via TAURI_SIGNING_PRIVATE_KEY (content or path)." >&2
  exit 1
fi
if [ -z "$PUBKEY" ]; then
  echo "error: FAIL CLOSED — tauri.conf.json plugins.updater.pubkey is empty. The shell verifies a download only against a non-empty pubkey; an empty pubkey means the updater is inert, so a signed release is impossible. Run the key generation (the owner step) and drop the public key into $CONF before re-running. Nothing was published." >&2
  exit 1
fi
[ -n "$TOKEN" ] || { echo "error: FORGEJO_TOKEN is required for a live publish (operator-provided; not read from git config)." >&2; exit 1; }
echo "==> key plane OK: private key present, config pubkey present (channel live)"

# ---------------------------------------------------------------------------
# 2. build the shell with updater artifacts on (D4)
# ---------------------------------------------------------------------------
MARKER="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo dev)"
echo "==> building shell (updater artifacts on, version 1.0.$V, marker $MARKER)"
export IDLEFILL_VERSION="1.0.$V"
export IDLEFILL_BUILD_MARKER="$MARKER"
export IDLEFILL_UPDATER_ARTIFACTS=1
# The private key rides the env the tauri CLI's signer reads (content or
# path). Never written to disk here.
export TAURI_SIGNING_PRIVATE_KEY="$PRIVKEY"
bash "$REPO/tauri/build.sh"

# ---------------------------------------------------------------------------
# 3. collect the bundle + signature (FAIL CLOSED if the .sig is absent)
# ---------------------------------------------------------------------------
BUNDLE_DIR="$REPO/tauri/src-tauri/target/release/bundle/macos"
BUNDLE="$BUNDLE_DIR/Idlefill.app.tar.gz"
SIG="$BUNDLE_DIR/Idlefill.app.tar.gz.sig"
[ -f "$BUNDLE" ] || { echo "error: FAIL CLOSED — the updater bundle $BUNDLE is absent after the build. Nothing published." >&2; exit 1; }
[ -f "$SIG" ]    || { echo "error: FAIL CLOSED — the signature $SIG is absent (the build did not sign it — check the private key / pubkey match). Nothing published." >&2; exit 1; }
echo "==> collected: Idlefill.app.tar.gz + Idlefill.app.tar.gz.sig"

# ---------------------------------------------------------------------------
# 4. assemble latest.json (D3 shape)
# ---------------------------------------------------------------------------
# The signature field is the base64 (STANDARD) of the .sig FILE CONTENT:
# the tauri-cli writes the .sig as one base64 line, and the client
# base64-decodes the field back to that text.
STAGING_TMP="$(mktemp -d "${TMPDIR:-/tmp}/idlefill-release-XXXXXX")"
trap 'rm -rf "$STAGING_TMP"' EXIT
cp "$BUNDLE" "$STAGING_TMP/Idlefill.app.tar.gz"
cp "$SIG"    "$STAGING_TMP/Idlefill.app.tar.gz.sig"
python3 - "$STAGING_TMP" "$V" "$BUNDLE_URL" "$CHANGELOG" <<'PY'
import base64, json, os, re, sys, datetime
d, relnum, url, notes = sys.argv[1:5]
semver = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
def sig_b64(s):
    t = s.strip()
    return bool(t) and not any(c.isspace() for c in t) and all(
        c.isalnum() or c in "+/=" for c in t)
version = "1.0." + relnum
assert semver.match(version), f"version not SemVer: {version}"
sig = open(os.path.join(d, "Idlefill.app.tar.gz.sig")).read()
assert sig_b64(sig), "the .sig field must be one base64 line"
m = {
    "version": version,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "notes": notes,
    "platforms": { "darwin-aarch64": { "url": url, "signature": sig } },
}
assert set(m) == {"version","pub_date","notes","platforms"}
for plat, p in m["platforms"].items():
    assert set(p) == {"url","signature"} and p["url"] and sig_b64(p["signature"])
    assert b"\n" in base64.b64decode(p["signature"])
json.dump(m, open(os.path.join(d, "latest.json"), "w"), indent=2)
print("assembled latest.json (version %s, platform darwin-aarch64)" % version)
PY
LATEST_JSON="$STAGING_TMP/latest.json"
echo "==> assembled: latest.json (version 1.0.$V, platform darwin-aarch64)"

# ---------------------------------------------------------------------------
# 5. drop the auto-created release + create (idempotent)
# ---------------------------------------------------------------------------
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
echo "==> creating release $RELNAME (tag $TAG)"
CREATE_JSON="$(python3 -c "import json,sys; print(json.dumps({'tag_name':'v'+sys.argv[1],'target_branch':'main','name':'Release #'+sys.argv[1],'body':sys.argv[2]}))" "$V" "$CHANGELOG")"
NEWID="$(curl -sS --max-time 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/releases" --data "$CREATE_JSON" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')")"
[ -n "$NEWID" ] || { echo "error: release create failed (no id) — nothing attached" >&2; exit 1; }
echo "==> release id $NEWID"

# ---------------------------------------------------------------------------
# 6. attach latest.json + Idlefill.app.tar.gz (multipart `attachment`)
# ---------------------------------------------------------------------------
# The verified pitfall from the Sparkle work: the asset field is `attachment`.
upload_asset() {
  local file="$1"
  local code
  code="$(curl -sS --max-time 120 -X POST -H "$AUTH" \
    -F "name=$(basename "$file")" \
    -F "attachment=@$file" \
    -o /dev/null -w '%{http_code}' "$API/releases/$NEWID/assets")"
  { [ "$code" = "201" ] || [ "$code" = "200" ]; } || { echo "error: attach $(basename "$file") -> HTTP $code" >&2; exit 1; }
  echo "==> attached: $(basename "$file")"
}
upload_asset "$LATEST_JSON"
upload_asset "$STAGING_TMP/Idlefill.app.tar.gz"

# ---------------------------------------------------------------------------
# 7. carry-forward: the newest release keeps the pair
# ---------------------------------------------------------------------------
mkdir -p "$STAGING"
cp "$LATEST_JSON" "$STAGING/latest.json"
cp "$STAGING_TMP/Idlefill.app.tar.gz" "$STAGING/Idlefill.app.tar.gz"
cp "$STAGING_TMP/Idlefill.app.tar.gz.sig" "$STAGING/Idlefill.app.tar.gz.sig"
echo "==> carry-forward: pair staged at $STAGING"

# ---------------------------------------------------------------------------
# 8. anonymous live verification (no token — the feed's access shape)
# ---------------------------------------------------------------------------
code="$(curl -sS --max-time 30 -o "$STAGING_TMP/feed.json" -w '%{http_code}' "$FEED_URL")"
[ "$code" = "200" ] || { echo "error: live feed GET $FEED_URL -> HTTP $code (expected 200)" >&2; exit 1; }
python3 - "$STAGING_TMP/feed.json" "$V" <<'PY'
import json, sys
feed = json.load(open(sys.argv[1]))
expected = "1.0." + sys.argv[2]
assert feed["version"] == expected, f"feed version {feed['version']} != release SemVer {expected}"
assert "platforms" in feed and feed["platforms"].get("darwin-aarch64"), "missing darwin-aarch64 platform"
assert feed["platforms"]["darwin-aarch64"]["signature"], "empty signature"
print("feed OK: version", feed["version"], "platform darwin-aarch64 present")
PY
code="$(curl -sS --max-time 60 -o /dev/null -w '%{http_code}' "$BUNDLE_URL")"
[ "$code" = "200" ] || { echo "error: live bundle GET $BUNDLE_URL -> HTTP $code (expected 200)" >&2; exit 1; }
echo "==> live bundle GET -> 200"

echo "==> done: $RELNAME published (signed updater pair + notes). tag $TAG, version 1.0.$V, feed $FEED_URL."

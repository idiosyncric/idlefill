#!/usr/bin/env bash
# Build the idlefill desktop app (swiftc, no Xcode project needed).
#
#   output: desktop/Idlefill.app — a real .app bundle:
#     Contents/MacOS/Idlefill       (the binary)
#     Contents/Frameworks/Sparkle.framework  (auto-update framework)
#     Contents/Info.plist           (windowed app; ad-hoc signed)
#
# Run from anywhere: the script locates itself and compiles the sibling
# IdlefillDesktop.swift. Requires the Xcode command-line tools (swiftc).
#
# Environment (all optional; the release script sets the first two):
#   IDLEFILL_VERSION        -> CFBundleShortVersionString AND CFBundleVersion
#                              (default 1.0). Sparkle compares CFBundleVersion
#                              numerically (segment-wise, zero-padded), so
#                              release.sh passes the release number (e.g. 2)
#                              and the appcast's <sparkle:version> equals the
#                              release version; a number sorts above the
#                              pre-numbering semver (2 > 0.0.2). STAYS the
#                              numeric release number — even for edge builds
#                              (the marker goes into __DESKTOP_BUILD__, below;
#                              Sparkle compares CFBundleVersion, never the
#                              marker).
#   IDLEFILL_DESKTOP_BUILD  -> the BUILD MARKER baked into the binary via the
#                              `__DESKTOP_BUILD__` placeholder (the menubar's
#                              `__MENUBAR_VERSION__` pattern): default =
#                              IDLEFILL_VERSION (release builds' effective
#                              marker is the release number), the edge
#                              pipeline passes the marker (edge-<branch>-
#                              <sha7>). `Idlefill --version` prints it — an
#                              installed build proves its own origin. A build
#                              that never substituted reports the default
#                              `1.0` — NOT the literal placeholder (the same
#                              fail-mode as the menubar's `0.0.0-dev`).
#   IDLEFILL_SUPUBLICEDKEY  -> base64 32-byte ed25519 PUBLIC key written as
#                              SUPublicEDKey (the key that signs the appcast).
#                              Omit the key on a dev build (Sparkle will refuse
#                              to install an unsigned/mismatched update).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/Idlefill.app"
BIN="$APP/Contents/MacOS/Idlefill"
PLIST="$APP/Contents/Info.plist"
VENDOR="$HERE/vendor/sparkle"
FRAMEWORK="$VENDOR/Sparkle.framework"
SRC="$HERE/IdlefillDesktop.swift"

VERSION="${IDLEFILL_VERSION:-1.0}"
# The build marker (the binary's `--version`): defaults to the numeric
# release version (a release build's effective marker IS the number —
# today's behavior), overridable by the edge pipeline (the marker).
MARKER="${IDLEFILL_DESKTOP_BUILD:-$VERSION}"
SUPUB="${IDLEFILL_SUPUBLICEDKEY:-}"
# NOTE: Gitea's release-download route is /releases/download/{vTag}/{fileName}
# (Gitea has NO /releases/latest/download/ route — that GitHub form 404s on
# Gitea even for public repos). The `latest` pseudo-tag in the {vTag} slot
# resolves to the newest release, which carries the whole current feed.
FEED_URL="https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml"

if [ ! -d "$FRAMEWORK" ]; then
  echo "error: $FRAMEWORK not found (run the vendor step / git checkout the repo)" >&2
  exit 1
fi

# Inject the marker into the source: replace ONLY the quoted placeholder
# literal (the constant name is left alone — a blanket replacement would
# also hit the unquoted identifier and produce invalid Swift). The same
# quoted-literal-only discipline as the menubar's build.sh.
INJECTED="$HERE/.IdlefillDesktop.versioned.swift"
trap 'rm -f "$INJECTED"' EXIT
sed "s/\"__DESKTOP_BUILD__\"/\"$MARKER\"/g" "$SRC" > "$INJECTED"
# Byte-verify the substitution landed: no QUOTED placeholder may remain
# (the unquoted constant name is expected to stay), and the marker must
# be present in the injected copy (a silent miss would bake the literal
# placeholder string into the binary).
if grep -q '"__DESKTOP_BUILD__"' "$INJECTED"; then
  echo "error: \"__DESKTOP_BUILD__\" placeholder survived substitution" >&2
  exit 1
fi
grep -q "let __DESKTOP_BUILD__ = \"$MARKER\"" "$INJECTED" || {
  echo "error: marker $MARKER not found in the injected source" >&2
  exit 1
}

echo "==> swiftc -O (version $VERSION, marker $MARKER) → $BIN"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks"
swiftc -O -parse-as-library \
  -o "$BIN" \
  "$INJECTED" \
  -framework AppKit -framework SwiftUI \
  -F "$VENDOR" \
  -framework Sparkle \
  -Xlinker -rpath -Xlinker "@loader_path/../Frameworks"

echo "==> bundling Sparkle.framework into Contents/Frameworks"
cp -R "$FRAMEWORK" "$APP/Contents/Frameworks/"

echo "==> writing $PLIST"
SUPUB_BLOCK=""
if [ -n "$SUPUB" ]; then
  SUPUB_BLOCK=$'\t<key>SUPublicEDKey</key>\n\t<string>'"$SUPUB"$'</string>'
fi
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.sam.idlefill.desktop</string>
	<key>CFBundleName</key>
	<string>Idlefill</string>
	<key>CFBundleExecutable</key>
	<string>Idlefill</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${VERSION}</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<false/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>SUFeedURL</key>
	<string>${FEED_URL}</string>
	<key>SUEnableInstallerLauncherService</key>
	<false/>
	${SUPUB_BLOCK}
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.sam.idlefill.desktop</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>idlefill</string>
			</array>
		</dict>
	</array>
	<key>NSAppTransportSecurity</key>
	<dict>
		<!-- The arbiter is a local/tailnet server on plain HTTP. A bundled
		     app is subject to ATS (a bare binary is not) — without this
		     exception every /api/state poll is blocked and the panel reads
		     "unreachable" while the server is fine. -->
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>
</plist>
EOF

echo "==> codesign (ad-hoc) — LAST step, covers the bundled framework too"
codesign --force -s - "$APP"

echo "==> built $APP (version $VERSION, marker $MARKER, SUPublicEDKey $([ -n "$SUPUB" ] && echo present || echo absent))"
echo "run it with: open $APP"
echo "version check: $BIN --version"

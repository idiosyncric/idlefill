#!/usr/bin/env bash
# Build the idlefill menu bar app as a real .app bundle (swiftc, no Xcode
# project needed).
#
#   output: menubar/IdlefillMenubar.app — a real bundle:
#     Contents/MacOS/IdlefillMenubar  (the binary)
#     Contents/Info.plist             (bundle id + version + LSUIElement)
#
# Run from anywhere: the script locates itself and compiles the sibling
# IdlefillMenubar.swift. Requires the Xcode command-line tools (swiftc).
#
# Environment (all optional; the release script sets the first one):
#   IDLEFILL_VERSION   -> CFBundleShortVersionString AND CFBundleVersion,
#                         AND the version BAKED INTO THE BINARY: the source
#                         carries a `__MENUBAR_VERSION__` placeholder that
#                         this script substitutes (sed) before compiling,
#                         so `IdlefillMenubar --version` prints the release
#                         the bundle was built from. Default: the root
#                         package.json version (read with node — the single
#                         version source; the release tag v<X.Y.Z> is cut
#                         from it). A read failure falls back to 0.0.0-dev.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/IdlefillMenubar.app"
BIN="$APP/Contents/MacOS/IdlefillMenubar"
PLIST="$APP/Contents/Info.plist"
SRC="$HERE/IdlefillMenubar.swift"

VERSION="${IDLEFILL_VERSION:-}"
if [ -z "$VERSION" ]; then
  # The single version source: the root package.json (node is available on
  # any machine that builds this — the daemon needs it too). No jq.
  VERSION="$(node -p "require(process.argv[1]).version" "$REPO/package.json" 2>/dev/null || true)"
fi
if [ -z "$VERSION" ]; then
  echo "note: root package.json version unreadable — building with 0.0.0-dev" >&2
  VERSION="0.0.0-dev"
fi

# Inject the version into the source: replace ONLY the quoted placeholder
# literal (the constant name is left alone — a blanket replacement would
# also hit the unquoted identifier and produce invalid Swift).
INJECTED="$HERE/.IdlefillMenubar.versioned.swift"
trap 'rm -f "$INJECTED"' EXIT
sed "s/\"__MENUBAR_VERSION__\"/\"$VERSION\"/g" "$SRC" > "$INJECTED"
# Byte-verify the substitution landed: no QUOTED placeholder may remain
# (the unquoted constant name is expected to stay), and the version must
# be present in the injected copy (a silent miss would bake the literal
# placeholder string into the binary).
if grep -q '"__MENUBAR_VERSION__"' "$INJECTED"; then
  echo "error: \"__MENUBAR_VERSION__\" placeholder survived substitution" >&2
  exit 1
fi
grep -q "let __MENUBAR_VERSION__ = \"$VERSION\"" "$INJECTED" || {
  echo "error: version $VERSION not found in the injected source" >&2
  exit 1
}

echo "==> swiftc -O (version $VERSION) → $BIN"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -parse-as-library \
  -o "$BIN" \
  "$INJECTED" \
  -framework AppKit -framework SwiftUI

echo "==> writing $PLIST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.sam.idlefill.menubar</string>
	<key>CFBundleName</key>
	<string>Idlefill Menubar</string>
	<key>CFBundleExecutable</key>
	<string>IdlefillMenubar</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${VERSION}</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<!-- The update check and (in a dev build) the arbiter may speak
		     plain HTTP (local stubs / tailnet). Without this exception a
		     bundled app is subject to ATS and the check fails quiet. -->
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>
</plist>
EOF

echo "==> codesign (ad-hoc) — LAST step"
codesign --force -s - "$APP"

echo "==> built $APP (version $VERSION, ad-hoc signed)"
echo "run it with: open $APP   (menu bar icon appears at the right of the menu bar)"
echo "version check: $BIN --version"

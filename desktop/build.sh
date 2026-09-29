#!/usr/bin/env bash
# Build the idlefill desktop app (swiftc, no Xcode project needed).
#
#   output: desktop/Idlefill.app — a real .app bundle:
#     Contents/MacOS/Idlefill       (the binary)
#     Contents/Info.plist           (windowed app; ad-hoc signed)
#
# Run from anywhere: the script locates itself and compiles the sibling
# IdlefillDesktop.swift. Requires the Xcode command-line tools (swiftc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/Idlefill.app"
BIN="$APP/Contents/MacOS/Idlefill"
PLIST="$APP/Contents/Info.plist"

echo "==> swiftc -O → $BIN"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -parse-as-library \
  -o "$BIN" \
  "$HERE/IdlefillDesktop.swift" \
  -framework AppKit -framework SwiftUI

echo "==> writing $PLIST"
cat > "$PLIST" <<'EOF'
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
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<false/>
	<key>NSHighResolutionCapable</key>
	<true/>
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

echo "==> codesign (ad-hoc)"
codesign --force -s - "$APP"

echo "==> built $APP"
echo "run it with: open $APP"

#!/usr/bin/env bash
# Build the idlefill menu bar app (swiftc, no Xcode project needed).
#
#   scripts → none; deps → none (SwiftUI + AppKit only)
#   output: menubar/IdlefillMenubar (a runnable .app-free binary)
#
# Run from anywhere: the script locates itself and compiles the sibling
# IdlefillMenubar.swift. Requires the Xcode command-line tools (swiftc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/IdlefillMenubar}"

echo "==> swiftc → $OUT"
swiftc -O -parse-as-library \
  -o "$OUT" \
  "$HERE/IdlefillMenubar.swift" \
  -framework AppKit -framework SwiftUI

echo "==> built $OUT"
echo "run it with: $OUT   (menu bar icon appears at the right of the menu bar)"

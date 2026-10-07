#!/usr/bin/env bash
# Build the idlefill Tauri shell (issue #70, decision doc
# docs/architecture/tauri-cutover.md D7/D8). Mirrors desktop/build.sh's
# discipline: the marker comes from the environment and the binary
# proves its own origin. No signing identity, no notarization, no
# install step here (Q-b LOCKED: no update plane — every install is a
# build from a checkout).
#
#   output: src-tauri/target/release/bundle/macos/Idlefill.app
#
# Environment:
#   IDLEFILL_VERSION   -> tauri.conf.json's `version` via TAURI_CONFIG.
#                         MUST be semver (tauri rejects "1.0" — "1.0.0"
#                         is the equivalent). Default 1.0.0.
#   IDLEFILL_BUILD_MARKER -> baked into the binary via option_env!
#                         (the __DESKTOP_BUILD__ analog). Default `dev`.
#                         `idlefill --version` prints `idlefill <marker>`.
#
# Flags:
#   --debug -> build the DEBUG profile. The dev-tooling plugins
#         (tauri-plugin-pilot, tauri-plugin-mcp-bridge) are registered
#         only under #[cfg(debug_assertions)] in lib.rs, so only this
#         profile answers `tauri-pilot ping`. Output moves to
#         target/debug/bundle/macos/Idlefill.app. Release stays the
#         default; nothing here installs or launches the app.
set -euo pipefail

PROFILE=release
TAURI_BUILD_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) PROFILE=debug; TAURI_BUILD_ARGS+=(--debug); shift ;;
    *) echo "usage: $0 [--debug]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src-tauri"

VERSION="${IDLEFILL_VERSION:-1.0.0}"
MARKER="${IDLEFILL_BUILD_MARKER:-dev}"

# The tray icon is generated, not checked in as a binary blob: re-render
# it before compiling (make-tray-icon.py writes the RGBA bytes the tray
# embeds via include_bytes!).
python3 "$HERE/make-tray-icon.py" "$SRC/icons/tray-icon.rgba"

export IDLEFILL_BUILD_MARKER="$MARKER"
# Version override through tauri's config-merge env (tauri-utils
# config.rs merges this JSON patch over tauri.conf.json at build time).
export TAURI_CONFIG="$(python3 - "$VERSION" <<'PY'
import json, sys
print(json.dumps({"version": sys.argv[1]}))
PY
)"

cargo build --profile "$PROFILE" --manifest-path "$SRC/Cargo.toml"

APP="$SRC/target/$PROFILE/bundle/macos/Idlefill.app"
if command -v cargo-tauri >/dev/null 2>&1; then
  # The tauri CLI runs the bundler; the bare `cargo build` above warms
  # the deps but never emits the .app. Exact spike-proven invocation
  # (ISSUE69-GRILL-REPORT: `~/.cargo/bin/cargo-tauri tauri build
  # --debug` produced the bundle).
  (cd "$SRC" && cargo-tauri tauri build "${TAURI_BUILD_ARGS[@]}")
  echo "built: $APP"
else
  echo "built (unbundled binary): $SRC/target/$PROFILE/idlefill-app"
  echo "note: cargo install tauri-cli for the .app bundle"
fi

BIN="$APP/Contents/MacOS/idlefill-app"
[ -x "$BIN" ] && "$BIN" --version || "$SRC/target/$PROFILE/idlefill-app" --version || true

# Post-bundle byte-verify (gate 4): the bundle's Info.plist must be a
# valid plist carrying BOTH the idlefill URL scheme and the ATS merge.
#
# ROOT CAUSE of the "corrupted bundle" scare (2026-10-06, twice): the
# VERIFY command was the writer. On macOS 26+, `plutil -extract <key>
# json <file>` WITHOUT -o overwrites the INPUT file with the extracted
# JSON and prints nothing. That turned the good 1363-byte plist into a
# bare 115-byte CFBundleURLTypes JSON array (mtime matches the check,
# not the build). The bundler always writes a valid XML plist
# (tauri-bundler 2.9.4 macos/app.rs:366, to_file_xml). Probed on this
# host: `json` and `xml1` formats rewrite the input file, `raw` prints
# to stdout, `json -o -` prints to stdout. This gate therefore uses
# ONLY the raw form; any human re-check must use `-o -`.
if [ -d "$APP" ]; then
  PL="$APP/Contents/Info.plist"
  plutil -lint "$PL" >/dev/null || { echo "error: bundle Info.plist is not a valid plist" >&2; exit 1; }
  plutil -extract CFBundleURLTypes raw "$PL" >/dev/null \
    || { echo "error: bundle Info.plist has no CFBundleURLTypes" >&2; exit 1; }
  plutil -extract NSAppTransportSecurity.NSAllowsArbitraryLoads raw "$PL" >/dev/null \
    || { echo "error: bundle Info.plist has no ATS merge" >&2; exit 1; }
  # Guard the guard: if a future plutil mutates the file under the
  # probe again, fail here instead of shipping the corpse.
  plutil -lint "$PL" >/dev/null \
    || { echo "error: bundle Info.plist corrupted BY THE GATE CHECK itself" >&2; exit 1; }
  echo "info.plist verified: URL scheme + ATS present"
fi

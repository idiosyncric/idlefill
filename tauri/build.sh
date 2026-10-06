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
set -euo pipefail

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

cargo build --release --manifest-path "$SRC/Cargo.toml"

APP="$SRC/target/release/bundle/macos/Idlefill.app"
if command -v cargo-tauri >/dev/null 2>&1; then
  # The tauri CLI runs the bundler; the bare `cargo build` above warms
  # the deps but never emits the .app. Exact spike-proven invocation
  # (ISSUE69-GRILL-REPORT: `~/.cargo/bin/cargo-tauri tauri build
  # --debug` produced the bundle).
  (cd "$SRC" && cargo-tauri tauri build)
  echo "built: $APP"
else
  echo "built (unbundled binary): $SRC/target/release/idlefill-app"
  echo "note: cargo install tauri-cli for the .app bundle"
fi

BIN="$APP/Contents/MacOS/idlefill-app"
[ -x "$BIN" ] && "$BIN" --version || "$SRC/target/release/idlefill-app" --version || true

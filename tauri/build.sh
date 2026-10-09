#!/usr/bin/env bash
# Build the idlefill Tauri shell (issue #70, decision doc
# docs/architecture/tauri-cutover.md D7/D8; the signed updater channel
# is issue #75, docs/architecture/shell-updater.md). The marker comes
# from the environment and the binary proves its own origin.
# No install step here.
#
# The KEYLESS default (the checkout build, `./update.sh`): NO updater
# artifacts, NO signing (D4 LOCKED: `createUpdaterArtifacts` is set on
# the release pass ONLY, never committed — a committed `true` would
# fail every keyless build).
#
#   output: src-tauri/target/release/bundle/macos/Idlefill.app
#
# Environment:
#   IDLEFILL_VERSION   -> tauri.conf.json's `version` via the CLI's
#                         -c/--config merge (the bundler seam).
#                         MUST be semver (tauri rejects "1.0" — "1.0.0"
#                         is the equivalent). Default 1.0.0.
#   IDLEFILL_BUILD_MARKER -> baked into the binary via option_env!
#                         (the __DESKTOP_BUILD__ analog). Default `dev`.
#                         `idlefill --version` prints `idlefill <marker>`.
#   IDLEFILL_UPDATER_ARTIFACTS -> (release pass ONLY, #75) when set to 1,
#                         merge `bundle.createUpdaterArtifacts: true`
#                         into TAURI_CONFIG. The tauri CLI then emits the
#                         updater bundle (Idlefill.app.tar.gz) and, when
#                         TAURI_SIGNING_PRIVATE_KEY is set + the config's
#                         plugins.updater.pubkey is non-empty, signs it
#                         (Idlefill.app.tar.gz.sig). A keyless build with
#                         this flag on still builds the bundle but the
#                         signing step is skipped (the .sig is absent —
#                         the release pass fails closed on that).
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
# Version override through the CLI's --config merge seam (inline JSON
# patched over tauri.conf.json before bundling). The release pass (#75)
# adds `bundle.createUpdaterArtifacts: true` to the SAME patch — D4
# LOCKED: the flag is set on the release pass only, never committed (a
# committed `true` would fail every keyless checkout build). The merge
# deep-merges, so this patch coexists with the committed bundle block
# (it only adds createUpdaterArtifacts).
#
# CORRECTION (2026-10-09, first signed run): the old seam — exporting the
# patch as TAURI_CONFIG — NEVER reached the bundler. tauri-cli 2.12.1
# only WRITES TAURI_CONFIG (helpers/config.rs:170, for the build.rs ACL
# plane); it never reads it from the env. The env patch only ever
# reached the codegen plane. The bundler's seam is `-c/--config`.
UPDATER=0
if [ "${IDLEFILL_UPDATER_ARTIFACTS:-0}" = "1" ]; then
  UPDATER=1
fi
CONFIG_PATCH="$(python3 - "$VERSION" "$UPDATER" <<'PY'
import json, sys
patch = {"version": sys.argv[1]}
if sys.argv[2] == "1":
    patch["bundle"] = {"createUpdaterArtifacts": True}
print(json.dumps(patch))
PY
)"
# Still exported: the build.rs ACL/codegen plane DOES read TAURI_CONFIG
# (tauri-utils acl/build.rs:427).
export TAURI_CONFIG="$CONFIG_PATCH"
CONFIG_ARGS=(-c "$CONFIG_PATCH")
# The tauri CLI is the sole build entry (ISSUE69-GRILL-REPORT: the spike
# proved `cargo-tauri tauri build` emits the bundle). A bare `cargo build`
# BEFORE it was once a "warm the deps" step — measured 2026-10-08, it is
# pure cost: its build context differs from the CLI's, so it compiles ~24
# crates the CLI never reuses and then the CLI compiles them AGAIN (~100s
# warm total). With only the CLI step, a warm update recompiles just the
# app crate (the marker change forces it) and bundles: ~30s.
APP="$SRC/target/$PROFILE/bundle/macos/Idlefill.app"
if command -v cargo-tauri >/dev/null 2>&1; then
  # NOTE the ${arr[@]+"${arr[@]}"} form: macOS ships bash 3.2, where a
  # bare "${arr[@]}" over an EMPTY array dies "unbound variable" under
  # set -u (the release path, TAURI_BUILD_ARGS empty; hit live
  # 2026-10-07 via update.sh). The guarded form expands to nothing.
  (cd "$SRC" && cargo-tauri tauri build ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} ${TAURI_BUILD_ARGS[@]+"${TAURI_BUILD_ARGS[@]}"})
  echo "built: $APP"
else
  # The CLI is the only bundler; without it the best a build can do is
  # the unbundled binary (the .app bundle is what the install paths
  # need, so this is a degraded result, not an equivalent one).
  cargo build --profile "$PROFILE" --manifest-path "$SRC/Cargo.toml"
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

#!/bin/bash
# paperless-enrich executor shim: dispatches to the finance deploy's enrich.sh.
# The pipeline (taxonomy, payloads, results journal, custom-field queue) lives
# OUTSIDE this repo under ~/finance/paperless/enrich_20261016/ — override the
# root with IDLEFILL_PAPERLESS_HOME when the deploy lives elsewhere.
# Contract (idlefill): argv = {payload_file} {result_file}; exit 0 always,
# failures reported as {ok:false} inside the result file.
set -u
HOME_DIR="${IDLEFILL_PAPERLESS_HOME:-$HOME/finance/paperless/enrich_20261016}"
TARGET="$HOME_DIR/adapter/enrich.sh"
if [ ! -f "$TARGET" ]; then
  printf '{"ok":false,"error":"executor home missing: %s"}' "$HOME_DIR" > "$2"
  exit 0
fi
exec bash "$TARGET" "$1" "$2"

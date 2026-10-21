#!/bin/bash
# paperless-enrich executor shim: dispatches to the finance deploy's enrich.sh.
# The pipeline (taxonomy, payloads, results journal, custom-field queue) lives
# OUTSIDE this repo under ~/finance/paperless/enrich_20261016/ — override the
# root with IDLEFILL_PAPERLESS_HOME when the deploy lives elsewhere.
# Contract (idlefill): argv = {payload_file} {result_file}; exit 0 always,
# failures reported as {ok:false} inside the result file.
#
# LLM endpoint policy: route through idlefill's OWN aggregate router so the
# fleet's catalog decides which engine serves the client-configured model
# (payload.model, e.g. Qwen3.8-Flash-Next -> scanbot's 1080ti). Never hardcode
# a GPU here. The aggregate needs an idlefill agent key (idlk_...), kept in a
# 0600 file in the finance deploy; IDLEFILL_PROXY/IDLEFILL_KEY envs override.
set -u
HOME_DIR="${IDLEFILL_PAPERLESS_HOME:-$HOME/finance/paperless/enrich_20261016}"
TARGET="$HOME_DIR/adapter/enrich.sh"
if [ ! -f "$TARGET" ]; then
  printf '{"ok":false,"error":"executor home missing: %s"}' "$HOME_DIR" > "$2"
  exit 0
fi
if [ -z "${IDLEFILL_PROXY:-}" ]; then
  AGG_PORT=$(python3 -c "import json;print(json.load(open('$HOME/Software/idlefill/client/config.json')).get('aggregate_port',8800))" 2>/dev/null || echo 8800)
  export IDLEFILL_PROXY="http://127.0.0.1:${AGG_PORT}/v1"
fi
if [ -z "${IDLEFILL_KEY:-}" ] && [ -f "$HOME/finance/paperless/idlefill_agent_key" ]; then
  export IDLEFILL_KEY="$(cat "$HOME/finance/paperless/idlefill_agent_key")"
fi
exec bash "$TARGET" "$1" "$2"

#!/bin/zsh
set -e

PROJECT_DIR="/Users/bytedance/Documents/work/vis"
NODE_BIN="/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
URL="http://127.0.0.1:5173/"

cd "$PROJECT_DIR"

if lsof -ti tcp:5173 >/dev/null 2>&1 && lsof -ti tcp:5175 >/dev/null 2>&1; then
  open "$URL"
  echo "Viewer is already running at $URL"
  exit 0
fi

open "$URL"
exec "$NODE_BIN" scripts/dev.mjs

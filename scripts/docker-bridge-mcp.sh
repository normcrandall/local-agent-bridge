#!/bin/zsh
set -eu

ROOT="${BRIDGE_RUNTIME_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
  exec "$NODE_BIN" "$ROOT/src/docker-bridge.mjs"
fi

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$ROOT/src/docker-bridge.mjs"
fi

FALLBACK_NODE="$HOME/.nvm/versions/node/v24.14.0/bin/node"
if [[ -x "$FALLBACK_NODE" ]]; then
  exec "$FALLBACK_NODE" "$ROOT/src/docker-bridge.mjs"
fi

echo "Node.js is required to run the Docker Model Runner MCP bridge." >&2
exit 127

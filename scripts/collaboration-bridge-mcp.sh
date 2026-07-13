#!/bin/zsh
set -eu

ROOT="${0:A:h:h}"
export BRIDGE_RUNTIME_ROOT="$ROOT"
export BRIDGE_WORKSPACE_ROOT="${BRIDGE_WORKSPACE_ROOT:-$ROOT}"
export BRIDGE_COLLABORATION_DIR="${BRIDGE_COLLABORATION_DIR:-$HOME/.local/share/agent-bridge/state}"

if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
  exec "$NODE_BIN" "$ROOT/src/collaboration-bridge.mjs"
fi

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$ROOT/src/collaboration-bridge.mjs"
fi

for FALLBACK_NODE in "$HOME"/.nvm/versions/node/*/bin/node(N); do
  [[ -x "$FALLBACK_NODE" ]] && exec "$FALLBACK_NODE" "$ROOT/src/collaboration-bridge.mjs"
done

print -u2 "Node.js not found. Set NODE_BIN to an absolute Node.js path."
exit 127

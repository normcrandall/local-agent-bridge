#!/bin/zsh
set -eu

ROOT="${0:A:h:h}"
SOURCE_CODEX_HOME="${BRIDGE_SOURCE_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
DELEGATED_CODEX_HOME="${BRIDGE_CODEX_HOME:-$HOME/.local/share/agent-bridge/codex-home}"

NODE="${NODE_BIN:-}"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  for FALLBACK_NODE in "$HOME"/.nvm/versions/node/*/bin/node(N); do
    if [[ -x "$FALLBACK_NODE" ]]; then
      NODE="$FALLBACK_NODE"
      break
    fi
  done
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  print -u2 "Node.js is required to prepare the isolated delegated Codex home."
  exit 127
fi
"$NODE" "$ROOT/scripts/prepare-codex-home.mjs" "$SOURCE_CODEX_HOME" "$DELEGATED_CODEX_HOME" >/dev/null

export CODEX_HOME="$DELEGATED_CODEX_HOME"

if [[ -n "${CODEX_BRIDGE_CODEX_BIN:-}" && -x "$CODEX_BRIDGE_CODEX_BIN" ]]; then
  export CODEX_BRIDGE_CODEX_BIN
  exec "$NODE" "$ROOT/src/codex-bridge.mjs"
fi

for candidate in \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/.codex/plugins/.plugin-appserver/codex"
do
  if [[ -x "$candidate" ]]; then
    export CODEX_BRIDGE_CODEX_BIN="$candidate"
    exec "$NODE" "$ROOT/src/codex-bridge.mjs"
  fi
done

if command -v codex >/dev/null 2>&1 && codex --version >/dev/null 2>&1; then
  export CODEX_BRIDGE_CODEX_BIN="$(command -v codex)"
  exec "$NODE" "$ROOT/src/codex-bridge.mjs"
fi

print -u2 "A working Codex binary was not found. Set CODEX_BRIDGE_CODEX_BIN."
exit 127

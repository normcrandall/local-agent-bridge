#!/bin/zsh
set -eu

ROOT="${0:A:h:h}"
CLI="$ROOT/node_modules/@playwright/mcp/cli.js"

if [[ ! -f "$CLI" ]]; then
  print -u2 "Playwright MCP is not installed. Run npm install in $ROOT."
  exit 127
fi

if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
  exec "$NODE_BIN" "$CLI" --browser chrome --isolated
fi

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$CLI" --browser chrome --isolated
fi

for FALLBACK_NODE in "$HOME"/.nvm/versions/node/*/bin/node(N); do
  [[ -x "$FALLBACK_NODE" ]] && exec "$FALLBACK_NODE" "$CLI" --browser chrome --isolated
done

print -u2 "Node.js not found. Set NODE_BIN to an absolute Node.js path."
exit 127

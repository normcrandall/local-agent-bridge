import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const cache = mkdtempSync(join(tmpdir(), "claude-capability-guard-"));
const client = new Client({ name: "claude-capability-guard", version: "1" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "src/claude-bridge.mjs")],
    cwd: root,
    env: {
      ...process.env, CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs"), FAKE_CLAUDE_NO_STRICT: "1",
      BRIDGE_RUNTIME_ROOT: root, BRIDGE_WORKSPACE_ROOT: root, HOME: cache,
    },
  }));
  const result = await client.callTool({ name: "ask_claude", arguments: { prompt: "review", mode: "review" } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /strict-mcp-config isolation/);
} finally {
  await client.close().catch(() => {});
  rmSync(cache, { recursive: true, force: true });
}
console.log("Claude capability guard test passed: missing strict MCP isolation fails before delegation.");

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = resolve(homedir(), ".local/bin/agent-collaboration-mcp");
const runtimeServer = resolve(
  homedir(),
  ".local/share/agent-bridge/runtime/src/collaboration-bridge.mjs",
);
await access(launcher, constants.X_OK);
await access(runtimeServer, constants.R_OK);

const claudeConfigPath = resolve(
  homedir(),
  "Library/Application Support/Claude/claude_desktop_config.json",
);
const claudeConfig = JSON.parse(await readFile(claudeConfigPath, "utf8"));
assert.equal(claudeConfig.mcpServers?.collaboration?.command, launcher);
assert.deepEqual(claudeConfig.mcpServers?.collaboration?.args, []);

const userConfig = JSON.parse(await readFile(resolve(homedir(), ".claude.json"), "utf8"));
const servers = {
  codex: {
    launcher: resolve(homedir(), ".local/bin/agent-codex-mcp"),
    requiredTools: ["codex", "codex-reply"],
  },
  antigravity: {
    launcher: resolve(homedir(), ".local/bin/agent-antigravity-mcp"),
    requiredTools: ["ask_antigravity", "continue_antigravity"],
  },
  ollama: {
    launcher: resolve(homedir(), ".local/bin/agent-ollama-mcp"),
    requiredTools: ["ask_ollama", "continue_ollama", "get_ollama_status"],
  },
  docker: {
    launcher: resolve(homedir(), ".local/bin/agent-docker-mcp"),
    requiredTools: ["ask_docker", "continue_docker", "get_docker_status"],
  },
  collaboration: {
    launcher,
    requiredTools: [
      "cancel_collaboration",
      "continue_collaboration",
      "get_collaboration",
      "list_collaborations",
      "start_collaboration",
    ],
  },
  playwright: {
    launcher: resolve(homedir(), ".local/bin/agent-playwright-mcp"),
    requiredTools: ["browser_navigate"],
  },
};

for (const [name, definition] of Object.entries(servers)) {
  await access(definition.launcher, constants.X_OK);
  assert.equal(userConfig.mcpServers?.[name]?.command, definition.launcher);
  const client = new Client({ name: `global-launcher-regression-${name}`, version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: definition.launcher,
    args: [],
    cwd: homedir(),
    env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    for (const required of definition.requiredTools) {
      assert.equal(toolNames.includes(required), true, `${name} is missing ${required}`);
    }
  } finally {
    await client.close();
  }
}

console.log("Claude Desktop and Claude CLI global MCP launcher tests passed with a reduced GUI-style environment.");

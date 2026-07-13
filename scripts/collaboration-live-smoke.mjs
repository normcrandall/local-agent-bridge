import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const client = new Client({ name: "collaboration-live-smoke", version: "0.2.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [resolve(root, "scripts/collaboration-bridge-mcp.sh")],
  cwd: root,
  env: { ...process.env },
});

await client.connect(transport);
try {
  const started = await client.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Connectivity smoke test only. Do not edit files or invoke other agents or tools. State your agent identity, confirm you received this task through the persistent desktop collaboration broker, and end with exactly STATUS: AGREED.",
      agents: ["claude", "codex", "antigravity"],
      mode: "review",
      maxTurns: 3,
    },
  });
  if (started.isError) throw new Error(JSON.stringify(started.content));
  const id = started.structuredContent.id;
  console.log(`Live collaboration: ${id}`);

  const deadline = Date.now() + 15 * 60 * 1000;
  let view = started.structuredContent;
  while (["queued", "running", "cancelling"].includes(view.status) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const result = await client.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: id, includeTurns: 10 },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    view = result.structuredContent;
    process.stdout.write(`\rStatus: ${view.status}; turns: ${view.runtime?.turnCount || 0}`);
  }
  process.stdout.write("\n");
  for (const turn of view.turns || []) {
    console.log(`${turn.number}. ${turn.agent}: ${turn.status}`);
  }
  if (view.status !== "agreed" || view.runtime?.turnCount !== 3) {
    throw new Error(view.error || `Live collaboration ended ${view.status} after ${view.runtime?.turnCount || 0} turns.`);
  }
  console.log("Live three-provider collaboration passed using configured models.");
} finally {
  await client.close();
}

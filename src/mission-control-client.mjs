import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

function textFrom(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : JSON.stringify(result.structuredContent || {});
}

export async function callMissionControlAction({ runtimeRoot, workspaceRoot = runtimeRoot, stateRoot, name, arguments: input }) {
  const client = new Client({ name: "agent-bridge-mission-control", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(runtimeRoot, "src/collaboration-bridge.mjs")],
    cwd: runtimeRoot,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot, BRIDGE_WORKSPACE_ROOT: workspaceRoot, BRIDGE_COLLABORATION_DIR: stateRoot },
  });
  try {
    await client.connect(transport, { timeout: 5_000 });
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 30_000 });
    if (result.isError) throw new Error(textFrom(result));
    return result.structuredContent || { message: textFrom(result) };
  } finally {
    await client.close().catch(() => {});
  }
}

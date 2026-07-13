#!/usr/bin/env node

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--mcp-config");
const mcpConfig = configIndex >= 0
  ? JSON.parse(readFileSync(args[configIndex + 1], "utf8"))
  : null;

const delayMs = Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS || "0", 10);
if (delayMs > 0) {
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Inspecting the requested files; verification comes next." }] },
  })}\n`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

process.stdout.write(`${JSON.stringify({
  type: "result",
  result: JSON.stringify({ args, mcpConfig }),
  session_id: "fake-claude-session",
  is_error: false,
  duration_ms: 1,
})}\n`);

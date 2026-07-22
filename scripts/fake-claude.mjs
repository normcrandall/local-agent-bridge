#!/usr/bin/env node

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  const strict = process.env.FAKE_CLAUDE_NO_STRICT === "1" ? "" : " --strict-mcp-config";
  process.stdout.write(`-p, --print --output-format --model --fallback-model --resume${strict} --mcp-config --verbose --allowedTools --permission-mode --dangerously-skip-permissions --add-dir\n`);
  process.exit(0);
}
const configIndex = args.indexOf("--mcp-config");
const mcpConfig = configIndex >= 0
  ? JSON.parse(readFileSync(args[configIndex + 1], "utf8"))
  : null;

const delayMs = Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS || "0", 10);
if (process.env.FAKE_CLAUDE_TOOL_EVENT === "1") {
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] },
  })}\n`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  process.stdout.write(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "passed", is_error: false }] },
  })}\n`);
  if (process.env.FAKE_CLAUDE_AMBIGUOUS_TOOL_RESULT === "1") {
    process.stdout.write(`${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: { command: "git diff --check" } }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-2", content: "ambiguous result" }] },
    })}\n`);
  }
}
if (process.env.FAKE_CLAUDE_REVIEW_TOOL_EVENT === "1") {
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "review-1", name: "mcp__github_review__submit_pr_review", input: {} }] },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "review-1", content: "published", is_error: false }] },
  })}\n`);
}
if (delayMs > 0) {
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Inspecting the requested files; verification comes next." }] },
  })}\n`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

const result = process.env.FAKE_CLAUDE_HANDOFF === "1"
  ? 'Completed the delegated task.\nHANDOFF: {"outcome":"completed","summary":"Implemented and verified the delegated task.","artifacts":["src/example.mjs"],"verification":["npm test: passed"],"remaining":[],"nextAction":"chair_verify"}\nSTATUS: AGREED'
  : JSON.stringify({ args, mcpConfig });

process.stdout.write(`${JSON.stringify({
  type: "result",
  result,
  session_id: "fake-claude-session",
  is_error: false,
  duration_ms: 1,
  modelUsage: { "claude-opus-4-6": { inputTokens: 1, outputTokens: 1 } },
})}\n`);

#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("--json --model --sandbox --cd --skip-git-repo-check --config\n");
  process.exit(0);
}
if (process.env.FAKE_CODEX_ARGS_FILE) {
  appendFileSync(process.env.FAKE_CODEX_ARGS_FILE, `${JSON.stringify(args)}\n`);
}
if (args[0] === "exec" && args[1] === "resume" && args.includes("--color")) {
  process.stderr.write("error: unexpected argument '--color' found\n");
  process.exit(2);
}

const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "default";
const prompt = args.at(-1) || "";
if (prompt === "FAKE_NON_OVERLOAD_FAILURE") {
  process.stdout.write(`${JSON.stringify({ type: "error", message: "Codex authentication failed." })}\n`);
  process.exit(1);
}
const overloadedModels = new Set(
  (process.env.FAKE_CODEX_OVERLOAD_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean),
);
if (overloadedModels.has(model)) {
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "22222222-2222-4222-8222-222222222222" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "error", message: "We're experiencing high demand right now; please retry." })}\n`);
  process.exit(1);
}

const events = [
  { type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "Inspecting the relevant files." } },
  { type: "item.started", item: { id: "command-1", type: "command_execution", command: "test", status: "in_progress" } },
  { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "test", status: "completed", exit_code: 0 } },
  { type: "item.completed", item: { id: "message-2", type: "agent_message", text: "FAKE_CODEX_COMPLETE" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];

for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);

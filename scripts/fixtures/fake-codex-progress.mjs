#!/usr/bin/env node

import { appendFileSync } from "node:fs";

if (process.env.FAKE_CODEX_ARGS_FILE) {
  appendFileSync(process.env.FAKE_CODEX_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
}

const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "resume" && args.includes("--color")) {
  process.stderr.write("error: unexpected argument '--color' found\n");
  process.exit(2);
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

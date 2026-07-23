#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { listCollaborations, readCollaboration } from "../src/collaboration-store.mjs";
import { deliverAttentionNotification, scanPendingUserAttention } from "../src/user-attention.mjs";

const args = process.argv.slice(2);
const command = args[0] || "list";
const stateRootIndex = args.indexOf("--state-root");
const stateRoot = resolve(stateRootIndex >= 0 && args[stateRootIndex + 1]
  ? args[stateRootIndex + 1]
  : process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state"));
process.env.BRIDGE_COLLABORATION_DIR = stateRoot;

if (command === "test") {
  const result = await deliverAttentionNotification({
    title: "Agent Bridge notification test",
    subtitle: "Desktop attention signalling is enabled",
    body: "A collaboration that needs your input will alert you here and repeat every 15 minutes until acknowledged.",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.delivered ? 0 : 1);
}

if (command === "notify") {
  const results = await scanPendingUserAttention(process.cwd(), { force: true });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(0);
}

if (command !== "list") {
  process.stderr.write("Usage: bridge attention [list|notify|test] [--state-root PATH]\n");
  process.exit(2);
}

const summaries = await listCollaborations(process.cwd(), { limit: 10_000 });
const pending = [];
for (const summary of summaries) {
  if (summary.status !== "needs_user" && summary.coordinatorWake?.kind !== "needs_user") continue;
  const state = await readCollaboration(process.cwd(), summary.id).catch(() => null);
  if (!state || state.coordinatorWake?.status === "acknowledged") continue;
  pending.push({
    collaborationId: state.id,
    workspace: state.workspace,
    summary: state.coordinatorWake?.summary || state.error || state.task,
    attention: state.coordinatorWake?.userAttention || null,
  });
}
process.stdout.write(`${JSON.stringify({ stateRoot, pending }, null, 2)}\n`);

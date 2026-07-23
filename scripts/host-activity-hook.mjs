#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { recordHostActivity } from "../src/host-activity-store.mjs";

function inputJson() {
  try { return JSON.parse(readFileSync(0, "utf8")); }
  catch { return {}; }
}

const provider = process.argv[2];
const action = process.argv[3];
const input = inputJson();
const stateRoot = resolve(process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state"));
const sourceEvent = input.hook_event_name || input.hookEventName || action;
const tool = input.tool_name || input.toolName || null;
const task = action === "start" ? input.prompt : null;
const model = typeof input.model === "string"
  ? input.model
  : input.model?.display_name || input.model?.displayName || input.model?.id || input.model?.name || null;
const summary = action === "heartbeat" && tool
  ? `Native ${provider} host is using ${tool}.`
  : null;

try {
  await recordHostActivity(stateRoot, {
    provider,
    action,
    sessionId: input.session_id || input.sessionId || input.thread_id || input.threadId || null,
    workspace: input.cwd || process.env.GEMINI_PROJECT_DIR || process.cwd(),
    model,
    task,
    summary,
    sourceEvent,
  });
} catch {
  // Activity telemetry must never block or change the host agent's turn.
}

process.stdout.write("{}\n");

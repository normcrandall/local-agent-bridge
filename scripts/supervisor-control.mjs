#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { getSupervisorStatus, refreshSupervisor } from "../src/worker-supervisor-client.mjs";

const action = process.argv[2] || "status";
if (!["status", "refresh"].includes(action)) {
  throw new Error("Usage: bridge supervisor [status|refresh]");
}

const runtimeRoot = resolve(process.env.BRIDGE_RUNTIME_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || process.cwd());
const stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state"));

let result;
if (action === "refresh") {
  result = await refreshSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, startIfMissing: false });
} else {
  try {
    result = { running: true, ...(await getSupervisorStatus({ workspaceRoot, stateDirectory })) };
  } catch {
    result = { running: false, stateDirectory };
  }
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

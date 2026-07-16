#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  appendEvent,
  readCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";

const runtimeRoot = realpathSync(
  process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);
const workspaceRoot = realpathSync(
  process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || runtimeRoot,
);
const id = process.argv[2];
const delaySeconds = Number.parseInt(process.argv[3] || "0", 10);
if (!id || !Number.isInteger(delaySeconds) || delaySeconds < 0) {
  throw new Error("Usage: collaboration-recovery.mjs <collaborationId> <delaySeconds>");
}

await new Promise((resolvePromise) => setTimeout(resolvePromise, delaySeconds * 1000));
const state = await readCollaboration(workspaceRoot, id);
if (state.status !== "recovering" || state.cancelRequested) process.exit(0);

await updateCollaboration(workspaceRoot, id, (current) => ({
  ...current,
  status: "queued",
  workerPid: null,
  workerOwner: null,
  providerRecoveryState: {
    ...(current.providerRecoveryState || {}),
    status: "retrying",
    retriedAt: new Date().toISOString(),
  },
  runtime: {
    ...current.runtime,
    activeCall: null,
    availableAgents: current.agents,
  },
}));
await appendEvent(workspaceRoot, id, {
  type: "provider_recovery_retry",
  at: new Date().toISOString(),
  attempt: state.providerRecoveryState?.attempts || 0,
});

const worker = spawn(process.execPath, [resolve(runtimeRoot, "scripts/collaboration-worker.mjs"), id], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    BRIDGE_RUNTIME_ROOT: runtimeRoot,
    BRIDGE_WORKSPACE_ROOT: workspaceRoot,
    BRIDGE_WORKER_TOKEN: randomUUID(),
  },
  detached: true,
  stdio: "ignore",
});
worker.unref();

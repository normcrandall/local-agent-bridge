#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  appendEvent,
  collaborationDirectory,
  listCollaborations,
  readCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";
import { TERMINAL_COLLABORATION_STATUSES } from "../src/collaboration-cleanup.mjs";
import { enqueueCoordinatorWake } from "../src/coordinator-wake.mjs";
import { supervisorEndpoint } from "../src/worker-supervisor-protocol.mjs";

const PROTOCOL_VERSION = 1;
const runtimeRoot = resolve(process.env.BRIDGE_RUNTIME_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot);
const stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot));
const endpoint = supervisorEndpoint(stateDirectory);
const metadataPath = resolve(stateDirectory, "supervisor.json");
const supervisorId = randomUUID();
const monitored = new Map();
let stopping = false;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processCommand(pid) {
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout?.trim() || "";
}

function processStartIdentity(pid) {
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout?.trim() || null;
}

function normalizeWorkerEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker environment must be a string map.");
  }
  const entries = Object.entries(value);
  let bytes = 0;
  const normalized = {};
  for (const [key, entryValue] of entries) {
    if (!key || key.includes("\0") || typeof entryValue !== "string" || entryValue.includes("\0")) {
      throw new Error("Worker environment contains an invalid entry.");
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entryValue);
    if (bytes > 512_000) throw new Error("Worker environment exceeded the size limit.");
    normalized[key] = entryValue;
  }
  return normalized;
}

function recordedWorkerAlive(state) {
  if (!processAlive(state.workerPid)) return false;
  const command = processCommand(state.workerPid);
  const expected = state.workerOwner?.command || "collaboration-worker.mjs";
  const expectedStart = state.workerOwner?.processStartedAt || null;
  const observedStart = processStartIdentity(state.workerPid);
  return command.includes(expected)
    && command.includes(state.id)
    && (!expectedStart || expectedStart === observedStart);
}

async function atomicMetadata(value) {
  const temporary = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, metadataPath);
}

async function recordWorkerExit({ collaborationId, pid, code = null, signal = null, adopted = false }) {
  const entry = monitored.get(pid);
  if (entry?.receipted) return;
  if (entry) entry.receipted = true;
  const at = new Date().toISOString();
  let state;
  try {
    state = await readCollaboration(workspaceRoot, collaborationId);
  } catch {
    monitored.delete(pid);
    return;
  }
  const terminal = TERMINAL_COLLABORATION_STATUSES.has(state.status)
    || state.status === "cancelling"
    || state.cancelRequested === true;
  const ownsCurrentRun = state.workerPid === pid;
  const receipt = {
    type: "worker_exit",
    at,
    receiptId: randomUUID(),
    supervisorId,
    pid,
    code,
    signal,
    adopted,
    terminalReceipt: terminal,
  };
  await appendEvent(workspaceRoot, collaborationId, receipt).catch(() => {});
  if (ownsCurrentRun && !terminal && state.status !== "recovering") {
    const reason = signal ? `signal ${signal}` : code === null ? "an unknown process exit" : `exit code ${code}`;
    const error = `Worker exited without a terminal receipt (${reason}).`;
    await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
      ...current,
      status: "indeterminate",
      error,
      workerPid: null,
      lastWorkerExit: receipt,
      runtime: {
        ...(current.runtime || {}),
        activeCall: current.runtime?.activeCall
          ? { ...current.runtime.activeCall, status: "indeterminate", phase: "unknown" }
          : null,
      },
    })).catch(() => {});
    await enqueueCoordinatorWake(workspaceRoot, collaborationId).catch(() => {});
  }
  monitored.delete(pid);
}

function monitorWorker({ collaborationId, pid, child = null, adopted = false }) {
  monitored.set(pid, { collaborationId, pid, child, adopted, receipted: false });
  if (child) {
    child.once("exit", (code, signal) => {
      void recordWorkerExit({ collaborationId, pid, code, signal, adopted: false });
    });
  }
}

async function adoptRecordedWorkers() {
  const summaries = await listCollaborations(workspaceRoot, { limit: 10_000 });
  for (const summary of summaries) {
    if (TERMINAL_COLLABORATION_STATUSES.has(summary.status)) continue;
    const state = await readCollaboration(workspaceRoot, summary.id).catch(() => null);
    if (!state || !Number.isInteger(state.workerPid)) continue;
    if (recordedWorkerAlive(state)) {
      monitorWorker({ collaborationId: state.id, pid: state.workerPid, adopted: true });
    } else if (!processAlive(state.workerPid)) {
      await recordWorkerExit({
        collaborationId: state.id,
        pid: state.workerPid,
        code: null,
        signal: "UNKNOWN",
        adopted: true,
      });
    }
  }
}

async function startWorker({ collaborationId, requestedRuntimeRoot, requestedWorkspaceRoot, workerEnvironment }) {
  if (!/^bridge-[0-9a-f-]{36}$/.test(collaborationId || "")) throw new Error("Invalid collaboration ID.");
  const state = await readCollaboration(workspaceRoot, collaborationId);
  if (TERMINAL_COLLABORATION_STATUSES.has(state.status)) {
    throw new Error(`Cannot start terminal collaboration ${collaborationId} (${state.status}).`);
  }
  if (recordedWorkerAlive(state)) {
    if (!monitored.has(state.workerPid)) {
      monitorWorker({ collaborationId, pid: state.workerPid, adopted: true });
    }
    await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
      ...current,
      workerOwner: {
        ...(current.workerOwner || {}),
        adoptedBySupervisorId: supervisorId,
        adoptedBySupervisorPid: process.pid,
        adoptedAt: new Date().toISOString(),
      },
    }));
    return {
      supervisorId,
      supervisorPid: process.pid,
      workerPid: state.workerPid,
      reused: true,
    };
  }
  if (Number.isInteger(state.workerPid)) {
    if (processAlive(state.workerPid)) {
      throw new Error(`Recorded worker PID ${state.workerPid} is live but its command or start identity does not match; no replacement was started.`);
    }
    await recordWorkerExit({
      collaborationId,
      pid: state.workerPid,
      code: null,
      signal: "UNKNOWN",
      adopted: true,
    });
    throw new Error(`Recorded worker PID ${state.workerPid} disappeared; inspect recovery before starting replacement work.`);
  }

  const selectedRuntimeRoot = resolve(requestedRuntimeRoot || runtimeRoot);
  const selectedWorkspaceRoot = resolve(requestedWorkspaceRoot || workspaceRoot);
  if (selectedRuntimeRoot !== runtimeRoot) {
    throw new Error(`Supervisor runtime mismatch: expected ${runtimeRoot}.`);
  }
  const workerPath = resolve(process.env.BRIDGE_SUPERVISOR_WORKER_PATH || resolve(selectedRuntimeRoot, "scripts/collaboration-worker.mjs"));
  const selectedWorkerEnvironment = normalizeWorkerEnvironment(workerEnvironment);
  const workerToken = randomUUID();
  const child = spawn(process.execPath, [workerPath, collaborationId], {
    cwd: selectedRuntimeRoot,
    env: {
      ...selectedWorkerEnvironment,
      BRIDGE_RUNTIME_ROOT: selectedRuntimeRoot,
      BRIDGE_WORKSPACE_ROOT: selectedWorkspaceRoot,
      BRIDGE_COLLABORATION_DIR: stateDirectory,
      BRIDGE_WORKER_TOKEN: workerToken,
      BRIDGE_SUPERVISOR_ID: supervisorId,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  monitorWorker({ collaborationId, pid: child.pid, child });
  const owner = {
    id: collaborationId,
    pid: child.pid,
    token: workerToken,
    supervisorId,
    supervisorPid: process.pid,
    startedAt: new Date().toISOString(),
    processStartedAt: processStartIdentity(child.pid),
    command: basename(workerPath),
  };
  await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
    ...current,
    workerPid: child.pid,
    workerOwner: owner,
  }));
  await appendEvent(workspaceRoot, collaborationId, {
    type: "worker_supervised_started",
    at: owner.startedAt,
    supervisorId,
    supervisorPid: process.pid,
    pid: child.pid,
  });
  return {
    supervisorId,
    supervisorPid: process.pid,
    workerPid: child.pid,
    reused: false,
  };
}

async function endpointIsLive() {
  return new Promise((resolvePromise) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}

if (await endpointIsLive()) process.exit(0);
if (process.platform !== "win32") await rm(endpoint, { force: true });

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 1_000_000) {
      socket.destroy(new Error("Supervisor request exceeded the size limit."));
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    void (async () => {
      try {
        const request = JSON.parse(raw);
        if (request.protocol !== PROTOCOL_VERSION) throw new Error("Unsupported supervisor protocol version.");
        let result;
        if (request.type === "ping") {
          result = { supervisorId, supervisorPid: process.pid, protocol: PROTOCOL_VERSION, monitoredWorkers: monitored.size };
        } else if (request.type === "start") {
          result = await startWorker({
            collaborationId: request.collaborationId,
            requestedRuntimeRoot: request.runtimeRoot,
            requestedWorkspaceRoot: request.workspaceRoot,
            workerEnvironment: request.workerEnvironment,
          });
        } else {
          throw new Error(`Unknown supervisor request: ${request.type}`);
        }
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      }
    })();
  });
});

await atomicMetadata({
  protocol: PROTOCOL_VERSION,
  supervisorId,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  runtimeRoot,
  stateDirectory,
});
await adoptRecordedWorkers();
await new Promise((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(endpoint, resolvePromise);
});
if (process.platform !== "win32") await chmod(endpoint, 0o600);

const monitor = setInterval(() => {
  for (const entry of monitored.values()) {
    if (!entry.child && !processAlive(entry.pid)) {
      void recordWorkerExit({
        collaborationId: entry.collaborationId,
        pid: entry.pid,
        code: null,
        signal: "UNKNOWN",
        adopted: true,
      });
    }
  }
}, 1_000);
monitor.unref();

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  await atomicMetadata({
    protocol: PROTOCOL_VERSION,
    supervisorId,
    pid: process.pid,
    startedAt: JSON.parse(await readFile(metadataPath, "utf8")).startedAt,
    stoppedAt: new Date().toISOString(),
    signal,
  }).catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (process.platform !== "win32") await rm(endpoint, { force: true });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

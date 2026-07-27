#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
import { sanitizeWorkerEnvironment, supervisorEndpoint } from "../src/worker-supervisor-protocol.mjs";
import { createLocalModelWarmer } from "../src/local-model-warmth.mjs";
import { scanPendingUserAttention } from "../src/user-attention.mjs";
import { clearRepositoryCache, loadMissionControlSnapshot } from "../src/mission-control.mjs";
import { MissionControlEventStream } from "../src/mission-control-event-stream.mjs";
import { reconcileMissionControlRemote } from "../src/mission-control-remote.mjs";

import { killProcessSafely, processProbe } from "../src/process-identity-probe.mjs";

const PROTOCOL_VERSION = 1;
const runtimeRoot = resolve(process.env.BRIDGE_RUNTIME_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot);
const stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot));
const endpoint = supervisorEndpoint(stateDirectory);
const metadataPath = resolve(stateDirectory, "supervisor.json");
const supervisorId = randomUUID();
const supervisorStartedAt = new Date().toISOString();
const monitored = new Map();
const startOperations = new Map();
let stopping = false;
let ready = false;
let refreshing = false;
let modelWarmthStatus = { status: "starting", provider: null };
let attentionScanRunning = false;
const modelWarmer = createLocalModelWarmer({ onStatus: (status) => { modelWarmthStatus = status; } });
const configuredMissionControlRetention = Number.parseInt(process.env.BRIDGE_MISSION_CONTROL_EVENT_RETENTION || "512", 10);
const missionControlStream = new MissionControlEventStream({
  retention: Number.isSafeInteger(configuredMissionControlRetention)
    && configuredMissionControlRetention >= 1
    && configuredMissionControlRetention <= 10_000
    ? configuredMissionControlRetention
    : 512,
  loadSnapshot: () => loadMissionControlSnapshot({
    stateRoot: stateDirectory,
    view: "all",
    includeStale: true,
  }),
});
const configuredMissionControlIdleMs = Number.parseInt(process.env.BRIDGE_MISSION_CONTROL_IDLE_MS || "60000", 10);
const missionControlIdleMs = Number.isSafeInteger(configuredMissionControlIdleMs) && configuredMissionControlIdleMs >= 250
  ? configuredMissionControlIdleMs
  : 60_000;
let missionControlLastReadAt = 0;

function touchMissionControlStream() {
  missionControlLastReadAt = Date.now();
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function workerIdentityStatus({ pid, collaborationId, workerOwner }) {
  if (!processAlive(pid)) return { status: "dead" };
  const command = processProbe(pid, "command");
  const observedStart = processProbe(pid, "lstart");
  if (!command.available || !observedStart.available) {
    return { status: "unavailable", command, observedStart };
  }
  const expected = workerOwner?.command || "collaboration-worker.mjs";
  const expectedStart = workerOwner?.processStartedAt || null;
  const matches = command.value.includes(expected)
    && command.value.includes(collaborationId)
    && (!expectedStart || expectedStart === observedStart.value);
  return { status: matches ? "match" : "mismatch", command, observedStart };
}

function recordedWorkerIdentity(state) {
  return workerIdentityStatus({
    pid: state.workerPid,
    collaborationId: state.id,
    workerOwner: state.workerOwner,
  });
}

async function serializeStart(collaborationId, operation) {
  const previous = startOperations.get(collaborationId) || Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => { release = resolvePromise; });
  startOperations.set(collaborationId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (startOperations.get(collaborationId) === current) startOperations.delete(collaborationId);
  }
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

// A live PID whose identity is mismatched or unverifiable has NOT exited. Routing it
// through recordWorkerExit would null workerPid, and the next start request would then
// see an unowned collaboration and launch a duplicate writer alongside the running one.
// The fence therefore preserves workerPid and workerOwner, records why the worker is
// untrusted, and leaves startWorker to reject every replacement until the PID is proven
// dead by explicit recovery.
async function recordWorkerFenced({ collaborationId, pid, signal, reason }) {
  let state;
  try {
    state = await readCollaboration(workspaceRoot, collaborationId);
  } catch {
    return;
  }
  if (state.workerPid !== pid) return;
  if (state.lastWorkerFence?.pid === pid && state.lastWorkerFence?.signal === signal) return;

  const at = new Date().toISOString();
  const receipt = {
    type: "worker_fenced",
    at,
    receiptId: randomUUID(),
    supervisorId,
    pid,
    signal,
    reason,
    terminalReceipt: false,
  };
  await appendEvent(workspaceRoot, collaborationId, receipt).catch(() => {});

  const terminal = TERMINAL_COLLABORATION_STATUSES.has(state.status)
    || state.status === "cancelling"
    || state.cancelRequested === true;
  if (terminal) return;

  await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
    ...current,
    status: "indeterminate",
    error: reason,
    // workerPid and workerOwner are deliberately left untouched: the process is alive
    // and still owns this collaboration.
    lastWorkerFence: receipt,
    runtime: {
      ...(current.runtime || {}),
      activeCall: current.runtime?.activeCall
        ? { ...current.runtime.activeCall, status: "indeterminate", phase: "unknown" }
        : null,
    },
  })).catch(() => {});
  await enqueueCoordinatorWake(workspaceRoot, collaborationId).catch(() => {});
}

function fenceReason({ pid, signal, identity }) {
  return signal === "IDENTITY_UNAVAILABLE"
    ? `Worker PID ${pid} is live but its identity could not be verified (${identity?.command?.error || identity?.observedStart?.error || "probe unavailable"}); ownership is fenced and no replacement will be started.`
    : `Worker PID ${pid} is live but its command or start identity no longer matches the recorded owner; ownership is fenced and no replacement will be started.`;
}

function monitorWorker({ collaborationId, pid, child = null, adopted = false, workerOwner = null }) {
  monitored.set(pid, {
    collaborationId, pid, child, adopted, workerOwner, receipted: false, checking: false, probeFailures: 0, fenced: false,
  });
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
    const identity = recordedWorkerIdentity(state);
    if (identity.status === "match") {
      monitorWorker({ collaborationId: state.id, pid: state.workerPid, adopted: true, workerOwner: state.workerOwner });
    } else if (identity.status === "dead") {
      await recordWorkerExit({
        collaborationId: state.id,
        pid: state.workerPid,
        code: null,
        signal: "UNKNOWN",
        adopted: true,
      });
    } else if (identity.status === "unavailable") {
      // A probe failure at adoption may be transient, so keep ownership and let the
      // monitor's three-strike rule decide. Ownership is never released here.
      monitorWorker({ collaborationId: state.id, pid: state.workerPid, adopted: true, workerOwner: state.workerOwner });
    } else {
      // Mismatch is deterministic, not transient: fence immediately, but keep watching
      // the PID so a real exit can still be receipted.
      monitorWorker({ collaborationId: state.id, pid: state.workerPid, adopted: true, workerOwner: state.workerOwner });
      const entry = monitored.get(state.workerPid);
      if (entry) entry.fenced = true;
      await recordWorkerFenced({
        collaborationId: state.id,
        pid: state.workerPid,
        signal: "IDENTITY_MISMATCH",
        reason: fenceReason({ pid: state.workerPid, signal: "IDENTITY_MISMATCH", identity }),
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
  const recordedIdentity = Number.isInteger(state.workerPid) ? recordedWorkerIdentity(state) : { status: "dead" };
  if (recordedIdentity.status === "match") {
    if (!monitored.has(state.workerPid)) {
      monitorWorker({ collaborationId, pid: state.workerPid, adopted: true, workerOwner: state.workerOwner });
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
    // The PID is alive but unverified. Keep watching it, persist why it is untrusted,
    // and refuse the start: ownership stays with the running process until explicit
    // recovery proves it dead.
    if (recordedIdentity.status === "unavailable" || recordedIdentity.status === "mismatch") {
      const signal = recordedIdentity.status === "unavailable" ? "IDENTITY_UNAVAILABLE" : "IDENTITY_MISMATCH";
      if (!monitored.has(state.workerPid)) {
        monitorWorker({ collaborationId, pid: state.workerPid, adopted: true, workerOwner: state.workerOwner });
      }
      const entry = monitored.get(state.workerPid);
      if (entry) entry.fenced = true;
      await recordWorkerFenced({
        collaborationId,
        pid: state.workerPid,
        signal,
        reason: fenceReason({ pid: state.workerPid, signal, identity: recordedIdentity }),
      });
      throw new Error(recordedIdentity.status === "unavailable"
        ? `Recorded worker PID ${state.workerPid} identity could not be verified; no replacement was started.`
        : `Recorded worker PID ${state.workerPid} is live but its command or start identity does not match; no replacement was started.`);
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
  const selectedWorkerEnvironment = sanitizeWorkerEnvironment(workerEnvironment);
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
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
  const processStartedAt = processProbe(child.pid, "lstart");
  if (!processStartedAt.available) {
    killProcessSafely(child.pid, "SIGTERM");
    throw new Error(`Started worker PID ${child.pid} identity could not be captured; the worker was stopped.`);
  }
  child.unref();
  monitorWorker({ collaborationId, pid: child.pid, child });
  const owner = {
    id: collaborationId,
    pid: child.pid,
    token: workerToken,
    supervisorId,
    supervisorPid: process.pid,
    startedAt: new Date().toISOString(),
    processStartedAt: processStartedAt.value,
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

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);
if (await endpointIsLive()) process.exit(0);
if (process.platform !== "win32") await rm(endpoint, { force: true });

const server = createServer((socket) => {
  let buffer = "";
  const socketAbort = new AbortController();
  socket.once("close", () => socketAbort.abort());
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 1_000_000) {
      // Drop oversized untrusted input without attaching an unhandled socket error
      // that could terminate the machine supervisor and its subscription surface.
      socket.destroy();
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
        if (!ready) throw new Error("Collaboration supervisor is still starting.");
        let result;
        let afterResponse = null;
        if (request.type === "ping" || request.type === "status") {
          result = {
            supervisorId,
            supervisorPid: process.pid,
            protocol: PROTOCOL_VERSION,
            startedAt: supervisorStartedAt,
            runtimeRoot,
            stateDirectory,
            ready,
            refreshing,
            monitoredWorkers: monitored.size,
            workerPids: [...monitored.keys()].sort((left, right) => left - right),
            modelWarmth: modelWarmthStatus,
            missionControl: missionControlStream.status,
          };
        } else if (request.type === "start") {
          result = await serializeStart(request.collaborationId, () => startWorker({
            collaborationId: request.collaborationId,
            requestedRuntimeRoot: request.runtimeRoot,
            requestedWorkspaceRoot: request.workspaceRoot,
            workerEnvironment: request.workerEnvironment,
          }));
        } else if (request.type === "mission_control_snapshot") {
          touchMissionControlStream();
          result = await missionControlStream.snapshot();
        } else if (request.type === "mission_control_subscribe") {
          touchMissionControlStream();
          result = await missionControlStream.read({
            streamId: request.streamId,
            cursor: request.cursor,
            maxEvents: request.maxEvents,
            waitMs: request.waitMs,
            signal: socketAbort.signal,
          });
        } else if (request.type === "mission_control_refresh_repositories") {
          touchMissionControlStream();
          clearRepositoryCache();
          await missionControlStream.refresh();
          result = {
            refreshed: true,
            streamId: missionControlStream.streamId,
            cursor: missionControlStream.cursor,
          };
        } else if (request.type === "mission_control_reconcile") {
          touchMissionControlStream();
          const localSnapshot = await missionControlStream.snapshot();
          result = await reconcileMissionControlRemote({
            tickets: request.tickets,
            allowedLanes: localSnapshot?.payload?.lanes || [],
            stateRoot: stateDirectory,
            signal: socketAbort.signal,
          });
        } else if (request.type === "refresh") {
          refreshing = true;
          ready = false;
          result = {
            supervisorId,
            supervisorPid: process.pid,
            accepted: true,
            monitoredWorkers: monitored.size,
            workerPids: [...monitored.keys()].sort((left, right) => left - right),
          };
          afterResponse = () => void shutdown("REFRESH");
        } else {
          throw new Error(`Unknown supervisor request: ${request.type}`);
        }
        socket.end(`${JSON.stringify({ ok: true, result })}\n`, afterResponse || undefined);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      }
    })();
  });
});

const previousUmask = process.umask(0o077);
try {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(endpoint, resolvePromise);
  });
} finally {
  process.umask(previousUmask);
}
if (process.platform !== "win32") await chmod(endpoint, 0o600);
await atomicMetadata({
  protocol: PROTOCOL_VERSION,
  supervisorId,
  pid: process.pid,
  startedAt: supervisorStartedAt,
  runtimeRoot,
  stateDirectory,
});
await adoptRecordedWorkers();
modelWarmer.start();
ready = true;

async function scanAttention() {
  if (attentionScanRunning) return;
  attentionScanRunning = true;
  try {
    await scanPendingUserAttention(workspaceRoot);
  } catch {
    // Durable needs_user state remains visible even when desktop delivery fails.
  } finally {
    attentionScanRunning = false;
  }
}

void scanAttention();

const monitor = setInterval(() => {
  for (const entry of monitored.values()) {
    if (entry.child || entry.checking) continue;
    entry.checking = true;
    const identity = workerIdentityStatus({
      pid: entry.pid,
      collaborationId: entry.collaborationId,
      workerOwner: entry.workerOwner,
    });
    // Only a dead PID is a real exit. recordWorkerExit releases ownership, so it must
    // never be reached while the process is still running.
    if (identity.status === "dead") {
      void recordWorkerExit({
        collaborationId: entry.collaborationId,
        pid: entry.pid,
        code: null,
        signal: "UNKNOWN",
        adopted: true,
      });
      continue;
    }
    if (identity.status === "unavailable") {
      entry.probeFailures += 1;
      entry.checking = false;
      if (entry.probeFailures < 3) continue;
    }
    if (identity.status !== "match") {
      const signal = identity.status === "unavailable" ? "IDENTITY_UNAVAILABLE" : "IDENTITY_MISMATCH";
      entry.checking = false;
      // The PID stays monitored while fenced so that its eventual real exit is still
      // receipted, and so ownership is never handed to a replacement writer.
      if (!entry.fenced) {
        entry.fenced = true;
        void recordWorkerFenced({
          collaborationId: entry.collaborationId,
          pid: entry.pid,
          signal,
          reason: fenceReason({ pid: entry.pid, signal, identity }),
        });
      }
    } else {
      entry.probeFailures = 0;
      entry.fenced = false;
      entry.checking = false;
    }
  }
}, 1_000);
monitor.unref();

const attentionMonitor = setInterval(() => { void scanAttention(); }, 60_000);
attentionMonitor.unref();

const missionControlMonitor = setInterval(() => {
  if (Date.now() - missionControlLastReadAt <= missionControlIdleMs) {
    void missionControlStream.refresh().catch(() => {});
  }
}, 250);
missionControlMonitor.unref();

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  clearInterval(attentionMonitor);
  clearInterval(missionControlMonitor);
  modelWarmer.stop();
  await atomicMetadata({
    protocol: PROTOCOL_VERSION,
    supervisorId,
    pid: process.pid,
    startedAt: supervisorStartedAt,
    stoppedAt: new Date().toISOString(),
    signal,
  }).catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (process.platform !== "win32") await rm(endpoint, { force: true });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

#!/usr/bin/env node

import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getMissionControlEventSnapshot,
  getSupervisorStatus,
  readMissionControlEvents,
  startSupervisedWorker,
} from "../src/worker-supervisor-client.mjs";
import { validateMissionControlEventEnvelope } from "../src/mission-control-event-protocol.mjs";
import { MissionControlEventStream } from "../src/mission-control-event-stream.mjs";
import { supervisorEndpoint } from "../src/worker-supervisor-protocol.mjs";

const runtimeRoot = resolve(import.meta.dirname, "..");

function eventSource(status = "queued", updatedAt = "2026-07-26T12:00:00.000Z") {
  return {
    repositories: [{ repository: "norm/example", total: 1, attention: 0, live: status === "running" ? 1 : 0, visible: 1 }],
    lanes: [{ id: "bridge-00000000-0000-4000-8000-000000000216", repository: "norm/example", lifecyclePhase: status, updatedAt }],
  };
}

let kernelSource = eventSource();
const kernel = new MissionControlEventStream({ loadSnapshot: async () => kernelSource, retention: 2, streamId: "mission-control-test" });
const kernelSnapshot = await kernel.snapshot();
assert.equal(kernelSnapshot.sequence, 0, "snapshot bootstrap must not create an invisible sequence gap");
kernelSource = eventSource("running", "2026-07-26T12:00:01.000Z");
await Promise.all([kernel.refresh(), kernel.refresh()]);
const kernelDeltas = await kernel.read({ streamId: kernelSnapshot.streamId, cursor: 0, maxEvents: 10 });
assert.deepEqual(kernelDeltas.events.map((event) => event.sequence), [1, 2], "concurrent refreshes must serialize into a deterministic sequence");
kernelSource = eventSource("needs_user", "2026-07-26T12:00:02.000Z");
await kernel.refresh();
assert.equal((await kernel.read({ streamId: kernelSnapshot.streamId, cursor: 0, maxEvents: 10 })).resyncRequired, true, "slow readers must resynchronize after bounded retention advances");
assert.equal((await kernel.read({ streamId: "mission-control-old", cursor: kernel.cursor, maxEvents: 10 })).reason, "stream_changed");

let oversizedSource = eventSource();
const recoverableKernel = new MissionControlEventStream({
  loadSnapshot: async () => oversizedSource,
  maxSnapshotBytes: 1_024,
  streamId: "mission-control-recoverable",
});
const recoverableSnapshot = await recoverableKernel.snapshot();
oversizedSource = {
  ...eventSource("running"),
  lanes: [{ ...eventSource("running").lanes[0], objective: "x".repeat(2_000) }],
};
await recoverableKernel.refresh();
assert.equal(recoverableKernel.status.degradedReason, "snapshot_too_large");
assert.equal((await recoverableKernel.snapshot()).type, "resync.required", "oversized snapshots must degrade to a recoverable protocol event");
assert.equal((await recoverableKernel.read({
  streamId: recoverableSnapshot.streamId,
  cursor: recoverableSnapshot.cursor,
  maxEvents: 10,
})).reason, "snapshot_too_large");
oversizedSource = eventSource("running", "2026-07-26T12:00:03.000Z");
assert.equal((await recoverableKernel.snapshot()).type, "snapshot", "a smaller projection must recover without restarting the supervisor");
assert.equal(recoverableKernel.status.degraded, false);

let boundedLoads = 0;
const boundedKernel = new MissionControlEventStream({
  loadSnapshot: async () => { boundedLoads += 1; return eventSource(); },
  maxWaiters: 1,
  streamId: "mission-control-bounded",
});
const boundedSnapshot = await boundedKernel.snapshot();
const firstAbort = new AbortController();
const firstWaiter = boundedKernel.read({
  streamId: boundedSnapshot.streamId,
  cursor: boundedSnapshot.cursor,
  maxEvents: 10,
  waitMs: 1_000,
  signal: firstAbort.signal,
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
assert.equal(boundedKernel.status.waitingSubscribers, 1);
assert.equal(boundedKernel.status.activeSubscribers, 1);
const loadsBeforeOverCapacity = boundedLoads;
const secondStartedAt = Date.now();
const overCapacity = await boundedKernel.read({
  streamId: boundedSnapshot.streamId,
  cursor: boundedSnapshot.cursor,
  maxEvents: 10,
  waitMs: 1_000,
});
assert.ok(Date.now() - secondStartedAt < 500, "over-cap subscribers must degrade to an immediate read");
assert.deepEqual(overCapacity.events, []);
assert.equal(boundedLoads, loadsBeforeOverCapacity, "over-cap subscribers must not queue another snapshot disk read");
const loadsBeforeInvalidRead = boundedLoads;
await assert.rejects(
  boundedKernel.read({ streamId: boundedSnapshot.streamId, cursor: -1, maxEvents: 10 }),
  /cursor must be a non-negative/i,
);
assert.equal(boundedLoads, loadsBeforeInvalidRead, "invalid subscribe input must not trigger a snapshot load");
firstAbort.abort();
await firstWaiter;

// Keep the Unix socket path below Darwin's sockaddr_un limit.
const temporary = await mkdtemp(join(tmpdir(), "bmc-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
const collaborationId = "bridge-00000000-0000-4000-8000-000000000216";
const statePath = join(stateDirectory, `${collaborationId}.json`);
await mkdir(stateDirectory, { recursive: true });
await mkdir(workspace, { recursive: true });

let currentState = {
  id: collaborationId,
  createdAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:00:00.000Z",
  status: "queued",
  workspace,
  repository: "norm/example",
  participants: ["codex"],
  writer: "codex",
  runtime: { turnCount: 0, activeCall: null },
};

async function writeState(patch = {}) {
  currentState = { ...currentState, ...patch };
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(currentState, null, 2)}\n`);
  await rename(temporaryPath, statePath);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function rawRequest(payload, { destroyAfterMs = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(supervisorEndpoint(stateDirectory));
    let buffer = "";
    socket.setTimeout(7_000, () => socket.destroy(new Error("raw supervisor request timed out")));
    socket.once("error", rejectPromise);
    socket.once("connect", () => {
      socket.write(typeof payload === "string" ? payload : `${JSON.stringify({ protocol: 1, ...payload })}\n`);
      if (destroyAfterMs !== null) setTimeout(() => { socket.destroy(); resolvePromise(null); }, destroyAfterMs);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolvePromise(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("close", () => {
      if (destroyAfterMs === null && !buffer.includes("\n")) resolvePromise(null);
    });
  });
}

const previousEnvironment = {
  workerPath: process.env.BRIDGE_SUPERVISOR_WORKER_PATH,
  testOutput: process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT,
  retention: process.env.BRIDGE_MISSION_CONTROL_EVENT_RETENTION,
  idleMs: process.env.BRIDGE_MISSION_CONTROL_IDLE_MS,
};
let supervisorPid = null;
let workerPid = null;
try {
  await writeState();
  process.env.BRIDGE_SUPERVISOR_WORKER_PATH = join(runtimeRoot, "scripts/worker-supervisor-test-worker.mjs");
  process.env.BRIDGE_SUPERVISOR_TEST_OUTPUT = temporary;
  process.env.BRIDGE_MISSION_CONTROL_EVENT_RETENTION = "8";
  process.env.BRIDGE_MISSION_CONTROL_IDLE_MS = "250";
  const options = { runtimeRoot, workspaceRoot: workspace, stateDirectory };

  const started = await startSupervisedWorker({ collaborationId, ...options });
  supervisorPid = started.supervisorPid;
  workerPid = started.workerPid;
  const snapshot = validateMissionControlEventEnvelope(await getMissionControlEventSnapshot(options));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.payload.lanes.length, 1);
  assert.equal((await stat(supervisorEndpoint(stateDirectory))).mode & 0o777, 0o600, "subscription transport must retain owner-only Unix permissions");

  await rawRequest({ type: "mission_control_subscribe", streamId: snapshot.streamId, cursor: snapshot.cursor, maxEvents: 10, waitMs: 5_000 }, { destroyAfterMs: 50 });
  assert.equal(alive(workerPid), true, "disconnecting a reader must not affect a collaboration worker");
  assert.equal((await getSupervisorStatus(options)).supervisorPid, supervisorPid);

  const firstReader = readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor: snapshot.cursor, maxEvents: 10, waitMs: 2_000 });
  const secondReader = readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor: snapshot.cursor, maxEvents: 10, waitMs: 2_000 });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  await writeState({ status: "running", updatedAt: "2026-07-26T12:00:03.000Z" });
  const [first, second] = await Promise.all([firstReader, secondReader]);
  assert.ok(first.events.length > 0, "subscriber must receive deltas after its cursor");
  assert.deepEqual(first.events, second.events, "multiple readers must observe the same ordered batch");
  assert.ok(first.events.every((event, index, events) => event.sequence > snapshot.cursor && (!index || event.sequence === events[index - 1].sequence + 1)));

  let cursor = first.cursor;
  const emptyResume = await readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor, maxEvents: 10, waitMs: 0 });
  assert.deepEqual(emptyResume.events, [], "resume at the latest cursor must not replay old events");
  for (let index = 0; index < 5; index += 1) {
    await writeState({ status: index % 2 ? "running" : "needs_user", updatedAt: `2026-07-26T12:00:0${4 + index}.000Z` });
    const batch = await readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor, maxEvents: 10, waitMs: 2_000 });
    assert.ok(batch.events.length > 0);
    cursor = batch.cursor;
  }
  const stale = await readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor: snapshot.cursor, maxEvents: 10, waitMs: 0 });
  assert.equal(stale.resyncRequired, true);
  assert.equal(stale.reason, "retention_window_exceeded");
  assert.equal(validateMissionControlEventEnvelope(stale.resyncEvent).type, "resync.required");
  assert.ok(stale.events.length === 0, "a stale cursor must never receive a partial batch");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  const cursorBeforeIdle = (await getSupervisorStatus(options)).missionControl.cursor;
  await writeState({ status: "queued", updatedAt: "2026-07-26T12:00:09.000Z" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  assert.equal((await getSupervisorStatus(options)).missionControl.cursor, cursorBeforeIdle, "the 4 Hz stream monitor must idle out when no reader remains");

  await assert.rejects(
    readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor, maxEvents: 101, waitMs: 0 }),
    /batch must be between/i,
  );
  await assert.rejects(
    readMissionControlEvents({ ...options, streamId: snapshot.streamId, cursor, maxEvents: 1, waitMs: 5_001 }),
    /wait must be between/i,
  );
  const malformed = await rawRequest("{not-json}\n");
  assert.equal(malformed.ok, false, "malformed requests must fail without terminating the supervisor");
  const oversized = await rawRequest(`${"x".repeat(1_000_001)}\n`);
  assert.equal(oversized, null, "oversized requests must be disconnected without a response allocation");
  assert.equal((await getSupervisorStatus(options)).supervisorPid, supervisorPid);

  const replacement = validateMissionControlEventEnvelope(await getMissionControlEventSnapshot(options));
  assert.ok(replacement.cursor >= cursor, "resync snapshot must describe the current stream head after any idle-period change");
  assert.deepEqual((await readMissionControlEvents({ ...options, streamId: replacement.streamId, cursor: replacement.cursor, maxEvents: 10 })).events, []);

  console.log("Mission Control subscription tests passed: owner-only bootstrap, ordered resume, resync, multi-reader, disconnect, backpressure, malformed input, and bounded lifetime are verified.");
} finally {
  if (supervisorPid && alive(supervisorPid)) process.kill(supervisorPid, "SIGTERM");
  if (supervisorPid) await waitForExit(supervisorPid);
  if (workerPid && alive(workerPid)) process.kill(workerPid, "SIGTERM");
  if (workerPid) await waitForExit(workerPid);
  for (const [key, value] of Object.entries({
    BRIDGE_SUPERVISOR_WORKER_PATH: previousEnvironment.workerPath,
    BRIDGE_SUPERVISOR_TEST_OUTPUT: previousEnvironment.testOutput,
    BRIDGE_MISSION_CONTROL_EVENT_RETENTION: previousEnvironment.retention,
    BRIDGE_MISSION_CONTROL_IDLE_MS: previousEnvironment.idleMs,
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}

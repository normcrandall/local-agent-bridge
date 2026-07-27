#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supervisorEndpoint } from "../src/worker-supervisor-protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "ab-lg-"));
const stateDirectory = join(temporary, "state");
const workspaceRoot = join(temporary, "workspace");
const psLog = join(temporary, "ps.log");
let currentPid = null;
let missingPidFixture = null;
let missingPidReplacement = null;
let invalidPidFixture = null;
let legacyError = "";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(message);
}

try {
  const legacy = spawn(process.execPath, [join(root, "scripts/fixtures/collaboration-supervisor.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspaceRoot,
      BRIDGE_COLLABORATION_DIR: stateDirectory,
    },
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  legacy.stderr.on("data", (chunk) => { legacyError += chunk.toString("utf8"); });
  legacy.unref();
  try {
    await waitFor(async () => {
      try {
        const metadata = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
        return metadata.pid === legacy.pid;
      } catch {
        return false;
      }
    }, "legacy supervisor did not start");
  } catch (error) {
    const metadata = await readFile(join(stateDirectory, "supervisor.json"), "utf8").catch(() => "missing");
    throw new Error(`${error.message}; pid=${legacy.pid}; alive=${alive(legacy.pid)}; metadata=${metadata.trim()}; stderr=${legacyError.trim()}`);
  }

  process.env.BRIDGE_SUPERVISOR_PS_BIN = join(root, "scripts/fixtures/fake-transient-ps.mjs");
  process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG = psLog;
  const { getMissionControlEventSnapshot, getSupervisorStatus } = await import("../src/worker-supervisor-client.mjs");
  const { MISSION_CONTROL_EVENT_PROTOCOL_VERSION } = await import("../src/mission-control-event-protocol.mjs");
  const options = { runtimeRoot: root, workspaceRoot, stateDirectory };
  const status = await getSupervisorStatus(options);
  assert.equal(status.supervisorPid, legacy.pid);
  assert.equal(status.legacy, true, "status must fall back to ping for a live legacy supervisor");

  const snapshot = await getMissionControlEventSnapshot(options);
  const current = await getSupervisorStatus(options);
  currentPid = current.supervisorPid;
  assert.equal(snapshot.version, MISSION_CONTROL_EVENT_PROTOCOL_VERSION);
  assert.equal(current.missionControl.protocolVersion, MISSION_CONTROL_EVENT_PROTOCOL_VERSION);
  assert.equal(alive(legacy.pid), false, "Mission Control bootstrap must stop an incompatible supervisor only after identity verification");
  assert.notEqual(currentPid, legacy.pid);
  const probes = await readFile(psLog, "utf8");
  assert.match(probes, /command=/, "legacy fencing must use the configured process probe for command identity");
  assert.match(probes, /lstart=/, "legacy fencing must verify process start freshness before signalling");

  const missingPidState = join(temporary, "missing-pid-state");
  missingPidFixture = spawn(process.execPath, [join(root, "scripts/fixtures/collaboration-supervisor.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspaceRoot,
      BRIDGE_COLLABORATION_DIR: missingPidState,
      BRIDGE_FIXTURE_SUPERVISOR_PID_MODE: "absent",
      BRIDGE_FIXTURE_SUPERVISOR_ID_MODE: "absent",
      BRIDGE_FIXTURE_SUPPORT_REFRESH: "1",
    },
    detached: true,
    stdio: "ignore",
  });
  missingPidFixture.unref();
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(missingPidState, "supervisor.json"), "utf8")).pid === missingPidFixture.pid;
    } catch { return false; }
  }, "missing-PID fixture did not start");
  const missingPidPrevious = await getSupervisorStatus({ ...options, stateDirectory: missingPidState });
  assert.equal(missingPidPrevious.supervisorPid, undefined);
  assert.equal(missingPidPrevious.supervisorId, undefined);
  const missingIdentityRefreshStartedAt = Date.now();
  const missingPidSnapshot = await getMissionControlEventSnapshot({ ...options, stateDirectory: missingPidState });
  assert.ok(Date.now() - missingIdentityRefreshStartedAt < 4_000,
    "a compatible successor must be accepted without the five-second missing-supervisorId false failure");
  const missingPidCurrent = await getSupervisorStatus({ ...options, stateDirectory: missingPidState });
  missingPidReplacement = missingPidCurrent.supervisorPid;
  assert.equal(missingPidSnapshot.version, MISSION_CONTROL_EVENT_PROTOCOL_VERSION);
  assert.equal(alive(missingPidFixture.pid), false, "accepted refresh must fence an absent PID through endpoint ownership transition");
  assert.notEqual(missingPidCurrent.supervisorId, missingPidPrevious.supervisorId);

  const invalidPidState = join(temporary, "invalid-pid-state");
  invalidPidFixture = spawn(process.execPath, [join(root, "scripts/fixtures/collaboration-supervisor.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspaceRoot,
      BRIDGE_COLLABORATION_DIR: invalidPidState,
      BRIDGE_FIXTURE_SUPERVISOR_PID_MODE: "invalid",
    },
    detached: true,
    stdio: "ignore",
  });
  invalidPidFixture.unref();
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(invalidPidState, "supervisor.json"), "utf8")).pid === invalidPidFixture.pid;
    } catch { return false; }
  }, "invalid-PID fixture did not start");
  await assert.rejects(
    getMissionControlEventSnapshot({ ...options, stateDirectory: invalidPidState }),
    /Cannot fence incompatible supervisor .*refresh was rejected and supervisorPid is not-a-pid/,
  );
  assert.equal(alive(invalidPidFixture.pid), true, "an unfenceable endpoint owner must remain untouched");
  assert.equal((await getSupervisorStatus({ ...options, stateDirectory: invalidPidState })).supervisorPid, "not-a-pid",
    "failed fencing must not spawn a replacement into the owned endpoint");
  console.log("Legacy supervisor test passed: Mission Control protocol negotiation replaces version-skewed supervisors after identity-safe fencing.");
} finally {
  if (currentPid && alive(currentPid)) process.kill(currentPid, "SIGTERM");
  if (missingPidReplacement && alive(missingPidReplacement)) process.kill(missingPidReplacement, "SIGTERM");
  if (missingPidFixture?.pid && alive(missingPidFixture.pid)) process.kill(missingPidFixture.pid, "SIGTERM");
  if (invalidPidFixture?.pid && alive(invalidPidFixture.pid)) process.kill(invalidPidFixture.pid, "SIGTERM");
  await waitFor(() => !currentPid || !alive(currentPid), "replacement supervisor did not stop during cleanup").catch(() => {});
  await waitFor(() => !missingPidReplacement || !alive(missingPidReplacement), "missing-PID replacement did not stop during cleanup").catch(() => {});
  await waitFor(() => !invalidPidFixture?.pid || !alive(invalidPidFixture.pid), "invalid-PID fixture did not stop during cleanup").catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

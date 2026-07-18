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
  const { getSupervisorStatus, refreshSupervisor } = await import("../src/worker-supervisor-client.mjs");
  const options = { runtimeRoot: root, workspaceRoot, stateDirectory };
  const status = await getSupervisorStatus(options);
  assert.equal(status.supervisorPid, legacy.pid);
  assert.equal(status.legacy, true, "status must fall back to ping for a live legacy supervisor");

  const refreshed = await refreshSupervisor(options);
  currentPid = refreshed.current.supervisorPid;
  assert.equal(refreshed.accepted.legacySignal, true);
  assert.equal(alive(legacy.pid), false, "legacy supervisor must be stopped only after identity verification");
  assert.notEqual(currentPid, legacy.pid);
  const probes = await readFile(psLog, "utf8");
  assert.match(probes, /command=/, "legacy fencing must use the configured process probe for command identity");
  assert.match(probes, /lstart=/, "legacy fencing must verify process start freshness before signalling");
  console.log("Legacy supervisor test passed: status falls back to ping and refresh fences command plus start identity through the configured probe.");
} finally {
  if (currentPid && alive(currentPid)) process.kill(currentPid, "SIGTERM");
  await waitFor(() => !currentPid || !alive(currentPid), "replacement supervisor did not stop during cleanup").catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

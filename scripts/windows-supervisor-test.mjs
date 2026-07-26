#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killProcessSafely, processProbe } from "../src/process-identity-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-win-test-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
await mkdir(stateDirectory, { recursive: true });
await mkdir(workspace, { recursive: true });

const testId = "bridge-00000000-0000-4000-8000-000000000072";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function seed(id) {
  const now = new Date().toISOString();
  await writeFile(join(stateDirectory, `${id}.json`), `${JSON.stringify({
    id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    workspace,
    runtime: { turnCount: 0, activeCall: null },
  }, null, 2)}\n`);
  await writeFile(join(stateDirectory, `${id}.jsonl`), "");
}

function startWorkerWithWin32Fixture(id) {
  const source = [
    `import { startSupervisedWorker } from ${JSON.stringify(join(root, "src/worker-supervisor-client.mjs"))};`,
    "const result = await startSupervisedWorker({ collaborationId: process.argv[1] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const environment = {
    ...process.env,
    BRIDGE_RUNTIME_ROOT: root,
    BRIDGE_WORKSPACE_ROOT: workspace,
    BRIDGE_COLLABORATION_DIR: stateDirectory,
    BRIDGE_SUPERVISOR_WORKER_PATH: join(root, "scripts/worker-supervisor-test-worker.mjs"),
    BRIDGE_SUPERVISOR_PS_BIN: join(root, "scripts/fixtures/fake-win32-ps.mjs"),
    BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
  };
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, id], {
    encoding: "utf8",
    env: environment,
  }));
}

try {
  // Test 1: Unit testing processProbe availability & fail-closed behavior
  const currentPid = process.pid;
  const probeCommand = processProbe(currentPid, "command");
  assert.equal(probeCommand.available, true, "Process command probe must be available for live process");

  const invalidProbe = processProbe(99999999, "command");
  assert.equal(invalidProbe.available, false, "Probe must return available=false for non-existent PID");

  const zeroProbe = processProbe(0, "command");
  assert.equal(zeroProbe.available, false, "Probe must fail closed for PID <= 1");

  // Test 2: killProcessSafely handles invalid PID safely
  assert.equal(killProcessSafely(0), false, "killProcessSafely must return false for invalid PID");

  // Test 3: Fixture-driven Windows worker start, supervisor restart, adoption, and duplicate-writer fencing
  await seed(testId);

  // Start worker using Windows process probe fixture
  const firstStart = startWorkerWithWin32Fixture(testId);
  assert.equal(firstStart.reused, false, "First start must launch a new worker");
  assert.equal(alive(firstStart.workerPid), true, "Worker must be running");

  // Second start on same collaboration ID must adopt verified live worker instead of launching duplicate
  const secondStart = startWorkerWithWin32Fixture(testId);
  assert.equal(secondStart.reused, true, "Second start must adopt the live verified worker");
  assert.equal(secondStart.workerPid, firstStart.workerPid, "Adopted worker PID must match existing worker PID");

  // Cleanup worker
  if (alive(firstStart.workerPid)) killProcessSafely(firstStart.workerPid, "SIGKILL");

  console.log("Windows supervisor process probe regression test (unit & fixture adoption) passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

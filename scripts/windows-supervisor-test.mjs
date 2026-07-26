#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const fixture = join(root, "scripts/fixtures/fake-win32-ps.mjs");
const workerPath = join(root, "scripts/worker-supervisor-test-worker.mjs");
const mismatchFile = join(temporary, "mismatch");
const malformedFile = join(temporary, "malformed");
const failureFile = join(temporary, "failure.json");
const probeLog = join(temporary, "probe.log");

const expectedCommand = "node.exe C:\\bridge\\scripts\\worker-supervisor-test-worker.mjs "
  + "bridge-00000000-0000-4000-8000-000000000072";
const expectedCreation = "2026-07-26T05:00:00.0000000-04:00";

// The fixture names the worker script from this variable; pin it so the in-process
// probe assertions and the supervisor-driven phase observe the same identity.
process.env.BRIDGE_SUPERVISOR_WORKER_PATH = workerPath;

// Exercise the win32 branch of processProbe on any platform by pointing it at the
// fixture instead of powershell.exe. probeBinary stays unset so the branch is reached.
function win32Probe(pid, field, extra = {}) {
  return processProbe(pid, field, {
    platform: "win32",
    probeBinary: undefined,
    powershellBinary: fixture,
    ...extra,
  });
}

function logLines() {
  return existsSync(probeLog) ? readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

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
    BRIDGE_SUPERVISOR_WORKER_PATH: workerPath,
    BRIDGE_SUPERVISOR_PS_BIN: fixture,
    BRIDGE_SUPERVISOR_TEST_MISMATCH_FILE: mismatchFile,
    BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
  };
  delete environment.BRIDGE_SUPERVISOR_TEST_PS_LOG;
  delete environment.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
  delete environment.BRIDGE_SUPERVISOR_TEST_MALFORMED_FILE;
  // stderr is captured rather than inherited so the expected fencing failure in the
  // last phase does not print an uncaught-exception trace into a passing run.
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, id], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

try {
  // 1. Fail-closed guards that need no probe at all.
  assert.equal(processProbe(0, "command").available, false, "probe must fail closed for PID <= 1");
  assert.equal(processProbe("not-a-pid", "command").available, false, "probe must fail closed for a non-numeric PID");
  assert.equal(killProcessSafely(0), false, "killProcessSafely must refuse an invalid PID");

  // 2. The win32 branch reads command and start identity from one Win32_Process query.
  process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG = probeLog;
  const winCommand = win32Probe(4001, "command");
  const winStart = win32Probe(4001, "lstart");
  assert.equal(winCommand.available, true, "win32 branch must resolve the process command line");
  assert.equal(winCommand.value, expectedCommand, "win32 command must come from Win32_Process CommandLine");
  assert.equal(winStart.available, true, "win32 branch must resolve the process creation identity");
  assert.equal(winStart.value, expectedCreation, "win32 start identity must come from Win32_Process CreationDate");

  const queries = logLines();
  assert.equal(queries.length, 1, "both identity fields must come from a single atomic Win32_Process query");
  assert.match(queries[0], /-NoProfile -NonInteractive -Command/, "win32 probe must invoke PowerShell non-interactively");
  assert.match(queries[0], /Win32_Process -Filter "ProcessId = 4001"/, "win32 probe must filter on the requested PID");

  // 3. A transient probe failure must still be retried on Windows, as it is on POSIX.
  //    A cached miss would silently collapse the retry loop and fail a healthy worker closed.
  await writeFile(failureFile, `${JSON.stringify({ pid: 4002, remaining: 2 })}\n`);
  process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE = failureFile;
  const recovered = win32Probe(4002, "command");
  delete process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
  assert.equal(recovered.available, true, "win32 probe must recover from a transient query failure");
  assert.equal(recovered.attempts, 3, "win32 probe must actually re-query rather than reuse a cached miss");

  // 4. Unparseable and unresolvable query results both fail closed.
  process.env.BRIDGE_SUPERVISOR_TEST_MALFORMED_FILE = malformedFile;
  await writeFile(malformedFile, "");
  const malformed = win32Probe(4003, "command");
  delete process.env.BRIDGE_SUPERVISOR_TEST_MALFORMED_FILE;
  assert.equal(malformed.available, false, "unparseable Win32_Process output must fail closed");

  delete process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG;

  // 5. Windows termination must target the whole process tree, not just the recorded PID.
  const killLog = join(temporary, "kill.log");
  process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG = killLog;
  killProcessSafely(4004, "SIGTERM", { platform: "win32", taskkillBinary: fixture });
  delete process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG;
  assert.equal(
    readFileSync(killLog, "utf8").trim(),
    "/PID 4004 /T /F",
    "win32 termination must use taskkill with tree and force flags",
  );

  // 6. Supervisor restart adopts a verified live worker instead of starting a duplicate.
  await seed(testId);
  const firstStart = startWorkerWithWin32Fixture(testId);
  assert.equal(firstStart.reused, false, "first start must launch a new worker");
  assert.equal(alive(firstStart.workerPid), true, "worker must be running");

  const secondStart = startWorkerWithWin32Fixture(testId);
  assert.equal(secondStart.reused, true, "restart must adopt the live verified worker");
  assert.equal(secondStart.workerPid, firstStart.workerPid, "adopted worker PID must match the recorded worker");

  // 7. Once the observed identity no longer matches, the supervisor must refuse to
  //    replace the live worker rather than starting a second writer.
  await writeFile(mismatchFile, "");
  let fenced = null;
  try {
    startWorkerWithWin32Fixture(testId);
  } catch (error) {
    fenced = `${error.stderr || ""}${error.message || ""}`;
  }
  assert.ok(fenced, "a mismatched worker identity must refuse the start");
  assert.match(fenced, /does not match/, "refusal must name the identity mismatch");
  assert.match(fenced, /no replacement was started/, "refusal must confirm no duplicate writer was started");
  assert.equal(alive(firstStart.workerPid), true, "the fenced worker must be left running, not replaced");

  if (alive(firstStart.workerPid)) killProcessSafely(firstStart.workerPid, "SIGKILL");

  console.log("Windows supervisor test passed: win32 identity query, retry, fail-closed parsing, tree termination, restart adoption, and duplicate-writer fencing.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

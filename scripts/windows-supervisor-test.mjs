#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const unavailableFile = join(temporary, "unavailable");
const failureFile = join(temporary, "failure.json");
const probeLog = join(temporary, "probe.log");
const daemonProbeLog = join(temporary, "daemon-probe.log");

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

async function waitFor(condition, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(message);
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
    // Force the native Win32_Process branch inside the supervisor daemon. PS_BIN is
    // deliberately NOT set: it would select the generic /bin/ps-shaped path and leave
    // the Windows code under test unexecuted.
    BRIDGE_SUPERVISOR_PLATFORM: "win32",
    BRIDGE_SUPERVISOR_POWERSHELL_BIN: fixture,
    BRIDGE_SUPERVISOR_TEST_MISMATCH_FILE: mismatchFile,
    BRIDGE_SUPERVISOR_TEST_UNAVAILABLE_FILE: unavailableFile,
    BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
  };
  environment.BRIDGE_SUPERVISOR_TEST_PS_LOG = daemonProbeLog;
  delete environment.BRIDGE_SUPERVISOR_PS_BIN;
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

// Runs a start that is expected to be refused, and returns the refusal text.
function expectStartRefused(id) {
  try {
    const result = startWorkerWithWin32Fixture(id);
    throw new assert.AssertionError({
      message: `start must have been refused, but it returned ${JSON.stringify(result)}`,
    });
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    return `${error.stderr || ""}${error.message || ""}`;
  }
}

// The daemon caches a successful Win32_Process lookup for 1s, so an identity flipped
// mid-test is only observable once that window closes.
async function settleProbeCache() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
}

async function readState(id) {
  return JSON.parse(await readFile(join(stateDirectory, `${id}.json`), "utf8"));
}

async function supervisorPid() {
  return JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8")).pid;
}

// Terminate ONLY the supervisor daemon. The worker is spawned detached, so it must
// survive; adoption is meaningless if the restart takes the worker down with it.
async function stopSupervisorOnly() {
  const pid = await supervisorPid();
  process.kill(pid, "SIGTERM");
  await waitFor(() => !alive(pid), "supervisor daemon did not stop");
}

let startedWorkerPid = null;

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

  // 6. A real supervisor restart: kill only the daemon, leave the worker running, and
  //    require the replacement daemon to adopt the same PID through the native probe.
  await seed(testId);
  const firstStart = startWorkerWithWin32Fixture(testId);
  startedWorkerPid = firstStart.workerPid;
  assert.equal(firstStart.reused, false, "first start must launch a new worker");
  assert.equal(alive(firstStart.workerPid), true, "worker must be running");

  const firstSupervisorPid = await supervisorPid();
  assert.notEqual(firstSupervisorPid, firstStart.workerPid, "supervisor and worker must be distinct processes");
  await stopSupervisorOnly();
  assert.equal(alive(firstSupervisorPid), false, "the supervisor daemon must be stopped");
  assert.equal(alive(firstStart.workerPid), true, "restarting the supervisor must not disturb the worker");

  const afterRestart = startWorkerWithWin32Fixture(testId);
  const secondSupervisorPid = await supervisorPid();
  assert.notEqual(secondSupervisorPid, firstSupervisorPid, "a new supervisor daemon must have been started");
  assert.equal(afterRestart.reused, true, "the restarted supervisor must adopt the live verified worker");
  assert.equal(afterRestart.workerPid, firstStart.workerPid, "adopted worker PID must match the pre-restart worker");
  assert.equal(alive(firstStart.workerPid), true, "adoption must not replace the running worker");

  // Prove the adoption ran through the native Win32_Process branch, not the ps override.
  const probeCalls = readFileSync(daemonProbeLog, "utf8");
  assert.match(probeCalls, /-NoProfile -NonInteractive -Command/, "the daemon must probe identity through PowerShell");
  assert.match(probeCalls, /Get-CimInstance Win32_Process/, "the daemon must use the native Win32_Process query");
  assert.doesNotMatch(probeCalls, /(^|\n)-p \d+ -o /, "the daemon must not fall back to the generic ps probe");

  // 7. A mismatched identity on a live PID must not spawn a duplicate, and must not
  //    release ownership: workerPid stays set so no later start can claim the slot.
  await writeFile(mismatchFile, "");
  await settleProbeCache();
  const mismatchRefusal = expectStartRefused(testId);
  assert.match(mismatchRefusal, /does not match/, "refusal must name the identity mismatch");
  assert.match(mismatchRefusal, /no replacement was started/, "refusal must confirm no duplicate writer was started");
  assert.equal(alive(firstStart.workerPid), true, "the fenced worker must be left running, not replaced");

  const fencedState = await readState(testId);
  assert.equal(fencedState.workerPid, firstStart.workerPid, "a fenced live worker must keep ownership of workerPid");
  assert.ok(fencedState.workerOwner, "a fenced live worker must keep its recorded owner");
  assert.equal(fencedState.status, "indeterminate", "fencing must surface as an indeterminate collaboration");
  assert.equal(fencedState.lastWorkerFence?.signal, "IDENTITY_MISMATCH", "the fence reason must be persisted");
  assert.equal(fencedState.lastWorkerExit, undefined, "a live fenced worker must not be recorded as exited");

  // A second attempt must still be refused: the fence does not decay into a free slot.
  assert.match(expectStartRefused(testId), /no replacement was started/, "a fenced worker must reject repeat starts");
  assert.equal((await readState(testId)).workerPid, firstStart.workerPid, "repeat refusal must still preserve ownership");

  // 8. The same holds when identity is missing rather than mismatched.
  await rm(mismatchFile, { force: true });
  await writeFile(unavailableFile, "");
  await settleProbeCache();
  const unavailableRefusal = expectStartRefused(testId);
  assert.match(unavailableRefusal, /could not be verified/, "refusal must name the unverifiable identity");
  assert.match(unavailableRefusal, /no replacement was started/, "unverifiable identity must not start a duplicate");
  const unverifiedState = await readState(testId);
  assert.equal(unverifiedState.workerPid, firstStart.workerPid, "an unverifiable live worker must keep ownership");
  assert.equal(unverifiedState.lastWorkerFence?.signal, "IDENTITY_UNAVAILABLE", "the unavailable fence must be persisted");
  assert.equal(unverifiedState.lastWorkerExit, undefined, "an unverifiable live worker must not be recorded as exited");
  await rm(unavailableFile, { force: true });

  console.log("Windows supervisor test passed: native Win32_Process adoption across a real supervisor restart, plus duplicate-writer fencing that preserves ownership on mismatched and unverifiable identity.");
} finally {
  // The supervisor daemon outlives the client that started it and keeps writing into
  // the state directory, so stop it and wait for exit before removing the temp tree.
  if (startedWorkerPid && alive(startedWorkerPid)) killProcessSafely(startedWorkerPid, "SIGKILL");
  try {
    const metadata = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
    if (alive(metadata.pid)) {
      process.kill(metadata.pid, "SIGTERM");
      await waitFor(() => !alive(metadata.pid), "supervisor did not stop during test cleanup");
    }
  } catch {}
  await rm(temporary, { recursive: true, force: true });
}

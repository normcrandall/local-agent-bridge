#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supervisorEndpoint } from "../src/worker-supervisor-protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-supervisor-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
const processProbeFailureFile = join(temporary, "fail-next-process-probe");
await mkdir(stateDirectory, { recursive: true });
await mkdir(workspace, { recursive: true });

const ids = [
  "bridge-00000000-0000-4000-8000-000000000071",
  "bridge-00000000-0000-4000-8000-000000000072",
  "bridge-00000000-0000-4000-8000-000000000073",
  "bridge-00000000-0000-4000-8000-000000000074",
];

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

function startFromIndependentClient(id, { set = {}, unset = [] } = {}) {
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
    BRIDGE_SUPERVISOR_PS_BIN: join(root, "scripts/fixtures/fake-transient-ps.mjs"),
    BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE: processProbeFailureFile,
    BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
    ...set,
  };
  for (const name of unset) delete environment[name];
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, id], {
    encoding: "utf8",
    env: environment,
  }));
}

function startFromIndependentClientAsync(id) {
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
    BRIDGE_SUPERVISOR_PS_BIN: join(root, "scripts/fixtures/fake-transient-ps.mjs"),
    BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE: processProbeFailureFile,
    BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
  };
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, ["--input-type=module", "-e", source, id], {
      encoding: "utf8",
      env: environment,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr || error.message));
        return;
      }
      resolvePromise(JSON.parse(stdout));
    });
  });
}

function controlFromIndependentClient(action) {
  const source = [
    `import { getSupervisorStatus, refreshSupervisor } from ${JSON.stringify(join(root, "src/worker-supervisor-client.mjs"))};`,
    `const options = ${JSON.stringify({ runtimeRoot: root, workspaceRoot: workspace, stateDirectory })};`,
    "const result = process.argv[1] === 'refresh' ? await refreshSupervisor(options) : await getSupervisorStatus(options);",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source, action], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspace,
      BRIDGE_COLLABORATION_DIR: stateDirectory,
      BRIDGE_SUPERVISOR_WORKER_PATH: join(root, "scripts/worker-supervisor-test-worker.mjs"),
      BRIDGE_SUPERVISOR_PS_BIN: join(root, "scripts/fixtures/fake-transient-ps.mjs"),
      BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE: processProbeFailureFile,
      BRIDGE_SUPERVISOR_TEST_OUTPUT: temporary,
    },
  }));
}

try {
  await Promise.all(ids.map(seed));

  const first = startFromIndependentClient(ids[0], { set: {
    FIRST_HOST_ONLY_SECRET: "must-not-transit-supervisor-ipc",
    AGENT_BRIDGE_TEST_REQUIRED: "preserved",
    AWS_ACCESS_KEY_ID: "bedrock-access-key",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer-token",
    CLOUD_ML_REGION: "us-central1",
  } });
  assert.equal(first.reused, false);
  assert.equal(alive(first.workerPid), true, "worker must survive the MCP client process exiting");
  assert.equal(alive(first.supervisorPid), true, "machine supervisor must survive its first client exiting");
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700, "supervisor state directory must be private");
  if (process.platform !== "win32") {
    assert.equal((await stat(supervisorEndpoint(stateDirectory))).mode & 0o777, 0o600, "supervisor socket must be owner-only");
  }
  await waitFor(async () => {
    try {
      await readFile(join(temporary, `${ids[0]}.environment.json`), "utf8");
      return true;
    } catch {
      return false;
    }
  }, "first worker did not record its environment fixture");
  const firstEnvironment = JSON.parse(await readFile(join(temporary, `${ids[0]}.environment.json`), "utf8"));
  assert.equal(firstEnvironment.firstHostOnlySecret, null, "arbitrary caller secrets must not transit supervisor IPC");
  assert.equal(firstEnvironment.bridgeRequiredSetting, "preserved", "bridge configuration must reach the worker");
  assert.equal(firstEnvironment.awsAccessKeyId, "bedrock-access-key", "Bedrock AWS credentials must reach the worker");
  assert.equal(firstEnvironment.awsBearerTokenBedrock, "bedrock-bearer-token", "Bedrock bearer credentials must reach the worker");
  assert.equal(firstEnvironment.cloudMlRegion, "us-central1", "Vertex region configuration must reach the worker");
  assert.equal(firstEnvironment.pathPresent, true, "workers must retain executable discovery");

  await writeFile(processProbeFailureFile, "fail once\n");
  const transientReuse = startFromIndependentClient(ids[0]);
  assert.equal(transientReuse.reused, true, "a transient process probe must retry and reuse the verified worker");
  assert.equal(transientReuse.workerPid, first.workerPid);
  await waitFor(async () => {
    try {
      await readFile(processProbeFailureFile, "utf8");
      return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }, "supervisor did not exercise the configured transient process probe");
  const afterTransientProbe = JSON.parse(await readFile(join(stateDirectory, `${ids[0]}.json`), "utf8"));
  assert.notEqual(afterTransientProbe.status, "indeterminate", "one transient process probe must not invalidate a live worker");
  assert.equal(alive(first.workerPid), true, "transient process probe recovery must preserve the worker");

  const second = startFromIndependentClient(ids[1], { unset: ["FIRST_HOST_ONLY_SECRET"] });
  assert.equal(second.supervisorId, first.supervisorId, "independent clients must share one machine supervisor");
  assert.equal(second.supervisorPid, first.supervisorPid);
  assert.equal(alive(second.workerPid), true);
  await waitFor(async () => {
    try {
      await readFile(join(temporary, `${ids[1]}.environment.json`), "utf8");
      return true;
    } catch {
      return false;
    }
  }, "second worker did not record its environment fixture");
  const secondEnvironment = JSON.parse(await readFile(join(temporary, `${ids[1]}.environment.json`), "utf8"));
  assert.equal(secondEnvironment.firstHostOnlySecret, null, "the first host's environment must not bleed into another host's worker");

  const concurrent = await Promise.all([
    startFromIndependentClientAsync(ids[2]),
    startFromIndependentClientAsync(ids[2]),
  ]);
  assert.equal(concurrent[0].workerPid, concurrent[1].workerPid, "same-ID concurrent starts must resolve to one worker");
  assert.equal(concurrent.filter((entry) => entry.reused).length, 1, "exactly one same-ID start must reuse the serialized winner");
  const concurrentTranscript = await readFile(join(stateDirectory, `${ids[2]}.jsonl`), "utf8");
  assert.equal(concurrentTranscript.split("\n").filter((line) => line.includes('"type":"worker_supervised_started"')).length, 1,
    "same-ID concurrent starts must emit one supervised-worker start");

  const statusBeforeRefresh = controlFromIndependentClient("status");
  assert.equal(statusBeforeRefresh.supervisorId, first.supervisorId);
  assert.equal(statusBeforeRefresh.runtimeRoot, root);
  assert.equal(statusBeforeRefresh.stateDirectory, stateDirectory);
  assert.equal(statusBeforeRefresh.monitoredWorkers, 3);

  const refreshed = controlFromIndependentClient("refresh");
  assert.equal(refreshed.previous.supervisorId, first.supervisorId);
  assert.notEqual(refreshed.current.supervisorId, first.supervisorId, "refresh must replace the supervisor process");
  assert.equal(refreshed.current.monitoredWorkers, 3, "replacement supervisor must adopt every live worker before reporting ready");
  for (const workerPid of [first.workerPid, second.workerPid, concurrent[0].workerPid]) {
    assert.equal(alive(workerPid), true, "supervisor refresh must never kill an owned worker");
  }

  await writeFile(processProbeFailureFile, `${JSON.stringify({ pid: concurrent[0].workerPid, remaining: 12 })}\n`);
  await waitFor(async () => {
    try {
      await readFile(processProbeFailureFile, "utf8");
      return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }, "monitor did not exercise two consecutive unavailable probe intervals", 5_000);
  const toleratedProbeFailure = JSON.parse(await readFile(join(stateDirectory, `${ids[2]}.json`), "utf8"));
  assert.notEqual(toleratedProbeFailure.status, "indeterminate",
    "two consecutive unavailable probe intervals must not invalidate a live worker");
  assert.equal(alive(concurrent[0].workerPid), true, "transient cross-interval probe failures must preserve the worker");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));

  await writeFile(processProbeFailureFile, `${JSON.stringify({ pid: concurrent[0].workerPid, remaining: 18 })}\n`);
  await waitFor(async () => {
    const state = JSON.parse(await readFile(join(stateDirectory, `${ids[2]}.json`), "utf8"));
    return state.status === "indeterminate" && state.lastWorkerExit?.signal === "IDENTITY_UNAVAILABLE";
  }, "three consecutive unavailable probe intervals were not receipted", 6_000);
  assert.equal(alive(concurrent[0].workerPid), true, "identity-unavailable fencing must record, not kill, the worker");

  process.kill(-first.workerPid, "SIGTERM");
  await waitFor(async () => {
    const transcript = await readFile(join(stateDirectory, `${ids[0]}.jsonl`), "utf8");
    return transcript.includes('"type":"worker_exit"');
  }, "replacement supervisor did not persist the adopted worker exit receipt");
  const exited = JSON.parse(await readFile(join(stateDirectory, `${ids[0]}.json`), "utf8"));
  assert.equal(exited.status, "indeterminate");
  assert.match(exited.error, /without a terminal receipt/i);

  const identityMismatch = startFromIndependentClient(ids[3], {
    set: { BRIDGE_SUPERVISOR_TEST_CHANGE_TITLE_MS: "4000" },
  });

  process.kill(refreshed.current.supervisorPid, "SIGTERM");
  await waitFor(() => !alive(refreshed.current.supervisorPid), "supervisor did not stop");
  assert.equal(alive(second.workerPid), true, "worker must survive supervisor replacement");

  const recovered = startFromIndependentClient(ids[1]);
  assert.notEqual(recovered.supervisorId, refreshed.current.supervisorId, "a new supervisor instance must fence the old instance");
  assert.equal(recovered.reused, true, "restart must adopt the live recorded worker instead of duplicating it");
  assert.equal(recovered.workerPid, second.workerPid);

  await waitFor(async () => {
    const state = JSON.parse(await readFile(join(stateDirectory, `${ids[3]}.json`), "utf8"));
    return state.status === "indeterminate" && state.lastWorkerExit?.signal === "IDENTITY_MISMATCH";
  }, "adopted worker identity mismatch was not receipted", 7_000);
  assert.equal(alive(identityMismatch.workerPid), true, "identity fencing must record, not kill, a live mismatched PID");

  const cancelling = JSON.parse(await readFile(join(stateDirectory, `${ids[1]}.json`), "utf8"));
  await writeFile(join(stateDirectory, `${ids[1]}.json`), `${JSON.stringify({
    ...cancelling,
    status: "cancelling",
    cancelRequested: true,
  }, null, 2)}\n`);
  process.kill(-second.workerPid, "SIGTERM");
  await waitFor(async () => {
    const transcript = await readFile(join(stateDirectory, `${ids[1]}.jsonl`), "utf8");
    return transcript.includes('"type":"worker_exit"') && transcript.includes('"terminalReceipt":true');
  }, "intentional cancellation did not receive a non-incident exit receipt");
  const intentionallyStopped = JSON.parse(await readFile(join(stateDirectory, `${ids[1]}.json`), "utf8"));
  assert.equal(intentionallyStopped.status, "cancelling", "supervisor must not turn an intentional cancellation into an incident");

  process.kill(recovered.supervisorPid, "SIGTERM");
  console.log("Worker supervisor test passed: independent clients share a daemon, same-ID starts serialize, client exit is harmless, exits and identity changes are receipted, restart adopts live workers, and cancellation remains intentional.");
} finally {
  for (const id of ids) {
    try {
      const state = JSON.parse(await readFile(join(stateDirectory, `${id}.json`), "utf8"));
      if (alive(state.workerPid)) process.kill(-state.workerPid, "SIGKILL");
    } catch {}
    try {
      const transcript = await readFile(join(stateDirectory, `${id}.jsonl`), "utf8");
      for (const line of transcript.trim().split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "worker_supervised_started" && alive(event.pid)) process.kill(-event.pid, "SIGKILL");
      }
    } catch {}
  }
  try {
    const metadata = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
    if (alive(metadata.pid)) {
      process.kill(metadata.pid, "SIGTERM");
      await waitFor(() => !alive(metadata.pid), "supervisor did not stop during test cleanup");
    }
  } catch {}
  await rm(temporary, { recursive: true, force: true });
}

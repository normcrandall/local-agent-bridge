#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-supervisor-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
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

try {
  await Promise.all(ids.map(seed));

  const first = startFromIndependentClient(ids[0], { set: { FIRST_HOST_ONLY_SECRET: "must-not-bleed" } });
  assert.equal(first.reused, false);
  assert.equal(alive(first.workerPid), true, "worker must survive the MCP client process exiting");
  assert.equal(alive(first.supervisorPid), true, "machine supervisor must survive its first client exiting");

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

  process.kill(-first.workerPid, "SIGTERM");
  await waitFor(async () => {
    const transcript = await readFile(join(stateDirectory, `${ids[0]}.jsonl`), "utf8");
    return transcript.includes('"type":"worker_exit"') && transcript.includes('"signal":"SIGTERM"');
  }, "supervisor did not persist the worker signal-exit receipt");
  const exited = JSON.parse(await readFile(join(stateDirectory, `${ids[0]}.json`), "utf8"));
  assert.equal(exited.status, "indeterminate");
  assert.match(exited.error, /without a terminal receipt/i);

  const identityMismatch = startFromIndependentClient(ids[3], {
    set: { BRIDGE_SUPERVISOR_TEST_CHANGE_TITLE_MS: "4000" },
  });

  process.kill(first.supervisorPid, "SIGTERM");
  await waitFor(() => !alive(first.supervisorPid), "supervisor did not stop");
  assert.equal(alive(second.workerPid), true, "worker must survive supervisor replacement");

  const recovered = startFromIndependentClient(ids[1]);
  assert.notEqual(recovered.supervisorId, first.supervisorId, "a new supervisor instance must fence the old instance");
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
    if (alive(metadata.pid)) process.kill(metadata.pid, "SIGTERM");
  } catch {}
  await rm(temporary, { recursive: true, force: true });
}

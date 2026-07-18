import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import process from "node:process";
import { collaborationDirectory } from "./collaboration-store.mjs";
import { sanitizeWorkerEnvironment, supervisorEndpoint } from "./worker-supervisor-protocol.mjs";

const PROTOCOL_VERSION = 1;

function pause(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

async function request(endpoint, payload, timeoutMs = 1_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let buffer = "";
    const socket = createConnection(endpoint);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Supervisor request timed out.")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, ...payload })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) finish(new Error(response.error || "Supervisor request failed."));
        else finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function acquireStartupLock(directory) {
  const lock = join(directory, "supervisor-start.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return async () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number.parseInt(await readFile(join(lock, "owner"), "utf8"), 10);
        const info = await stat(lock);
        if (!processAlive(owner) || Date.now() - info.mtimeMs > 10_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (inspectError) {
        if (inspectError.code === "ENOENT") continue;
      }
      await pause(50);
    }
  }
  throw new Error("Timed out acquiring the collaboration supervisor startup lock.");
}

async function ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint }) {
  try {
    return await request(endpoint, { type: "ping" }, 300);
  } catch {}

  const release = await acquireStartupLock(stateDirectory);
  try {
    try {
      return await request(endpoint, { type: "ping" }, 300);
    } catch {}

    const bootstrap = resolve(runtimeRoot, "scripts/collaboration-supervisor-bootstrap.mjs");
    const launched = spawnSync(process.execPath, [bootstrap], {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        BRIDGE_RUNTIME_ROOT: runtimeRoot,
        BRIDGE_WORKSPACE_ROOT: workspaceRoot,
        BRIDGE_COLLABORATION_DIR: stateDirectory,
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    if (launched.status !== 0) {
      throw new Error(`Unable to bootstrap collaboration supervisor: ${(launched.stderr || launched.stdout || "unknown error").trim()}`);
    }
    const deadline = Date.now() + 5_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await request(endpoint, { type: "ping" }, 300);
      } catch (error) {
        lastError = error;
        await pause(50);
      }
    }
    throw new Error(`Collaboration supervisor did not become ready: ${lastError?.message || "unknown error"}`);
  } finally {
    await release();
  }
}

async function stopLegacySupervisor({ previous, runtimeRoot, stateDirectory }) {
  const metadata = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
  const command = spawnSync("/bin/ps", ["-p", String(previous.supervisorPid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  }).stdout?.trim() || "";
  if (metadata.supervisorId !== previous.supervisorId
    || metadata.pid !== previous.supervisorPid
    || resolve(metadata.runtimeRoot || "") !== resolve(runtimeRoot)
    || resolve(metadata.stateDirectory || "") !== resolve(stateDirectory)
    || !command.includes("collaboration-supervisor.mjs")) {
    throw new Error("Legacy supervisor identity could not be verified; refresh was refused.");
  }
  process.kill(previous.supervisorPid, "SIGTERM");
  return { ...previous, accepted: true, legacySignal: true };
}

export async function startSupervisedWorker({
  collaborationId,
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
} = {}) {
  if (!/^bridge-[0-9a-f-]{36}$/.test(collaborationId || "")) {
    throw new Error(`Invalid collaboration ID: ${collaborationId}`);
  }
  const endpoint = supervisorEndpoint(stateDirectory);
  await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint });
  return request(endpoint, {
    type: "start",
    collaborationId,
    runtimeRoot,
    workspaceRoot,
    workerEnvironment: sanitizeWorkerEnvironment(process.env),
  }, 5_000);
}

export async function getSupervisorStatus({
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || fileURLToPath(new URL("..", import.meta.url))),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
} = {}) {
  return request(supervisorEndpoint(stateDirectory), { type: "status" });
}

export async function refreshSupervisor({
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
  startIfMissing = true,
} = {}) {
  const endpoint = supervisorEndpoint(stateDirectory);
  let previous;
  let legacy = false;
  try {
    previous = await request(endpoint, { type: "status" });
  } catch (error) {
    try {
      previous = await request(endpoint, { type: "ping" });
      legacy = true;
    } catch {
      if (!startIfMissing) return { running: false, previous: null, current: null };
      const current = await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint });
      return { running: true, previous: null, current, started: true };
    }
  }

  const accepted = legacy
    ? await stopLegacySupervisor({ previous, runtimeRoot, stateDirectory })
    : await request(endpoint, { type: "refresh" }, 2_000);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(previous.supervisorPid)) {
    await pause(50);
  }
  if (processAlive(previous.supervisorPid)) {
    throw new Error("Collaboration supervisor did not stop after accepting refresh.");
  }
  const current = await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint });
  if (current.supervisorId === previous.supervisorId) {
    throw new Error("Collaboration supervisor refresh did not replace the running supervisor.");
  }
  return { running: true, previous, accepted, current, started: false };
}

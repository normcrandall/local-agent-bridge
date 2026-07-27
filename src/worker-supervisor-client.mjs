import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import process from "node:process";
import { collaborationDirectory } from "./collaboration-store.mjs";
import { sanitizeWorkerEnvironment, supervisorEndpoint } from "./worker-supervisor-protocol.mjs";
import { processProbe } from "./process-identity-probe.mjs";
import { MISSION_CONTROL_EVENT_PROTOCOL_VERSION } from "./mission-control-event-protocol.mjs";

const PROTOCOL_VERSION = 1;

export function supervisorSupportsMissionControlProtocol(status) {
  return status?.protocol === PROTOCOL_VERSION
    && status?.missionControl?.protocolVersion === MISSION_CONTROL_EVENT_PROTOCOL_VERSION;
}

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

function abortError() {
  const error = new Error("Supervisor request aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function request(endpoint, payload, timeoutMs = 1_000, { signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(abortError());
      return;
    }
    let settled = false;
    let buffer = "";
    const socket = createConnection(endpoint);
    const abort = () => finish(abortError());
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.setTimeout(0);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => finish(new Error("Supervisor request timed out.")));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (settled) return;
      const error = new Error("Supervisor connection closed before a response was received.");
      error.code = "SUPERVISOR_CONNECTION_CLOSED";
      finish(error);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, ...payload })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) {
          const error = new Error(response.error || "Supervisor request failed.");
          error.code = "SUPERVISOR_REQUEST_REJECTED";
          finish(error);
        } else finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

function validSupervisorPid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

function endpointUnavailable(error) {
  return ["ENOENT", "ECONNREFUSED"].includes(error?.code);
}

async function waitForSupervisorTransition({ endpoint, previous, signal, timeoutMs = 5_000 }) {
  const previousId = typeof previous?.supervisorId === "string" && previous.supervisorId
    ? previous.supervisorId
    : null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    try {
      const current = await request(endpoint, { type: "ping" }, 300, { signal });
      if (previousId && current?.supervisorId !== previousId) return current;
      if (!previousId && supervisorSupportsMissionControlProtocol(current)) return current;
    } catch (error) {
      if (endpointUnavailable(error)) return null;
      if (error?.name === "AbortError") throw error;
    }
    await pause(50);
  }
  const identity = previousId ? ` ${previousId}` : " with no usable supervisorId";
  throw new Error(`Cannot fence incompatible supervisor${identity}: it still owns the endpoint after refresh.`);
}

async function acquireStartupLock(directory, signal) {
  const lock = join(directory, "supervisor-start.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (signal?.aborted) throw abortError();
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

async function ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint, signal }) {
  if (signal?.aborted) throw abortError();
  try {
    const current = await request(endpoint, { type: "ping" }, 300, { signal });
    if (supervisorSupportsMissionControlProtocol(current)) return current;
  } catch {}

  if (signal?.aborted) throw abortError();
  const release = await acquireStartupLock(stateDirectory, signal);
  try {
    let incompatible = null;
    try {
      const current = await request(endpoint, { type: "ping" }, 300, { signal });
      if (supervisorSupportsMissionControlProtocol(current)) return current;
      incompatible = current;
    } catch {}

    if (signal?.aborted) throw abortError();

    if (incompatible) {
      let refreshAccepted = false;
      try {
        await request(endpoint, { type: "refresh" }, 2_000, { signal });
        refreshAccepted = true;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (validSupervisorPid(incompatible.supervisorPid) && processAlive(incompatible.supervisorPid)) {
          await stopSupervisorAfterIdentityCheck({ previous: incompatible, runtimeRoot, stateDirectory });
        } else if (error?.code === "SUPERVISOR_REQUEST_REJECTED") {
          const observed = String(incompatible.supervisorPid ?? "missing");
          throw new Error(`Cannot fence incompatible supervisor ${incompatible.supervisorId || "with unknown identity"}: refresh was rejected and supervisorPid is ${observed}.`);
        }
      }
      const transitioned = await waitForSupervisorTransition({ endpoint, previous: incompatible, signal });
      if (transitioned) {
        if (supervisorSupportsMissionControlProtocol(transitioned)) return transitioned;
        const source = refreshAccepted ? "accepted refresh" : "identity-fenced stop";
        throw new Error(`Cannot use supervisor ${transitioned.supervisorId || "with unknown identity"}: ${source} produced another incompatible endpoint owner.`);
      }
    }

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
      if (signal?.aborted) throw abortError();
      try {
        const current = await request(endpoint, { type: "ping" }, 300, { signal });
        if (supervisorSupportsMissionControlProtocol(current)) return current;
        lastError = new Error(`Supervisor advertises Mission Control event protocol ${String(current?.missionControl?.protocolVersion ?? "missing")}; expected ${MISSION_CONTROL_EVENT_PROTOCOL_VERSION}.`);
      } catch (error) {
        lastError = error;
      }
      await pause(50);
    }
    throw new Error(`Collaboration supervisor did not become ready: ${lastError?.message || "unknown error"}`);
  } finally {
    await release();
  }
}

async function stopSupervisorAfterIdentityCheck({ previous, runtimeRoot, stateDirectory }) {
  const metadata = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
  const commandRes = processProbe(previous.supervisorPid, "command");
  const observedStartRes = processProbe(previous.supervisorPid, "lstart");
  const command = commandRes.available ? commandRes.value : null;
  const observedStart = observedStartRes.available ? observedStartRes.value : null;
  const expectedStartedAt = metadata.startedAt || previous.startedAt;
  const observedStartedAtMs = Date.parse(observedStart || "");
  const expectedStartedAtMs = Date.parse(expectedStartedAt || "");
  const startIdentityMatches = Number.isFinite(observedStartedAtMs)
    && Number.isFinite(expectedStartedAtMs)
    && Math.abs(observedStartedAtMs - expectedStartedAtMs) <= 5_000;
  if (metadata.supervisorId !== previous.supervisorId
    || metadata.pid !== previous.supervisorPid
    || resolve(metadata.runtimeRoot || "") !== resolve(runtimeRoot)
    || resolve(metadata.stateDirectory || "") !== resolve(stateDirectory)
    || !command?.includes("collaboration-supervisor.mjs")
    || !startIdentityMatches) {
    throw new Error("Supervisor identity could not be verified; refresh was refused.");
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
  const endpoint = supervisorEndpoint(stateDirectory);
  try {
    return await request(endpoint, { type: "status" });
  } catch (error) {
    try {
      return { ...await request(endpoint, { type: "ping" }), legacy: true };
    } catch {
      throw error;
    }
  }
}

export async function getMissionControlEventSnapshot({
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
  signal,
} = {}) {
  const endpoint = supervisorEndpoint(stateDirectory);
  await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint, signal });
  return request(endpoint, { type: "mission_control_snapshot" }, 10_000, { signal });
}

export async function readMissionControlEvents({
  streamId,
  cursor,
  maxEvents = 50,
  waitMs = 0,
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
  signal,
} = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5_000) {
    throw new Error("Mission Control subscription wait must be between 0 and 5000ms.");
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) {
    throw new Error("Mission Control subscription batch must be between 1 and 100.");
  }
  const endpoint = supervisorEndpoint(stateDirectory);
  await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint, signal });
  return request(endpoint, {
    type: "mission_control_subscribe",
    streamId,
    cursor,
    maxEvents,
    waitMs,
  }, Math.min(15_000, Math.max(5_000, waitMs + 5_000)), { signal });
}

export async function refreshMissionControlRepositories({
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
  signal,
} = {}) {
  const endpoint = supervisorEndpoint(stateDirectory);
  await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint, signal });
  // Repository probes are individually bounded, but the aggregate scan scales with
  // the number of lanes. The caller already runs this operation off the render path;
  // keep it abortable without imposing an unrelated whole-scan deadline.
  return request(endpoint, { type: "mission_control_refresh_repositories" }, 0, { signal });
}

export async function getMissionControlReconciliation({
  tickets = [],
  runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  workspaceRoot = resolve(process.env.BRIDGE_WORKSPACE_ROOT || runtimeRoot),
  stateDirectory = resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(workspaceRoot)),
  signal,
} = {}) {
  const endpoint = supervisorEndpoint(stateDirectory);
  await ensureSupervisor({ runtimeRoot, workspaceRoot, stateDirectory, endpoint, signal });
  return request(endpoint, { type: "mission_control_reconcile", tickets }, 30_000, { signal });
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
    ? await stopSupervisorAfterIdentityCheck({ previous, runtimeRoot, stateDirectory })
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

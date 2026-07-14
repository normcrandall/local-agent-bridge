import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const LOCK_STALE_MS = 30_000;

function pause(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function collaborationDirectory(root) {
  return process.env.BRIDGE_COLLABORATION_DIR
    ? resolve(process.env.BRIDGE_COLLABORATION_DIR)
    : resolve(root, ".bridge/collaborations");
}

function validateId(id) {
  if (!/^bridge-[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid collaboration ID: ${id}`);
  return id;
}

function paths(root, id) {
  validateId(id);
  const directory = collaborationDirectory(root);
  return {
    directory,
    state: resolve(directory, `${id}.json`),
    transcript: resolve(directory, `${id}.jsonl`),
    updateLock: resolve(directory, `${id}.update.lock`),
    workerLock: resolve(directory, `${id}.worker.lock`),
  };
}

async function acquireFileLock(path, { attempts = 100, intervalMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return async () => {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number.parseInt(await readFile(path, "utf8"), 10);
        const hasOwner = Number.isInteger(owner) && owner > 0;
        let ownerAlive = false;
        if (hasOwner) {
          try {
            process.kill(owner, 0);
            ownerAlive = true;
          } catch (processError) {
            ownerAlive = processError.code === "EPERM";
          }
        }
        const info = await stat(path);
        if ((hasOwner && !ownerAlive) || (!hasOwner && Date.now() - info.mtimeMs > LOCK_STALE_MS)) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(intervalMs);
    }
  }
  throw new Error(`Timed out acquiring collaboration lock: ${path}`);
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createCollaboration(root, input) {
  const id = `bridge-${randomUUID()}`;
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const state = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    cancelRequested: false,
    workerPid: null,
    error: null,
    ...input,
  };
  await atomicWriteJson(target.state, state);
  await appendEvent(root, id, { type: "collaboration_started", at: now, ...input });
  return state;
}

export async function readCollaboration(root, id) {
  const content = await readFile(paths(root, id).state, "utf8");
  return JSON.parse(content);
}

export async function updateCollaboration(root, id, updater) {
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(target.updateLock);
  try {
    const current = await readCollaboration(root, id);
    const updated = await updater(current);
    const next = { ...updated, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    await atomicWriteJson(target.state, next);
    return next;
  } finally {
    await release();
  }
}

export async function appendEvent(root, id, event) {
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  await appendFile(target.transcript, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function readTurns(root, id, limit = 20, afterTurn = 0) {
  if (limit === 0) return [];
  try {
    const content = await readFile(paths(root, id).transcript, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "turn")
      .filter((event) => (event.number || 0) > afterTurn)
      .slice(-limit);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function collaborationView(root, id, turnLimit = 20, afterTurn = 0) {
  const state = await readCollaboration(root, id);
  const turns = await readTurns(root, id, turnLimit, afterTurn);
  return { ...state, turns };
}

export async function listCollaborations(root, { status, limit = 20 } = {}) {
  const directory = collaborationDirectory(root);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const states = await Promise.all(
    names
      .filter((name) => /^bridge-[0-9a-f-]{36}\.json$/.test(name))
      .map(async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"))),
  );
  return states
    .filter((state) => !status || state.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map((state) => ({
      id: state.id,
      task: state.task,
      status: state.status,
      agents: state.agents,
      workspace: state.workspace,
      turnCount: state.runtime?.turnCount || 0,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      error: state.error,
    }));
}

export async function acquireWorkerLock(root, id) {
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  return acquireFileLock(target.workerLock, { attempts: 200, intervalMs: 50 });
}

export async function acquireWorkspaceLock(root, workspace) {
  const directory = collaborationDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  return acquireFileLock(resolve(directory, `workspace-${digest}.lock`), {
    attempts: 100,
    intervalMs: 50,
  });
}

export async function waitForCollaborationChange(root, id, afterUpdatedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readCollaboration(root, id);
    if (!afterUpdatedAt || state.updatedAt !== afterUpdatedAt) return state;
    await pause(200);
  }
  return readCollaboration(root, id);
}

export async function archiveCollaboration(root, id) {
  const target = paths(root, id);
  const state = await readCollaboration(root, id);
  if (["queued", "running", "cancelling", "indeterminate"].includes(state.status)) {
    throw new Error(`Cannot archive ${id} while status is ${state.status}.`);
  }
  const archive = resolve(target.directory, "archive");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const archivedTranscript = resolve(archive, `${id}.jsonl`);
  let transcriptMoved = false;
  try { await rename(target.transcript, archivedTranscript); transcriptMoved = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rename(target.state, resolve(archive, `${id}.json`)); }
  catch (error) {
    if (transcriptMoved) await rename(archivedTranscript, target.transcript).catch(() => {});
    throw error;
  }
  return { id, archived: true, status: state.status, archive };
}

export async function pruneTerminalCollaborations(root, { olderThanDays = 30, now = Date.now() } = {}) {
  const states = await listCollaborations(root, { limit: 10_000 });
  const cutoff = now - olderThanDays * 86_400_000;
  const archived = [];
  for (const state of states) {
    if (["queued", "running", "cancelling", "indeterminate"].includes(state.status)) continue;
    const updatedAt = Date.parse(state.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
    archived.push(await archiveCollaboration(root, state.id));
  }
  return archived;
}

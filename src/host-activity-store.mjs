import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROVIDERS = new Set(["claude", "codex", "antigravity"]);
export const HOST_ACTIVITY_LIVE_MS = 60 * 60 * 1000;
export const HOST_ACTIVITY_HISTORY_MS = 24 * 60 * 60 * 1000;

function clean(value, limit = 240) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function hostActivityDirectory(stateRoot) {
  return resolve(stateRoot, "host-activity");
}

export function hostActivityId({ provider, sessionId, workspace }) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported host provider: ${provider}`);
  const identity = clean(sessionId, 500) || resolve(workspace || process.cwd());
  const digest = createHash("sha256").update(`${provider}:${identity}`).digest("hex").slice(0, 24);
  return `host-${provider}-${digest}`;
}

function paths(root, id) {
  const directory = hostActivityDirectory(root);
  return {
    directory,
    state: resolve(directory, `${id}.json`),
    lock: resolve(directory, `${id}.lock`),
  };
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 10_000) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(10);
    }
  }
  throw new Error(`Timed out acquiring host activity lock: ${path}`);
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function recordHostActivity(stateRoot, {
  provider,
  sessionId = null,
  workspace = process.cwd(),
  model = null,
  action,
  task = null,
  summary = null,
  sourceEvent = null,
  now = Date.now(),
} = {}) {
  if (!["start", "heartbeat", "stop"].includes(action)) throw new Error(`Unsupported host activity action: ${action}`);
  const id = hostActivityId({ provider, sessionId, workspace });
  const target = paths(stateRoot, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(target.lock);
  try {
    const current = await readOptional(target.state);
    if (action === "heartbeat" && !current?.active) return current;
    if (action === "stop" && !current) return null;
    const at = new Date(now).toISOString();
    const active = action !== "stop";
    const next = {
      version: 1,
      id,
      type: "native_host",
      provider,
      workspace: resolve(workspace || process.cwd()),
      model: clean(model, 120) || current?.model || null,
      active,
      phase: active ? "working" : "idle",
      task: clean(task) || current?.task || `Native ${provider} host turn`,
      summary: clean(summary) || (active ? `Native ${provider} host turn is active.` : `Native ${provider} host turn completed.`),
      startedAt: active ? (current?.active ? current.startedAt : at) : current.startedAt,
      heartbeatAt: active ? at : current.heartbeatAt,
      expiresAt: active ? new Date(now + HOST_ACTIVITY_LIVE_MS).toISOString() : at,
      endedAt: active ? null : at,
      updatedAt: at,
      sourceEvent: clean(sourceEvent, 80) || action,
    };
    await atomicWrite(target.state, next);
    return next;
  } finally {
    await release();
  }
}

export async function listHostActivities(stateRoot, {
  now = Date.now(),
  historyAfterMs = HOST_ACTIVITY_HISTORY_MS,
} = {}) {
  const directory = hostActivityDirectory(stateRoot);
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const states = await Promise.all(names
    .filter((name) => /^host-(claude|codex|antigravity)-[0-9a-f]{24}\.json$/.test(name))
    .map((name) => readOptional(resolve(directory, name))));
  return states
    .filter(Boolean)
    .filter((state) => now - Date.parse(state.updatedAt || "") <= historyAfterMs)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function hostActivityLane(state, now = Date.now()) {
  const live = state.active === true && Date.parse(state.expiresAt || "") >= now;
  return {
    id: state.id,
    type: "native_host",
    lifecyclePhase: live ? "working" : "idle",
    workspace: state.workspace,
    task: state.task,
    activeAgent: state.provider,
    writer: null,
    model: state.model,
    narrative: {
      summary: state.summary,
      updatedAt: state.updatedAt,
      ageSeconds: Math.max(0, Math.floor((now - Date.parse(state.updatedAt || "")) / 1000)),
      source: "host_hook",
      isPlaceholder: false,
    },
    heartbeat: state.heartbeatAt ? {
      heartbeatAt: state.heartbeatAt,
      ageSeconds: Math.max(0, Math.floor((now - Date.parse(state.heartbeatAt)) / 1000)),
    } : null,
    hostActivity: {
      active: state.active,
      expiresAt: state.expiresAt,
      sourceEvent: state.sourceEvent,
      live,
    },
    updatedAt: state.updatedAt,
    createdAt: state.startedAt,
    nextAction: live ? "continue" : "none",
  };
}

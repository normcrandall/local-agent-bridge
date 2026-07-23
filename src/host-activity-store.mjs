import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROVIDERS = new Set(["claude", "codex", "antigravity"]);
export const HOST_ACTIVITY_LIVE_MS = 60 * 60 * 1000;
export const HOST_ACTIVITY_HISTORY_MS = 24 * 60 * 60 * 1000;
export const HOST_ACTIVITY_HEARTBEAT_GRACE_MS = 2 * 60 * 1000;

function clean(value, limit = 240) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function hostActivityDirectory(stateRoot) {
  return resolve(stateRoot, "host-activity");
}

export function hostActivityId({ provider, sessionId }) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported host provider: ${provider}`);
  const identity = clean(sessionId, 500);
  if (!identity) throw new Error(`Native ${provider} host activity requires a session identifier.`);
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

async function acquireLock(path, attempts = 100) {
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

async function statOptional(path) {
  try { return await stat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
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
  hostPid = null,
  lockAttempts = 100,
  now = Date.now(),
} = {}) {
  if (!["start", "heartbeat", "stop"].includes(action)) throw new Error(`Unsupported host activity action: ${action}`);
  const id = hostActivityId({ provider, sessionId });
  const target = paths(stateRoot, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  if (action === "heartbeat") {
    const observed = await readOptional(target.state);
    if (!observed?.active) return observed;
  }
  const release = await acquireLock(target.lock, lockAttempts);
  let next;
  try {
    const current = await readOptional(target.state);
    if (action === "heartbeat" && !current?.active) return current;
    if (action === "stop" && !current) return null;
    const at = new Date(now).toISOString();
    const active = action !== "stop";
    next = {
      version: 1,
      id,
      type: "native_host",
      provider,
      workspace: resolve(workspace || process.cwd()),
      model: clean(model, 120) || current?.model || null,
      hostPid: Number.isInteger(hostPid) && hostPid > 1 ? hostPid : current?.hostPid || null,
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
  } finally {
    await release();
  }
  if (action === "start") await pruneHostActivityArtifacts(stateRoot, { now }).catch(() => null);
  return next;
}

export async function auditHostActivityArtifacts(stateRoot, {
  now = Date.now(),
  olderThanMs = HOST_ACTIVITY_HISTORY_MS,
  names = null,
} = {}) {
  const directory = hostActivityDirectory(stateRoot);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { directory, candidates: [], preserved: [] }; throw error; }
  const selected = names ? new Set(names) : null;
  const candidates = [];
  const preserved = [];
  for (const entry of entries) {
    if (!entry.isFile() || (selected && !selected.has(entry.name))) continue;
    const path = resolve(directory, entry.name);
    if (/^host-(claude|codex|antigravity)-[0-9a-f]{24}\.json$/.test(entry.name)) {
      let state;
      try { state = await readOptional(path); }
      catch {
        const info = await statOptional(path);
        if (!info) continue;
        const item = { name: entry.name, type: "state", updatedAt: new Date(info.mtimeMs).toISOString() };
        if (now - info.mtimeMs > olderThanMs) candidates.push(item);
        else preserved.push({ ...item, reason: "invalid_json" });
        continue;
      }
      const updatedAt = dateMs(state?.updatedAt);
      const old = updatedAt > 0 && now - updatedAt > olderThanMs;
      const live = state ? hostActivityLane(state, now).hostActivity.live : false;
      const item = { name: entry.name, type: "state", updatedAt: state?.updatedAt || null };
      if (old && !live) candidates.push(item);
      else preserved.push({ ...item, reason: live ? "live_host" : "within_retention" });
      continue;
    }
    if (/^host-(claude|codex|antigravity)-[0-9a-f]{24}\.(lock|json\..+\.tmp)$/.test(entry.name)) {
      const info = await statOptional(path);
      if (!info) continue;
      const item = {
        name: entry.name,
        type: entry.name.endsWith(".lock") ? "lock" : "temporary",
        updatedAt: new Date(info.mtimeMs).toISOString(),
      };
      if (now - info.mtimeMs > olderThanMs) candidates.push(item);
      else preserved.push({ ...item, reason: "within_retention" });
    }
  }
  return { directory, candidates, preserved };
}

export async function pruneHostActivityArtifacts(stateRoot, options = {}) {
  const audit = await auditHostActivityArtifacts(stateRoot, options);
  const removed = [];
  const failed = [];
  for (const candidate of audit.candidates) {
    let release = null;
    try {
      if (candidate.type === "state") {
        const id = candidate.name.replace(/\.json$/, "");
        release = await acquireLock(paths(stateRoot, id).lock);
        const rechecked = await auditHostActivityArtifacts(stateRoot, { ...options, names: [candidate.name] });
        if (!rechecked.candidates.some((entry) => entry.name === candidate.name)) continue;
      }
      await unlink(resolve(audit.directory, candidate.name));
      removed.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") failed.push({ ...candidate, error: error.message });
    } finally {
      await release?.();
    }
  }
  return { ...audit, removed, failed };
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
    .map((name) => readOptional(resolve(directory, name)).catch(() => null)));
  return states
    .filter(Boolean)
    .filter((state) => now - Date.parse(state.updatedAt || "") <= historyAfterMs)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function hostActivityLane(state, now = Date.now()) {
  const hostProcessAlive = processAlive(state.hostPid);
  const heartbeatAgeMs = Math.max(0, now - dateMs(state.heartbeatAt));
  const recentReceipt = dateMs(state.heartbeatAt) > 0 && heartbeatAgeMs <= HOST_ACTIVITY_HEARTBEAT_GRACE_MS;
  const live = state.active === true
    && Date.parse(state.expiresAt || "") >= now
    && (hostProcessAlive || recentReceipt);
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
      processAlive: hostProcessAlive,
      recentReceipt,
      livenessProof: hostProcessAlive ? "process" : recentReceipt ? "recent_receipt" : "none",
      live,
    },
    updatedAt: state.updatedAt,
    createdAt: state.startedAt,
    nextAction: live ? "continue" : "none",
  };
}

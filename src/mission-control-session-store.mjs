import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { missionControlLaneKey, requiredIdentifier } from "./mission-control-event-protocol.mjs";
import {
  createMissionControlNavigationState,
  reconcileMissionControlNavigation,
  restoreMissionControlNavigation,
  serializeMissionControlNavigation,
} from "./mission-control-navigation.mjs";

export const MISSION_CONTROL_SESSION_STORE_VERSION = 1;
export const MISSION_CONTROL_SESSION_MAX_BYTES = 64 * 1_024;

const SESSION_DIRECTORY = "mission-control-sessions";
const MAX_ACKNOWLEDGEMENTS = 512;
const MAX_TOKEN_LENGTH = 2_048;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LOCK_ATTEMPTS = 200;
const LOCK_STALE_MS = 30_000;

export class MissionControlSessionStoreError extends Error {
  constructor(message, { code = "MISSION_CONTROL_SESSION_STORE_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MissionControlSessionStoreError";
    this.code = code;
  }
}

function fail(message, code, cause = null) {
  throw new MissionControlSessionStoreError(message, { code, cause });
}

function canonicalWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) fail("workspace must be a non-empty path.", "INVALID_SCOPE");
  const workspace = resolve(value);
  if (!isAbsolute(workspace)) fail("workspace must resolve to an absolute path.", "INVALID_SCOPE");
  return workspace;
}

function canonicalRepository(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return requiredIdentifier(value, "repository");
  } catch (error) {
    fail(error.message, "INVALID_SCOPE", error);
  }
}

function scopeFor(workspace, repository) {
  return Object.freeze({
    workspace: canonicalWorkspace(workspace),
    repository: canonicalRepository(repository),
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sessionPaths(stateRoot, scope) {
  const root = canonicalWorkspace(stateRoot);
  const workspaceKey = digest(scope.workspace);
  const repositoryKey = digest(scope.repository ?? "@all-repositories");
  const directory = resolve(root, SESSION_DIRECTORY, workspaceKey);
  const state = resolve(directory, `${repositoryKey}.json`);
  return { directory, state, lock: `${state}.lock` };
}

export function missionControlSessionPath(stateRoot, { workspace, repository = null } = {}) {
  return sessionPaths(stateRoot, scopeFor(workspace, repository)).state;
}

function cleanToken(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TOKEN_LENGTH || /[\0\r\n]/u.test(value)) return null;
  return value;
}

function cleanLaneKey(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("\0");
  if (separator < 1 || separator !== value.lastIndexOf("\0")) return null;
  try {
    return missionControlLaneKey(value.slice(0, separator), value.slice(separator + 1));
  } catch {
    return null;
  }
}

function cleanReceipts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, token]) => [cleanLaneKey(key), cleanToken(token)])
    .filter(([key, token]) => key && token)
    .slice(-MAX_ACKNOWLEDGEMENTS));
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return { value, milliseconds };
}

function laneKey(lane) {
  try {
    return missionControlLaneKey(lane?.repository, lane?.id);
  } catch {
    return null;
  }
}

function laneTerminal(lane) {
  return lane?.terminal === true || [
    "agreed", "cancelled", "closed", "complete", "completed", "done", "failed",
    "merged", "superseded", "budget", "indeterminate",
  ].includes(String(lane?.status ?? lane?.lifecyclePhase ?? "").trim().toLowerCase());
}

function inputAlreadyAcknowledgedBySource(lane) {
  return lane?.attention?.acknowledged === true
    || lane?.coordinatorWake?.acknowledged === true
    || lane?.coordinatorWake?.status === "acknowledged";
}

function inputRequired(lane) {
  if (!lane || laneTerminal(lane) || inputAlreadyAcknowledgedBySource(lane)) return false;
  const status = String(lane.status ?? lane.lifecyclePhase ?? "").trim().toLowerCase();
  return status === "needs_user"
    || lane.attention?.required === true
    || lane.coordinatorWake?.actionable === true;
}

export function missionControlInputToken(lane) {
  const key = laneKey(lane);
  if (!key || !inputRequired(lane)) return null;
  const explicit = [
    ["wake-sequence", lane?.coordinatorWake?.sequence],
    ["wake-id", lane?.coordinatorWake?.id],
    ["attention-claim", lane?.attention?.claimId],
    ["attention-request", lane?.attention?.requestedAt],
    ["attention-id", lane?.attention?.id],
  ];
  for (const [kind, value] of explicit) {
    const token = cleanToken(value == null ? null : String(value));
    if (token) return `${kind}:${token}`;
  }
  const stableFacts = stableJson({
    lane: key,
    status: String(lane.status ?? lane.lifecyclePhase ?? "").trim().toLowerCase(),
    createdAt: String(lane.createdAt ?? lane.startedAt ?? ""),
    reason: String(lane.attention?.reason ?? lane.coordinatorWake?.kind ?? lane.nextAction ?? "needs_user"),
  });
  return `input-facts:${digest(stableFacts)}`;
}

export function missionControlInputNeedsAlert(session, lane) {
  const key = laneKey(lane);
  const token = missionControlInputToken(lane);
  return Boolean(key && token && session?.acknowledgedInputs?.[key] !== token);
}

export function createMissionControlSessionState(overrides = {}) {
  return {
    navigation: createMissionControlNavigationState(overrides.navigation),
    acknowledgedInputs: cleanReceipts(overrides.acknowledgedInputs),
  };
}

export function markMissionControlInputAcknowledged(session, lane) {
  const key = laneKey(lane);
  const token = missionControlInputToken(lane);
  if (!key || !token) {
    throw new MissionControlSessionStoreError("An actionable, non-terminal input lane is required.", { code: "NOT_ACTIONABLE" });
  }
  const receipts = Object.entries(session?.acknowledgedInputs || {}).filter(([receiptKey]) => receiptKey !== key);
  return createMissionControlSessionState({
    ...session,
    acknowledgedInputs: Object.fromEntries([...receipts, [key, token]]),
  });
}

/**
 * Reconcile persisted selection/order against the current projection. Unknown
 * lanes cannot remain selected. Acknowledgement receipts are retained (within
 * their bound), so a temporarily removed lane cannot re-alert when replayed.
 */
export function reconcileMissionControlSession(session, model) {
  const safe = createMissionControlSessionState(session);
  const reconciled = reconcileMissionControlNavigation(safe.navigation, model);
  return {
    session: createMissionControlSessionState({
      navigation: reconciled.state,
      acknowledgedInputs: safe.acknowledgedInputs,
    }),
    ...Object.fromEntries(Object.entries(reconciled).filter(([key]) => key !== "state")),
  };
}

function envelopePayload({ scope, revision, savedAt, session }) {
  return {
    scope,
    revision,
    savedAt,
    navigation: session.navigation,
    acknowledgedInputs: session.acknowledgedInputs,
  };
}

function renderEnvelope({ scope, revision, savedAt, session }) {
  const payload = envelopePayload({ scope, revision, savedAt, session });
  return `${JSON.stringify({
    version: MISSION_CONTROL_SESSION_STORE_VERSION,
    ...payload,
    payloadDigest: digest(stableJson(payload)),
  }, null, 2)}\n`;
}

function compactSession(session, { scope, revision, savedAt, maxBytes }) {
  const safe = createMissionControlSessionState(session);
  // The navigation serializer owns its schema bounds and strips arbitrary UI,
  // provider, transcript, and credential fields before this envelope is built.
  safe.navigation = restoreMissionControlNavigation(
    serializeMissionControlNavigation(safe.navigation, { now: Date.parse(savedAt) }),
    { now: Date.parse(savedAt) },
  );
  const render = () => renderEnvelope({ scope, revision, savedAt, session: safe });
  let serialized = render();
  const discardOldest = (record) => {
    const key = Object.keys(record)[0];
    if (!key) return false;
    delete record[key];
    return true;
  };
  while (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    if (!discardOldest(safe.navigation.laneOrderByScope)
      && !safe.navigation.repositoryOrder.shift()
      && !safe.navigation.portfolioOrder.shift()
      && !discardOldest(safe.navigation.seenCompletions)
      && !discardOldest(safe.acknowledgedInputs)) {
      fail("Mission Control session exceeds its persistence bound.", "SESSION_TOO_LARGE");
    }
    serialized = render();
  }
  return { session: safe, serialized };
}

async function readOptional(path, maxBytes) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", text: null };
    return { status: "corrupt", error };
  }
  if (!info.isFile() || info.size > maxBytes) {
    return { status: "corrupt", error: new Error("Mission Control session is not a bounded regular file.") };
  }
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return { status: "corrupt", error: new Error("Mission Control session grew beyond its persistence bound while being read.") };
    }
    return { status: "present", text };
  } catch (error) {
    return { status: "corrupt", error };
  }
}

function restoreEnvelope(text, { scope, now, maxAgeMs }) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Session envelope must be an object.");
    if (parsed.version !== MISSION_CONTROL_SESSION_STORE_VERSION) {
      return { status: "unsupported_version", error: `Unsupported session version ${String(parsed.version)}.` };
    }
    if (parsed.scope?.workspace !== scope.workspace || parsed.scope?.repository !== scope.repository) {
      return { status: "scope_mismatch", error: "Persisted Mission Control session belongs to another scope." };
    }
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1) throw new Error("Session revision is invalid.");
    const timestamp = canonicalTimestamp(parsed.savedAt);
    if (!timestamp) throw new Error("Session savedAt is invalid.");
    const payload = envelopePayload({
      scope: parsed.scope,
      revision: parsed.revision,
      savedAt: parsed.savedAt,
      session: { navigation: parsed.navigation, acknowledgedInputs: parsed.acknowledgedInputs },
    });
    if (!/^[0-9a-f]{64}$/u.test(parsed.payloadDigest || "") || digest(stableJson(payload)) !== parsed.payloadDigest) {
      throw new Error("Session payload checksum does not match.");
    }
    if (timestamp.milliseconds > now + 60_000 || now - timestamp.milliseconds > maxAgeMs) {
      return { status: "stale", revision: parsed.revision, savedAt: parsed.savedAt };
    }
    const navigation = restoreMissionControlNavigation(
      serializeMissionControlNavigation(parsed.navigation, { now: timestamp.milliseconds }),
      { now: timestamp.milliseconds },
    );
    return {
      status: "loaded",
      revision: parsed.revision,
      savedAt: parsed.savedAt,
      session: createMissionControlSessionState({ navigation, acknowledgedInputs: parsed.acknowledgedInputs }),
    };
  } catch (error) {
    return { status: "corrupt", error: error.message };
  }
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

async function acquireLock(path, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return async () => {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") fail("Unable to acquire Mission Control session lock.", "LOCK_ERROR", error);
      try {
        const [ownerText, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        const owner = Number.parseInt(ownerText, 10);
        if ((!processAlive(owner) && Number.isInteger(owner)) || (!Number.isInteger(owner) && Date.now() - info.mtimeMs > LOCK_STALE_MS)) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(10);
    }
  }
  fail("Timed out acquiring Mission Control session lock.", "LOCK_TIMEOUT");
}

async function atomicWrite(path, serialized) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    try {
      const directory = await open(resolve(path, ".."), "r");
      await directory.sync();
      await directory.close();
    } catch {}
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function createMissionControlSessionStore({
  stateRoot,
  workspace,
  repository = null,
  now = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxBytes = MISSION_CONTROL_SESSION_MAX_BYTES,
  lockAttempts = DEFAULT_LOCK_ATTEMPTS,
} = {}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) fail("maxAgeMs must be a positive safe integer.", "INVALID_LIMIT");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024) fail("maxBytes must be at least 1024.", "INVALID_LIMIT");
  if (!Number.isSafeInteger(lockAttempts) || lockAttempts < 1) fail("lockAttempts must be a positive safe integer.", "INVALID_LIMIT");
  const scope = scopeFor(workspace, repository);
  const paths = sessionPaths(stateRoot, scope);
  const defaults = () => createMissionControlSessionState();

  async function load() {
    const observed = await readOptional(paths.state, maxBytes);
    if (observed.status === "missing") return { status: "missing", path: paths.state, scope, revision: 0, session: defaults() };
    if (observed.status === "corrupt") {
      return { status: "corrupt", path: paths.state, scope, revision: 0, session: defaults(), error: observed.error?.message || String(observed.error) };
    }
    const restored = restoreEnvelope(observed.text, { scope, now: now(), maxAgeMs });
    return {
      ...restored,
      path: paths.state,
      scope,
      revision: restored.revision || 0,
      session: restored.session || defaults(),
    };
  }

  async function save(session, { expectedRevision = null } = {}) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(paths.lock, lockAttempts);
    try {
      const current = await load();
      if (expectedRevision != null && current.revision !== expectedRevision) {
        fail(`Mission Control session revision changed: expected ${expectedRevision}, current ${current.revision}.`, "REVISION_CONFLICT");
      }
      const revision = current.revision + 1;
      const savedAt = new Date(now()).toISOString();
      const compacted = compactSession(session, { scope, revision, savedAt, maxBytes });
      await atomicWrite(paths.state, compacted.serialized);
      return { status: "saved", path: paths.state, scope, revision, savedAt, session: compacted.session };
    } finally {
      await release();
    }
  }

  async function update(updater, { model = null } = {}) {
    if (typeof updater !== "function") fail("update requires a function.", "INVALID_UPDATE");
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(paths.lock, lockAttempts);
    try {
      const current = await load();
      let candidate = await updater(structuredClone(current.session), current);
      candidate = createMissionControlSessionState(candidate);
      if (model) candidate = reconcileMissionControlSession(candidate, model).session;
      const revision = current.revision + 1;
      const savedAt = new Date(now()).toISOString();
      const compacted = compactSession(candidate, { scope, revision, savedAt, maxBytes });
      await atomicWrite(paths.state, compacted.serialized);
      return { status: "saved", path: paths.state, scope, revision, savedAt, session: compacted.session, recoveredFrom: current.status };
    } finally {
      await release();
    }
  }

  async function clear() {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(paths.lock, lockAttempts);
    try {
      await rm(paths.state, { force: true });
      return { status: "cleared", path: paths.state, scope };
    } finally {
      await release();
    }
  }

  return Object.freeze({ scope, path: paths.state, load, save, update, clear });
}

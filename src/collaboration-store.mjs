import { createHash, randomUUID } from "node:crypto";
import { attentionRequestAt } from "./attention-state.mjs";
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
import { CLAIMED_ISSUE_CONTEXT_MARKER } from "./claimed-issue-context.mjs";
import { collaborationAlias } from "./collaboration-identity.mjs";

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

function identityIndexPath(root, identityKey) {
  if (!/^[0-9a-f]{64}$/.test(identityKey || "")) throw new Error("Invalid collaboration identity key.");
  return resolve(collaborationDirectory(root), `identity-${identityKey}.json`);
}

function identityLockPath(root, identityKey) {
  if (!/^[0-9a-f]{64}$/.test(identityKey || "")) throw new Error("Invalid collaboration identity key.");
  return resolve(collaborationDirectory(root), `identity-${identityKey}.lock`);
}

async function removeStaleIdentityLock(root, identityKey) {
  const path = identityLockPath(root, identityKey);
  try {
    const owner = Number.parseInt(await readFile(path, "utf8"), 10);
    const info = await stat(path);
    let ownerAlive = false;
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        ownerAlive = true;
      } catch (error) {
        ownerAlive = error.code === "EPERM";
      }
    }
    if ((!ownerAlive && Number.isInteger(owner) && owner > 0) || (!Number.isInteger(owner) && Date.now() - info.mtimeMs > LOCK_STALE_MS)) {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
  const id = input.id || `bridge-${randomUUID()}`;
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
  if (state.identityKey) {
    await atomicWriteJson(identityIndexPath(root, state.identityKey), { id, identityKey: state.identityKey, updatedAt: now });
  }
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
      identityKey: state.identityKey,
      task: String(state.task || "").split(CLAIMED_ISSUE_CONTEXT_MARKER)[0].trim().slice(0, 500),
      status: state.status,
      agents: state.agents,
      workspace: state.workspace,
      turnCount: state.runtime?.turnCount || 0,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      error: state.error,
      coordinatorWake: state.coordinatorWake ? {
        sequence: state.coordinatorWake.sequence,
        kind: state.coordinatorWake.kind,
        status: state.coordinatorWake.status,
        nextAction: state.coordinatorWake.nextAction,
      } : null,
    }));
}

export async function findCollaborationByIdentity(root, identityKey, {
  statuses = ["queued", "running", "recovering", "cancelling", "needs_user", "indeterminate"],
} = {}) {
  if (!identityKey) return null;
  const allowed = new Set(statuses);
  try {
    const indexed = JSON.parse(await readFile(identityIndexPath(root, identityKey), "utf8"));
    const state = await readCollaboration(root, indexed.id);
    if (state.identityKey === identityKey && allowed.has(state.status)) return state;
  } catch {}
  const candidates = await listCollaborations(root, { limit: 10_000 });
  for (const candidate of candidates) {
    if (!allowed.has(candidate.status)) continue;
    if (candidate.identityKey && candidate.identityKey !== identityKey) continue;
    const state = await readCollaboration(root, candidate.id);
    if (state.identityKey === identityKey) {
      await atomicWriteJson(identityIndexPath(root, identityKey), { id: state.id, identityKey, updatedAt: state.updatedAt });
      return state;
    }
  }
  return null;
}

export async function acquireWorkerLock(root, id) {
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  return acquireFileLock(target.workerLock, { attempts: 200, intervalMs: 50 });
}

export async function acquireIdentityLock(root, identityKey) {
  if (!/^[0-9a-f]{64}$/.test(identityKey || "")) throw new Error("Invalid collaboration identity key.");
  const directory = collaborationDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return acquireFileLock(identityLockPath(root, identityKey), {
    attempts: 7_200,
    intervalMs: 50,
  });
}

export function workspaceLockPath(root, workspace) {
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  return resolve(collaborationDirectory(root), `workspace-${digest}.lock`);
}

export async function acquireWorkspaceLock(root, workspace) {
  const directory = collaborationDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return acquireFileLock(workspaceLockPath(root, workspace), {
    attempts: 100,
    intervalMs: 50,
  });
}

// Issue #55: on cancel, deterministically release the worker/update/workspace locks
// owned by the (already reaped) worker. Ownership is preserved: a lock file is removed
// only when its recorded owner PID equals the cancelled worker's PID or that owner is
// no longer alive. A lock held by a different *live* process is never touched.
export async function releaseOwnedCollaborationLocks(root, {
  id,
  workspace,
  ownerPid,
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  },
} = {}) {
  const target = paths(root, id);
  const lockPaths = [target.workerLock, target.updateLock];
  if (workspace) lockPaths.push(workspaceLockPath(root, workspace));
  const released = [];
  const preserved = [];
  for (const path of lockPaths) {
    let owner = null;
    try {
      owner = Number.parseInt(await readFile(path, "utf8"), 10);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const ownedByTarget = Number.isInteger(ownerPid) && owner === ownerPid;
    const ownerLive = Number.isInteger(owner) && owner > 1 && isAlive(owner);
    if (ownedByTarget || !ownerLive) {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      released.push(path);
    } else {
      preserved.push(path);
    }
  }
  return { released, preserved };
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

export async function archiveCollaboration(root, id, { expectedUpdatedAt = null } = {}) {
  const target = paths(root, id);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(target.updateLock);
  try {
    const state = await readCollaboration(root, id);
    if (expectedUpdatedAt && state.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Cannot archive ${id}: state changed after cleanup audit.`);
    }
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(state.status)) {
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
    if (state.identityKey) {
      const indexPath = identityIndexPath(root, state.identityKey);
      try {
        const indexed = JSON.parse(await readFile(indexPath, "utf8"));
        if (indexed.id === id) await unlink(indexPath);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await removeStaleIdentityLock(root, state.identityKey);
    }
    return { id, archived: true, status: state.status, archive };
  } finally {
    await release();
  }
}

export async function pruneTerminalCollaborations(root, { olderThanDays = 30, now = Date.now() } = {}) {
  const states = await listCollaborations(root, { limit: 10_000 });
  const cutoff = now - olderThanDays * 86_400_000;
  const archived = [];
  for (const state of states) {
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(state.status)) continue;
    const updatedAt = Date.parse(state.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
    archived.push(await archiveCollaboration(root, state.id));
  }
  return archived;
}

export async function queryControlPlane(stateRoot, options = {}) {
  const includeArchived = options.includeArchived || false;
  const now = options.now || Date.now();
  const collaborations = [];

  async function loadJsonFiles(directory, pattern) {
    try {
      const names = await readdir(directory);
      const results = [];
      for (const name of names) {
        if (pattern.test(name)) {
          try {
            const content = await readFile(resolve(directory, name), "utf8");
            results.push(JSON.parse(content));
          } catch {}
        }
      }
      return results;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  const colStates = await loadJsonFiles(stateRoot, /^bridge-[0-9a-f-]{36}\.json$/);
  for (const c of colStates) {
    collaborations.push({ state: c, archived: false });
  }

  if (includeArchived) {
    const archStates = await loadJsonFiles(resolve(stateRoot, "archive"), /^bridge-[0-9a-f-]{36}\.json$/);
    for (const c of archStates) {
      collaborations.push({ state: c, archived: true });
    }
  }

  const portfolioRoot = process.env.BRIDGE_PORTFOLIO_DIR || resolve(stateRoot, "portfolios");
  const portfolios = await loadJsonFiles(portfolioRoot, /^helm-[0-9a-f-]{36}\.json$/);

  const lanes = [];
  const processedCollaborationIds = new Set();

  function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  function parseAge(dateStr) {
    if (!dateStr) return null;
    const parsed = Date.parse(dateStr);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
  }

  function buildCollaborationLane(cState, archived) {
    const participants = cState.participants || cState.agents || [];
    const writer = cState.writer || cState.runtime?.writer || null;
    const activeCall = cState.runtime?.activeCall || null;

    const usage = {};
    for (const agent of participants) {
      const entry = cState.usage?.[agent];
      if (entry && (entry.costUsd !== undefined || entry.tokens !== undefined)) {
        usage[agent] = {
          costUsd: entry.costUsd !== undefined ? entry.costUsd : null,
          tokens: entry.tokens !== undefined ? entry.tokens : null,
          metadata: { source: "recorded", confidence: "high" }
        };
      } else {
        usage[agent] = {
          costUsd: null,
          tokens: null,
          metadata: { source: "unknown", confidence: "unknown" }
        };
      }
    }

    const narrative = activeCall ? {
      summary: activeCall.summary || null,
      updatedAt: activeCall.summaryAt || null,
      ageSeconds: parseAge(activeCall.summaryAt),
      source: activeCall.summarySource || null,
      isPlaceholder: activeCall.summarySource === "broker"
    } : {
      summary: null,
      updatedAt: null,
      ageSeconds: null,
      source: null,
      isPlaceholder: false
    };

    const heartbeat = activeCall ? {
      heartbeatAt: activeCall.heartbeatAt || null,
      ageSeconds: parseAge(activeCall.heartbeatAt)
    } : null;

    const handoff = cState.completion ? {
      sequence: cState.completion.sequence,
      outcome: cState.completion.lastHandoff?.outcome || null,
      summary: cState.completion.lastHandoff?.summary || null,
      acknowledged: cState.completion.acknowledged || false,
      nextAction: cState.completion.nextAction || null
    } : null;

    const lastDecision = cState.decisions?.at(-1) || null;
    const isPending = lastDecision && lastDecision.action !== "resolved";
    const blocker = {
      error: cState.error || null,
      needsUser: cState.status === "needs_user",
      pendingDecision: isPending ? {
        question: lastDecision.question || null,
        category: lastDecision.category || null,
        owner: lastDecision.owner || null,
        reason: lastDecision.reason || null
      } : null,
      decisionEscalation: cState.decisionEscalation ? {
        question: cState.decisionEscalation.question || null,
        category: cState.decisionEscalation.category || null,
        owner: cState.decisionEscalation.owner || null,
        reason: cState.decisionEscalation.reason || null
      } : null
    };

    const recovery = {
      status: ["indeterminate", "recovering"].includes(cState.status) ? cState.status : null,
      recommendation: cState.status === "indeterminate"
        ? "Execution ownership is ambiguous. Inspect with bridge recover <id>; do not start replacement work. Cancel only after verifying workspace and provider state."
        : null,
      processAlive: processAlive(cState.workerPid),
      unavailableAgents: cState.runtime?.unavailableAgents || null,
      availableAgents: cState.runtime?.availableAgents || null,
      providerRecoveryState: cState.providerRecoveryState || null
    };

    const budget = cState.budget ? {
      limit: cState.budget,
      exceeded: cState.runtime?.budgetExceeded || false
    } : null;

    let nextAction = "none";
    if (handoff) {
      nextAction = handoff.nextAction || "none";
    } else if (cState.status === "needs_user") {
      nextAction = "needs_user";
    } else if (cState.status === "indeterminate") {
      nextAction = "inspect_recovery";
    } else if (["queued", "running", "recovering", "cancelling"].includes(cState.status)) {
      nextAction = "continue";
    } else if (["failed", "cancelled", "budget"].includes(cState.status)) {
      nextAction = "requeue_or_cancel";
    }

    return {
      id: cState.id,
      alias: cState.alias || collaborationAlias(cState),
      type: "collaboration",
      workspace: cState.workspace || null,
      repository: cState.issueClaim?.repository || cState.githubReview?.repository || cState.githubBuilder?.repository || null,
      task: String(cState.taskBase || cState.task || "").split(CLAIMED_ISSUE_CONTEXT_MARKER)[0].trim().slice(0, 500),
      participants,
      writer,
      activeAgent: activeCall?.agent || cState.runtime?.previousAgent || null,
      lifecyclePhase: cState.status || "unknown",
      createdAt: cState.createdAt || null,
      updatedAt: cState.updatedAt || null,
      mode: cState.mode || null,
      workProfile: cState.workProfile || null,
      permissionProfile: cState.permissionProfile || null,
      issueNumber: cState.issueClaim?.issueNumber || null,
      prNumber: cState.ci?.pr || cState.ciTracking?.prNumber || cState.githubReview?.prNumber || cState.githubBuilder?.prNumber || null,
      branch: cState.githubBuilder?.headRef || cState.branch || null,
      headSha: cState.githubReview?.headSha || cState.githubBuilder?.headSha || cState.issueClaim?.headSha || null,
      ci: cState.ci || cState.ciTracking || null,
      coordinatorWake: cState.coordinatorWake || null,
      attentionRequestedAt: attentionRequestAt(cState),
      reviewPublication: cState.reviewPublication || null,
      performanceSummary: cState.performanceSummary || null,
      turnCount: cState.runtime?.turnCount || 0,
      model: activeCall?.model || activeCall?.selectedModel || null,
      narrative,
      heartbeat,
      activity: activeCall?.activity || null,
      handoff,
      blocker,
      recovery,
      budget,
      usage,
      portfolio: null,
      nextAction,
      archived
    };
  }

  for (const p of portfolios) {
    if (!p.items) continue;
    for (const item of p.items) {
      const colId = item.collaborationId;
      const matched = colId ? collaborations.find(c => c.state.id === colId) : null;

      let mtEntry = null;
      if (p.mergeTrain) {
        if (Array.isArray(p.mergeTrain)) {
          mtEntry = p.mergeTrain.find(mt => mt.itemId === item.id) || null;
        } else {
          if (Array.isArray(p.mergeTrain.queue)) {
            mtEntry = p.mergeTrain.queue.find(mt => mt.itemId === item.id) || null;
          }
          if (!mtEntry && Array.isArray(p.mergeTrain.history)) {
            mtEntry = p.mergeTrain.history.find(mt => mt.itemId === item.id) || null;
          }
        }
      }
      const portfolioInfo = {
        portfolioId: p.id,
        itemId: item.id,
        priority: item.priority !== undefined ? item.priority : null,
        blockedBy: item.blockedBy || [],
        conflictsWith: item.conflictsWith || [],
        paths: item.paths || [],
        mergeTrain: mtEntry ? {
          prNumber: mtEntry.prNumber,
          headSha: mtEntry.headSha,
          priority: mtEntry.priority !== undefined ? mtEntry.priority : null
        } : null
      };

      if (matched) {
        processedCollaborationIds.add(matched.state.id);
        const colLane = buildCollaborationLane(matched.state, matched.archived);
        colLane.type = "combined";
        colLane.portfolio = portfolioInfo;
        lanes.push(colLane);
      } else {
        const participants = item.writer ? [item.writer] : [];
        const writer = item.writer || null;

        const usage = {};
        for (const agent of participants) {
          usage[agent] = {
            costUsd: null,
            tokens: null,
            metadata: { source: "unknown", confidence: "unknown" }
          };
        }

        lanes.push({
          id: `${p.id}:${item.id}`,
          type: "portfolio_lane",
          workspace: p.workspace || null,
          repository: p.repository || null,
          task: item.title || item.task || item.summary || item.id,
          participants,
          writer,
          activeAgent: null,
          lifecyclePhase: item.status || "unknown",
          createdAt: p.createdAt || null,
          updatedAt: item.updatedAt || p.updatedAt || null,
          attentionRequestedAt: item.needsUserAt || item.updatedAt || p.updatedAt || p.createdAt || null,
          mode: "work",
          workProfile: null,
          permissionProfile: null,
          issueNumber: item.issueNumber || null,
          prNumber: item.prNumber || mtEntry?.prNumber || null,
          branch: item.branch || null,
          headSha: item.headSha || mtEntry?.headSha || null,
          ci: item.ci || null,
          coordinatorWake: null,
          reviewPublication: null,
          performanceSummary: null,
          turnCount: 0,
          model: null,
          narrative: {
            summary: item.summary || null,
            updatedAt: item.updatedAt || p.updatedAt || null,
            ageSeconds: parseAge(item.updatedAt || p.updatedAt),
            source: "portfolio"
          },
          heartbeat: null,
          handoff: null,
          blocker: null,
          recovery: null,
          budget: null,
          usage,
          portfolio: portfolioInfo,
          nextAction: item.status === "ready" ? "start_collaboration" : "none",
          alias: `${p.repository || `local/${String(p.workspace || "workspace").split("/").at(-1)}`}:#${item.issueNumber || item.id}:${item.writer ? `${item.writer}-writer` : "portfolio"}`,
          archived: false
        });
      }
    }
  }

  for (const c of collaborations) {
    if (!processedCollaborationIds.has(c.state.id)) {
      lanes.push(buildCollaborationLane(c.state, c.archived));
    }
  }

  lanes.sort((left, right) => left.id.localeCompare(right.id));
  let filteredLanes = lanes;

  if (options.workspace) {
    const filterW = resolve(options.workspace);
    filteredLanes = filteredLanes.filter(lane => {
      if (!lane.workspace) return false;
      const laneW = resolve(lane.workspace);
      return laneW === filterW || laneW.startsWith(filterW + "/");
    });
  }

  if (options.status) {
    const filterStatus = options.status.toLowerCase();
    filteredLanes = filteredLanes.filter(lane => (lane.lifecyclePhase || "unknown").toLowerCase() === filterStatus);
  }

  if (options.provider) {
    const filterProv = options.provider.toLowerCase();
    filteredLanes = filteredLanes.filter(lane => {
      const matchWriter = lane.writer && lane.writer.toLowerCase() === filterProv;
      const matchPart = lane.participants.some(p => p.toLowerCase() === filterProv);
      return matchWriter || matchPart;
    });
  }

  if (options.portfolio) {
    const filterPort = options.portfolio;
    filteredLanes = filteredLanes.filter(lane => lane.portfolio && lane.portfolio.portfolioId === filterPort);
  }

  return {
    version: "1.0.0",
    query: {
      stateRoot: resolve(stateRoot),
      filters: {
        workspace: options.workspace || null,
        status: options.status || null,
        provider: options.provider || null,
        portfolio: options.portfolio || null
      },
      includeArchived
    },
    lanes: filteredLanes
  };
}

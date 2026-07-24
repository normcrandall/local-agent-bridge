import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { queryControlPlane } from "./collaboration-store.mjs";
import { attentionRequestAt, attentionRequestIsFresh } from "./attention-state.mjs";
import { LIVE_COLLABORATION_STATUSES } from "./collaboration-cleanup.mjs";
import { hostActivityLane, listHostActivities } from "./host-activity-store.mjs";
import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";

const ACTIVE_STATUSES = new Set([
  "queued", "waiting_capacity", "running", "working", "recovering", "cancelling",
  "validating",
  ...PORTFOLIO_STATUS_GROUPS.ready,
  ...PORTFOLIO_STATUS_GROUPS.active,
  ...PORTFOLIO_STATUS_GROUPS.integration,
]);
const ATTENTION_STATUSES = new Set(["budget", ...PORTFOLIO_STATUS_GROUPS.paused]);
const TERMINAL_STATUSES = new Set(["agreed", "cancelled", "closed", "superseded", "turn_limit", ...PORTFOLIO_STATUS_GROUPS.terminal]);
const repositoryCache = new Map();
const timelineCache = new Map();
let repositoryCacheGeneration = 0;
const execFileAsync = promisify(execFile);
const MAX_TIMELINE_READ_BYTES = 1_048_576;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIVE_HEARTBEAT_AFTER_MS = 60_000;
const DEFAULT_RECENT_ACTIVITY_AFTER_MS = 5 * 60 * 1000;

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const stripAnsi = (value) => String(value || "").replace(ANSI_PATTERN, "");

export function navigationIntent(key, selectedIndex) {
  if (key === "j" || key === "\x1b[B") return { selectedIndex: selectedIndex + 1, preserveSelectedId: false };
  if (key === "k" || key === "\x1b[A") return { selectedIndex: selectedIndex - 1, preserveSelectedId: false };
  if (key === "g") return { selectedIndex: 0, preserveSelectedId: false };
  if (key === "G") return { selectedIndex: Number.MAX_SAFE_INTEGER, preserveSelectedId: false };
  return { selectedIndex, preserveSelectedId: true };
}

export function paneFocusIntent(key, activePane) {
  if (key === "\t" || key === "\x1b[C") return (activePane + 1) % 3;
  if (key === "\x1b[Z" || key === "\x1b[D") return (activePane + 2) % 3;
  return activePane;
}

export function clearRepositoryCache() {
  repositoryCacheGeneration += 1;
  repositoryCache.clear();
}

export async function readFileRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return { buffer: buffer.subarray(0, filled), consumedSize: start + filled };
}

function clean(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatLocalDateTime(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} ${values.timeZoneName}`;
}

export function parseRepositoryRemote(remote) {
  const value = clean(remote);
  if (!value) return null;
  let path = null;
  try {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : null;
    if (normalized) path = new URL(normalized).pathname;
  } catch {}
  if (!path) {
    const scp = value.match(/^[^@\s]+@[^:\s]+:(.+)$/);
    if (scp) path = scp[1];
  }
  if (!path && !value.includes("://")) path = value;
  const parts = String(path || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

async function remoteRepository(candidate) {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: candidate,
      encoding: "utf8",
      timeout: 750,
      maxBuffer: 16_384,
    });
    return parseRepositoryRemote(stdout);
  } catch { return null; }
}

async function repositoryFromWorkspace(workspace) {
  if (!workspace) return "unknown/local";
  const root = resolve(workspace);
  const cached = repositoryCache.get(root);
  if (cached?.promise) return cached.promise;
  if (cached && cached.expiresAt > Date.now()) return cached.repository;
  const generation = repositoryCacheGeneration;
  const lookup = (async () => {
    const worktreeMarker = "/.bridge/worktrees/";
    const markerIndex = root.indexOf(worktreeMarker);
    const candidates = markerIndex > 0 ? [root, root.slice(0, markerIndex)] : [root];
    const parent = dirname(root);
    if (basename(parent).endsWith("-worktrees")) {
      candidates.push(resolve(dirname(parent), basename(parent).replace(/-worktrees$/, "")));
    }
    let repository = null;
    for (const candidate of candidates) {
      repository = await remoteRepository(candidate);
      if (repository) break;
    }
    const fallback = repository || `local/${basename(root) || "workspace"}`;
    if (generation === repositoryCacheGeneration) {
      repositoryCache.set(root, {
        repository: fallback,
        expiresAt: repository ? Number.POSITIVE_INFINITY : Date.now() + 600_000,
      });
    }
    return fallback;
  })();
  repositoryCache.set(root, { promise: lookup, expiresAt: Number.POSITIVE_INFINITY });
  return lookup;
}

export async function repositoryForLane(lane) {
  const explicit = clean(lane.repository).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(explicit)) return explicit;
  return repositoryFromWorkspace(lane.workspace);
}

async function mapLimit(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  }));
  return output;
}

export function isAttentionLane(lane, now = Date.now()) {
  const status = String(lane.lifecyclePhase || "unknown").toLowerCase();
  // Delivery completion does not make a live process or an unresolved human
  // boundary disappear. Those remain operable until the attempt itself stops.
  if (ACTIVE_STATUSES.has(status)) return true;
  if (["needs_user", "indeterminate", "blocked"].includes(status)) return true;
  const delivered = portfolioTerminalStatus(lane);
  if (delivered) return false;
  if (TERMINAL_STATUSES.has(status)) return false;
  if (["failed", "budget"].includes(status)) return now - dateMs(lane.updatedAt) <= 86_400_000;
  if (lane.handoff && !lane.handoff.acknowledged) return true;
  if (lane.coordinatorWake && !lane.coordinatorWake.acknowledged) return true;
  return false;
}

export function isLiveLane(lane, now = Date.now(), heartbeatAfterMs = DEFAULT_LIVE_HEARTBEAT_AFTER_MS) {
  // Liveness describes the provider process, not the delivery artifact. A
  // merge can land while a final provider turn is still winding down.
  const status = String(lane.lifecyclePhase || "unknown").toLowerCase();
  if (lane.type === "native_host") return status === "working" && lane.hostActivity?.live === true;
  if (!["collaboration", "combined"].includes(lane.type)) return false;
  if (!LIVE_COLLABORATION_STATUSES.has(status)) return false;
  if (lane.recovery?.processAlive === true) return true;
  const heartbeatAt = dateMs(lane.heartbeat?.heartbeatAt);
  return heartbeatAt > 0 && now - heartbeatAt <= heartbeatAfterMs;
}

export function laneNeedsUser(lane) {
  const wake = lane.coordinatorWake;
  const lifecycle = String(lane.status || lane.lifecyclePhase || "").toLowerCase();
  return lifecycle === "needs_user"
    && !lane.heartbeat
    && wake
    && wake.status !== "acknowledged"
    && (wake.kind === "needs_user" || wake.nextAction === "needs_user");
}

export function isStaleLane(lane, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const status = effectiveLaneStatus(lane);
  if (isLiveLane(lane, now) || status === "indeterminate") return false;
  const updatedAt = dateMs(laneNeedsUser(lane) ? attentionRequestAt(lane) : lane.updatedAt);
  if (!updatedAt || now - updatedAt < staleAfterMs) return false;
  if (lane.type === "portfolio_lane") return !PORTFOLIO_STATUS_GROUPS.integration.includes(status);
  return ["needs_user", "blocked", "failed", "budget", "ready"].includes(status);
}

function summarizeCollapsedStale(lanes) {
  const byStatus = {};
  const byRepository = {};
  const portfolios = new Set();
  for (const lane of lanes) {
    const status = String(lane.lifecyclePhase || "unknown").toLowerCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
    byRepository[lane.repository] = (byRepository[lane.repository] || 0) + 1;
    if (lane.portfolio?.portfolioId) portfolios.add(lane.portfolio.portfolioId);
  }
  return {
    total: lanes.length,
    portfolioItems: lanes.filter((lane) => lane.type === "portfolio_lane").length,
    portfolios: portfolios.size,
    byStatus,
    byRepository,
  };
}

export function statusRank(status) {
  const value = String(status || "unknown").toLowerCase();
  if (ATTENTION_STATUSES.has(value)) return 0;
  if (PORTFOLIO_STATUS_GROUPS.integration.includes(value)) return 1;
  if (["running", "working", "recovering", "cancelling"].includes(value)) return 1;
  if (PORTFOLIO_STATUS_GROUPS.active.includes(value) || value === "validating") return 2;
  if (["queued", "waiting_capacity", ...PORTFOLIO_STATUS_GROUPS.ready].includes(value)) return 3;
  return 4;
}

function portfolioTerminalStatus(lane) {
  const status = String(lane.portfolio?.status || "").toLowerCase();
  return PORTFOLIO_STATUS_GROUPS.terminal.includes(status) ? status : null;
}

function effectiveLaneStatus(lane) {
  return portfolioTerminalStatus(lane) || String(lane.lifecyclePhase || "unknown").toLowerCase();
}

function stoppedReason(lane) {
  const status = String(lane.lifecyclePhase || "unknown").toLowerCase();
  if (status === "budget") return "budget reached";
  if (status === "indeterminate") return "ownership uncertain";
  if (status === "failed") return "provider failed";
  if (status === "cancelled") return "cancelled";
  return clean(status).replace(/_/g, " ");
}

export function operatorLaneCategory(lane, now = Date.now()) {
  const status = effectiveLaneStatus(lane);
  if (laneNeedsUser(lane) && attentionRequestIsFresh(lane, now)) return "needs_user";
  const attemptStatus = String(lane.lifecyclePhase || "unknown").toLowerCase();
  if (attemptStatus === "needs_user") {
    const heartbeatAt = dateMs(lane.heartbeat?.heartbeatAt);
    return lane.recovery?.processAlive === true || (heartbeatAt > 0 && now - heartbeatAt <= DEFAULT_LIVE_HEARTBEAT_AFTER_MS)
      ? "active"
      : null;
  }
  if (isLiveLane(lane, now)) return "active";
  if (PORTFOLIO_STATUS_GROUPS.terminal.includes(status)) return null;
  if (["failed", "indeterminate", "budget"].includes(status)) {
    return now - dateMs(lane.updatedAt) <= 86_400_000 || status === "indeterminate" ? "stopped" : null;
  }
  if ([
    "queued", "waiting_capacity", "blocked", "validating", "turn_limit",
    ...PORTFOLIO_STATUS_GROUPS.ready,
    ...PORTFOLIO_STATUS_GROUPS.active,
    ...PORTFOLIO_STATUS_GROUPS.integration,
  ].includes(status)) return now - dateMs(lane.updatedAt) <= DEFAULT_STALE_AFTER_MS ? "waiting" : null;
  if (lane.handoff && !lane.handoff.acknowledged) return now - dateMs(lane.updatedAt) <= DEFAULT_STALE_AFTER_MS ? "waiting" : null;
  return null;
}

function operatorLaneIdentity(lane, issueToPr = new Map()) {
  const repository = lane.repository || "unknown/local";
  // Once a pull request exists it is the delivery source of truth. Review,
  // writer, and portfolio lanes do not consistently carry the issue number,
  // but they do share the PR number. Prefer it so a terminal PR outcome can
  // supersede every stopped attempt associated with that delivery.
  if (lane.prNumber) return `${repository}:pr:${lane.prNumber}`;
  const mappedPr = lane.issueNumber ? issueToPr.get(`${repository}:issue:${lane.issueNumber}`) : null;
  if (mappedPr) return `${repository}:pr:${mappedPr}`;
  if (lane.issueNumber) return `${repository}:issue:${lane.issueNumber}`;
  if (lane.portfolio?.itemId) return `${repository}:item:${lane.portfolio.itemId}`;
  if (lane.alias) return `${repository}:alias:${lane.alias}`;
  return `${repository}:lane:${lane.id}`;
}

const OPERATOR_CATEGORY_RANK = { needs_user: 0, active: 1, stopped: 2, waiting: 3, history: 4 };

function operatorRepresentativeRank(lane, now) {
  const category = operatorLaneCategory(lane, now) || "history";
  const typeRank = lane.type === "collaboration" || lane.type === "combined" ? 0 : lane.type === "native_host" ? 1 : 2;
  return [OPERATOR_CATEGORY_RANK[category] ?? 9, typeRank, -dateMs(lane.updatedAt)];
}

function compareRank(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

export function deduplicateOperatorLanes(lanes, { now = Date.now(), includeHistory = false } = {}) {
  const issueToPrCandidates = new Map();
  for (const lane of lanes || []) {
    if (!lane.issueNumber || !lane.prNumber) continue;
    const key = `${lane.repository || "unknown/local"}:issue:${lane.issueNumber}`;
    const candidate = {
      prNumber: lane.prNumber,
      terminal: portfolioTerminalStatus(lane) ? 1 : 0,
      updatedAt: dateMs(lane.updatedAt),
    };
    const previous = issueToPrCandidates.get(key);
    if (!previous || candidate.terminal > previous.terminal
      || (candidate.terminal === previous.terminal && candidate.updatedAt > previous.updatedAt)) {
      issueToPrCandidates.set(key, candidate);
    }
  }
  const issueToPr = new Map([...issueToPrCandidates].map(([key, value]) => [key, value.prNumber]));
  const groups = new Map();
  for (const lane of lanes || []) {
    const identity = operatorLaneIdentity(lane, issueToPr);
    const group = groups.get(identity) || [];
    group.push(lane);
    groups.set(identity, group);
  }
  return [...groups.entries()].flatMap(([operatorId, group]) => {
    const terminalEvidence = group.filter((lane) => portfolioTerminalStatus(lane));
    const actionable = group.filter((lane) => operatorLaneCategory(lane, now));
    const urgent = actionable.filter((lane) => ["active", "needs_user"].includes(operatorLaneCategory(lane, now)));
    if (terminalEvidence.length && !includeHistory && !urgent.length) return [];
    if (!terminalEvidence.length && !actionable.length && !includeHistory) return [];
    const candidates = urgent.length ? urgent : terminalEvidence.length ? terminalEvidence : actionable.length ? actionable : group;
    const sorted = [...candidates].sort((left, right) => compareRank(operatorRepresentativeRank(left, now), operatorRepresentativeRank(right, now)));
    const representative = sorted[0];
    const providers = [...new Set(group.map((lane) => lane.activeAgent || lane.writer).filter(Boolean))];
    const categories = [...new Set(candidates.map((lane) => operatorLaneCategory(lane, now) || "history"))]
      .sort((left, right) => (OPERATOR_CATEGORY_RANK[left] ?? 9) - (OPERATOR_CATEGORY_RANK[right] ?? 9));
    const relatedAttempts = group
      .map((lane) => ({
        id: lane.id,
        lifecyclePhase: String(lane.lifecyclePhase || "unknown").toLowerCase(),
        reason: stoppedReason(lane),
      }))
      .filter((attempt) => ["failed", "indeterminate", "budget", "cancelled"].includes(attempt.lifecyclePhase));
    const operatorCategory = categories[0] || "history";
    return [{
      ...representative,
      operatorId,
      operatorCategory,
      legacyOperatorCategory: operatorCategory === "stopped" ? "failed" : operatorCategory,
      relatedLaneCount: group.length,
      relatedLaneIds: group.map((lane) => lane.id),
      relatedAttempts,
      providers,
    }];
  }).sort((left, right) => (OPERATOR_CATEGORY_RANK[left.operatorCategory] ?? 9) - (OPERATOR_CATEGORY_RANK[right.operatorCategory] ?? 9)
    || left.repository.localeCompare(right.repository)
    || dateMs(right.updatedAt) - dateMs(left.updatedAt));
}

export async function loadMissionControlSnapshot({
  stateRoot,
  includeArchived = false,
  view = null,
  showAll = false,
  includeStale = false,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  repositoryFilter = null,
  now = Date.now(),
} = {}) {
  const controlPlane = await queryControlPlane(stateRoot, { includeArchived, now });
  const hostActivities = await listHostActivities(stateRoot, { now });
  const rawLanes = [...controlPlane.lanes, ...hostActivities.map((state) => hostActivityLane(state, now))];
  const allLanes = await mapLimit(rawLanes, 12, async (lane) => ({ ...lane, repository: await repositoryForLane(lane) }));
  const normalizedFilter = clean(repositoryFilter).toLowerCase();
  const matching = allLanes.filter((lane) => !normalizedFilter
    || lane.repository.toLowerCase() === normalizedFilter);
  const mode = view || (showAll ? "all" : "live");
  if (!["live", "attention", "all"].includes(mode)) throw new Error(`Unknown Mission Control view: ${mode}`);
  const attention = matching.filter((lane) => isAttentionLane(lane, now));
  const allNeedsUser = matching.filter((lane) => laneNeedsUser(lane));
  const needsUser = allNeedsUser.filter((lane) => attentionRequestIsFresh(lane, now));
  const stale = attention.filter((lane) => isStaleLane(lane, now, staleAfterMs));
  const selected = mode === "all"
    ? matching
    : mode === "attention"
      ? attention.filter((lane) => includeStale || !isStaleLane(lane, now, staleAfterMs))
      : matching.filter((lane) => isLiveLane(lane, now));
  const visible = selected.sort((left, right) => {
    const repositoryOrder = left.repository.localeCompare(right.repository);
    if (repositoryOrder) return repositoryOrder;
    return statusRank(left.lifecyclePhase) - statusRank(right.lifecyclePhase)
      || dateMs(right.updatedAt) - dateMs(left.updatedAt)
      || left.id.localeCompare(right.id);
  });
  const recentActivity = matching
    .filter((lane) => !isLiveLane(lane, now))
    .map((lane) => ({
      lane,
      activityAt: laneNeedsUser(lane) ? attentionRequestAt(lane) : lane.updatedAt,
    }))
    .filter(({ activityAt }) => {
      const activityMs = dateMs(activityAt);
      return activityMs > 0 && now - activityMs <= DEFAULT_RECENT_ACTIVITY_AFTER_MS;
    })
    .sort((left, right) => dateMs(right.activityAt) - dateMs(left.activityAt))
    .slice(0, 3)
    .map(({ lane, activityAt }) => ({
      id: lane.id,
      repository: lane.repository,
      lifecyclePhase: lane.lifecyclePhase,
      activeAgent: lane.activeAgent || lane.writer || null,
      summary: lane.narrative?.summary || lane.task || null,
      updatedAt: activityAt,
      nextAction: lane.nextAction || null,
      blockedBy: lane.portfolio?.blockedBy || [],
    }));

  const repositories = new Map();
  for (const lane of matching) {
    const summary = repositories.get(lane.repository) || { repository: lane.repository, total: 0, attention: 0, live: 0, visible: 0 };
    summary.total += 1;
    if (isAttentionLane(lane, now)) summary.attention += 1;
    if (isLiveLane(lane, now)) summary.live += 1;
    repositories.set(lane.repository, summary);
  }
  for (const lane of visible) repositories.get(lane.repository).visible += 1;
  const providerActivity = {};
  for (const lane of visible) {
    const provider = lane.activeAgent || lane.writer;
    if (!provider) continue;
    providerActivity[provider] = (providerActivity[provider] || 0) + 1;
  }
  // Always reconcile operator identities against the complete local control
  // plane. Terminal portfolio evidence may not itself be an attention lane,
  // and may be older than the stale cutoff, but it must still supersede a
  // newer stopped attempt for the same PR.
  const modeSource = mode === "attention" ? attention : matching;
  const operatorSource = [...new Set([
    ...modeSource.filter((lane) => includeStale || !isStaleLane(lane, now, staleAfterMs)),
    ...matching.filter((lane) => portfolioTerminalStatus(lane)),
  ])];
  const operatorLanes = deduplicateOperatorLanes(operatorSource, {
    now,
    includeHistory: mode === "all" || (mode === "attention" && includeStale),
  });
  const operatorCounts = { active: 0, needs_user: 0, waiting: 0, stopped: 0, failed: 0, history: 0 };
  for (const lane of operatorLanes) operatorCounts[lane.operatorCategory] = (operatorCounts[lane.operatorCategory] || 0) + 1;
  // Compatibility alias for JSON consumers written before the operator-facing
  // distinction between a stopped attempt and a failed objective.
  operatorCounts.failed = operatorCounts.stopped;
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    stateRoot: resolve(stateRoot),
    mode,
    filter: repositoryFilter || null,
    repositories: [...repositories.values()].sort((a, b) => a.repository.localeCompare(b.repository)),
    visibleRepositories: new Set(visible.map((lane) => lane.repository)).size,
    collapsedStale: !includeStale && mode === "attention" ? summarizeCollapsedStale(stale) : summarizeCollapsedStale([]),
    staleAfterMs,
    includeStale,
    providerActivity,
    operatorCounts,
    operatorLanes,
    needsUserCount: needsUser.length,
    historicalNeedsUserCount: allNeedsUser.length - needsUser.length,
    needsUserRequests: needsUser.map((lane) => ({
      id: lane.id,
      repository: lane.repository,
      summary: lane.coordinatorWake?.summary || lane.blocker?.decisionEscalation?.question || lane.task || "Protected decision",
      requestedAt: attentionRequestAt(lane),
    })),
    needsUserKeys: needsUser.map((lane) => `${lane.id}:${lane.coordinatorWake?.sequence || 0}`).sort(),
    needsUserSignature: needsUser
      .map((lane) => `${lane.id}:${lane.coordinatorWake?.sequence || 0}`)
      .sort()
      .join("|"),
    recentActivity,
    totalLanes: matching.length,
    visibleLanes: visible.length,
    lanes: visible,
  };
}

export function newlyObservedAttentionKeys(seenKeys, currentKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  return (currentKeys || []).filter((key) => !seen.has(key));
}

function eventSummary(event) {
  const value = event.summary || event.message || event.outcome || event.status || event.phase || event.error;
  if (value) return clean(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 240);
  const agent = event.agent || event.provider;
  return agent ? `${clean(agent)} event` : "";
}

export async function loadTimeline(stateRoot, id, limit = 8) {
  if (!/^bridge-[0-9a-f-]{36}$/.test(String(id || ""))) return [];
  const path = resolve(stateRoot, `${id}.jsonl`);
  let info;
  try { info = await stat(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const cached = timelineCache.get(path);
  const sameFile = cached && cached.ino === info.ino && cached.birthtimeMs === info.birthtimeMs;
  if (sameFile && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.events.slice(-limit);
  const delta = cached ? info.size - cached.size : Number.POSITIVE_INFINITY;
  const incremental = sameFile && delta >= 0 && delta <= MAX_TIMELINE_READ_BYTES;
  const start = incremental ? cached.size : Math.max(0, info.size - MAX_TIMELINE_READ_BYTES);
  const handle = await open(path, "r");
  let text;
  let consumedSize;
  try {
    const length = Math.max(0, info.size - start);
    const range = await readFileRange(handle, start, length);
    consumedSize = range.consumedSize;
    text = `${incremental ? cached.remainder : ""}${range.buffer.toString("utf8")}`;
  } finally {
    await handle.close();
  }
  if (!incremental && start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
  const lines = text.split("\n");
  const remainder = text.endsWith("\n") ? "" : lines.pop() || "";
  const added = lines.filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return [{ at: event.at || event.recordedAt || null, type: clean(event.type || "event"), agent: clean(event.agent || event.provider), summary: eventSummary(event) }];
    } catch { return []; }
  });
  const events = [...(incremental ? cached.events : []), ...added].slice(-64);
  timelineCache.delete(path);
  timelineCache.set(path, {
    size: consumedSize,
    mtimeMs: info.mtimeMs,
    ino: info.ino,
    birthtimeMs: info.birthtimeMs,
    remainder,
    events,
  });
  while (timelineCache.size > 100) timelineCache.delete(timelineCache.keys().next().value);
  return events.slice(-limit);
}

function characterWidth(character) {
  const point = character.codePointAt(0);
  if (point === 0 || point < 32 || (point >= 0x7f && point < 0xa0)) return 0;
  if (/\p{Mark}/u.test(character)) return 0;
  if (point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1faff)
    || (point >= 0x20000 && point <= 0x3fffd)
  )) return 2;
  return 1;
}

export function displayWidth(value) {
  let total = 0;
  for (const { segment } of graphemeSegmenter.segment(stripAnsi(value))) {
    total += graphemeWidth(segment);
  }
  return total;
}

function graphemeWidth(segment) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)) return 2;
  return Math.max(0, ...[...segment].map(characterWidth));
}

function sliceDisplay(value, width, { cleanValue = true } = {}) {
  if (width <= 0) return "";
  let output = "";
  let used = 0;
  const input = cleanValue ? clean(value) : String(value ?? "").replace(/[\r\n\t]+/g, " ");
  for (const { segment } of graphemeSegmenter.segment(input)) {
    const next = graphemeWidth(segment);
    if (used + next > width) break;
    output += segment;
    used += next;
  }
  return output;
}

function truncate(value, width) {
  const text = clean(value);
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  return `${sliceDisplay(text, width - 1)}…`;
}

function pad(value, width) {
  const raw = String(value ?? "").replace(/[\r\n\t]+/g, " ");
  const rawWidth = displayWidth(raw);
  const text = rawWidth <= width
    ? raw
    : width === 1 ? "…" : `${sliceDisplay(raw, width - 1, { cleanValue: false })}…`;
  const textWidth = rawWidth <= width ? rawWidth : displayWidth(text);
  return `${text}${" ".repeat(Math.max(0, width - textWidth))}`;
}

function wrap(value, width, prefix = "") {
  const words = clean(value).split(" ").filter(Boolean);
  if (!words.length || width <= 0) return [];
  const contentWidth = Math.max(1, width - displayWidth(prefix));
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (displayWidth(`${current} ${word}`) <= contentWidth) current += ` ${word}`;
    else { lines.push(prefix + truncate(current, contentWidth)); current = word; }
  }
  if (current) lines.push(prefix + truncate(current, contentWidth));
  return lines;
}

function age(value, now = Date.now()) {
  const ms = dateMs(value);
  if (!ms) return "unknown";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function performanceLine(summary) {
  if (!summary) return null;
  const active = Math.round((summary.activeTimeMs || 0) / 1000);
  const dead = Math.round((summary.deadTimeMs || 0) / 1000);
  const latest = summary.latestMilestone?.name;
  return `Timing: active ${active}s | dead ${dead}s${latest ? ` | latest ${latest}` : ""}`;
}

function paint(text, code, enabled) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const CATEGORY_STYLE = {
  active: "36;1",
  needs_user: "33;1",
  waiting: "90",
  stopped: "31;1",
  history: "90",
};

function categoryLabel(category) {
  return { active: "ACTIVE", needs_user: "NEEDS YOU", waiting: "WAITING", stopped: "STOPPED", history: "HISTORY" }[category] || "OTHER";
}

function laneLabel(lane) {
  if (lane.prNumber) return `PR #${lane.prNumber}`;
  if (lane.issueNumber) return `#${lane.issueNumber}`;
  return lane.alias || String(lane.id || "lane").replace(/^bridge-/, "").slice(0, 8);
}

function friendlyPhase(lane) {
  const delivered = portfolioTerminalStatus(lane);
  if (delivered) return delivered;
  if (["failed", "indeterminate", "budget", "cancelled"].includes(String(lane.lifecyclePhase || "").toLowerCase())) {
    return stoppedReason(lane);
  }
  const raw = clean(lane.nextAction && lane.nextAction !== "none" ? lane.nextAction : lane.lifecyclePhase || "unknown");
  return raw.replace(/_/g, " ");
}

function meaningfulNarrative(lane) {
  const summary = clean(lane.narrative?.summary);
  if (!summary || lane.narrative?.isPlaceholder) return "";
  if (/\busing an MCP tool\b/i.test(summary)) return "Provider tool activity observed";
  return summary;
}

export function coalesceTimeline(events, limit = 5) {
  const output = [];
  for (const event of events || []) {
    const rawSummary = clean(event.summary);
    if (!rawSummary) continue;
    // Provider adapters may emit the same low-information tool-use heartbeat many times.
    // Collapse those observations without implying which tool ran or that progress completed.
    const summary = /\busing an MCP tool\b/i.test(rawSummary) ? "Provider tool activity" : rawSummary;
    const key = `${clean(event.type)}\0${clean(event.agent)}\0${summary}`;
    const previous = output.at(-1);
    if (previous?.key === key) {
      previous.count += 1;
      previous.at = event.at || previous.at;
    } else {
      output.push({ ...event, summary, key, count: 1 });
    }
  }
  return output.slice(-limit).map(({ key, ...event }) => event);
}

function paneLine(text = "", code = null, meta = {}) {
  return { text: String(text ?? "").replace(/[\r\n\t]+/g, " ").trimEnd(), code, ...meta };
}

function paneSection(label, count, category) {
  return paneLine(`${label}${Number.isFinite(count) ? ` ${count}` : ""}`, CATEGORY_STYLE[category] || "1");
}

export function missionControlRepositories(snapshot, { includeAll = true } = {}) {
  const lanes = snapshot.operatorLanes || snapshot.lanes || [];
  const repositories = [...new Set(lanes.map((lane) => lane.repository).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return includeAll && repositories.length ? [null, ...repositories] : repositories;
}

export function missionControlVisibleLanes(snapshot, selectedRepository = null) {
  const lanes = snapshot.operatorLanes || snapshot.lanes || [];
  return selectedRepository ? lanes.filter((lane) => lane.repository === selectedRepository) : lanes;
}

function repositoryPane(snapshot, lanes, repositories, selectedRepository) {
  const summaries = new Map();
  for (const lane of lanes) {
    const summary = summaries.get(lane.repository) || { active: 0, needs_user: 0, waiting: 0, stopped: 0 };
    summary[lane.operatorCategory] = (summary[lane.operatorCategory] || 0) + 1;
    summaries.set(lane.repository, summary);
  }
  const rows = [];
  for (const repository of repositories) {
    if (repository === null) {
      const selected = selectedRepository === null;
      rows.push(paneLine(`${selected ? "▶" : " "} All repositories  ${lanes.length}`, selected ? "7" : "36;1", { selected }));
      continue;
    }
    const counts = summaries.get(repository) || {};
    const active = counts.active || 0;
    const needs = counts.needs_user || 0;
    const stopped = counts.stopped || 0;
    const badge = needs ? `!${needs}` : stopped ? `■${stopped}` : String(active);
    const selected = repository === selectedRepository;
    rows.push(paneLine(`${selected ? "▶" : " "} ${repository.split("/").at(-1)}  ${badge}`, selected ? "7" : needs ? CATEGORY_STYLE.needs_user : stopped ? CATEGORY_STYLE.stopped : active ? CATEGORY_STYLE.active : null, { selected }));
  }
  if (!rows.length) rows.push(paneLine("No active repositories", "90"));
  rows.push(paneLine(""));
  rows.push(paneSection("NEEDS YOU", snapshot.operatorCounts?.needs_user || 0, "needs_user"));
  rows.push(paneSection("WAITING", snapshot.operatorCounts?.waiting || 0, "waiting"));
  rows.push(paneSection("STOPPED", snapshot.operatorCounts?.stopped ?? snapshot.operatorCounts?.failed ?? 0, "stopped"));
  if (snapshot.historicalNeedsUserCount) rows.push(paneLine(`HISTORICAL INPUT ${snapshot.historicalNeedsUserCount}`, "90"));
  if (snapshot.collapsedStale?.total) rows.push(paneLine(`STALE HIDDEN ${snapshot.collapsedStale.total} · press s`, "90"));
  return rows;
}

function workPane(lanes, selectedIndex, now) {
  if (!lanes.length) return [paneLine("No work is running", "90"), paneLine("Press a for attention or h for history", "90")];
  const rows = [];
  let category = null;
  lanes.forEach((lane, index) => {
    if (lane.operatorCategory !== category) {
      if (rows.length) rows.push(paneLine(""));
      category = lane.operatorCategory;
      const count = lanes.filter((candidate) => candidate.operatorCategory === category).length;
      rows.push(paneSection(categoryLabel(category), count, category));
    }
    const provider = lane.providers?.join("+") || lane.activeAgent || lane.writer || "unassigned";
    const related = lane.relatedLaneCount > 1 ? ` +${lane.relatedLaneCount - 1}` : "";
    const marker = index === selectedIndex ? "▶" : " ";
    const text = `${marker} ${laneLabel(lane)}  ${provider}  ${friendlyPhase(lane)}  ${age(lane.updatedAt, now)}${related}`;
    rows.push(paneLine(text, index === selectedIndex ? "7" : CATEGORY_STYLE[category], { selected: index === selectedIndex }));
  });
  return rows;
}

function detailPane(lane, timeline, width, now, snapshot, expanded = false) {
  if (!lane) {
    const rows = [paneLine("No lane selected", "90")];
    if (snapshot.recentActivity?.length) {
      rows.push(paneLine(""), paneLine("RECENT ACTIVITY", "1"), paneLine("Coordinator may be between lanes", "90"));
      for (const recent of snapshot.recentActivity.slice(0, 4)) {
        rows.push(paneLine(`${recent.repository.split("/").at(-1)} · ${recent.lifecyclePhase} · ${age(recent.updatedAt, now)} ago`, "90"));
      }
    }
    if (snapshot.historicalNeedsUserCount) {
      rows.push(
        paneLine(""),
        paneLine(`${snapshot.historicalNeedsUserCount} historical input request${snapshot.historicalNeedsUserCount === 1 ? "" : "s"}`, "90"),
        paneLine("No alert will be sent", "90"),
      );
    }
    return rows;
  }
  const category = lane.operatorCategory || operatorLaneCategory(lane, now) || "history";
  const provider = lane.providers?.join(", ") || lane.activeAgent || lane.writer || "unassigned";
  const deliveryStatus = portfolioTerminalStatus(lane);
  const rows = [
    paneLine(`${laneLabel(lane)} · ${provider}`, "1"),
    paneLine(`${categoryLabel(category)} · ${friendlyPhase(lane)} · ${age(lane.updatedAt, now)} ago`, CATEGORY_STYLE[category]),
  ];
  if (deliveryStatus) {
    rows.push(paneLine(""), paneLine(`DELIVERY  ${lane.prNumber ? `PR #${lane.prNumber} ` : ""}${deliveryStatus}`, "32;1"));
    const attemptReasons = [...new Set((lane.relatedAttempts || []).map((attempt) => attempt.reason).filter(Boolean))];
    if (attemptReasons.length) {
      rows.push(paneLine(`ATTEMPT  stopped · ${attemptReasons.join(", ")}`, "90"));
    }
  }
  const objective = deliveryStatus ? lane.portfolio?.summary || lane.task || lane.narrative?.summary : lane.task || lane.narrative?.summary;
  if (objective) {
    rows.push(paneLine(""), paneLine("OBJECTIVE", "1"));
    rows.push(...wrap(objective, width).slice(0, expanded ? 10 : 3).map((line) => paneLine(line)));
  }
  const narrative = meaningfulNarrative(lane);
  if (narrative && narrative !== clean(objective)) {
    rows.push(paneLine(""), paneLine("NOW", "36;1"));
    rows.push(...wrap(narrative, width).slice(0, 3).map((line) => paneLine(line)));
  }
  const summaryIsStale = lane.heartbeat?.heartbeatAt && lane.narrative?.updatedAt
    && dateMs(lane.narrative.updatedAt) < dateMs(lane.heartbeat.heartbeatAt) - 60_000;
  if (summaryIsStale) rows.push(paneLine("SUMMARY STALE · process heartbeat remains live", "33;1"));
  const github = [lane.issueNumber && `issue #${lane.issueNumber}`, lane.prNumber && `PR #${lane.prNumber}`, lane.branch, lane.headSha && lane.headSha.slice(0, 10)].filter(Boolean).join(" · ");
  if (github) rows.push(paneLine(""), paneLine(`GITHUB  ${github}`, "35"));
  if (!deliveryStatus && lane.nextAction && lane.nextAction !== "none") rows.push(paneLine(`NEXT  ${friendlyPhase(lane)}`, "33"));
  const blocker = lane.blocker?.error || lane.blocker?.pendingDecision?.question || lane.blocker?.decisionEscalation?.question;
  if (blocker) rows.push(...wrap(`BLOCKED  ${blocker}`, width).slice(0, 2).map((line) => paneLine(line, "31;1")));
  if (lane.portfolio?.blockedBy?.length) rows.push(paneLine(`WAITING ON  ${lane.portfolio.blockedBy.join(", ")}`, "33"));
  if (expanded) {
    rows.push(paneLine(""), paneLine("DETAILS", "1"));
    rows.push(paneLine(`ID  ${lane.id}`, "90"));
    if (lane.workspace) rows.push(paneLine(`WORKSPACE  ${lane.workspace}`, "90"));
    if (lane.model) rows.push(paneLine(`MODEL  ${lane.model}`, "90"));
    rows.push(paneLine(`CREATED  ${formatLocalDateTime(lane.createdAt)}`, "90"));
    rows.push(paneLine(`UPDATED  ${formatLocalDateTime(lane.updatedAt)}`, "90"));
    const timing = performanceLine(lane.performanceSummary);
    if (timing) rows.push(paneLine(timing, "90"));
    const activity = lane.type === "native_host" ? lane.hostActivity?.activity : lane.activity;
    if (activity) {
      const count = activity.progressEventCount ?? activity.toolEventCount ?? 0;
      const lastActivityAt = activity.lastOutputAt || activity.lastToolAt || activity.lastProgressAt;
      rows.push(paneLine(`ACTIVITY  ${count} events · ${Number(activity.outputBytes || 0)} bytes${lastActivityAt ? ` · ${age(lastActivityAt, now)} ago` : ""}`, "90"));
    }
  }
  const events = coalesceTimeline(timeline, 4);
  if (events.length) {
    rows.push(paneLine(""), paneLine("RECENT ACTIVITY", "1"));
    for (const event of events) {
      const repeated = event.count > 1 ? ` ×${event.count}` : "";
      rows.push(paneLine(`${formatLocalDateTime(event.at).slice(11, 19)}  ${event.summary}${repeated}`, "90"));
    }
  }
  return rows;
}

function borderLine(widths, left, join, right, color) {
  return paint(`${left}${widths.map((width) => "─".repeat(width)).join(join)}${right}`, "90", color);
}

function renderGrid({ titles, panes, widths, contentRows, color, activePane = 0 }) {
  const lines = [borderLine(widths, "┌", "┬", "┐", color)];
  lines.push(`${paint("│", "90", color)}${titles.map((title, index) => paint(pad(` ${title}`, widths[index]), index === activePane ? "1;36" : "1", color)).join(paint("│", "90", color))}${paint("│", "90", color)}`);
  lines.push(borderLine(widths, "├", "┼", "┤", color));
  for (let row = 0; row < contentRows; row += 1) {
    const cells = panes.map((pane, index) => {
      const entry = pane[row] || paneLine("");
      const fitted = pad(` ${entry.text}`, widths[index]);
      return entry.code ? paint(fitted, entry.code, color) : fitted;
    });
    lines.push(`${paint("│", "90", color)}${cells.join(paint("│", "90", color))}${paint("│", "90", color)}`);
  }
  lines.push(borderLine(widths, "└", "┴", "┘", color));
  return lines;
}

export function windowPane(rows, contentRows, centerSelection = false, offset = null) {
  if (contentRows <= 0) return [];
  if (contentRows < 3 && rows.length > contentRows) {
    const visible = contentRows === 1
      ? [paneLine(`${rows.length} rows · expand terminal`, "90")]
      : [rows[0], paneLine(`↓ ${rows.length - 1} more`, "90")];
    Object.defineProperty(visible, "appliedOffset", { value: 0 });
    return visible;
  }
  if (rows.length <= contentRows) {
    const visible = [...rows];
    Object.defineProperty(visible, "appliedOffset", { value: 0 });
    return visible;
  }
  const selected = centerSelection ? rows.findIndex((row) => row.selected) : -1;
  let start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const topIndicator = start > 0 ? 1 : 0;
    const provisionalCapacity = Math.max(1, contentRows - topIndicator - 1);
    if (selected >= 0 && !Number.isFinite(offset)) start = Math.max(0, selected - Math.floor(provisionalCapacity / 2));
    const bottomIndicator = start + Math.max(1, contentRows - (start > 0 ? 1 : 0)) < rows.length ? 1 : 0;
    const capacity = Math.max(1, contentRows - (start > 0 ? 1 : 0) - bottomIndicator);
    start = Math.min(start, Math.max(0, rows.length - capacity));
  }
  const topIndicator = start > 0 ? 1 : 0;
  let capacity = Math.max(1, contentRows - topIndicator);
  let bottomIndicator = start + capacity < rows.length ? 1 : 0;
  capacity = Math.max(1, contentRows - topIndicator - bottomIndicator);
  const visible = rows.slice(start, start + capacity);
  if (topIndicator) visible.unshift(paneLine(`↑ ${start} earlier`, "90"));
  const remaining = rows.length - (start + capacity);
  if (remaining > 0) visible.push(paneLine(`↓ ${remaining} more`, "90"));
  Object.defineProperty(visible, "appliedOffset", { value: start });
  return visible;
}

function gridMeasurements(width, activePane) {
  if (width >= 84) {
    const interior = width - 4;
    const repositoryWidth = Math.max(18, Math.min(28, Math.floor(interior * 0.22)));
    const workWidth = Math.max(32, Math.min(52, Math.floor(interior * 0.38)));
    const detailWidth = interior - repositoryWidth - workWidth;
    return { paneIndex: null, widths: [repositoryWidth, workWidth, detailWidth] };
  }
  const paneIndex = Math.min(Math.max(0, activePane), 2);
  return { paneIndex, widths: [Math.max(1, width - 2)] };
}

function gridLayout(measurements, activePane, titles, panes, contentRows, color) {
  if (measurements.paneIndex === null) {
    return renderGrid({ titles, panes, widths: measurements.widths, contentRows, color, activePane });
  }
  const paneIndex = measurements.paneIndex;
  return renderGrid({ titles: [titles[paneIndex]], panes: [panes[paneIndex]], widths: measurements.widths, contentRows, color, activePane: 0 });
}

export function renderMissionControl(snapshot, {
  selectedIndex = 0,
  timeline = [],
  width = 120,
  height = 40,
  color = true,
  interactive = true,
  actionMessage = null,
  activePane = 1,
  detailExpanded = false,
  detailOffset = 0,
  selectedRepository = null,
  repositoryLocked = false,
  viewportState = null,
  now = Date.now(),
} = {}) {
  const usableWidth = Math.max(30, width);
  const allLanes = snapshot.operatorLanes || snapshot.lanes.map((lane) => ({ ...lane, operatorCategory: operatorLaneCategory(lane, now) || "history", providers: [lane.activeAgent || lane.writer].filter(Boolean), relatedLaneCount: 1 }));
  const repositories = missionControlRepositories({ ...snapshot, operatorLanes: allLanes }, { includeAll: !repositoryLocked });
  const effectiveRepository = repositories.includes(selectedRepository) ? selectedRepository : repositories[0] ?? null;
  const lanes = missionControlVisibleLanes({ ...snapshot, operatorLanes: allLanes }, effectiveRepository);
  const effectiveSelectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, lanes.length - 1));
  const selected = lanes[effectiveSelectedIndex] || null;
  const lines = [];
  const counts = snapshot.operatorCounts || { active: lanes.filter((lane) => lane.operatorCategory === "active").length, needs_user: snapshot.needsUserCount || 0, waiting: 0, stopped: 0, failed: 0 };
  const stoppedCount = counts.stopped ?? counts.failed ?? 0;
  const repositoryCount = new Set(allLanes.map((lane) => lane.repository)).size;
  const headline = `${paint("AGENT BRIDGE MISSION CONTROL", "1;34", color)}  ${paint(`ACTIVE ${counts.active || 0}`, "36;1", color)}  ${paint(`NEEDS YOU ${counts.needs_user || 0}`, counts.needs_user ? "33;1" : "90", color)}  ${paint(`WAITING ${counts.waiting || 0}`, "90", color)}  ${paint(`STOPPED ${stoppedCount}`, stoppedCount ? "31;1" : "90", color)}`;
  lines.push(truncateAnsi(headline, usableWidth));
  lines.push(truncate(`${formatLocalDateTime(snapshot.generatedAt)} · ${snapshot.mode} · ${repositoryCount} repo${repositoryCount === 1 ? "" : "s"}${snapshot.filter ? ` · ${snapshot.filter}` : ""}`, usableWidth));
  const footerRows = interactive ? (actionMessage ? 2 : 1) : snapshot.mode === "all" ? 1 : 0;
  const contentRows = Math.max(4, height - lines.length - footerRows - 4);
  const titles = ["REPOSITORIES", "WORK", "SELECTED LANE"];
  const measurements = gridMeasurements(usableWidth, activePane);
  const detailWidth = measurements.paneIndex === null
    ? measurements.widths[2] - 2
    : measurements.paneIndex === 2 ? measurements.widths[0] - 2 : Math.max(20, Math.floor(usableWidth * 0.35));
  const panes = [
    windowPane(repositoryPane(snapshot, allLanes, repositories, effectiveRepository), contentRows, true),
    windowPane(workPane(lanes, effectiveSelectedIndex, now), contentRows, true),
    windowPane(detailPane(selected, timeline, Math.max(1, detailWidth), now, snapshot, detailExpanded), contentRows, false, detailOffset),
  ];
  if (viewportState && typeof viewportState === "object") viewportState.detailOffset = panes[2].appliedOffset || 0;
  lines.push(...gridLayout(measurements, activePane, titles, panes, contentRows, color));
  if (interactive) {
    if (actionMessage) lines.push(truncateAnsi(paint(` ${actionMessage}`, actionMessage.toLowerCase().includes("failed") ? "31;1" : "33", color), usableWidth));
    const paneHelp = activePane === 0
      ? "REPOSITORIES · j/k choose · Enter work"
      : activePane === 1
        ? "WORK · j/k choose lane · Enter details"
        : `DETAILS · j/k scroll · g/G ends · Enter ${detailExpanded ? "collapse" : "expand"}`;
    lines.push(sliceDisplay(` ${paneHelp}  Tab/⇧Tab/←/→ pane  l/a/h view  o PR  c continue  x cancel  q quit`, usableWidth, { cleanValue: false }));
  } else if (snapshot.mode === "all") {
    lines.push(truncate("Archive preview: bridge cleanup --older-than-days 7", usableWidth));
  }
  return lines.slice(0, Math.max(1, height)).map((line) => truncateAnsi(line, usableWidth)).join("\n");
}

function truncateAnsi(value, width) {
  if (displayWidth(value) <= width) return value;
  if (!value.includes("\x1b[")) return truncate(value, width);
  const plain = stripAnsi(value);
  return truncate(plain, width);
}

export function renderSnapshot(snapshot, options = {}) {
  return renderMissionControl(snapshot, { ...options, color: false, interactive: false, height: options.height || 40 });
}

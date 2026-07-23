import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { queryControlPlane } from "./collaboration-store.mjs";
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
export const stripAnsi = (value) => String(value || "").replace(ANSI_PATTERN, "");

export function navigationIntent(key, selectedIndex) {
  if (key === "j" || key === "\x1b[B") return { selectedIndex: selectedIndex + 1, preserveSelectedId: false };
  if (key === "k" || key === "\x1b[A") return { selectedIndex: selectedIndex - 1, preserveSelectedId: false };
  if (key === "g") return { selectedIndex: 0, preserveSelectedId: false };
  if (key === "G") return { selectedIndex: Number.MAX_SAFE_INTEGER, preserveSelectedId: false };
  return { selectedIndex, preserveSelectedId: true };
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
  if (TERMINAL_STATUSES.has(status)) return false;
  if (ACTIVE_STATUSES.has(status)) return true;
  if (["needs_user", "indeterminate", "blocked"].includes(status)) return true;
  if (["failed", "budget"].includes(status)) return now - dateMs(lane.updatedAt) <= 86_400_000;
  if (lane.handoff && !lane.handoff.acknowledged) return true;
  if (lane.coordinatorWake && !lane.coordinatorWake.acknowledged) return true;
  return false;
}

export function isLiveLane(lane, now = Date.now(), heartbeatAfterMs = DEFAULT_LIVE_HEARTBEAT_AFTER_MS) {
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
  if (wake?.status === "acknowledged") return false;
  const lifecycle = String(lane.status || lane.lifecyclePhase || "").toLowerCase();
  return lifecycle === "needs_user"
    || wake?.kind === "needs_user"
    || wake?.nextAction === "needs_user";
}

export function isStaleLane(lane, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  if (isLiveLane(lane, now) || String(lane.lifecyclePhase || "").toLowerCase() === "indeterminate") return false;
  const updatedAt = dateMs(lane.updatedAt);
  if (!updatedAt || now - updatedAt < staleAfterMs) return false;
  const status = String(lane.lifecyclePhase || "unknown").toLowerCase();
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
  const needsUser = matching.filter((lane) => laneNeedsUser(lane));
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
    .filter((lane) => {
      const updatedAt = dateMs(lane.updatedAt);
      return updatedAt > 0 && now - updatedAt <= DEFAULT_RECENT_ACTIVITY_AFTER_MS;
    })
    .sort((left, right) => dateMs(right.updatedAt) - dateMs(left.updatedAt))
    .slice(0, 3)
    .map((lane) => ({
      id: lane.id,
      repository: lane.repository,
      lifecyclePhase: lane.lifecyclePhase,
      activeAgent: lane.activeAgent || lane.writer || null,
      summary: lane.narrative?.summary || lane.task || null,
      updatedAt: lane.updatedAt,
      nextAction: lane.nextAction || null,
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
    needsUserCount: needsUser.length,
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

function truncate(value, width) {
  const text = clean(value);
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function wrap(value, width, prefix = "") {
  const words = clean(value).split(" ").filter(Boolean);
  if (!words.length) return [];
  const contentWidth = Math.max(8, width - prefix.length);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= contentWidth) current += ` ${word}`;
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

function statusSymbol(status) {
  const value = String(status || "unknown").toLowerCase();
  if (ATTENTION_STATUSES.has(value)) return "!";
  if (ACTIVE_STATUSES.has(value)) return "*";
  if (["agreed", "completed", "merged"].includes(value)) return "+";
  if (value === "cancelled") return "-";
  return ".";
}

function paint(text, code, enabled) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function statusText(status, enabled) {
  const value = String(status || "unknown");
  const lower = value.toLowerCase();
  const code = ATTENTION_STATUSES.has(lower) ? "31;1" : ACTIVE_STATUSES.has(lower) ? "36;1" : ["agreed", "completed", "merged"].includes(lower) ? "32" : "90";
  return paint(value, code, enabled);
}

function field(label, value, width) {
  if (value === null || value === undefined || value === "") return [];
  return wrap(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`, width);
}

export function renderMissionControl(snapshot, {
  selectedIndex = 0,
  timeline = [],
  width = 120,
  height = 40,
  color = true,
  interactive = true,
  now = Date.now(),
} = {}) {
  const usableWidth = Math.max(30, width);
  const lanes = snapshot.lanes;
  const selected = lanes[Math.min(Math.max(0, selectedIndex), Math.max(0, lanes.length - 1))] || null;
  const lines = [];
  const providerLine = Object.entries(snapshot.providerActivity).map(([provider, count]) => `${provider}:${count}`).join("  ") || "idle";
  lines.push(paint("AGENT BRIDGE MISSION CONTROL", "1;34", color));
  lines.push(truncate(`Mode: ${snapshot.mode} | repos ${snapshot.visibleRepositories ?? snapshot.repositories.length} | lanes ${snapshot.visibleLanes}/${snapshot.totalLanes} | providers ${providerLine}`, usableWidth));
  if (snapshot.needsUserCount > 0) {
    lines.push(paint(`!!! USER INPUT REQUIRED: ${snapshot.needsUserCount} collaboration${snapshot.needsUserCount === 1 ? "" : "s"}. Press a to inspect.`, "31;1", color));
  }
  lines.push(paint("─".repeat(usableWidth), "90", color));

  if (!lanes.length) {
    lines.push("No collaboration lanes match this view.");
    if (snapshot.mode === "live") {
      lines.push("No providers are currently running.");
      if (snapshot.recentActivity?.length) {
        lines.push("Recent activity (the coordinator may be between lanes):");
        for (const recent of snapshot.recentActivity) {
          const provider = recent.activeAgent ? ` · ${recent.activeAgent}` : "";
          const next = recent.nextAction && recent.nextAction !== "none" ? ` · next ${recent.nextAction}` : "";
          lines.push(truncate(`  ${recent.repository} · ${recent.lifecyclePhase}${provider} · ${age(recent.updatedAt, now)} ago${next}`, usableWidth));
          if (recent.summary) lines.push(truncate(`    ${recent.summary}`, usableWidth));
        }
      }
      lines.push("Press a for attention items or h for history.");
    } else {
      lines.push("Try a different view or --repo filter.");
    }
  } else {
    const listBudget = interactive
      ? Math.max(4, Math.min(12, Math.floor(height * 0.3)))
      : Math.min(50, lanes.length);
    const start = interactive
      ? Math.max(0, Math.min(selectedIndex - Math.floor(listBudget / 2), lanes.length - listBudget))
      : 0;
    let lastRepository = null;
    for (let index = start; index < Math.min(lanes.length, start + listBudget); index += 1) {
      const lane = lanes[index];
      if (lane.repository !== lastRepository) {
        const repo = snapshot.repositories.find((entry) => entry.repository === lane.repository);
        lines.push(paint(`[${lane.repository}] ${repo?.live || 0} live / ${repo?.attention || 0} attention / ${repo?.total || 0} total`, "1;35", color));
        lastRepository = lane.repository;
      }
      const cursor = index === selectedIndex ? ">" : " ";
      const provider = lane.activeAgent || lane.writer || "unassigned";
      const label = lane.issueNumber ? `#${lane.issueNumber}` : lane.id.replace(/^bridge-/, "").slice(0, 8);
      const raw = `${cursor} ${statusSymbol(lane.lifecyclePhase)} ${label} ${lane.lifecyclePhase} ${provider} - ${lane.task || lane.narrative?.summary || "untitled lane"}`;
      lines.push(index === selectedIndex ? paint(truncate(raw, usableWidth), "7", color) : truncate(raw, usableWidth));
    }
    if (!interactive && lanes.length > listBudget) {
      lines.push(`… ${lanes.length - listBudget} more lanes; use --json for complete records`);
    }
  }

  if (snapshot.collapsedStale?.total) {
    const collapsed = snapshot.collapsedStale;
    lines.push(paint("─".repeat(usableWidth), "90", color));
    lines.push(truncate(`Collapsed ${collapsed.total} stale attention items (${collapsed.portfolioItems} portfolio items across ${collapsed.portfolios} portfolios). Press s or use --include-stale to inspect them.`, usableWidth));
  }

  if (selected) {
    lines.push(paint("─".repeat(usableWidth), "90", color));
    lines.push(`${statusText(selected.lifecyclePhase, color)}  ${paint(selected.repository, "1", color)}  ${selected.id}`);
    lines.push(...field("Workspace", selected.workspace, usableWidth));
    lines.push(...field("Task", selected.task, usableWidth));
    const role = [selected.type === "native_host" && "native host", selected.activeAgent && `active ${selected.activeAgent}`, selected.writer && `writer ${selected.writer}`, selected.model && `model ${selected.model}`].filter(Boolean).join(" | ");
    lines.push(...field("Agent", role, usableWidth));
    if (selected.narrative?.summary) {
      const stale = selected.heartbeat?.heartbeatAt && selected.narrative.updatedAt && dateMs(selected.narrative.updatedAt) < dateMs(selected.heartbeat.heartbeatAt) - 60_000;
      const source = selected.narrative.isPlaceholder ? "broker placeholder" : selected.narrative.source || "provider";
      lines.push(...wrap(`Narrative (${source}, ${age(selected.narrative.updatedAt, now)} old${stale ? ", stale while heartbeat remains live" : ""}): ${selected.narrative.summary}`, usableWidth));
    }
    if (selected.heartbeat?.heartbeatAt) lines.push(`Heartbeat: ${age(selected.heartbeat.heartbeatAt, now)} ago`);
    const github = [selected.issueNumber && `issue #${selected.issueNumber}`, selected.prNumber && `PR #${selected.prNumber}`, selected.branch, selected.headSha && selected.headSha.slice(0, 12)].filter(Boolean).join(" | ");
    lines.push(...field("GitHub", github, usableWidth));
    if (selected.portfolio) {
      const portfolio = `${selected.portfolio.portfolioId} / ${selected.portfolio.itemId}${selected.portfolio.blockedBy?.length ? ` | blocked by ${selected.portfolio.blockedBy.join(", ")}` : ""}`;
      lines.push(...field("Portfolio", portfolio, usableWidth));
    }
    const blocker = selected.blocker?.error || selected.blocker?.pendingDecision?.question || selected.blocker?.decisionEscalation?.question;
    lines.push(...field("Blocker", blocker, usableWidth));
    if (selected.handoff) lines.push(...field("Handoff", `${selected.handoff.outcome || "recorded"} | ${selected.handoff.acknowledged ? "acknowledged" : "awaiting coordinator"} | next ${selected.handoff.nextAction || selected.nextAction}`, usableWidth));
    lines.push(...field("Next", selected.nextAction, usableWidth));
    const timing = performanceLine(selected.performanceSummary);
    if (timing) lines.push(truncate(timing, usableWidth));
    if (timeline.length) {
      lines.push(paint("Timeline", "1;34", color));
      for (const event of timeline.slice(-5)) {
        const at = event.at ? new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--";
        lines.push(truncate(`  ${at} ${event.type}${event.agent ? ` (${event.agent})` : ""}${event.summary ? ` - ${event.summary}` : ""}`, usableWidth));
      }
    }
  }

  if (interactive) {
    lines.push(paint("─".repeat(usableWidth), "90", color));
    lines.push("j/k or arrows move | l live | a attention | h history | s stale | r refresh | q quit");
  }
  return lines.slice(0, Math.max(1, height)).map((line) => truncateAnsi(line, usableWidth)).join("\n");
}

function truncateAnsi(value, width) {
  if (stripAnsi(value).length <= width) return value;
  if (!value.includes("\x1b[")) return truncate(value, width);
  const plain = stripAnsi(value);
  return truncate(plain, width);
}

export function renderSnapshot(snapshot, options = {}) {
  return renderMissionControl(snapshot, { ...options, color: false, interactive: false, height: options.height || 200 });
}

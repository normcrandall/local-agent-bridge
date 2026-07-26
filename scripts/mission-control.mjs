#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { writeSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  clearRepositoryCache,
  deduplicateOperatorLanes,
  loadMissionControlSnapshot,
  loadTimeline,
  missionControlRepositories,
  missionControlVisibleLanes,
  navigationIntent,
  newlyObservedAttentionKeys,
  paneFocusIntent,
  renderMissionControl,
  renderSnapshot,
} from "../src/mission-control.mjs";
import {
  missionControlActionAvailability,
  missionControlConfirmation,
  missionControlCopyText,
  createMissionControlPaneLayout,
  missionControlPaneLayoutIntent,
  missionControlPlatformCommands,
  missionControlPrUrl,
  missionControlShouldRedraw,
  resolveMissionControlSelection,
  runClipboardCopy,
} from "../src/mission-control-actions.mjs";
import {
  callMissionControlAction,
  createMissionControlSubscriptionClient,
} from "../src/mission-control-client.mjs";
import { createProviderQuotaMonitor } from "../src/provider-quota.mjs";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

function usage() {
  process.stdout.write(`Usage: bridge mission-control [options]\n\n`);
  process.stdout.write(`Aliases: bridge mc\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --snapshot          Print one human-readable snapshot and exit\n`);
  process.stdout.write(`  --json              Print one JSON snapshot and exit\n`);
  process.stdout.write(`  --attention         Show current attention items\n`);
  process.stdout.write(`  --all               Show active terminal history\n`);
  process.stdout.write(`  --include-stale     Include stale attention and portfolio items\n`);
  process.stdout.write(`  --stale-after-hours N  Collapse attention items older than N hours (default: 24)\n`);
  process.stdout.write(`  --repo OWNER/REPO   Filter to one repository\n`);
  process.stdout.write(`  --refresh-ms N      Maximum idle redraw interval (minimum/default: 60000)\n`);
  process.stdout.write(`  --state-root PATH   Read a different bridge state directory\n`);
  process.stdout.write(`  --no-color          Disable ANSI colors\n`);
  process.stdout.write(`  --quota             Include a synchronous quota reading in one-shot output\n`);
  process.stdout.write(`  --no-quota          Disable provider quota probes and footer\n`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const stateRoot = resolve(value("--state-root", process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state")));
const repositoryFilter = value("--repo");
const refreshMs = Math.max(60_000, Number.parseInt(value("--refresh-ms", "60000"), 10) || 60_000);
let view = args.includes("--all") ? "all" : args.includes("--attention") ? "attention" : "live";
let includeStale = args.includes("--include-stale");
const staleAfterHours = Math.max(1, Number.parseInt(value("--stale-after-hours", "24"), 10) || 24);
const color = !args.includes("--no-color") && process.env.NO_COLOR === undefined;
const oneShot = args.includes("--snapshot") || args.includes("--json") || !process.stdin.isTTY || !process.stdout.isTTY;
const quotaEnabled = !args.includes("--no-quota")
  && process.env.AGENT_BRIDGE_PROVIDER_QUOTA !== "off"
  && (!oneShot || args.includes("--quota"));
const providerQuotaMonitor = createProviderQuotaMonitor();

async function snapshot() {
  const current = await loadMissionControlSnapshot({
    stateRoot,
    view,
    includeStale,
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
    repositoryFilter,
  });
  current.providerQuota = quotaEnabled ? await providerQuotaMonitor.snapshot({ waitForRefresh: oneShot }) : null;
  return current;
}

if (oneShot) {
  const current = await snapshot();
  let output;
  if (args.includes("--json")) {
    output = `${JSON.stringify(current, null, 2)}\n`;
  } else {
    const selected = (current.operatorLanes || current.lanes)[0];
    const timeline = selected ? await loadTimeline(stateRoot, selected.id) : [];
    const parsedWidth = Number.parseInt(process.env.COLUMNS || "120", 10);
    const parsedHeight = Number.parseInt(process.env.LINES || "60", 10);
    output = `${renderSnapshot(current, {
      selectedIndex: 0,
      timeline,
      width: Number.isFinite(parsedWidth) ? parsedWidth : 120,
      height: Number.isFinite(parsedHeight) ? Math.max(20, parsedHeight) : 60,
      detailExpanded: true,
    })}\n`;
  }
  await new Promise((resolveWrite) => process.stdout.write(output, resolveWrite));
  process.exit(0);
}

let selectedIndex = 0;
let selectedId = null;
let drawing = false;
let redrawPending = false;
let stopped = false;
let promptOpen = false;
let timer = null;
let restorePromise = null;
let terminalRestored = false;
let lastSnapshot = null;
let lastViewModel = null;
let subscriptionClient = null;
let actionMessage = null;
let pendingConfirmation = null;
let activePane = 1;
let detailExpanded = false;
let detailOffset = 0;
let paneLayout = createMissionControlPaneLayout();
let selectedTab = view === "attention" ? "needsYou" : view === "all" ? "history" : "active";
let selectedRepository = repositoryFilter || null;
const seenAttentionKeys = new Set();
let resolveExit;
const exitRequested = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
const restoreSequence = "\x1b[?25h\x1b[?1049l";

function restore() {
  if (restorePromise) return restorePromise;
  stopped = true;
  subscriptionClient?.stop();
  providerQuotaMonitor.stop();
  if (timer) clearInterval(timer);
  timer = null;
  process.stdout.off("resize", handleResize);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  restorePromise = new Promise((resolveRestore) => {
    process.stdout.write(restoreSequence, () => {
      terminalRestored = true;
      resolveRestore();
    });
  });
  return restorePromise;
}

function restoreSynchronously() {
  if (terminalRestored) return;
  try { process.stdin.setRawMode?.(false); } catch {}
  try { writeSync(process.stdout.fd, restoreSequence); } catch {}
  terminalRestored = true;
}

function startRefreshTimer() {
  if (stopped || timer) return;
  timer = setInterval(draw, refreshMs);
  timer.unref();
}

function pauseRefreshTimer() {
  const shouldResume = Boolean(timer) && !stopped;
  if (timer) clearInterval(timer);
  timer = null;
  return shouldResume;
}

function handleResize() {
  if (!missionControlShouldRedraw({ promptOpen, stopped })) return;
  void draw();
}

async function promptLine(label) {
  const shouldResumeRefresh = pauseRefreshTimer();
  promptOpen = true;
  process.stdin.off("data", handleKey);
  process.stdin.setRawMode(false);
  process.stdout.write(`\x1b[?25h\x1b[H\x1b[2J${label}\n`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question("> ")).trim();
  } finally {
    readline.close();
    promptOpen = false;
    process.stdin.setRawMode(true);
    process.stdin.on("data", handleKey);
    process.stdout.write("\x1b[?25l");
    if (shouldResumeRefresh) startRefreshTimer();
  }
}

function openExternalUrl(url, laneId) {
  const candidates = missionControlPlatformCommands().open;
  const attempt = (index) => {
    const candidate = candidates[index];
    if (!candidate) {
      if (selectedId !== laneId) return;
      actionMessage = `Open failed: no supported URL opener is installed. Copy the PR URL with y instead.`;
      void draw();
      return;
    }
    execFile(candidate.command, [...candidate.args, url], (error) => {
      if (error?.code === "ENOENT") return attempt(index + 1);
      if (selectedId !== laneId) return;
      actionMessage = error ? `Open failed: ${error.message}` : `Opened ${url}`;
      void draw();
    });
  };
  attempt(0);
}

function copySelection(lane) {
  return runClipboardCopy(missionControlCopyText(lane), {
    commands: missionControlPlatformCommands().copy,
    run: (candidate, input) => spawnSync(candidate.command, candidate.args, { input, encoding: "utf8" }),
  }).copied;
}

async function shutdown(code) {
  if (stopped) return;
  await restore();
  process.exitCode = code;
  resolveExit();
}

function subscriptionSnapshot(viewModel) {
  const categorized = [
    ["active", "active"],
    ["needsYou", "needs_user"],
    ["queue", "waiting"],
    ["history", "stopped"],
  ];
  const all = new Map();
  for (const [collection, operatorCategory] of categorized) {
    for (const lane of viewModel.collections?.[collection] || []) {
      const key = lane.key || `${lane.repository}\0${lane.id}`;
      if (!all.has(key)) all.set(key, { ...lane, operatorCategory });
    }
  }
  const matching = [...all.values()].filter((lane) => !repositoryFilter || lane.repository === repositoryFilter);
  const liveRepositories = new Set(matching
    .filter((lane) => lane.operatorCategory === "active")
    .map((lane) => lane.repository));
  const liveSource = matching.filter((lane) => {
    if (["active", "needs_user"].includes(lane.operatorCategory)) return true;
    return lane.operatorCategory === "waiting"
      && (liveRepositories.size === 0 || liveRepositories.has(lane.repository));
  });
  const selectedCollection = viewModel.collections?.[selectedTab] || [];
  const selectedKeys = new Set(selectedCollection.map((lane) => lane.key || `${lane.repository}\0${lane.id}`));
  const modeSource = matching.filter((lane) => selectedKeys.has(lane.key || `${lane.repository}\0${lane.id}`));
  const operatorLanes = deduplicateOperatorLanes(modeSource, {
    includeHistory: view === "all" || (view === "attention" && includeStale),
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
  });
  const counts = {
    active: viewModel.collections?.active?.length || 0,
    needs_user: viewModel.collections?.needsYou?.length || 0,
    waiting: viewModel.collections?.queue?.length || 0,
    stopped: viewModel.collections?.history?.length || 0,
  };
  return {
    generatedAt: viewModel.updatedAt || new Date().toISOString(),
    mode: view,
    selectedTab,
    filter: repositoryFilter,
    lanes: [...all.values()],
    operatorLanes,
    operatorCounts: counts,
    lifecycleCounts: {
      needs_user: counts.needs_user,
      queued: counts.waiting,
      blocked: (viewModel.collections?.queue || []).filter((lane) => lane.status === "blocked").length,
      recovering: (viewModel.collections?.active || []).filter((lane) => lane.status === "recovering").length,
      terminal: counts.stopped,
    },
    needsUserCount: counts.needs_user,
    needsUserKeys: (viewModel.collections?.needsYou || []).map((lane) => lane.key),
    providerQuota: null,
    providerCapacity: {},
    recentActivity: [],
    historicalNeedsUserCount: 0,
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
  };
}

async function draw(currentOverride = null) {
  if (stopped) return;
  if (drawing) {
    redrawPending = true;
    return;
  }
  drawing = true;
  try {
    const current = currentOverride || (lastViewModel ? subscriptionSnapshot(lastViewModel) : null) || lastSnapshot || await snapshot();
    if (quotaEnabled) current.providerQuota = await providerQuotaMonitor.snapshot({ waitForRefresh: false });
    lastSnapshot = current;
    if (stopped) return;
    const newlyObserved = newlyObservedAttentionKeys(seenAttentionKeys, current.needsUserKeys);
    if (newlyObserved.length) {
      process.stdout.write("\x07");
    }
    for (const key of current.needsUserKeys || []) seenAttentionKeys.add(key);
    const repositoryChoices = missionControlRepositories(current, { includeAll: !repositoryFilter });
    if (!repositoryChoices.includes(selectedRepository)) selectedRepository = repositoryChoices[0] ?? null;
    const operatorLanes = missionControlVisibleLanes(current, selectedRepository);
    if (selectedId) {
      const preserved = operatorLanes.findIndex((lane) => lane.id === selectedId);
      if (preserved >= 0) selectedIndex = preserved;
    }
    selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, operatorLanes.length - 1));
    selectedId = operatorLanes[selectedIndex]?.id || null;
    const timeline = selectedId ? await loadTimeline(stateRoot, selectedId) : [];
    if (stopped) return;
    const viewportState = {};
    const output = renderMissionControl(current, {
      selectedIndex,
      timeline,
      width: process.stdout.columns || 120,
      height: process.stdout.rows || 40,
      color,
      interactive: true,
      actionMessage,
      activePane,
      detailExpanded,
      detailOffset,
      paneLayout,
      selectedRepository,
      repositoryLocked: Boolean(repositoryFilter),
      viewportState,
    });
    detailOffset = viewportState.detailOffset || 0;
    if (stopped) return;
    process.stdout.write(`\x1b[H\x1b[2J${output}`);
  } catch (error) {
    if (stopped) return;
    process.stdout.write(`\x1b[H\x1b[2JMission Control refresh failed: ${error.message}\nPress r to retry or q to quit.`);
  } finally {
    drawing = false;
    if (redrawPending && !stopped) {
      redrawPending = false;
      // Always derive a coalesced replay from the newest subscribed model. An
      // override captured while the prior draw was in flight may already be
      // older than a subsequently delivered event batch.
      queueMicrotask(() => { void draw(null); });
    }
  }
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
async function handleKey(key) {
  if (key === "q" || key === "\u0003") {
    await shutdown(0);
    return;
  }
  if (["l", "a", "h"].includes(key)) {
    view = key === "l" ? "live" : key === "a" ? "attention" : "all";
    selectedTab = key === "l" ? "active" : key === "a" ? "needsYou" : "history";
    selectedIndex = 0;
    selectedId = null;
    actionMessage = null;
    pendingConfirmation = null;
    detailOffset = 0;
  }
  else if (/^[1-6]$/u.test(key)) {
    selectedTab = ["active", "needsYou", "queue", "reviews", "mergeTrain", "history"][Number(key) - 1];
    view = selectedTab === "active" ? "live" : selectedTab === "history" ? "all" : "attention";
    selectedIndex = 0;
    selectedId = null;
    detailOffset = 0;
    actionMessage = null;
    pendingConfirmation = null;
  }
  else if (key === "\t" || key === "\x1b[C") {
    activePane = paneFocusIntent(key, activePane);
    actionMessage = null;
  }
  else if (key === "\x1b[Z" || key === "\x1b[D") {
    activePane = paneFocusIntent(key, activePane);
    actionMessage = null;
  }
  else if (key === "\r" || key === "\n") {
    if (activePane === 0) activePane = 1;
    else if (activePane === 1) activePane = 2;
    else {
      detailExpanded = !detailExpanded;
      detailOffset = 0;
    }
    actionMessage = null;
  }
  else if (activePane === 0 && ["j", "k", "\x1b[B", "\x1b[A", "g", "G"].includes(key)) {
    const choices = missionControlRepositories(lastSnapshot || { lanes: [] }, { includeAll: !repositoryFilter });
    const currentIndex = Math.max(0, choices.findIndex((repository) => repository === selectedRepository));
    const intent = navigationIntent(key, currentIndex);
    const nextIndex = Math.min(Math.max(0, intent.selectedIndex), Math.max(0, choices.length - 1));
    selectedRepository = choices[nextIndex] ?? null;
    selectedIndex = 0;
    selectedId = null;
    detailExpanded = false;
    detailOffset = 0;
    actionMessage = null;
    pendingConfirmation = null;
  }
  else if (activePane === 2 && ["j", "k", "\x1b[B", "\x1b[A", "g", "G"].includes(key)) {
    if (key === "j" || key === "\x1b[B") detailOffset += 1;
    else if (key === "k" || key === "\x1b[A") detailOffset = Math.max(0, detailOffset - 1);
    else if (key === "g") detailOffset = 0;
    else detailOffset = Number.MAX_SAFE_INTEGER;
    actionMessage = null;
    pendingConfirmation = null;
  }
  else if (key === "s") {
    if (view !== "attention") view = "attention";
    includeStale = !includeStale;
    selectedIndex = 0;
    selectedId = null;
    actionMessage = null;
    pendingConfirmation = null;
    detailOffset = 0;
  }
  else if (["\\", "+", "=", "-", "_", "z", "d"].includes(key)) {
    paneLayout = missionControlPaneLayoutIntent(paneLayout, key, activePane);
    const paneName = ["repositories", "work", "details"][activePane];
    actionMessage = key === "d"
      ? `${paneLayout.detached.includes(activePane) ? "Detached" : "Reattached"} ${paneName} pane.`
      : key === "z"
        ? `${paneLayout.zoomedPane == null ? "Restored split view from" : "Zoomed"} ${paneName} pane.`
        : key === "\\"
          ? `${paneLayout.split ? "Enabled" : "Disabled"} split view.`
          : `Resized ${paneName} pane.`;
  }
  else if (["o", "y", "c", "x", "A", "w"].includes(key)) {
    const visibleLanes = missionControlVisibleLanes(lastSnapshot || { lanes: [] }, selectedRepository);
    const lane = resolveMissionControlSelection(visibleLanes, selectedId, selectedIndex);
    const available = missionControlActionAvailability(lane);
    const actionByKey = { o: "openPr", y: "copy", c: "continue", x: "cancel", A: "archive", w: "acknowledgeWake" };
    const action = actionByKey[key];
    if (!available[action]) {
      actionMessage = `Action ${action} is unavailable for the selected lane.`;
    } else if (key === "o") {
      const url = missionControlPrUrl(lane);
      openExternalUrl(url, lane.id);
    } else if (key === "y") {
      actionMessage = copySelection(lane) ? `Copied ${lane.alias || lane.id}.` : "Clipboard copy failed: no supported clipboard command succeeded in this environment.";
    } else if (key === "c") {
      const message = await promptLine(`Continue ${lane.alias || lane.id}. Enter the next instruction; blank cancels.`);
      if (!message) actionMessage = "Continue cancelled.";
      else {
        try {
          await callMissionControlAction({ runtimeRoot: resolve(import.meta.dirname, ".."), stateRoot, name: "continue_collaboration", arguments: { collaborationId: lane.id, message, additionalTurns: 6, expectedUpdatedAt: lane.updatedAt } });
          actionMessage = `Continuation queued for ${lane.alias || lane.id}.`;
        } catch (error) {
          actionMessage = `Continue failed: ${error.message}`;
        }
      }
    } else {
      const confirmation = missionControlConfirmation(pendingConfirmation, { key, lane });
      pendingConfirmation = confirmation.pending;
      if (!confirmation.confirmed) {
        const related = lane.relatedLaneCount > 1
          ? ` This targets ${lane.alias || lane.id} only; ${lane.relatedLaneCount - 1} related lane${lane.relatedLaneCount === 2 ? " remains" : "s remain"}.`
          : "";
        actionMessage = `Press ${key} again within 5 seconds to confirm ${action}.${related}`;
      } else {
        const armedLane = confirmation.lane;
        try {
          if (key === "x") await callMissionControlAction({ runtimeRoot: resolve(import.meta.dirname, ".."), stateRoot, name: "cancel_collaboration", arguments: { collaborationId: armedLane.id, expectedUpdatedAt: armedLane.updatedAt } });
          if (key === "A") await callMissionControlAction({ runtimeRoot: resolve(import.meta.dirname, ".."), stateRoot, name: "archive_collaboration", arguments: { collaborationId: armedLane.id, expectedUpdatedAt: armedLane.updatedAt } });
          if (key === "w") await callMissionControlAction({ runtimeRoot: resolve(import.meta.dirname, ".."), stateRoot, name: "acknowledge_coordinator_wake", arguments: { collaborationId: armedLane.id, sequence: armedLane.coordinatorWake.sequence, provider: armedLane.coordinatorWake.provider, summary: "User acknowledged the processed wake from Mission Control.", action: "processed" } });
          actionMessage = `${action} completed for ${armedLane.alias || armedLane.id}.`;
        } catch (error) {
          actionMessage = `${action} failed: ${error.message}`;
        }
      }
    }
  }
  else if (key === "r") clearRepositoryCache();
  else if (activePane === 1) {
    const intent = navigationIntent(key, selectedIndex);
    const changedSelection = intent.selectedIndex !== selectedIndex || !intent.preserveSelectedId;
    selectedIndex = intent.selectedIndex;
    if (!intent.preserveSelectedId) selectedId = null;
    if (changedSelection) {
      actionMessage = null;
      pendingConfirmation = null;
      detailExpanded = false;
      detailOffset = 0;
    }
  }
  await draw();
}
process.stdin.on("data", handleKey);
process.on("SIGINT", () => { void shutdown(130); });
process.on("SIGTERM", () => { void shutdown(143); });
process.on("exit", restoreSynchronously);
process.stdout.on("resize", handleResize);

startRefreshTimer();
subscriptionClient = createMissionControlSubscriptionClient({
  runtimeRoot: resolve(import.meta.dirname, ".."),
  workspaceRoot: resolve(import.meta.dirname, ".."),
  stateRoot,
  onUpdate: async ({ viewModel }) => {
    lastViewModel = viewModel;
    if (actionMessage?.startsWith("Subscription reconnecting:")) actionMessage = null;
    await draw(subscriptionSnapshot(viewModel));
  },
  onError: async (error) => {
    actionMessage = `Subscription reconnecting: ${error.message}`;
    if (lastSnapshot) await draw(lastSnapshot);
  },
});
void subscriptionClient.run();
await exitRequested;

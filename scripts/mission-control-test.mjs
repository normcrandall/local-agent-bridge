#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  coalesceTimeline,
  blockedReason,
  deduplicateOperatorLanes,
  displayWidth,
  isAttentionLane,
  isLiveLane,
  isStaleLane,
  formatLocalDateTime,
  loadMissionControlSnapshot,
  loadTimeline,
  missionControlRepositories,
  missionControlVisibleLanes,
  navigationIntent,
  newlyObservedAttentionKeys,
  operatorLaneCategory,
  paneFocusIntent,
  parseRepositoryRemote,
  renderSnapshot,
  renderMissionControl,
  readFileRange,
  statusRank,
  stripAnsi,
  windowPane,
} from "../src/mission-control.mjs";
import {
  HOST_ACTIVITY_LIVE_MS,
  HOST_ACTIVITY_HEARTBEAT_GRACE_MS,
  hostActivityLane,
  recordHostActivity,
} from "../src/host-activity-store.mjs";
import { PORTFOLIO_STATUSES, PORTFOLIO_STATUS_GROUPS } from "../src/portfolio-status.mjs";
import {
  missionControlActionAvailability,
  missionControlConfirmation,
  missionControlCopyText,
  missionControlPlatformCommands,
  missionControlPrUrl,
  resolveMissionControlSelection,
} from "../src/mission-control-actions.mjs";

assert.equal(parseRepositoryRemote("https://token@example.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("git@github.com:owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("ssh://git@github.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("not-a-remote"), null);
assert.equal(formatLocalDateTime("not-a-date"), "unknown");
assert.match(formatLocalDateTime("2026-07-23T12:00:00.000Z"), /^2026-07-2[34] \d{2}:\d{2}:\d{2} \S/);
assert.match(formatLocalDateTime("1970-01-01T00:00:00.000Z"), /^19(?:69|70)-/);
assert.deepEqual(navigationIntent("j", 1), { selectedIndex: 2, preserveSelectedId: false });
assert.deepEqual(navigationIntent("k", 1), { selectedIndex: 0, preserveSelectedId: false });
assert.deepEqual(navigationIntent("r", 1), { selectedIndex: 1, preserveSelectedId: true });
assert.equal(paneFocusIntent("\t", 0), 1);
assert.equal(paneFocusIntent("\x1b[C", 2), 0);
assert.equal(paneFocusIntent("\x1b[D", 0), 2);
assert.equal(paneFocusIntent("j", 1), 1);
assert.equal(blockedReason({ lifecyclePhase: "blocked", portfolio: { blockedBy: ["issue-672"] } }), "Waiting for issue #672 to complete.");
assert.equal(blockedReason({ lifecyclePhase: "blocked", blocker: { error: "Reviewer provider is unavailable." } }), "Reviewer provider is unavailable.");
assert.equal(blockedReason({ lifecyclePhase: "blocked" }), "No blocking reason was recorded by the coordinator.");
assert.equal(blockedReason({ lifecyclePhase: "working" }), "");
assert.equal(blockedReason({ lifecyclePhase: "agreed", handoff: { summary: "Review completed." } }), "");
const selectionFixture = [{ id: "first", updatedAt: "one" }, { id: "last", updatedAt: "two" }];
assert.equal(resolveMissionControlSelection(selectionFixture, null, Number.MAX_SAFE_INTEGER).id, "last");
assert.equal(resolveMissionControlSelection(selectionFixture, "first", 1).id, "first");
const armed = missionControlConfirmation(null, { key: "x", lane: selectionFixture[0], now: 100 });
selectionFixture[0].updatedAt = "changed";
const confirmed = missionControlConfirmation(armed.pending, { key: "x", lane: selectionFixture[0], now: 101 });
assert.equal(confirmed.confirmed, true);
assert.equal(confirmed.lane.updatedAt, "one", "confirmation must retain the rendered revision fence");
assert.equal(missionControlActionAvailability({ type: "collaboration", coordinatorWake: { sequence: 1, status: "pending", actionable: true } }).acknowledgeWake, false);
assert.equal(missionControlActionAvailability({ type: "collaboration", coordinatorWake: { sequence: 1, status: "pending", actionable: false } }).acknowledgeWake, true);
assert.equal(missionControlPlatformCommands("darwin").open[0].command, "open");
assert.equal(missionControlPlatformCommands("linux").copy[0].command, "wl-copy");
assert.equal(missionControlPlatformCommands("win32").copy[0].command, "clip.exe");
assert.deepEqual(newlyObservedAttentionKeys(new Set(["lane-a:1"]), ["lane-a:1"]), []);
assert.deepEqual(newlyObservedAttentionKeys(new Set(["lane-a:1", "lane-b:1"]), ["lane-a:1"]), [], "removing a request must not ring again");
assert.deepEqual(newlyObservedAttentionKeys(new Set(["lane-a:1"]), ["lane-a:1", "lane-b:1"]), ["lane-b:1"]);
assert.deepEqual(coalesceTimeline([
  { type: "progress", agent: "codex", at: "2026-07-23T12:00:00.000Z", summary: "Codex is using an MCP tool." },
  { type: "progress", agent: "codex", at: "2026-07-23T12:00:01.000Z", summary: "Publishing the pull request" },
  { type: "progress", agent: "codex", at: "2026-07-23T12:00:02.000Z", summary: "Publishing the pull request" },
]), [
  { type: "progress", agent: "codex", at: "2026-07-23T12:00:00.000Z", summary: "Provider tool activity", count: 1 },
  { type: "progress", agent: "codex", at: "2026-07-23T12:00:02.000Z", summary: "Publishing the pull request", count: 2 },
]);
assert.equal(displayWidth("🇺🇸"), 2);
assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
assert.deepEqual(windowPane(Array.from({ length: 10 }, (_, index) => ({ text: `row ${index}` })), 5).map(({ text }) => text), [
  "row 0", "row 1", "row 2", "row 3", "↓ 6 more",
]);
const tinyWindow = windowPane(Array.from({ length: 10 }, (_, index) => ({ text: `row ${index}` })), 2);
assert.deepEqual(tinyWindow.map(({ text }) => text), ["row 0", "↓ 9 more"]);
for (const status of PORTFOLIO_STATUSES) {
  const expected = !PORTFOLIO_STATUS_GROUPS.terminal.includes(status);
  assert.equal(isAttentionLane({ lifecyclePhase: status, updatedAt: "2026-07-23T11:59:00.000Z" }, Date.parse("2026-07-23T12:00:00.000Z")), expected, `${status} classification drifted`);
}
assert.equal(isAttentionLane({ lifecyclePhase: "unknown" }), false);
const classificationNow = Date.parse("2026-07-23T12:00:00.000Z");
assert.equal(isLiveLane({ type: "collaboration", lifecyclePhase: "running" }, classificationNow), false);
assert.equal(isLiveLane({ type: "collaboration", lifecyclePhase: "running", recovery: { processAlive: true } }, classificationNow), true);
assert.equal(isLiveLane({ type: "collaboration", lifecyclePhase: "running", heartbeat: { heartbeatAt: "2026-07-23T11:59:30.000Z" } }, classificationNow), true);
assert.equal(isLiveLane({ type: "collaboration", lifecyclePhase: "running", heartbeat: { heartbeatAt: "2026-07-23T11:58:00.000Z" } }, classificationNow), false);
assert.equal(isLiveLane({ type: "collaboration", lifecyclePhase: "indeterminate", heartbeat: { heartbeatAt: "2026-07-23T11:59:59.000Z" } }, classificationNow), false);
assert.equal(isLiveLane({ type: "portfolio_lane", lifecyclePhase: "implementing" }), false);
assert.equal(isLiveLane({ type: "native_host", lifecyclePhase: "working", hostActivity: { live: true } }), true);
assert.equal(isLiveLane({ type: "native_host", lifecyclePhase: "working", hostActivity: { live: false } }), false);
assert.equal(isStaleLane({ type: "portfolio_lane", lifecyclePhase: "blocked", updatedAt: "2026-07-22T10:00:00.000Z" }, Date.parse("2026-07-23T12:00:00.000Z")), true);
assert.equal(isStaleLane({ type: "portfolio_lane", lifecyclePhase: "integrating", updatedAt: "2026-07-22T10:00:00.000Z" }, Date.parse("2026-07-23T12:00:00.000Z")), false);
assert.equal(operatorLaneCategory({ type: "collaboration", lifecyclePhase: "turn_limit", updatedAt: "2026-07-23T11:59:00.000Z" }, classificationNow), "waiting");
assert.equal(operatorLaneCategory({ type: "collaboration", lifecyclePhase: "budget", updatedAt: "2026-07-23T11:59:00.000Z" }, classificationNow), "stopped");
for (const status of PORTFOLIO_STATUS_GROUPS.integration) assert.ok(statusRank(status) < statusRank("ready"));
const shortReadSource = Buffer.from("incremental-ledger-data");
const shortRead = await readFileRange({
  async read(buffer, offset, length, position) {
    const bytesRead = Math.min(3, length, shortReadSource.length - position);
    if (bytesRead <= 0) return { bytesRead: 0 };
    shortReadSource.copy(buffer, offset, position, position + bytesRead);
    return { bytesRead };
  },
}, 0, shortReadSource.length);
assert.equal(shortRead.buffer.toString("utf8"), shortReadSource.toString("utf8"));
assert.equal(shortRead.consumedSize, shortReadSource.length);

const root = await mkdtemp(join(tmpdir(), "bridge-mission-control-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-q"], { cwd: workspace });
execFileSync("git", ["remote", "add", "origin", "https://github.com/veliqon/control-plane.git"], { cwd: workspace });
await mkdir(join(root, "portfolios"));
const runningId = "bridge-11111111-1111-4111-8111-111111111111";
const completedId = "bridge-22222222-2222-4222-8222-222222222222";
const needsUserId = "bridge-33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-07-23T12:00:00.000Z");

try {
  const base = { workspace, agents: ["codex", "claude"], writer: "codex", createdAt: "2026-07-23T11:00:00.000Z" };
  await writeFile(join(root, `${runningId}.json`), JSON.stringify({
    ...base,
    id: runningId,
    status: "running",
    updatedAt: "2026-07-23T11:59:59.000Z",
    task: "Implement repository-aware mission control",
    githubBuilder: { repository: "veliqon/control-plane", headRef: "codex/mission-control", headSha: "a".repeat(40) },
    runtime: {
      turnCount: 2,
      activeCall: {
        agent: "codex",
        phase: "working",
        summary: "Rendering the repository and lane detail views.",
        summaryAt: "2026-07-23T11:58:00.000Z",
        summarySource: "provider_or_adapter",
        heartbeatAt: "2026-07-23T11:59:58.000Z",
        activity: { progressEventCount: 3, outputBytes: 412, lastOutputAt: "2026-07-23T11:59:00.000Z", lastProgressAt: "2026-07-23T11:59:00.000Z" },
      },
    },
    performanceSummary: { activeTimeMs: 12_000, deadTimeMs: 3_000, latestMilestone: { name: "first_progress" } },
  }));
  await writeFile(join(root, `${runningId}.jsonl`), [
    JSON.stringify({ type: "collaboration_started", at: "2026-07-23T11:00:00.000Z" }),
    JSON.stringify({ type: "progress", at: "2026-07-23T11:59:00.000Z", agent: "codex", summary: "Rendering repository views" }),
  ].join("\n") + "\n");
  await writeFile(join(root, `${completedId}.json`), JSON.stringify({
    ...base,
    id: completedId,
    status: "completed",
    updatedAt: "2026-07-23T10:00:00.000Z",
    task: "x".repeat(700),
    issueClaim: { repository: "veliqon/control-plane", issueNumber: 9 },
  }));
  const needsUserState = {
    ...base,
    id: needsUserId,
    status: "needs_user",
    updatedAt: "2026-07-23T11:58:00.000Z",
    task: "Resolve protected boundary",
    writer: "claude",
    githubReview: { repository: "norm/example", prNumber: 42, headSha: "b".repeat(40) },
    completion: { sequence: 1, acknowledged: false, nextAction: "needs_user", lastHandoff: { outcome: "blocked", summary: "Authorization required" } },
    coordinatorWake: {
      sequence: 1,
      kind: "needs_user",
      status: "pending",
      nextAction: "needs_user",
      summary: "Authorization required",
      createdAt: "2026-07-23T11:58:00.000Z",
    },
  };
  await writeFile(join(root, `${needsUserId}.json`), JSON.stringify(needsUserState));
  await writeFile(join(root, "portfolios", "helm-44444444-4444-4444-8444-444444444444.json"), JSON.stringify({
    id: "helm-44444444-4444-4444-8444-444444444444",
    workspace,
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T11:57:00.000Z",
    items: [{ id: "issue-12", title: "Queued portfolio work", issueNumber: 12, status: "ready", writer: "claude", blockedBy: [] }],
  }));

  const live = await loadMissionControlSnapshot({ stateRoot: root, now });
  assert.equal(live.mode, "live");
  assert.equal(live.totalLanes, 4);
  assert.equal(live.visibleLanes, 1);
  assert.equal(live.lanes[0].id, runningId);
  assert.equal(live.providerActivity.codex, 1);
  assert.equal(live.collapsedStale.total, 0);
  assert.equal(live.needsUserCount, 1);
  assert.match(live.needsUserSignature, new RegExp(needsUserId));
  assert.deepEqual(live.needsUserRequests.map(({ repository, summary }) => ({ repository, summary })), [{ repository: "norm/example", summary: "Authorization required" }]);
  await writeFile(join(root, `${needsUserId}.json`), JSON.stringify({
    ...needsUserState,
    coordinatorWake: { sequence: 1, kind: "needs_user", status: "acknowledged", nextAction: "needs_user", summary: "Authorization required" },
  }));
  const acknowledgedNeedsUser = await loadMissionControlSnapshot({ stateRoot: root, now });
  assert.equal(acknowledgedNeedsUser.needsUserCount, 0);
  assert.doesNotMatch(renderSnapshot(acknowledgedNeedsUser, { width: 88 }), /USER INPUT REQUIRED/);
  await writeFile(join(root, `${needsUserId}.json`), JSON.stringify({
    ...needsUserState,
    coordinatorWake: { sequence: 1, kind: "needs_user", status: "pending", nextAction: "needs_user", summary: "Authorization required" },
  }));

  const hostRoot = join(root, "host-test");
  const sessionId = "private-codex-session-123";
  const hostState = await recordHostActivity(hostRoot, {
    provider: "codex",
    sessionId,
    workspace,
    model: "gpt-5.6-sol",
    action: "start",
    hostPid: process.pid,
    task: "Inspect the native Codex app turn",
    sourceEvent: "UserPromptSubmit",
    now,
  });
  const hostLive = await loadMissionControlSnapshot({ stateRoot: hostRoot, now });
  assert.equal(hostLive.totalLanes, 1);
  assert.equal(hostLive.visibleLanes, 1);
  assert.equal(hostLive.lanes[0].type, "native_host");
  assert.equal(hostLive.lanes[0].repository, "veliqon/control-plane");
  assert.equal(hostLive.lanes[0].activeAgent, "codex");
  assert.equal(hostLive.lanes[0].hostActivity.processAlive, true);
  assert.equal(hostLive.providerActivity.codex, 1);
  const hostStateFile = join(hostRoot, "host-activity", (await readdir(join(hostRoot, "host-activity"))).find((name) => name.endsWith(".json")));
  assert.doesNotMatch(await readFile(hostStateFile, "utf8"), new RegExp(sessionId));
  await recordHostActivity(hostRoot, {
    provider: "codex",
    sessionId,
    workspace,
    action: "stop",
    sourceEvent: "Stop",
    now: now + 1_000,
  });
  const hostStopped = await loadMissionControlSnapshot({ stateRoot: hostRoot, now: now + 1_000 });
  assert.equal(hostStopped.totalLanes, 1);
  assert.equal(hostStopped.visibleLanes, 0);
  assert.equal(hostStopped.providerActivity.codex, undefined);
  assert.equal(hostStopped.recentActivity[0].repository, "veliqon/control-plane");
  assert.match(renderSnapshot(hostStopped, { width: 88, now: now + 1_000 }), /Coordinator may be between lanes/);

  const historicalRoot = join(root, "historical-test");
  await mkdir(historicalRoot);
  await mkdir(join(historicalRoot, "portfolios"));
  await writeFile(join(historicalRoot, `${needsUserId}.json`), JSON.stringify({
    ...needsUserState,
    createdAt: new Date(now - 7 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    coordinatorWake: {
      ...needsUserState.coordinatorWake,
      createdAt: new Date(now - 7 * 60 * 60_000).toISOString(),
    },
    userAttention: { status: "delivered", lastDeliveredAt: new Date(now).toISOString() },
  }));
  const historicalNeedsUser = await loadMissionControlSnapshot({ stateRoot: historicalRoot, now });
  assert.equal(historicalNeedsUser.needsUserCount, 0);
  assert.equal(historicalNeedsUser.historicalNeedsUserCount, 1);
  assert.equal(historicalNeedsUser.recentActivity.length, 0, "notification receipt writes must not make an old request recent");
  const historicalOutput = renderSnapshot(historicalNeedsUser, { width: 100, now });
  assert.doesNotMatch(historicalOutput, /!!! USER INPUT REQUIRED/);
  assert.match(historicalOutput, /1 historical input request[\s\S]*No alert will be sent/);
  const busyHistoricalOutput = renderSnapshot({
    ...historicalNeedsUser,
    operatorLanes: live.operatorLanes,
    operatorCounts: live.operatorCounts,
  }, { width: 120, now });
  assert.match(busyHistoricalOutput, /HISTORICAL INPUT 1/, "historical requests must remain visible while other work is active");
  const revealedHistorical = await loadMissionControlSnapshot({ stateRoot: historicalRoot, view: "attention", includeStale: true, now });
  assert.ok(revealedHistorical.operatorLanes.some((lane) => lane.id === needsUserId && lane.operatorCategory === "history"));
  assert.match(renderSnapshot(revealedHistorical, { width: 120, now }), /PR #42/);
  await writeFile(join(historicalRoot, "portfolios", "helm-55555555-5555-4555-8555-555555555555.json"), JSON.stringify({
    id: "helm-55555555-5555-4555-8555-555555555555",
    workspace,
    repository: "veliqon/control-plane",
    createdAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
    items: [{
      id: "issue-13",
      title: "A newly blocked portfolio lane",
      status: "blocked",
      writer: "claude",
      blockedBy: ["issue-401"],
      needsUserAt: new Date(now - 30_000).toISOString(),
      updatedAt: new Date(now - 30_000).toISOString(),
    }],
  }));
  const freshPortfolioRequest = await loadMissionControlSnapshot({ stateRoot: historicalRoot, now });
  assert.equal(freshPortfolioRequest.needsUserCount, 0, "a portfolio status without a stopped provider wake must not alert");
  assert.equal(freshPortfolioRequest.historicalNeedsUserCount, 1);
  const freshPortfolioOutput = renderSnapshot(freshPortfolioRequest, { width: 100, now });
  assert.doesNotMatch(freshPortfolioOutput, /!!! USER INPUT REQUIRED/);
  assert.match(freshPortfolioOutput, /BLOCKED BECAUSE[\s\S]*Waiting for issue #401 to complete\./);
  const expiredHostLane = hostActivityLane({
    ...hostState,
    expiresAt: new Date(now + HOST_ACTIVITY_LIVE_MS).toISOString(),
  }, now + HOST_ACTIVITY_LIVE_MS + 1);
  assert.equal(expiredHostLane.hostActivity.live, false);
  assert.equal(isLiveLane(expiredHostLane, now + HOST_ACTIVITY_LIVE_MS + 1), false);
  const recentDeadHostLane = hostActivityLane({ ...hostState, hostPid: 99_999_999 }, now + 1);
  assert.equal(recentDeadHostLane.hostActivity.processAlive, false);
  assert.equal(recentDeadHostLane.hostActivity.livenessProof, "recent_receipt");
  assert.equal(isLiveLane(recentDeadHostLane, now + 1), true);
  const staleDeadHostLane = hostActivityLane({ ...hostState, hostPid: 99_999_999 }, now + HOST_ACTIVITY_HEARTBEAT_GRACE_MS + 1);
  assert.equal(staleDeadHostLane.hostActivity.livenessProof, "none");
  assert.equal(isLiveLane(staleDeadHostLane, now + HOST_ACTIVITY_HEARTBEAT_GRACE_MS + 1), false);

  const outcomeRoot = join(root, "outcome-test");
  const budgetReviewId = "bridge-66666666-6666-4666-8666-666666666666";
  await mkdir(outcomeRoot);
  await mkdir(join(outcomeRoot, "portfolios"));
  await writeFile(join(outcomeRoot, `${budgetReviewId}.json`), JSON.stringify({
    ...base,
    id: budgetReviewId,
    status: "budget",
    updatedAt: "2026-07-23T11:50:00.000Z",
    task: "Review the exact pull request head",
    issueClaim: { repository: "veliqon/control-plane", issueNumber: 669 },
    budget: { maxMinutes: 90 },
    runtime: { budgetExceeded: true, previousAgent: "claude" },
    completion: {
      sequence: 1,
      acknowledged: true,
      nextAction: "continue",
      lastHandoff: { outcome: "completed", summary: "Review completed before the budget boundary." },
    },
  }));
  await writeFile(join(outcomeRoot, "portfolios", "helm-77777777-7777-4777-8777-777777777777.json"), JSON.stringify({
    id: "helm-77777777-7777-4777-8777-777777777777",
    workspace,
    repository: "veliqon/control-plane",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    items: [{
      id: "issue-669",
      issueNumber: 669,
      prNumber: 674,
      title: "Merged focus lifecycle work",
      status: "merged",
      writer: "codex",
      collaborationId: budgetReviewId,
      headSha: "c".repeat(40),
      summary: "PR #674 merged after its independent review completed.",
      updatedAt: "2026-07-23T08:00:00.000Z",
      blockedBy: [],
    }],
  }));
  const failedReviewId = "bridge-99999999-9999-4999-8999-999999999999";
  await writeFile(join(outcomeRoot, `${failedReviewId}.json`), JSON.stringify({
    ...base,
    id: failedReviewId,
    status: "failed",
    updatedAt: "2026-07-23T11:52:00.000Z",
    task: "Resolve review threads after the delivery was already accepted",
    githubReview: { repository: "veliqon/control-plane", prNumber: 674, headSha: "c".repeat(40) },
    runtime: { previousAgent: "antigravity" },
    error: "The reviewer identity was unavailable.",
  }));
  const mergedOutcome = await loadMissionControlSnapshot({ stateRoot: outcomeRoot, now });
  assert.equal(mergedOutcome.visibleLanes, 0, "a merged portfolio outcome must not remain live or attention work");
  assert.equal(mergedOutcome.operatorLanes.length, 0, "a stopped review attempt must not make its merged PR look failed");
  assert.equal(mergedOutcome.operatorCounts.stopped, 0);
  assert.equal(mergedOutcome.operatorCounts.failed, 0, "the compatibility alias must also exclude superseded attempts");
  const mergedHistory = await loadMissionControlSnapshot({ stateRoot: outcomeRoot, showAll: true, now });
  assert.equal(mergedHistory.operatorLanes.length, 1, "PR identity must reconcile portfolio, writer, and review attempts");
  assert.equal(mergedHistory.operatorLanes[0].portfolio.status, "merged");
  assert.equal(mergedHistory.operatorLanes[0].relatedLaneCount, 2);
  assert.deepEqual(mergedHistory.operatorLanes[0].relatedAttempts.map((attempt) => attempt.lifecyclePhase).sort(), ["budget", "failed"]);
  assert.equal(mergedHistory.operatorLanes[0].operatorCategory, "history");
  const mergedHistoryOutput = renderSnapshot(mergedHistory, { width: 120, height: 30, now, detailExpanded: true });
  assert.match(mergedHistoryOutput, /DELIVERY\s+PR #674 merged/);
  assert.match(mergedHistoryOutput, /ATTEMPT\s+stopped ·/);
  assert.doesNotMatch(mergedHistoryOutput, /FAILED/);
  assert.doesNotMatch(mergedHistoryOutput, /NEXT\s+continue/);

  const standaloneBudgetId = "bridge-88888888-8888-4888-8888-888888888888";
  await writeFile(join(outcomeRoot, `${standaloneBudgetId}.json`), JSON.stringify({
    ...base,
    id: standaloneBudgetId,
    status: "budget",
    updatedAt: "2026-07-23T11:59:00.000Z",
    task: "A provider attempt that genuinely stopped",
    githubReview: { repository: "veliqon/control-plane", prNumber: 675, headSha: "d".repeat(40) },
    budget: { maxMinutes: 90 },
    runtime: { budgetExceeded: true, previousAgent: "claude" },
  }));
  const stoppedAttempt = await loadMissionControlSnapshot({ stateRoot: outcomeRoot, now });
  assert.equal(stoppedAttempt.operatorCounts.stopped, 1);
  assert.equal(stoppedAttempt.operatorCounts.failed, 1, "legacy JSON consumers retain the failed count alias");
  assert.match(renderSnapshot(stoppedAttempt, { width: 120, now }), /STOPPED 1/);
  assert.match(renderSnapshot(stoppedAttempt, { width: 120, now }), /budget reached/);

  const edgeRoot = join(root, "outcome-edge-test");
  await mkdir(edgeRoot);
  await mkdir(join(edgeRoot, "portfolios"));
  const terminalNeedsUserId = "bridge-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await writeFile(join(edgeRoot, `${terminalNeedsUserId}.json`), JSON.stringify({
    ...base,
    id: terminalNeedsUserId,
    status: "needs_user",
    updatedAt: "2026-07-23T11:59:00.000Z",
    task: "Finish coordinator acknowledgement after delivery",
    issueClaim: { repository: "veliqon/control-plane", issueNumber: 700 },
    coordinatorWake: {
      sequence: 1,
      kind: "needs_user",
      nextAction: "needs_user",
      status: "pending",
      summary: "A real owner decision remains.",
      createdAt: "2026-07-23T11:59:00.000Z",
    },
  }));
  const queuedId = "bridge-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeFile(join(edgeRoot, `${queuedId}.json`), JSON.stringify({
    ...base,
    id: queuedId,
    status: "queued",
    updatedAt: "2026-07-23T11:59:30.000Z",
    task: "Ordinary queued work",
    issueClaim: { repository: "veliqon/control-plane", issueNumber: 702 },
  }));
  const priorAttemptId = "bridge-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await writeFile(join(edgeRoot, `${priorAttemptId}.json`), JSON.stringify({
    ...base,
    id: priorAttemptId,
    status: "failed",
    updatedAt: "2026-07-23T11:58:00.000Z",
    task: "Earlier issue-only attempt",
    issueClaim: { repository: "veliqon/control-plane", issueNumber: 701 },
    error: "Provider transport failed.",
  }));
  await writeFile(join(edgeRoot, "portfolios", "helm-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json"), JSON.stringify({
    id: "helm-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    workspace,
    repository: "veliqon/control-plane",
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    items: [{
      id: "issue-700",
      issueNumber: 700,
      prNumber: 700,
      status: "merged",
      collaborationId: terminalNeedsUserId,
      summary: "PR #700 merged, with a real user boundary still open.",
      headSha: "e".repeat(40),
    }, {
      id: "issue-701",
      issueNumber: 701,
      prNumber: 701,
      status: "merged",
      summary: "PR #701 merged after a prior provider attempt stopped.",
      headSha: "f".repeat(40),
    }],
  }));
  const edgeAttention = await loadMissionControlSnapshot({ stateRoot: edgeRoot, view: "attention", now });
  assert.equal(edgeAttention.operatorCounts.needs_user, 1, "a terminal delivery must not hide a real user boundary");
  assert.equal(edgeAttention.operatorCounts.waiting, 1, "queued work remains part of the existing attention contract");
  assert.ok(edgeAttention.operatorLanes.some((lane) => lane.prNumber === 700 && lane.operatorCategory === "needs_user"));
  assert.ok(edgeAttention.operatorLanes.some((lane) => lane.issueNumber === 702));
  const edgeHistory = await loadMissionControlSnapshot({ stateRoot: edgeRoot, showAll: true, now });
  const mergedPriorAttempt = edgeHistory.operatorLanes.find((lane) => lane.prNumber === 701);
  assert.equal(mergedPriorAttempt.operatorCategory, "history");
  assert.equal(mergedPriorAttempt.relatedLaneCount, 2, "an issue-only prior attempt must join its eventual PR delivery");
  assert.deepEqual(mergedPriorAttempt.relatedAttempts.map((attempt) => attempt.lifecyclePhase), ["failed"]);
  const mergedPriorIndex = edgeHistory.operatorLanes.findIndex((lane) => lane.prNumber === 701);
  const edgeHistoryOutput = renderMissionControl(edgeHistory, { width: 120, height: 30, now, selectedIndex: mergedPriorIndex, detailExpanded: true });
  assert.match(edgeHistoryOutput, /DELIVERY\s+PR #701 merged/);
  assert.match(edgeHistoryOutput, /ATTEMPT\s+stopped · provider failed/);
  assert.equal(stoppedAttempt.operatorLanes.find((lane) => lane.prNumber === 675).legacyOperatorCategory, "failed");

  const attention = await loadMissionControlSnapshot({ stateRoot: root, view: "attention", now });
  assert.equal(attention.mode, "attention");
  assert.equal(attention.totalLanes, 4);
  assert.equal(attention.visibleLanes, 3);
  assert.deepEqual(attention.repositories.map((entry) => entry.repository), ["norm/example", "veliqon/control-plane"]);
  assert.equal(attention.providerActivity.codex, 1);
  assert.equal(attention.providerActivity.claude, 2);
  assert.ok(attention.lanes.some((lane) => lane.id === runningId && lane.repository === "veliqon/control-plane"));
  assert.ok(attention.lanes.some((lane) => lane.id.startsWith("helm-") && lane.repository === "veliqon/control-plane"));
  assert.ok(!attention.lanes.some((lane) => lane.id === completedId));
  const collapsed = await loadMissionControlSnapshot({ stateRoot: root, view: "attention", staleAfterMs: 60_000, now });
  assert.equal(collapsed.visibleLanes, 1);
  assert.equal(collapsed.collapsedStale.total, 2);
  assert.equal(collapsed.collapsedStale.portfolioItems, 1);
  assert.match(renderSnapshot(collapsed, { width: 120, now }), /STALE HIDDEN 2.*press s/);
  const revealed = await loadMissionControlSnapshot({ stateRoot: root, view: "attention", staleAfterMs: 60_000, includeStale: true, now });
  assert.equal(revealed.visibleLanes, 3);

  const similarRepositoryId = "bridge-55555555-5555-4555-8555-555555555555";
  await writeFile(join(root, `${similarRepositoryId}.json`), JSON.stringify({
    ...base,
    id: similarRepositoryId,
    status: "completed",
    updatedAt: "2026-07-23T09:00:00.000Z",
    githubBuilder: { repository: "veliqon/control-plane-extra" },
  }));

  const all = await loadMissionControlSnapshot({ stateRoot: root, showAll: true, repositoryFilter: "veliqon/control-plane", now });
  assert.equal(all.totalLanes, 3);
  assert.equal(all.visibleLanes, 3);
  assert.ok(all.lanes.some((lane) => lane.id === completedId));
  assert.equal(all.lanes.find((lane) => lane.id === completedId).task.length, 500);

  const timeline = await loadTimeline(root, runningId, 5);
  assert.equal(timeline.length, 2);
  assert.equal(timeline.at(-1).summary, "Rendering repository views");
  await appendFile(join(root, `${runningId}.jsonl`), Array.from({ length: 70 }, (_, index) => JSON.stringify({
    type: "user_continued",
    at: `2026-07-23T11:59:${String(index % 60).padStart(2, "0")}.000Z`,
    message: `${index}: ${"sensitive continuation detail ".repeat(20)}`,
  })).join("\n") + "\n");
  const boundedTimeline = await loadTimeline(root, runningId, 100);
  assert.equal(boundedTimeline.length, 64);
  assert.ok(boundedTimeline.every((event) => event.summary.length <= 240));
  const timelinePath = join(root, `${runningId}.jsonl`);
  const priorTimelineSize = (await stat(timelinePath)).size;
  const replacementPath = join(root, "replacement.jsonl");
  await writeFile(replacementPath, `${JSON.stringify({
    type: "progress",
    at: "2026-07-23T12:00:01.000Z",
    summary: "replacement timeline",
    padding: "r".repeat(priorTimelineSize + 32),
  })}\n`);
  await rename(replacementPath, timelinePath);
  const replacedTimeline = await loadTimeline(root, runningId, 100);
  assert.equal(replacedTimeline.length, 1);
  assert.equal(replacedTimeline[0].summary, "replacement timeline");
  await appendFile(timelinePath, `${JSON.stringify({ type: "noise", message: "x".repeat(1_100_000) })}\n${JSON.stringify({
    type: "progress",
    at: "2026-07-23T12:00:02.000Z",
    summary: "after oversized delta",
  })}\n`);
  const oversizedDeltaTimeline = await loadTimeline(root, runningId, 100);
  assert.equal(oversizedDeltaTimeline.at(-1).summary, "after oversized delta");
  assert.ok(oversizedDeltaTimeline.every((event) => event.summary.length <= 240));
  const selectedIndex = attention.operatorLanes.findIndex((lane) => lane.id === runningId);
  const rendered = renderSnapshot(attention, { selectedIndex, timeline, width: 120, height: 40, now, detailExpanded: true });
  assert.match(rendered, /AGENT BRIDGE MISSION CONTROL/);
  assert.match(rendered, /NEEDS YOU 1/);
  assert.match(rendered, /control-plane/);
  assert.match(rendered, /WORKSPACE/);
  assert.match(rendered, /CREATED.*2026/);
  assert.match(rendered, /UPDATED.*2026/);
  assert.match(rendered, /SUMMARY STALE.*heartbeat remains live/);
  assert.match(rendered, /ACTIVITY.*3 events.*412 bytes/);
  const selectedLane = attention.lanes[selectedIndex];
  assert.deepEqual(missionControlActionAvailability(selectedLane), { openPr: false, copy: true, continue: false, cancel: true, archive: false, acknowledgeWake: false });
  const needsUserLane = attention.lanes.find((lane) => lane.id === needsUserId);
  assert.equal(missionControlPrUrl(needsUserLane), "https://github.com/norm/example/pull/42");
  assert.match(missionControlCopyText(needsUserLane), /norm\/example/);
  assert.match(rendered, /RECENT ACTIVITY[\s\S]*Rendering repository views/);
  assert.match(rendered, /Timing: active 12s \| dead 3s/);
  assert.ok(rendered.split("\n").every((line) => displayWidth(line) <= 120));
  const manyOperatorLanes = Array.from({ length: 55 }, (_, index) => ({
    ...attention.operatorLanes[0],
    id: `lane-${index}`,
    operatorId: `lane-${index}`,
    issueNumber: 1_000 + index,
    operatorCategory: "waiting",
  }));
  const manyLanes = { ...attention, operatorLanes: manyOperatorLanes, operatorCounts: { active: 0, needs_user: 0, waiting: 55, failed: 0 }, visibleLanes: 55, totalLanes: 55 };
  const manyRendered = renderSnapshot(manyLanes, { width: 120, height: 20 });
  assert.match(manyRendered, /more/);
  assert.match(manyRendered, /↓ \d+ more/);
  const renderedHistory = renderSnapshot(all, { width: 88, now });
  assert.match(renderedHistory, /bridge cleanup --older-than-days 7/);
  assert.ok(renderedHistory.split("\n").every((line) => displayWidth(line) <= 88));
  assert.ok(renderSnapshot(all, { width: 30, now }).split("\n").every((line) => displayWidth(line) <= 30));

  const duplicate = deduplicateOperatorLanes([
    { ...attention.operatorLanes[0], id: "one", issueNumber: 99, repository: "veliqon/control-plane", lifecyclePhase: "ready", updatedAt: new Date(now - 1_000).toISOString() },
    { ...attention.operatorLanes[0], id: "two", issueNumber: 99, repository: "veliqon/control-plane", lifecyclePhase: "running", recovery: { processAlive: true }, updatedAt: new Date(now).toISOString() },
  ], { now });
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].relatedLaneCount, 2);
  assert.equal(duplicate[0].id, "two", "the live collaboration must represent a duplicated issue");
  assert.match(missionControlCopyText(duplicate[0]), /related: one,two|related: two,one/);

  const colored = renderMissionControl(attention, { selectedIndex, timeline, width: 120, height: 28, now, color: true, interactive: true });
  assert.match(colored, /\x1b\[/);
  const gridRows = colored.split("\n").map(stripAnsi).filter((line) => /^[┌├│└]/.test(line));
  assert.ok(gridRows.every((line) => displayWidth(line) === 120), "every grid row must fill the terminal width");
  const dividerColumns = (line) => {
    let column = 0;
    const result = [];
    for (const character of line) {
      if ("│┌┬┐├┼┤└┴┘".includes(character)) result.push(column);
      column += displayWidth(character);
    }
    return result;
  };
  const verticalRows = gridRows.filter((line) => line.startsWith("│"));
  assert.ok(verticalRows.every((line) => assert.deepEqual(dividerColumns(line), dividerColumns(verticalRows[0])) === undefined), "vertical dividers must never shift");
  const noColor = renderMissionControl(attention, { selectedIndex, timeline, width: 120, height: 28, now, color: false, interactive: true });
  assert.doesNotMatch(noColor, /\x1b\[/);
  assert.match(noColor, /│ REPOSITORIES/);
  assert.match(noColor, /│ DETAILS/);
  assert.doesNotMatch(noColor, /SELECTED LANE/);
  assert.match(noColor, /WORK · j\/k choose lane · Enter details/);

  const secondRepositoryLane = {
    ...attention.operatorLanes[0],
    id: "second-repository-lane",
    operatorId: "second-repository-lane",
    repository: "veliqon/second-repo",
    issueNumber: 314,
    prNumber: 315,
    task: "Second repository objective",
  };
  const multiRepository = {
    ...attention,
    operatorLanes: [...attention.operatorLanes, secondRepositoryLane],
  };
  assert.deepEqual(missionControlRepositories(multiRepository), [null, "norm/example", "veliqon/control-plane", "veliqon/second-repo"]);
  assert.deepEqual(missionControlRepositories({ operatorLanes: [secondRepositoryLane] }), [null, "veliqon/second-repo"]);
  assert.deepEqual(missionControlVisibleLanes(multiRepository, "veliqon/second-repo").map((lane) => lane.id), ["second-repository-lane"]);
  const repositoryFocused = renderMissionControl(multiRepository, {
    selectedRepository: "veliqon/second-repo",
    selectedIndex: 0,
    width: 120,
    height: 28,
    now,
    color: false,
    interactive: true,
    activePane: 0,
  });
  assert.match(repositoryFocused, /▶ second-repo/);
  assert.match(repositoryFocused, /PR #315/);
  assert.doesNotMatch(repositoryFocused, /PR #42/);
  assert.match(repositoryFocused, /REPOSITORIES · j\/k choose · Enter work/);
  const clampedSelection = renderMissionControl(multiRepository, {
    selectedIndex: Number.MAX_SAFE_INTEGER,
    width: 120,
    height: 28,
    now,
    color: false,
    interactive: true,
  });
  assert.match(clampedSelection, /▶ PR #315/, "the work marker must match the detail lane after renderer clamping");
  const narrow = renderMissionControl(attention, { selectedIndex, timeline, width: 60, height: 20, now, color: false, interactive: true, activePane: 2 });
  const narrowGrid = narrow.split("\n").filter((line) => /^[┌├│└]/.test(line));
  assert.ok(narrowGrid.every((line) => displayWidth(line) === 60));
  const viewportState = {};
  const scrolledDetail = renderMissionControl(attention, { selectedIndex, timeline, width: 60, height: 12, now, color: false, interactive: true, activePane: 2, detailExpanded: true, detailOffset: Number.MAX_SAFE_INTEGER, viewportState });
  assert.match(scrolledDetail, /RECENT ACTIVITY|Rendering repository views/);
  assert.ok(viewportState.detailOffset < Number.MAX_SAFE_INTEGER, "detail scrolling must clamp to a usable offset");
  const narrowRepositories = renderMissionControl({ ...attention, historicalNeedsUserCount: 1, collapsedStale: { total: 2 } }, { selectedIndex, timeline, width: 60, height: 20, now, color: false, interactive: true, activePane: 0 });
  assert.match(narrowRepositories, /REPOSITORIES/);
  assert.match(narrowRepositories, /HISTORICAL INPUT|STALE HIDDEN/);

  const cli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--attention", "--stale-after-hours", "72", "--state-root", root, "--repo", "norm/example"], { encoding: "utf8" });
  assert.match(cli, /norm\/example/);
  assert.match(cli, /historical input request/);
  assert.doesNotMatch(cli, /Old completed lane/);
  const staleCli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--attention", "--include-stale", "--stale-after-hours", "72", "--state-root", root, "--repo", "norm/example"], { encoding: "utf8" });
  assert.match(staleCli, /PR #42/);
  assert.match(staleCli, /ID  bridge-33333333/);
  const invalidColumnsCli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--attention", "--stale-after-hours", "72", "--state-root", root, "--repo", "norm/example"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "not-a-number" },
  });
  assert.match(invalidColumnsCli, /AGENT BRIDGE MISSION CONTROL/);

  console.log("Mission Control tests passed: live defaults, native host visibility, attention/stale filtering, repository grouping, timeline rendering, and snapshot CLI behavior are verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}

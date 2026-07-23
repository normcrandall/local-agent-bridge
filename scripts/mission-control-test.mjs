#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isAttentionLane,
  isLiveLane,
  isStaleLane,
  loadMissionControlSnapshot,
  loadTimeline,
  navigationIntent,
  parseRepositoryRemote,
  renderSnapshot,
  readFileRange,
  statusRank,
  stripAnsi,
} from "../src/mission-control.mjs";
import {
  HOST_ACTIVITY_LIVE_MS,
  HOST_ACTIVITY_HEARTBEAT_GRACE_MS,
  hostActivityLane,
  recordHostActivity,
} from "../src/host-activity-store.mjs";
import { PORTFOLIO_STATUSES, PORTFOLIO_STATUS_GROUPS } from "../src/portfolio-status.mjs";

assert.equal(parseRepositoryRemote("https://token@example.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("git@github.com:owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("ssh://git@github.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("not-a-remote"), null);
assert.deepEqual(navigationIntent("j", 1), { selectedIndex: 2, preserveSelectedId: false });
assert.deepEqual(navigationIntent("k", 1), { selectedIndex: 0, preserveSelectedId: false });
assert.deepEqual(navigationIntent("r", 1), { selectedIndex: 1, preserveSelectedId: true });
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
  await writeFile(join(root, `${needsUserId}.json`), JSON.stringify({
    ...base,
    id: needsUserId,
    status: "needs_user",
    updatedAt: "2026-07-23T11:58:00.000Z",
    task: "Resolve protected boundary",
    writer: "claude",
    githubReview: { repository: "norm/example", prNumber: 42, headSha: "b".repeat(40) },
    completion: { sequence: 1, acknowledged: false, nextAction: "needs_user", lastHandoff: { outcome: "blocked", summary: "Authorization required" } },
  }));
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
  const selectedIndex = attention.lanes.findIndex((lane) => lane.id === runningId);
  const rendered = renderSnapshot(attention, { selectedIndex, timeline, width: 88, height: 100, now });
  assert.match(rendered, /AGENT BRIDGE MISSION CONTROL/);
  assert.match(rendered, /veliqon\/control-plane/);
  assert.match(rendered, /Workspace:/);
  assert.match(rendered, /Narrative .*stale while heartbeat remains live/);
  assert.match(rendered, /Timing: active 12s \| dead 3s/);
  assert.ok(rendered.split("\n").every((line) => stripAnsi(line).length <= 88));
  const manyLanes = { ...attention, lanes: Array.from({ length: 55 }, (_, index) => ({ ...attention.lanes[0], id: `lane-${index}` })), visibleLanes: 55, totalLanes: 55 };
  assert.match(renderSnapshot(manyLanes, { width: 88 }), /… 5 more lanes; use --json for complete records/);

  const cli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--attention", "--state-root", root, "--repo", "norm/example"], { encoding: "utf8" });
  assert.match(cli, /norm\/example/);
  assert.match(cli, /PR #42/);
  assert.doesNotMatch(cli, /Old completed lane/);
  const invalidColumnsCli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--attention", "--state-root", root, "--repo", "norm/example"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "not-a-number" },
  });
  assert.match(invalidColumnsCli, /AGENT BRIDGE MISSION CONTROL/);

  console.log("Mission Control tests passed: live defaults, native host visibility, attention/stale filtering, repository grouping, timeline rendering, and snapshot CLI behavior are verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}

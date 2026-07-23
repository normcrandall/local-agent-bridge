#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadMissionControlSnapshot,
  loadTimeline,
  parseRepositoryRemote,
  renderSnapshot,
  stripAnsi,
} from "../src/mission-control.mjs";

assert.equal(parseRepositoryRemote("https://token@example.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("git@github.com:owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("ssh://git@github.com/owner/repo.git"), "owner/repo");
assert.equal(parseRepositoryRemote("not-a-remote"), null);

const root = await mkdtemp(join(tmpdir(), "bridge-mission-control-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
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
    task: "Old completed lane",
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
    repository: "veliqon/control-plane",
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T11:57:00.000Z",
    items: [{ id: "issue-12", title: "Queued portfolio work", issueNumber: 12, status: "ready", writer: "claude", blockedBy: [] }],
  }));

  const attention = await loadMissionControlSnapshot({ stateRoot: root, now });
  assert.equal(attention.mode, "attention");
  assert.equal(attention.totalLanes, 4);
  assert.equal(attention.visibleLanes, 3);
  assert.deepEqual(attention.repositories.map((entry) => entry.repository), ["norm/example", "veliqon/control-plane"]);
  assert.equal(attention.providerActivity.codex, 1);
  assert.equal(attention.providerActivity.claude, 2);
  assert.ok(attention.lanes.some((lane) => lane.id === runningId && lane.repository === "veliqon/control-plane"));
  assert.ok(!attention.lanes.some((lane) => lane.id === completedId));

  const all = await loadMissionControlSnapshot({ stateRoot: root, showAll: true, repositoryFilter: "veliqon/control-plane", now });
  assert.equal(all.visibleLanes, 3);
  assert.ok(all.lanes.some((lane) => lane.id === completedId));

  const timeline = await loadTimeline(root, runningId, 5);
  assert.equal(timeline.length, 2);
  assert.equal(timeline.at(-1).summary, "Rendering repository views");
  const selectedIndex = attention.lanes.findIndex((lane) => lane.id === runningId);
  const rendered = renderSnapshot(attention, { selectedIndex, timeline, width: 88, height: 100, now });
  assert.match(rendered, /AGENT BRIDGE MISSION CONTROL/);
  assert.match(rendered, /veliqon\/control-plane/);
  assert.match(rendered, /Workspace:/);
  assert.match(rendered, /Narrative .*stale while heartbeat remains live/);
  assert.match(rendered, /Timing: active 12s \| dead 3s/);
  assert.ok(rendered.split("\n").every((line) => stripAnsi(line).length <= 88));

  const cli = execFileSync(process.execPath, [resolve(import.meta.dirname, "mission-control.mjs"), "--snapshot", "--state-root", root, "--repo", "norm/example"], { encoding: "utf8" });
  assert.match(cli, /norm\/example/);
  assert.match(cli, /PR #42/);
  assert.doesNotMatch(cli, /Old completed lane/);

  console.log("Mission Control tests passed: repository grouping, attention filtering, timeline rendering, and snapshot CLI behavior are verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Issue #55 dispatch/narrative fixtures: command allowlist admission and command-aware narrative.
import "./issue-55-allowlist-test.mjs";
import "./issue-55-narrative-test.mjs";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "agent-collaboration-test-"));
const fakeCodex = join(stateDirectory, "codex");
await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${resolve(root, "scripts/fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(fakeCodex, 0o700);
const cleanProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !name.startsWith("BRIDGE_")
    && !["CLAUDE_BRIDGE_ACTIVE", "CODEX_BRIDGE_ACTIVE", "ANTIGRAVITY_BRIDGE_ACTIVE"].includes(name)
  )),
);
const env = {
  ...cleanProcessEnv,
  BRIDGE_COLLABORATION_DIR: stateDirectory,
  CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs"),
  AGY_BIN: "/bin/echo",
};
const terminalReconcileId = "bridge-00000000-0000-4000-8000-000000000001";
await writeFile(join(stateDirectory, `${terminalReconcileId}.json`), `${JSON.stringify({
  id: terminalReconcileId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  status: "turn_limit", task: "stale terminal metadata", workspace: root, agents: ["claude"],
  workerPid: 999999, workerOwner: { id: terminalReconcileId, pid: 999999 },
  runtime: { turnCount: 1, activeCall: { agent: "claude", status: "running" } },
})}\n`);

async function connect(name, extraEnv = {}) {
  const client = new Client({ name, version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: [resolve(root, "scripts/collaboration-bridge-mcp.sh")],
    cwd: root,
    env: { ...env, ...extraEnv },
  });
  await client.connect(transport);
  return client;
}

async function waitForStop(client, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let view;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: id, detail: "full", includeTurns: 20 },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    view = result.structuredContent;
    if (!["queued", "running", "recovering", "cancelling"].includes(view.status)) return view;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${id}; last status: ${view?.status}`);
}

async function acknowledgeWake(client, view, summary = "Coordinator processed the wake event.") {
  assert.equal(view.coordinatorWake?.actionable, true);
  assert.equal(view.coordinatorWake?.status, "pending");
  const result = await client.callTool({
    name: "acknowledge_coordinator_wake",
    arguments: {
      collaborationId: view.id,
      sequence: view.coordinatorWake.sequence,
      provider: view.coordinatorWake.provider,
      summary,
      action: "processed",
    },
  });
  assert.equal(result.structuredContent.coordinatorWake.status, "acknowledged");
  return result.structuredContent;
}

let firstClient;
let secondClient;
let nestedClient;
let fallbackClient;
let heartbeatClient;
let cancellationClient;
let codexFallbackClient;
let completionClient;
let capacityClient;
let recoveryClient;
try {
  firstClient = await connect("collaboration-test-app-one");
  const tools = await firstClient.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "acknowledge_coordinator_wake",
    "acknowledge_handoff",
    "archive_collaboration",
    "authorize_portfolio_merge",
    "begin_portfolio_merge_validation",
    "cancel_collaboration",
    "continue_collaboration",
    "create_portfolio",
    "enqueue_portfolio_merge",
    "get_collaboration",
    "get_context_capsule",
    "get_portfolio",
    "list_collaborations",
    "list_portfolios",
    "merge_pull_request",
    "plan_portfolio",
    "prune_collaborations",
    "record_decision",
    "record_native_chair_turn",
    "record_portfolio_merge",
    "record_portfolio_merge_validation",
    "recover_portfolio_merge_validation",
    "refresh_portfolio_target",
    "release_issue_claim",
    "replay_incident",
    "start_collaboration",
    "update_portfolio_item",
    "wait_for_portfolio_lane",
  ]);
  const targetSha = "a".repeat(40);
  const firstHead = "b".repeat(40);
  const plannedPortfolio = await firstClient.callTool({
    name: "plan_portfolio",
    arguments: {
      maxParallel: 2,
      items: [
        { id: "101", title: "First", priority: 10, paths: ["src/first"] },
        { id: "102", title: "Second", priority: 9, blockedBy: ["101"], paths: ["src/second"] },
        { id: "103", title: "Third", priority: 8, paths: ["src/third"] },
      ],
    },
  });
  assert.deepEqual(plannedPortfolio.structuredContent.schedule.selected.map((item) => item.id), ["101", "103"]);
  let portfolio = (await firstClient.callTool({
    name: "create_portfolio",
    arguments: {
      objective: "Deliver independent work safely",
      workspace: ".",
      maxParallel: 2,
      targetBranch: "main",
      targetSha,
      items: [
        { id: "101", title: "First", priority: 10, paths: ["src/first"] },
        { id: "102", title: "Second", priority: 9, blockedBy: ["101"], paths: ["src/second"] },
      ],
    },
  })).structuredContent;
  assert.match(portfolio.id, /^helm-/);
  portfolio = (await firstClient.callTool({
    name: "update_portfolio_item",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", status: "implementing", writer: "claude" },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "enqueue_portfolio_merge",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", prNumber: 11, headSha: firstHead, priority: 10 },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "begin_portfolio_merge_validation",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "record_portfolio_merge_validation",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", outcome: "passed", checks: ["npm test"] },
  })).structuredContent;
  const mergeAuthorizationResult = await firstClient.callTool({
    name: "authorize_portfolio_merge",
    arguments: { portfolioId: portfolio.id, itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead },
  });
  assert.equal(mergeAuthorizationResult.structuredContent.authorization.authorized, true);
  portfolio = (await firstClient.callTool({
    name: "record_portfolio_merge",
    arguments: {
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      itemId: "101",
      expectedTargetSha: targetSha,
      expectedHeadSha: firstHead,
      mergedSha: "c".repeat(40),
    },
  })).structuredContent;
  assert.equal(portfolio.items.find((item) => item.id === "101").status, "merged");
  assert.equal(portfolio.schedule.selected[0].id, "102");

  const failedLaneId = "bridge-00000000-0000-4000-8000-000000000040";
  let failedLanePortfolio = (await firstClient.callTool({
    name: "create_portfolio",
    arguments: {
      objective: "Do not park on a success-only signal",
      workspace: ".",
      maxParallel: 1,
      targetBranch: "main",
      targetSha,
      items: [{ id: "40", title: "Rework", priority: 10, paths: ["src/rework"] }],
    },
  })).structuredContent;
  failedLanePortfolio = (await firstClient.callTool({
    name: "update_portfolio_item",
    arguments: {
      portfolioId: failedLanePortfolio.id,
      expectedRevision: failedLanePortfolio.revision,
      itemId: "40",
      status: "repairing",
      writer: "antigravity",
      collaborationId: failedLaneId,
      headSha: "d".repeat(40),
    },
  })).structuredContent;
  await writeFile(join(stateDirectory, `${failedLaneId}.json`), `${JSON.stringify({
    id: failedLaneId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    status: "failed",
    task: "Repair lane #40",
    workspace: root,
    agents: ["antigravity"],
    error: "No requested model is currently available.",
    runtime: {
      turnCount: 0,
      availableAgents: [],
      unavailableAgents: { antigravity: "Model unavailable." },
    },
  })}\n`);
  const failedLane = await firstClient.callTool({
    name: "wait_for_portfolio_lane",
    arguments: {
      portfolioId: failedLanePortfolio.id,
      itemId: "40",
      expectedHeadSha: "d".repeat(40),
      waitSeconds: 0,
    },
  });
  assert.equal(failedLane.structuredContent.outcome, "lane_stopped");
  assert.equal(failedLane.structuredContent.nextAction, "reassign_writer");
  assert.equal(failedLane.structuredContent.collaboration.status, "failed");
  assert.match(failedLane.structuredContent.reason, /No requested model/);
  assert.equal(failedLane.structuredContent.item.status, "failed");

  const reconciledTerminal = await firstClient.callTool({
    name: "get_collaboration", arguments: { collaborationId: terminalReconcileId, detail: "full", includeTurns: 0 },
  });
  assert.equal(reconciledTerminal.structuredContent.runtime.activeCall, null);
  assert.equal(reconciledTerminal.structuredContent.workerPid, null);

  const started = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Verify portable collaboration state",
      agents: ["claude"],
      maxTurns: 2,
      modelFallbacks: { claude: ["claude-opus-4-6", "claude-sonnet-5"], codex: ["5.6 terra"] },
      allowClaudeFable: true,
      verificationCommands: ["npm test"],
      handoffPath: ".bridge/test-handoffs/collaboration-review.md",
    },
  });
  assert.notEqual(started.isError, true);
  const id = started.structuredContent.id;
  assert.match(id, /^bridge-[0-9a-f-]{36}$/);
  await firstClient.close();
  firstClient = null;

  secondClient = await connect("collaboration-test-app-two");
  const firstRun = await waitForStop(secondClient, id);
  assert.equal(firstRun.status, "turn_limit", firstRun.error || "first run failed");
  assert.equal(firstRun.runtime.turnCount, 2);
  assert.equal(firstRun.turns.length, 2);
  assert.deepEqual(firstRun.modelFallbacks, {
    claude: ["claude-opus-4-6", "claude-sonnet-5"],
    codex: ["5.6 terra"],
  });
  assert.equal(firstRun.allowClaudeFable, true);
  assert.match(firstRun.turns[0].message, /--fallback-model/);
  assert.match(firstRun.turns[0].message, /claude-opus-4-6,claude-sonnet-5/);
  assert.match(firstRun.turns[0].message, /Bash\(npm test\)/);
  assert.match(firstRun.turns[0].message, /collaboration-review\.md/);

  completionClient = await connect("collaboration-test-completion", { FAKE_CLAUDE_HANDOFF: "1" });
  const completionStarted = await completionClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Return a durable completion receipt",
      agents: ["claude"],
      maxTurns: 1,
    },
  });
  const completionRun = await waitForStop(completionClient, completionStarted.structuredContent.id);
  assert.equal(completionRun.status, "agreed");
  assert.equal(completionRun.completion.phase, "awaiting_chair_verification");
  assert.equal(completionRun.completion.sequence, 1);
  assert.equal(completionRun.completion.acknowledged, false);
  assert.equal(completionRun.completion.lastHandoff.outcome, "completed");
  const completionCompact = await completionClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: completionRun.id, detail: "status", includeTurns: 0 },
  });
  assert.equal(completionCompact.structuredContent.completion.nextAction, "chair_verify");
  const prematureContinue = await completionClient.callTool({
    name: "continue_collaboration",
    arguments: { collaborationId: completionRun.id, message: "Continue without verifying", additionalTurns: 1 },
  });
  assert.equal(prematureContinue.isError, true);
  assert.match(prematureContinue.content.map((item) => item.text || "").join("\n"), /unacknowledged HANDOFF sequence 1/);
  const acknowledged = await completionClient.callTool({
    name: "acknowledge_handoff",
    arguments: {
      collaborationId: completionRun.id,
      sequence: 1,
      accepted: true,
      summary: "Chair verified the handoff.",
      verification: ["npm test: passed independently"],
      remaining: [],
    },
  });
  assert.equal(acknowledged.structuredContent.completion.phase, "verified_complete");
  assert.equal(acknowledged.structuredContent.completion.acknowledged, true);

  const chaired = await secondClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review work owned by the native Codex chair",
      agents: ["codex", "claude"],
      startAgent: "codex",
      chair: { provider: "codex", sessionId: "native-thread-1", workspace: root },
      maxTurns: 1,
    },
  });
  assert.notEqual(chaired.isError, true);
  assert.deepEqual(chaired.structuredContent.agents, ["claude"]);
  assert.equal(chaired.structuredContent.chair.source, "native-chair");
  const chairedDone = await waitForStop(secondClient, chaired.structuredContent.id);
  assert.equal(chairedDone.status, "turn_limit");
  const prematureNativeReceipt = await secondClient.callTool({
    name: "record_native_chair_turn",
    arguments: { collaborationId: chairedDone.id, summary: "Must wait for wake acknowledgement.", artifacts: [], verification: [] },
  });
  assert.equal(prematureNativeReceipt.isError, true);
  assert.match(prematureNativeReceipt.content.map((item) => item.text || "").join("\n"), /unacknowledged coordinator wake 1/);
  await acknowledgeWake(secondClient, chairedDone, "Codex received the peer review completion.");
  const nativeReceipt = await secondClient.callTool({
    name: "record_native_chair_turn",
    arguments: { collaborationId: chairedDone.id, summary: "Codex implemented locally.", artifacts: ["src/example.mjs"], verification: ["tests passed"] },
  });
  assert.equal(nativeReceipt.structuredContent.receipt.source, "native-chair");
  const protectedDecision = await secondClient.callTool({
    name: "record_decision",
    arguments: {
      collaborationId: chairedDone.id,
      question: "May the workflow spend money?",
      category: "money",
      owner: "user",
    },
  });
  assert.equal(protectedDecision.structuredContent.status, "needs_user");
  const protectedView = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: chairedDone.id, detail: "full", includeTurns: 0 },
  });
  assert.equal(protectedView.structuredContent.coordinatorWake.sequence, 2);
  assert.equal(protectedView.structuredContent.coordinatorWake.actionable, false);
  const resumedAfterUser = await secondClient.callTool({
    name: "continue_collaboration",
    arguments: { collaborationId: chairedDone.id, message: "The user declined the spend; continue without it.", additionalTurns: 1 },
  });
  assert.notEqual(resumedAfterUser.isError, true);
  assert.equal(resumedAfterUser.structuredContent.coordinatorWake.sequence, 2);
  assert.equal(resumedAfterUser.structuredContent.coordinatorWake.status, "acknowledged");
  await secondClient.callTool({ name: "cancel_collaboration", arguments: { collaborationId: chairedDone.id } });
  const archivedChair = await secondClient.callTool({ name: "archive_collaboration", arguments: { collaborationId: chairedDone.id } });
  assert.equal(archivedChair.structuredContent.archived, true);
  const rotatedNative = await secondClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review task zero after the native Codex chair implements it",
      agents: ["codex", "claude"], taskNumber: 0, mode: "work",
      chair: { provider: "codex", sessionId: "native-thread-2", workspace: root },
      maxTurns: 1,
    },
  });
  assert.notEqual(rotatedNative.isError, true);
  assert.equal(rotatedNative.structuredContent.chairOwnsWork, true);
  assert.equal(rotatedNative.structuredContent.mode, "review");
  assert.equal(rotatedNative.structuredContent.rotation.writer, "codex");
  await waitForStop(secondClient, rotatedNative.structuredContent.id);

  const compactPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id },
  });
  assert.deepEqual(compactPoll.structuredContent.turns, []);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "task"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "verificationCommands"), false);
  assert.doesNotMatch(compactPoll.content[0].text, /Latest turn/);

  const zeroTurnPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id, detail: "full", includeTurns: 0 },
  });
  assert.deepEqual(zeroTurnPoll.structuredContent.turns, []);
  assert.match(zeroTurnPoll.structuredContent.task, /portable collaboration state/);

  const incrementalPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id, detail: "full", includeTurns: 20, afterTurn: 1 },
  });
  assert.deepEqual(incrementalPoll.structuredContent.turns.map((turn) => turn.number), [2]);

  const continued = await secondClient.callTool({
    name: "continue_collaboration",
    arguments: {
      collaborationId: id,
      message: "Continue from this second app with the same collaboration.",
      additionalTurns: 2,
      modelFallbacks: { codex: ["5.6 base"] },
    },
  });
  assert.notEqual(continued.isError, true);
  assert.equal(continued.structuredContent.cleanup, null);
  const secondRun = await waitForStop(secondClient, id);
  assert.equal(secondRun.status, "turn_limit", secondRun.error || "second run failed");
  assert.equal(secondRun.runtime.turnCount, 4);
  assert.equal(secondRun.turns.length, 4);
  assert.deepEqual(secondRun.modelFallbacks, {
    claude: ["claude-opus-4-6", "claude-sonnet-5"],
    codex: ["5.6 base"],
  });
  assert.equal(secondRun.allowClaudeFable, false, "Fable authorization must not survive collaboration continuation");
  assert.match(secondRun.turns[2].message, /Continue from this second app/);
  assert.match(secondRun.turns[2].message, /Bash\(npm test\)/);
  assert.match(secondRun.turns[2].message, /collaboration-review\.md/);

  const listed = await secondClient.callTool({ name: "list_collaborations", arguments: {} });
  assert.equal(listed.structuredContent.collaborations[0].id, id);
  const cancelled = await secondClient.callTool({
    name: "cancel_collaboration",
    arguments: { collaborationId: id },
  });
  assert.equal(cancelled.structuredContent.status, "cancelled");

  nestedClient = await connect("collaboration-test-nested", { BRIDGE_DELEGATED_SESSION: "1" });
  const nested = await nestedClient.callTool({
    name: "start_collaboration",
    arguments: { task: "must be blocked", agents: ["claude", "antigravity"] },
  });
  assert.equal(nested.isError, true);
  assert.match(JSON.stringify(nested.content), /Nested collaboration mutation blocked/);

  fallbackClient = await connect("collaboration-test-fallback", {
    AGY_BIN: "/usr/bin/false",
  });
  const fallbackStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Proceed with Claude when Antigravity is unavailable",
      agents: ["claude", "antigravity"],
      maxTurns: 2,
    },
  });
  assert.notEqual(fallbackStarted.isError, true);
  const fallbackRun = await waitForStop(fallbackClient, fallbackStarted.structuredContent.id);
  assert.equal(fallbackRun.status, "turn_limit", fallbackRun.error || "fallback run failed");
  assert.deepEqual(fallbackRun.runtime.availableAgents, ["claude"]);
  assert.match(fallbackRun.runtime.unavailableAgents.antigravity, /exited|failed/i);
  assert.deepEqual(fallbackRun.turns.map((turn) => turn.agent), ["claude", "claude"]);

  const writerFailoverStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Continue the work lane with the next eligible writer",
      agents: ["antigravity", "claude"],
      startAgent: "antigravity",
      writer: "antigravity",
      mode: "work",
      workProfile: "implement",
      maxTurns: 1,
    },
  });
  const writerFailoverRun = await waitForStop(fallbackClient, writerFailoverStarted.structuredContent.id);
  assert.equal(writerFailoverRun.runtime.writer, "claude");
  assert.deepEqual(writerFailoverRun.turns.map((turn) => turn.agent), ["claude"]);
  assert.match(writerFailoverRun.runtime.unavailableAgents.antigravity, /exited|failed/i);

  recoveryClient = await connect("collaboration-test-provider-recovery", {
    AGY_BIN: resolve(root, "scripts/fake-antigravity.mjs"),
    FAKE_ANTIGRAVITY_OVERLOAD_MODELS: "provider-configured model",
  });
  const recoveryStarted = await recoveryClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Recover automatically when the only requested provider is temporarily unavailable",
      agents: ["antigravity"],
      maxTurns: 1,
      modelFallbacks: { antigravity: [] },
      providerRecovery: { enabled: true, maxAttempts: 1, backoffSeconds: [1] },
    },
  });
  const recoveryRun = await waitForStop(recoveryClient, recoveryStarted.structuredContent.id);
  assert.equal(recoveryRun.status, "failed");
  assert.equal(recoveryRun.providerRecoveryState.attempts, 1);
  assert.equal(recoveryRun.providerRecoveryState.status, "exhausted");
  assert.match(recoveryRun.error, /No requested model/);

  const singleTurnStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Run exactly one bounded peer handoff",
      agents: ["claude"],
      maxTurns: 1,
    },
  });
  assert.notEqual(singleTurnStarted.isError, true);
  const singleTurnRun = await waitForStop(fallbackClient, singleTurnStarted.structuredContent.id);
  assert.equal(singleTurnRun.status, "turn_limit", singleTurnRun.error || "single-turn run failed");
  assert.equal(singleTurnRun.runtime.turnCount, 1);
  assert.equal(singleTurnRun.turns.length, 1);

  codexFallbackClient = await connect("collaboration-test-codex-model-fallback", {
    CODEX_BRIDGE_CODEX_BIN: fakeCodex,
    BRIDGE_CODEX_HOME: join(stateDirectory, "codex-home"),
    FAKE_CODEX_OVERLOAD_MODELS: "5.6 sol",
  });
  const codexFallbackStarted = await codexFallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Finish the Codex turn after a model overload",
      agents: ["codex"],
      maxTurns: 1,
      models: { codex: "5.6 sol" },
      modelFallbacks: { codex: ["5.6 terra"] },
    },
  });
  assert.notEqual(codexFallbackStarted.isError, true);
  const codexFallbackRun = await waitForStop(codexFallbackClient, codexFallbackStarted.structuredContent.id);
  assert.equal(codexFallbackRun.status, "turn_limit", codexFallbackRun.error || "Codex fallback run failed");
  assert.equal(codexFallbackRun.runtime.turnCount, 1);
  assert.deepEqual(codexFallbackRun.turns[0].metadata.modelRouting, {
    requestedModel: "5.6 sol",
    model: "5.6 terra",
    fallbackUsed: true,
    attemptedModels: ["5.6 sol", "5.6 terra"],
    fallbackModels: ["5.6 terra"],
    fallbackManagedBy: "bridge",
  });

  heartbeatClient = await connect("collaboration-test-heartbeat", { FAKE_CLAUDE_DELAY_MS: "1200" });
  const heartbeatStarted = await heartbeatClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Expose provider-authored progress while work is active",
      agents: ["claude", "antigravity"],
      startAgent: "claude",
      maxTurns: 2,
    },
  });
  const heartbeatId = heartbeatStarted.structuredContent.id;
  let activeView;
  const activeDeadline = Date.now() + 5_000;
  while (Date.now() < activeDeadline) {
    const activeResult = await heartbeatClient.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: heartbeatId, includeTurns: 2 },
    });
    activeView = activeResult.structuredContent;
    if (activeView.runtime?.activeCall?.summary?.includes("Inspecting the requested files")) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(activeView.runtime.activeCall.agent, "claude");
  assert.equal(activeView.runtime.activeCall.status, "running");
  assert.match(activeView.runtime.activeCall.summary, /Inspecting the requested files/);
  assert.ok(activeView.runtime.activeCall.heartbeatAt);
  const heartbeatRun = await waitForStop(heartbeatClient, heartbeatId);
  assert.ok(["agreed", "turn_limit"].includes(heartbeatRun.status), heartbeatRun.error || "heartbeat run failed");

  capacityClient = await connect("collaboration-test-provider-capacity", { FAKE_CLAUDE_DELAY_MS: "2000" });
  const capacityStarts = await Promise.all([1, 2, 3].map((number) => capacityClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: `Parallel read-only review ${number}`,
      agents: ["claude"],
      maxTurns: 1,
      providerConcurrency: { claude: { work: 1, review: 2 } },
    },
  })));
  const capacityIds = capacityStarts.map((result) => result.structuredContent.id);
  let capacityViews = [];
  const capacityDeadline = Date.now() + 5_000;
  while (Date.now() < capacityDeadline) {
    capacityViews = await Promise.all(capacityIds.map(async (collaborationId) => {
      const result = await capacityClient.callTool({
        name: "get_collaboration",
        arguments: { collaborationId, detail: "full", includeTurns: 0 },
      });
      return result.structuredContent;
    }));
    const leased = capacityViews.filter((view) => view.runtime?.activeCall?.capacity?.slot);
    const waiting = capacityViews.filter((view) => view.runtime?.activeCall?.phase === "waiting_capacity");
    if (leased.length === 2 && waiting.length === 1) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.equal(
    capacityViews.filter((view) => view.runtime?.activeCall?.capacity?.slot).length,
    2,
    JSON.stringify(capacityViews.map((view) => ({
      status: view.status,
      error: view.error,
      activeCall: view.runtime?.activeCall,
    })), null, 2),
  );
  assert.equal(capacityViews.filter((view) => view.runtime?.activeCall?.phase === "waiting_capacity").length, 1);
  const capacityRuns = await Promise.all(capacityIds.map((collaborationId) => waitForStop(
    capacityClient,
    collaborationId,
    10_000,
  )));
  assert.ok(capacityRuns.every((view) => view.runtime.turnCount === 1));

  cancellationClient = await connect("collaboration-test-active-cancellation", { FAKE_CLAUDE_DELAY_MS: "10000" });
  const cancellationStarted = await cancellationClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Cancel an active provider process",
      agents: ["claude", "antigravity"],
      startAgent: "claude",
      maxTurns: 2,
    },
  });
  const cancellationId = cancellationStarted.structuredContent.id;
  const cancellationDeadline = Date.now() + 5_000;
  let cancellationView;
  while (Date.now() < cancellationDeadline) {
    const result = await cancellationClient.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: cancellationId, includeTurns: 2 },
    });
    cancellationView = result.structuredContent;
    if (cancellationView.runtime?.activeCall) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(cancellationView.runtime.activeCall.agent, "claude");
  const activeCancellation = await cancellationClient.callTool({
    name: "cancel_collaboration",
    arguments: { collaborationId: cancellationId },
  });
  assert.equal(activeCancellation.structuredContent.status, "cancelled");
  assert.equal(activeCancellation.structuredContent.workerPid, null);
  assert.equal(activeCancellation.structuredContent.runtime.activeCall, null);

  const cpTestResult = spawnSync(process.execPath, [resolve(root, "scripts/collaboration-control-plane-test.mjs")], { stdio: "inherit" });
  assert.equal(cpTestResult.status, 0, "Control plane unit tests failed");

  console.log("Persistent collaboration and unavailable-provider fallback tests passed without invoking any model.");
} finally {
  await firstClient?.close().catch(() => {});
  await secondClient?.close().catch(() => {});
  await nestedClient?.close().catch(() => {});
  await fallbackClient?.close().catch(() => {});
  await heartbeatClient?.close().catch(() => {});
  await cancellationClient?.close().catch(() => {});
  await codexFallbackClient?.close().catch(() => {});
  await completionClient?.close().catch(() => {});
  await capacityClient?.close().catch(() => {});
  await recoveryClient?.close().catch(() => {});
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(resolve(root, ".bridge/test-handoffs"), { recursive: true, force: true });
}

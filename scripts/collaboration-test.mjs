import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    if (!["queued", "running", "cancelling"].includes(view.status)) return view;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${id}; last status: ${view?.status}`);
}

let firstClient;
let secondClient;
let nestedClient;
let fallbackClient;
let heartbeatClient;
let cancellationClient;
let codexFallbackClient;
try {
  firstClient = await connect("collaboration-test-app-one");
  const tools = await firstClient.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "archive_collaboration",
    "cancel_collaboration",
    "continue_collaboration",
    "get_collaboration",
    "list_collaborations",
    "prune_collaborations",
    "record_decision",
    "record_native_chair_turn",
    "start_collaboration",
  ]);
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
  assert.match(firstRun.turns[0].message, /--fallback-model/);
  assert.match(firstRun.turns[0].message, /claude-opus-4-6,claude-sonnet-5/);
  assert.match(firstRun.turns[0].message, /Bash\(npm test\)/);
  assert.match(firstRun.turns[0].message, /collaboration-review\.md/);

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
  const nativeReceipt = await secondClient.callTool({
    name: "record_native_chair_turn",
    arguments: { collaborationId: chairedDone.id, summary: "Codex implemented locally.", artifacts: ["src/example.mjs"], verification: ["tests passed"] },
  });
  assert.equal(nativeReceipt.structuredContent.receipt.source, "native-chair");
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

  console.log("Persistent collaboration and unavailable-provider fallback tests passed without invoking any model.");
} finally {
  await firstClient?.close().catch(() => {});
  await secondClient?.close().catch(() => {});
  await nestedClient?.close().catch(() => {});
  await fallbackClient?.close().catch(() => {});
  await heartbeatClient?.close().catch(() => {});
  await cancellationClient?.close().catch(() => {});
  await codexFallbackClient?.close().catch(() => {});
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(resolve(root, ".bridge/test-handoffs"), { recursive: true, force: true });
}

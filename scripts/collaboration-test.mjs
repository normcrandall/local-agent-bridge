import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "agent-collaboration-test-"));
const cleanProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("BRIDGE_")),
);
const env = {
  ...cleanProcessEnv,
  BRIDGE_COLLABORATION_DIR: stateDirectory,
  CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs"),
  AGY_BIN: "/bin/echo",
};

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
      arguments: { collaborationId: id, includeTurns: 20 },
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
try {
  firstClient = await connect("collaboration-test-app-one");
  const tools = await firstClient.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "cancel_collaboration",
    "continue_collaboration",
    "get_collaboration",
    "list_collaborations",
    "start_collaboration",
  ]);

  const started = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Verify portable collaboration state",
      agents: ["claude"],
      maxTurns: 2,
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
  assert.match(firstRun.turns[0].message, /Bash\(npm test\)/);
  assert.match(firstRun.turns[0].message, /collaboration-review\.md/);

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
    },
  });
  assert.notEqual(continued.isError, true);
  const secondRun = await waitForStop(secondClient, id);
  assert.equal(secondRun.status, "turn_limit", secondRun.error || "second run failed");
  assert.equal(secondRun.runtime.turnCount, 4);
  assert.equal(secondRun.turns.length, 4);
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
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(resolve(root, ".bridge/test-handoffs"), { recursive: true, force: true });
}

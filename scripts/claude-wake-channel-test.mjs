import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "agent-wake-channel-test-"));
const id = "bridge-00000000-0000-4000-8000-000000000042";
const now = new Date().toISOString();
const statePath = join(stateDirectory, `${id}.json`);
await writeFile(statePath, `${JSON.stringify({
  id,
  createdAt: now,
  updatedAt: now,
  status: "turn_limit",
  workspace: root,
  chair: { provider: "claude", source: "native-chair", workspace: root },
  runtime: { turnCount: 1, activeCall: null },
  coordinatorWake: {
    sequence: 1,
    key: `${id}:1:1:0:turn_limit:phase_stopped:continue`,
    provider: "claude",
    sessionId: null,
    workspace: root,
    kind: "phase_stopped",
    actionable: true,
    nextAction: "continue",
    summary: "The delegated review turn completed.",
    status: "pending",
    sourceStatus: "turn_limit",
    sourceTurnCount: 1,
    sourceHandoffSequence: null,
    createdAt: now,
    deliveredAt: null,
    delivery: null,
    acknowledgedAt: null,
    acknowledgement: null,
  },
})}\n`);

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
});

const client = new Client({ name: "claude-wake-channel-test", version: "0.1.0" });
let notification;
let resolveNotification;
const notificationPromise = new Promise((resolvePromise) => {
  resolveNotification = resolvePromise;
});
client.setNotificationHandler(ChannelNotificationSchema, (received) => {
  notification = received;
  resolveNotification(received);
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "src/claude-wake-channel.mjs")],
  cwd: root,
  env: {
    ...process.env,
    BRIDGE_COLLABORATION_DIR: stateDirectory,
    BRIDGE_WORKSPACE_ROOT: root,
    AGENT_BRIDGE_WAKE_POLL_MS: "500",
  },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["acknowledge_wake"]);
  await Promise.race([
    notificationPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Claude channel wake.")), 5_000)),
  ]);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.match(notification.params.content, new RegExp(id));
  assert.match(notification.params.content, /Next action: continue/);
  assert.equal(notification.params.meta?.wake_sequence, "1");

  let delivered;
  const deliveryDeadline = Date.now() + 2_000;
  while (Date.now() < deliveryDeadline) {
    delivered = JSON.parse(await readFile(statePath, "utf8"));
    if (delivered.coordinatorWake.status === "delivered") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(delivered.coordinatorWake.status, "delivered");
  assert.equal(delivered.coordinatorWake.delivery.adapter, "claude_channel");

  const acknowledged = await client.callTool({
    name: "acknowledge_wake",
    arguments: {
      collaborationId: id,
      sequence: 1,
      summary: "Claude resumed and processed the delegated result.",
      action: "continued",
    },
  });
  assert.equal(acknowledged.structuredContent.wake.status, "acknowledged");
  assert.equal(acknowledged.structuredContent.wake.acknowledgement.provider, "claude");

  const outsideWorkspace = JSON.parse(await readFile(statePath, "utf8"));
  outsideWorkspace.workspace = "/tmp/unrelated-workspace";
  await writeFile(statePath, `${JSON.stringify(outsideWorkspace)}\n`);
  await assert.rejects(
    client.callTool({
      name: "acknowledge_wake",
      arguments: {
        collaborationId: id,
        sequence: 1,
        summary: "Must not cross workspace boundaries.",
      },
    }),
    /outside this Claude channel workspace/,
  );
  console.log("Claude wake channel test passed: push notification, durable delivery, and explicit acknowledgement.");
} finally {
  await client.close().catch(() => {});
  await rm(stateDirectory, { recursive: true, force: true });
}

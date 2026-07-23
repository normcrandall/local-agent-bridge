#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboration, readCollaboration, updateCollaboration } from "../src/collaboration-store.mjs";
import { acknowledgeCoordinatorWake } from "../src/coordinator-wake.mjs";
import { scanPendingUserAttention, signalUserAttention } from "../src/user-attention.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-user-attention-"));
process.env.BRIDGE_COLLABORATION_DIR = join(root, "state");
const now = Date.parse("2026-07-23T12:00:00.000Z");
const calls = [];
const run = async (command, args) => { calls.push({ command, args }); return { stdout: "", stderr: "" }; };

try {
  const collaboration = await createCollaboration(root, {
    task: "Wait for an owner decision",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    chair: { provider: "codex", source: "native-chair" },
    status: "needs_user",
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "needs_user",
      actionable: false,
      nextAction: "needs_user",
      summary: "Choose whether to approve the external expense.",
      status: "pending",
      createdAt: new Date(now).toISOString(),
    },
  });

  const first = await signalUserAttention(root, collaboration.id, { now, platform: "darwin", run });
  assert.equal(first.delivered, true);
  assert.equal(first.adapter, "macos_notification_center");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/osascript");
  assert.ok(calls[0].args.some((argument) => String(argument).includes("Agent Bridge needs your input")));
  assert.doesNotMatch(JSON.stringify(calls[0]), /external expense/, "lock-screen notification text must not expose the decision summary");
  let state = await readCollaboration(root, collaboration.id);
  assert.equal(state.coordinatorWake.userAttention.status, "delivered");
  assert.equal(state.coordinatorWake.userAttention.attempt, 1);
  const deliveredStateUpdatedAt = state.updatedAt;

  const deduplicated = await signalUserAttention(root, collaboration.id, { now: now + 60_000, platform: "darwin", run });
  assert.equal(deduplicated.reason, "not_due_or_not_needed");
  assert.equal(calls.length, 1);
  state = await readCollaboration(root, collaboration.id);
  assert.equal(state.updatedAt, deliveredStateUpdatedAt, "a not-due reminder must not churn collaboration state");

  const reminder = await scanPendingUserAttention(root, { now: now + 16 * 60_000, platform: "darwin", run });
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].delivered, true);
  assert.equal(calls.length, 2);
  state = await readCollaboration(root, collaboration.id);
  assert.equal(state.coordinatorWake.userAttention.attempt, 2);

  await acknowledgeCoordinatorWake(root, collaboration.id, 1, { provider: "codex", action: "needs_user" });
  const afterAcknowledgement = await signalUserAttention(root, collaboration.id, { now: now + 32 * 60_000, platform: "darwin", run, force: true });
  assert.equal(afterAcknowledgement.reason, "not_due_or_not_needed");
  assert.equal(calls.length, 2);

  const failed = await createCollaboration(root, {
    task: "Retry a failed desktop signal",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    chair: { provider: "codex", source: "native-chair" },
    status: "needs_user",
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "needs_user",
      actionable: false,
      nextAction: "needs_user",
      summary: "A protected decision is pending.",
      status: "pending",
      createdAt: new Date(now).toISOString(),
    },
  });
  const failRun = async () => { throw new Error("notification service unavailable"); };
  const firstFailure = await signalUserAttention(root, failed.id, { now, platform: "darwin", run: failRun });
  assert.equal(firstFailure.delivered, false);
  state = await readCollaboration(root, failed.id);
  assert.equal(state.coordinatorWake.userAttention.status, "failed");
  const recovered = await signalUserAttention(root, failed.id, { now: now + 1_000, platform: "darwin", run });
  assert.equal(recovered.delivered, true);

  await updateCollaboration(root, failed.id, (current) => ({ ...current, status: "agreed" }));
  console.log("User attention tests passed: immediate delivery, deduplicated reminders, acknowledgement stop, and failed-delivery recovery are verified.");
} finally {
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

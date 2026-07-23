#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCollaboration, readCollaboration, updateCollaboration } from "../src/collaboration-store.mjs";
import { acknowledgeCoordinatorWake } from "../src/coordinator-wake.mjs";
import { attentionMessage, deliverAttentionNotification, scanPendingUserAttention, signalUserAttention } from "../src/user-attention.mjs";

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
  assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(root.split("/").at(-1)), "workspace details must be opt-in");
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

  const chairless = await createCollaboration(root, {
    task: "Wait for input without a native chair",
    workspace: root,
    agents: ["claude"],
    participants: ["claude"],
    status: "needs_user",
  });
  const chairlessDelivery = await signalUserAttention(root, chairless.id, { now, platform: "darwin", run });
  assert.equal(chairlessDelivery.delivered, true);
  state = await readCollaboration(root, chairless.id);
  assert.equal(state.coordinatorWake, undefined);
  assert.equal(state.userAttention.status, "delivered");
  assert.equal(state.userAttention.attempt, 1);

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
  const firstFailure = await signalUserAttention(root, failed.id, { now, platform: "darwin", run: failRun, clock: () => now + 500 });
  assert.equal(firstFailure.delivered, false);
  state = await readCollaboration(root, failed.id);
  assert.equal(state.coordinatorWake.userAttention.status, "failed");
  assert.equal(state.coordinatorWake.userAttention.completedAt, new Date(now + 500).toISOString());
  const backedOff = await signalUserAttention(root, failed.id, { now: now + 30_000, platform: "darwin", run });
  assert.equal(backedOff.reason, "not_due_or_not_needed");
  const recovered = await signalUserAttention(root, failed.id, { now: now + 61_000, platform: "darwin", run });
  assert.equal(recovered.delivered, true);

  const disabled = await createCollaboration(root, {
    task: "Keep desktop notifications disabled",
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
      summary: "A disabled notification should not churn state.",
      status: "pending",
      createdAt: new Date(now).toISOString(),
    },
  });
  const disabledEnvironment = { AGENT_BRIDGE_ATTENTION_NOTIFICATIONS: "off" };
  const disabledDelivery = await signalUserAttention(root, disabled.id, { now, platform: "darwin", run, environment: disabledEnvironment });
  assert.equal(disabledDelivery.reason, "disabled_by_policy");
  const disabledState = await readCollaboration(root, disabled.id);
  const disabledUpdatedAt = disabledState.updatedAt;
  assert.equal(disabledState.coordinatorWake.userAttention.attempt, 1);
  await scanPendingUserAttention(root, { now: now + 60 * 60_000, platform: "darwin", run, environment: disabledEnvironment });
  state = await readCollaboration(root, disabled.id);
  assert.equal(state.updatedAt, disabledUpdatedAt, "disabled notifications must not create a periodic write loop");
  assert.equal(state.coordinatorWake.userAttention.attempt, 1);

  const hiddenMessage = attentionMessage({ workspace: "/private/client-secret", coordinatorWake: {} });
  assert.equal(hiddenMessage.subtitle, "Protected decision");
  const detailedMessage = attentionMessage({ workspace: "/private/client-secret", coordinatorWake: {} }, {
    environment: { AGENT_BRIDGE_ATTENTION_DETAIL: "repository" },
  });
  assert.equal(detailedMessage.subtitle, "client-secret");

  const linuxCalls = [];
  await deliverAttentionNotification(hiddenMessage, {
    platform: "linux",
    environment: { HOME: "/tmp/home", PATH: "/untrusted/bin" },
    run: async (command, args, options) => { linuxCalls.push({ command, args, options }); },
  });
  assert.equal(linuxCalls[0].command, "/usr/bin/notify-send");
  assert.equal(linuxCalls[0].options.env.PATH, "/usr/bin:/bin");

  const cli = JSON.parse(execFileSync(process.execPath, [
    resolve(import.meta.dirname, "user-attention-cli.mjs"),
    "list",
    "--state-root",
    process.env.BRIDGE_COLLABORATION_DIR,
  ], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, BRIDGE_COLLABORATION_DIR: "" } }));
  assert.equal(cli.stateRoot, process.env.BRIDGE_COLLABORATION_DIR);
  assert.ok(cli.pending.some((entry) => entry.collaborationId === disabled.id), "CLI must read the explicit machine state root, not cwd");

  await updateCollaboration(root, failed.id, (current) => ({ ...current, status: "agreed" }));
  console.log("User attention tests passed: immediate delivery, deduplicated reminders, bounded failure recovery, disabled-policy stability, privacy, and acknowledgement stop are verified.");
} finally {
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

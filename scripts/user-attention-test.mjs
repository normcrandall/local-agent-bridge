#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    githubReview: { repository: "veliqon/example", prNumber: 42, headSha: "a".repeat(40) },
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
  assert.equal(first.adapter, "macos_terminal_notifier");
  assert.equal(first.actionable, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /terminal-notifier$/);
  const actionUrl = calls[0].args.find((argument) => String(argument).startsWith("file://"));
  assert.ok(actionUrl, "the click action must open the repository-filtered Mission Control launcher");
  assert.match(await readFile(fileURLToPath(actionUrl), "utf8"), /bridge' mc --attention --repo 'veliqon\/example'/);
  assert.ok(calls[0].args.some((argument) => String(argument).includes("Agent Bridge needs your input")));
  assert.ok(calls[0].args.some((argument) => String(argument).includes("veliqon/example")));
  assert.ok(calls[0].args.some((argument) => String(argument).includes(collaboration.id.slice(0, 24))));
  assert.doesNotMatch(JSON.stringify(calls[0]), /external expense/, "lock-screen notification text must not expose the decision summary");
  const visibleNotificationArguments = calls[0].args.slice(0, calls[0].args.indexOf("-open"));
  assert.doesNotMatch(JSON.stringify(visibleNotificationArguments), new RegExp(root.split("/").at(-1)), "a known repository should replace the visible workspace fallback");
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
  assert.equal(reminder.length, 0);
  assert.equal(calls.length, 1);
  state = await readCollaboration(root, collaboration.id);
  assert.equal(state.coordinatorWake.userAttention.attempt, 1);

  await acknowledgeCoordinatorWake(root, collaboration.id, 1, { provider: "codex", action: "needs_user" });
  const afterAcknowledgement = await signalUserAttention(root, collaboration.id, { now: now + 32 * 60_000, platform: "darwin", run, force: true });
  assert.equal(afterAcknowledgement.reason, "not_due_or_not_needed");
  assert.equal(calls.length, 1);

  const repeatRequest = await createCollaboration(root, {
    task: "Alert again for a genuinely new immutable request",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    chair: { provider: "codex", source: "native-chair" },
    status: "needs_user",
    githubReview: { repository: "veliqon/example", prNumber: 45, headSha: "d".repeat(40) },
    userAttention: {
      status: "delivered",
      requestedAt: new Date(now - 60_000).toISOString(),
      lastDeliveredAt: new Date(now - 60_000).toISOString(),
    },
    coordinatorWake: {
      sequence: 2,
      provider: "codex",
      kind: "needs_user",
      nextAction: "needs_user",
      summary: "A different protected decision is pending.",
      status: "pending",
      createdAt: new Date(now + 1_000).toISOString(),
    },
  });
  const callsBeforeRepeatRequest = calls.length;
  const repeatResults = await scanPendingUserAttention(root, { now: now + 2_000, platform: "darwin", run });
  assert.ok(repeatResults.some((result) => result.collaborationId === repeatRequest.id && result.delivered));
  assert.equal(calls.length, callsBeforeRepeatRequest + 1, "a new wake must not be silenced by a legacy top-level delivered receipt");
  state = await readCollaboration(root, repeatRequest.id);
  assert.equal(state.coordinatorWake.userAttention.requestedAt, state.createdAt);
  assert.notEqual(state.coordinatorWake.userAttention.requestedAt, state.userAttention.requestedAt);

  const chairless = await createCollaboration(root, {
    task: "Wait for input without a native chair",
    workspace: root,
    agents: ["claude"],
    participants: ["claude"],
    status: "needs_user",
  });
  const chairlessDelivery = await signalUserAttention(root, chairless.id, { now, platform: "darwin", run });
  assert.equal(chairlessDelivery.delivered, false);
  assert.equal(chairlessDelivery.reason, "not_due_or_not_needed");
  state = await readCollaboration(root, chairless.id);
  assert.equal(state.coordinatorWake, undefined);
  assert.equal(state.userAttention, undefined);

  const providerStillRunning = await createCollaboration(root, {
    task: "Resolve a question autonomously before stopping",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    status: "needs_user",
    runtime: { activeCall: { agent: "claude", status: "running" } },
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "needs_user",
      nextAction: "needs_user",
      status: "pending",
      createdAt: new Date(now).toISOString(),
    },
  });
  const activeDelivery = await signalUserAttention(root, providerStillRunning.id, { now, platform: "darwin", run });
  assert.equal(activeDelivery.reason, "not_due_or_not_needed");

  const historical = await createCollaboration(root, {
    task: "Preserve an old request without alerting",
    workspace: root,
    agents: ["claude"],
    participants: ["claude"],
    status: "needs_user",
    createdAt: new Date(now - 7 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now - 7 * 60 * 60_000).toISOString(),
  });
  const callsBeforeHistoricalScan = calls.length;
  await scanPendingUserAttention(root, { now, platform: "darwin", run });
  state = await readCollaboration(root, historical.id);
  assert.equal(state.userAttention, undefined);
  assert.equal(calls.length, callsBeforeHistoricalScan, "historical requests must remain durable without generating desktop alerts");

  const oldBlocking = await createCollaboration(root, {
    task: "Keep an old stopped-provider request inspectable",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    status: "needs_user",
    createdAt: new Date(now - 8 * 60 * 60_000).toISOString(),
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "needs_user",
      nextAction: "needs_user",
      summary: "An old protected decision remains unresolved.",
      status: "pending",
      createdAt: new Date(now - 8 * 60 * 60_000).toISOString(),
    },
  });

  const recentEscalation = await createCollaboration(root, {
    task: "Raise a new protected decision in an old collaboration",
    workspace: root,
    agents: ["claude"],
    participants: ["claude"],
    status: "needs_user",
    createdAt: new Date(now - 9 * 60 * 60_000).toISOString(),
    completion: {
      lastHandoff: { recordedAt: new Date(now - 7 * 60 * 60_000).toISOString() },
    },
    decisionEscalation: {
      action: "needs_user",
      reason: "A new authorization boundary was reached.",
      recordedAt: new Date(now - 1_000).toISOString(),
    },
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "needs_user",
      nextAction: "needs_user",
      summary: "A new authorization boundary was reached.",
      status: "pending",
      createdAt: new Date(now - 1_000).toISOString(),
    },
  });
  const callsBeforeRecentEscalation = calls.length;
  const escalationResults = await scanPendingUserAttention(root, { now, platform: "darwin", run });
  assert.ok(escalationResults.some((result) => result.collaborationId === recentEscalation.id && result.delivered));
  assert.equal(calls.length, callsBeforeRecentEscalation + 1, "the newest request marker must win over an old handoff");

  const failed = await createCollaboration(root, {
    task: "Retry a failed desktop signal",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    chair: { provider: "codex", source: "native-chair" },
    status: "needs_user",
    githubReview: { repository: "veliqon/example", prNumber: 43, headSha: "b".repeat(40) },
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
    githubReview: { repository: "veliqon/example", prNumber: 44, headSha: "c".repeat(40) },
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

  const fallbackMessage = attentionMessage({ id: "bridge-example", workspace: "/private/client-secret", coordinatorWake: {} });
  assert.equal(fallbackMessage.subtitle, "client-secret · bridge-example");
  const repositoryMessage = attentionMessage({ id: "bridge-example", githubReview: { repository: "veliqon/example" }, workspace: "/private/client-secret" });
  assert.equal(repositoryMessage.subtitle, "veliqon/example · bridge-example");
  assert.match(repositoryMessage.body, /bridge mc --attention --repo veliqon\/example/);
  const genericMessage = attentionMessage(
    { id: "bridge-example", githubReview: { repository: "veliqon/example" }, workspace: "/private/client-secret" },
    { environment: { AGENT_BRIDGE_ATTENTION_DETAIL: "generic" } },
  );
  assert.equal(genericMessage.subtitle, "Protected decision");
  assert.doesNotMatch(genericMessage.body, /veliqon\/example|bridge-example|client-secret/);

  const linuxCalls = [];
  await deliverAttentionNotification(fallbackMessage, {
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
  assert.ok(cli.pending.some((entry) => entry.collaborationId === disabled.id && entry.repository === "veliqon/example" && entry.status === "needs_user"));
  assert.ok(cli.historical.some((entry) => entry.collaborationId === oldBlocking.id), "old unresolved requests must remain inspectable without alerting");

  const filteredCli = JSON.parse(execFileSync(process.execPath, [
    resolve(import.meta.dirname, "user-attention-cli.mjs"),
    "list",
    "--state-root",
    process.env.BRIDGE_COLLABORATION_DIR,
    "--repo",
    "veliqon/example",
  ], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, BRIDGE_COLLABORATION_DIR: "" } }));
  assert.ok(filteredCli.pending.length > 0);
  assert.ok([...filteredCli.pending, ...filteredCli.historical].every((entry) => entry.repository === "veliqon/example"));

  await updateCollaboration(root, failed.id, (current) => ({ ...current, status: "agreed" }));
  console.log("User attention tests passed: stopped-provider gating, one-shot delivery, repository identity, fresh-request filtering, bounded failure recovery, disabled-policy stability, and acknowledgement stop are verified.");
} finally {
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

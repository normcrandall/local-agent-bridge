#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";
import {
  acknowledgeCoordinatorWake,
  classifyCoordinatorWake,
  coordinatorHookDecision,
  enqueueCoordinatorWake,
  listCoordinatorStates,
  markCoordinatorWakeDelivered,
} from "../src/coordinator-wake.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-wake-test-"));
process.env.BRIDGE_COLLABORATION_DIR = join(root, "state");

try {
  const active = await createCollaboration(root, {
    task: "Review the implementation",
    workspace: root,
    agents: ["claude"],
    participants: ["codex", "claude"],
    chair: { provider: "codex", source: "native-chair" },
    runtime: { turnCount: 0 },
  });
  const parentStates = await listCoordinatorStates({ root, provider: "codex", cwd: join(root, "..") });
  assert.equal(parentStates.length, 0);
  const laneWorkspace = join(root, ".bridge", "worktrees", "lane-one");
  await updateCollaboration(root, active.id, (current) => ({ ...current, workspace: laneWorkspace }));
  const laneStates = await listCoordinatorStates({ root, provider: "codex", cwd: root });
  assert.equal(laneStates.length, 1);
  await updateCollaboration(root, active.id, (current) => ({ ...current, workspace: root }));
  let states = await listCoordinatorStates({ root, provider: "codex", cwd: root });
  let decision = coordinatorHookDecision(states);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /still queued/);

  await updateCollaboration(root, active.id, (current) => ({
    ...current,
    status: "agreed",
    runSequence: 1,
    runtime: { ...current.runtime, turnCount: 2 },
    completion: {
      sequence: 1,
      acknowledged: false,
      nextAction: "chair_verify",
      lastHandoff: {
        agent: "claude",
        outcome: "completed",
        summary: "Review completed with no findings.",
      },
    },
  }));
  states = await listCoordinatorStates({ root, provider: "codex", cwd: root });
  decision = coordinatorHookDecision(states);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /wake is still being finalized/);

  const queued = await enqueueCoordinatorWake(root, active.id);
  assert.equal(queued.coordinatorWake.sequence, 1);
  assert.equal(queued.coordinatorWake.kind, "handoff_ready");
  assert.equal(queued.coordinatorWake.status, "pending");
  assert.equal(classifyCoordinatorWake(queued).actionable, true);

  const idempotent = await enqueueCoordinatorWake(root, active.id);
  assert.equal(idempotent.coordinatorWake.sequence, 1);

  states = await listCoordinatorStates({ root, provider: "codex", cwd: root });
  decision = coordinatorHookDecision(states);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /wake 1/);
  assert.match(decision.reason, /acknowledge_coordinator_wake/);

  const delivered = await markCoordinatorWakeDelivered(root, active.id, 1, {
    adapter: "test",
  });
  assert.equal(delivered.coordinatorWake.status, "delivered");

  const acknowledged = await acknowledgeCoordinatorWake(root, active.id, 1, {
    provider: "codex",
    summary: "Verified and processed.",
    action: "completed",
  });
  assert.equal(acknowledged.coordinatorWake.status, "acknowledged");
  states = await listCoordinatorStates({ root, provider: "codex", cwd: root });
  assert.equal(states.length, 0);

  const protectedState = await createCollaboration(root, {
    task: "Protected decision",
    workspace: root,
    agents: ["antigravity"],
    participants: ["claude", "antigravity"],
    chair: { provider: "claude", source: "native-chair" },
    runtime: { turnCount: 1 },
  });
  await updateCollaboration(root, protectedState.id, (current) => ({
    ...current,
    status: "needs_user",
    completion: {
      sequence: 1,
      acknowledged: false,
      nextAction: "needs_user",
      lastHandoff: {
        agent: "antigravity",
        outcome: "blocked",
        summary: "User authorization is required.",
      },
    },
  }));
  const protectedWake = await enqueueCoordinatorWake(root, protectedState.id);
  assert.equal(protectedWake.coordinatorWake.actionable, false);
  states = await listCoordinatorStates({ root, provider: "claude", cwd: root });
  decision = coordinatorHookDecision(states);
  assert.equal(decision.decision, "allow");
  assert.match(decision.systemMessage, /requires user input/);

  console.log("Coordinator wake tests passed: active hold-open, durable idempotent wake, delivery, acknowledgement, and protected user boundary.");
} finally {
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

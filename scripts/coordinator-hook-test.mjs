#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "agent-coordinator-hook-test-"));
const id = "bridge-00000000-0000-4000-8000-000000000043";
const now = new Date().toISOString();
const statePath = join(stateDirectory, `${id}.json`);

function runHook(provider, event, input = {}) {
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts/coordinator-hook.mjs"),
    provider,
    event,
  ], {
    cwd: root,
    env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateDirectory },
    input: JSON.stringify({ cwd: root, ...input }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || "{}");
}

try {
  const activeId = "bridge-00000000-0000-4000-8000-000000000041";
  await writeFile(join(stateDirectory, `${activeId}.json`), `${JSON.stringify({
    id: activeId,
    createdAt: now,
    updatedAt: new Date(Date.now() - 1_000).toISOString(),
    status: "running",
    workspace: root,
    chair: { provider: "antigravity", source: "native-chair", workspace: root },
    runtime: { turnCount: 0, activeCall: { agent: "claude", status: "running" } },
  })}\n`);
  const activeStart = runHook("antigravity", "session_start", { hook_event_name: "SessionStart" });
  assert.match(activeStart.hookSpecificOutput.additionalContext, /still running/);
  const activeStop = runHook("antigravity", "stop");
  assert.equal(activeStop.decision, "deny");
  const activeStatePath = join(stateDirectory, `${activeId}.json`);
  const activeState = JSON.parse(await readFile(activeStatePath, "utf8"));
  await writeFile(activeStatePath, `${JSON.stringify({
    ...activeState,
    updatedAt: new Date().toISOString(),
  })}\n`);
  const progressingRetry = runHook("antigravity", "stop", { stop_hook_active: true });
  assert.equal(progressingRetry.decision, "deny");
  const stalledRetry = runHook("antigravity", "stop", { stop_hook_active: true });
  assert.equal(stalledRetry.decision, undefined);
  assert.match(stalledRetry.systemMessage, /did not advance/);

  const missingWakeId = "bridge-00000000-0000-4000-8000-000000000040";
  const missingWakePath = join(stateDirectory, `${missingWakeId}.json`);
  await writeFile(missingWakePath, `${JSON.stringify({
    id: missingWakeId,
    createdAt: now,
    updatedAt: new Date(Date.now() - 2_000).toISOString(),
    status: "turn_limit",
    runSequence: 1,
    workspace: root,
    chair: { provider: "codex", source: "native-chair", workspace: root },
    runtime: { turnCount: 1, activeCall: null },
  })}\n`);
  const repairedStop = runHook("codex", "stop");
  assert.equal(repairedStop.decision, "block");
  const repairedState = JSON.parse(await readFile(missingWakePath, "utf8"));
  assert.equal(repairedState.coordinatorWake.status, "pending");
  assert.equal(repairedState.coordinatorWake.nextAction, "continue");
  const retryStop = runHook("codex", "stop", { stop_hook_active: true });
  assert.equal(retryStop.decision, undefined);
  assert.match(retryStop.systemMessage, /did not advance/);

  await writeFile(statePath, `${JSON.stringify({
    id,
    createdAt: now,
    updatedAt: now,
    status: "turn_limit",
    workspace: root,
    chair: { provider: "codex", source: "native-chair", workspace: root },
    runtime: { turnCount: 1, activeCall: null },
    coordinatorWake: {
      sequence: 1,
      provider: "codex",
      kind: "phase_stopped",
      actionable: true,
      nextAction: "continue",
      summary: "Peer review finished.",
      status: "pending",
      sourceTurnCount: 1,
    },
  })}\n`);
  const stop = runHook("codex", "stop");
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /acknowledge_coordinator_wake/);
  const start = runHook("codex", "session_start", { hook_event_name: "SessionStart" });
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.hookSpecificOutput.additionalContext, /A durable collaboration wake is pending/);

  const restartedId = "bridge-00000000-0000-4000-8000-000000000045";
  await writeFile(join(stateDirectory, `${restartedId}.json`), `${JSON.stringify({
    id: restartedId,
    createdAt: now,
    updatedAt: new Date(Date.now() + 2_000).toISOString(),
    status: "turn_limit",
    workspace: root,
    chair: { provider: "claude", source: "native-chair", workspace: root, sessionId: "old-session" },
    runtime: { turnCount: 1, activeCall: null },
    coordinatorWake: {
      sequence: 1,
      provider: "claude",
      kind: "phase_stopped",
      actionable: true,
      nextAction: "continue",
      summary: "Resume after restart.",
      status: "pending",
      sourceTurnCount: 1,
    },
  })}\n`);
  const restarted = runHook("claude", "session_start", {
    hook_event_name: "SessionStart",
    session_id: "new-session",
  });
  assert.match(restarted.hookSpecificOutput.additionalContext, /Resume after restart/);

  const laneRoot = join(root, ".bridge", "worktrees", "lane-one");
  const laneId = "bridge-00000000-0000-4000-8000-000000000046";
  await writeFile(join(stateDirectory, `${laneId}.json`), `${JSON.stringify({
    id: laneId,
    createdAt: now,
    updatedAt: new Date(Date.now() + 3_000).toISOString(),
    status: "running",
    workspace: laneRoot,
    chair: { provider: "antigravity", source: "native-chair", workspace: laneRoot },
    runtime: { turnCount: 0, activeCall: { agent: "claude", status: "running" } },
  })}\n`);
  const laneStop = runHook("antigravity", "stop");
  assert.equal(laneStop.decision, "deny");
  assert.match(laneStop.reason, new RegExp(laneId));
  await rm(join(stateDirectory, `${laneId}.json`));

  const protectedId = "bridge-00000000-0000-4000-8000-000000000044";
  await writeFile(join(stateDirectory, `${protectedId}.json`), `${JSON.stringify({
    id: protectedId,
    createdAt: now,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
    status: "needs_user",
    workspace: root,
    chair: { provider: "claude", source: "native-chair", workspace: root, sessionId: "owner-session" },
    runtime: { turnCount: 1, activeCall: null },
    coordinatorWake: {
      sequence: 1,
      provider: "claude",
      kind: "needs_user",
      actionable: false,
      nextAction: "needs_user",
      summary: "Authorization is required.",
      status: "pending",
      sourceTurnCount: 1,
    },
  })}\n`);
  const unrelatedStop = runHook("claude", "stop", { session_id: "unrelated-session" });
  assert.deepEqual(unrelatedStop, {});
  const protectedStop = runHook("claude", "stop", { session_id: "owner-session" });
  assert.equal(protectedStop.decision, undefined);
  assert.match(protectedStop.systemMessage, /requires user input/);
  console.log("Coordinator hook test passed: stop blocking, restart recovery, and protected user boundary.");
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostActivityId, listHostActivities, recordHostActivity } from "../src/host-activity-store.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "bridge-host-hook-"));
const hook = resolve(import.meta.dirname, "host-activity-hook.mjs");
const invoke = (provider, action, input) => execFileSync(process.execPath, [hook, provider, action], {
  input: JSON.stringify(input),
  env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateRoot },
  encoding: "utf8",
});

try {
  assert.equal(invoke("codex", "start", {
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
    model: { id: "gpt-5.6-sol" },
    prompt: "Implement native Mission Control activity",
  }), "{}\n");
  let states = await listHostActivities(stateRoot);
  assert.equal(states.length, 1);
  assert.equal(states[0].active, true);
  assert.equal(states[0].model, "gpt-5.6-sol");
  assert.equal(states[0].task, "Implement native Mission Control activity");
  assert.equal(states[0].hostPid, process.pid);

  invoke("codex", "heartbeat", {
    hook_event_name: "PreToolUse",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
    tool_name: "exec_command",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].summary, "Native codex host is using exec_command.");
  assert.equal(states[0].sourceEvent, "PreToolUse");

  invoke("codex", "stop", {
    hook_event_name: "Stop",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].active, false);
  assert.equal(states[0].phase, "idle");

  invoke("codex", "heartbeat", {
    hook_event_name: "PostToolUse",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
    tool_name: "exec_command",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].active, false, "a late heartbeat must not resurrect a completed turn");

  const oldSessionId = "expired-host-receipt";
  const oldNow = Date.now() - 2 * 86_400_000;
  await recordHostActivity(stateRoot, { provider: "codex", sessionId: oldSessionId, workspace: "/workspace/example", hostPid: process.pid, action: "start", now: oldNow });
  await recordHostActivity(stateRoot, { provider: "codex", sessionId: oldSessionId, workspace: "/workspace/example", action: "stop", now: oldNow + 1_000 });
  const oldPath = join(stateRoot, "host-activity", `${hostActivityId({ provider: "codex", sessionId: oldSessionId })}.json`);
  await access(oldPath);

  for (const provider of ["claude", "antigravity"]) {
    invoke(provider, "start", {
      hook_event_name: provider === "antigravity" ? "BeforeAgent" : "UserPromptSubmit",
      session_id: `${provider}-session`,
      cwd: "/workspace/example",
      prompt: `Review ${provider} native activity`,
    });
  }
  states = await listHostActivities(stateRoot);
  assert.equal(states.filter((state) => state.active).length, 2);
  assert.deepEqual(states.filter((state) => state.active).map((state) => state.provider).sort(), ["antigravity", "claude"]);
  await assert.rejects(() => access(oldPath), (error) => error.code === "ENOENT");

  invoke("antigravity", "start", {
    hook_event_name: "BeforeAgent",
    cwd: "/workspace/example",
    prompt: "Missing session identifier must fail closed",
  });
  assert.equal((await listHostActivities(stateRoot)).length, 3, "a missing session id must not create a workspace-colliding lane");

  console.log("Native host activity hook tests passed: lifecycle, bounded metadata, and late-event safety are verified.");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listHostActivities } from "../src/host-activity-store.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "bridge-host-hook-"));
const hook = resolve(import.meta.dirname, "host-activity-hook.mjs");
const invoke = (action, input) => execFileSync(process.execPath, [hook, "codex", action], {
  input: JSON.stringify(input),
  env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateRoot },
  encoding: "utf8",
});

try {
  assert.equal(invoke("start", {
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

  invoke("heartbeat", {
    hook_event_name: "PreToolUse",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
    tool_name: "exec_command",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].summary, "Native codex host is using exec_command.");
  assert.equal(states[0].sourceEvent, "PreToolUse");

  invoke("stop", {
    hook_event_name: "Stop",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].active, false);
  assert.equal(states[0].phase, "idle");

  invoke("heartbeat", {
    hook_event_name: "PostToolUse",
    session_id: "codex-secret-session",
    cwd: "/workspace/example",
    tool_name: "exec_command",
  });
  states = await listHostActivities(stateRoot);
  assert.equal(states[0].active, false, "a late heartbeat must not resurrect a completed turn");

  console.log("Native host activity hook tests passed: lifecycle, bounded metadata, and late-event safety are verified.");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

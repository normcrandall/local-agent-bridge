#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  coordinatorHookDecision,
  enqueueCoordinatorWake,
  listCoordinatorStates,
  wakeStateDirectory,
} from "../src/coordinator-wake.mjs";

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const provider = process.argv[2];
const event = process.argv[3] || "stop";
if (!["claude", "codex", "antigravity"].includes(provider)) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const input = inputJson();
const cwd = input.cwd || process.env.GEMINI_PROJECT_DIR || process.cwd();
const sessionId = input.session_id || input.sessionId || null;
let states = await listCoordinatorStates({ provider, cwd });
if (event !== "session_start") {
  states = states.filter((state) => !state.chair?.sessionId || !sessionId || state.chair.sessionId === sessionId);
}

const finalizing = states.filter((state) => (
  state.runSequence
  && !["queued", "running", "recovering", "cancelling", "indeterminate"].includes(state.status)
  && !state.coordinatorWake
));
if (finalizing.length) {
  await Promise.all(finalizing.map((state) => enqueueCoordinatorWake(process.cwd(), state.id).catch(() => null)));
  states = await listCoordinatorStates({ provider, cwd });
  if (event !== "session_start") {
    states = states.filter((state) => !state.chair?.sessionId || !sessionId || state.chair.sessionId === sessionId);
  }
}
const decision = coordinatorHookDecision(states);

if (event === "session_start") {
  const pending = states.find((state) => state.coordinatorWake?.status !== "acknowledged");
  const recovery = pending || states.find((state) => (
    ["queued", "running", "recovering", "cancelling", "indeterminate", "needs_user"].includes(state.status)
  ));
  if (!recovery) {
    process.stdout.write("{}\n");
    process.exit(0);
  }
  const wake = recovery.coordinatorWake;
  const additionalContext = wake?.actionable
    ? `A durable collaboration wake is pending. Collaboration ${recovery.id}, wake ${wake.sequence}, next action ${wake.nextAction}: ${wake.summary}. Inspect it with get_collaboration and acknowledge it with acknowledge_coordinator_wake after processing.`
    : ["queued", "running", "recovering", "cancelling"].includes(recovery.status)
      ? `Collaboration ${recovery.id} is still ${recovery.status}. Resume bounded get_collaboration monitoring and do not finish while it remains active.`
      : `Collaboration ${recovery.id} requires attention but is not safe to continue autonomously: ${wake?.summary || recovery.status}.`;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: input.hook_event_name || input.hookEventName || "SessionStart",
      additionalContext,
    },
  })}\n`);
  process.exit(0);
}

function progressSignature() {
  const state = states.find((candidate) => candidate.id === decision.collaborationId);
  if (!state) return null;
  return [
    state.id,
    state.updatedAt,
    state.status,
    state.coordinatorWake?.sequence || 0,
    state.coordinatorWake?.status || "none",
    state.coordinatorWake?.key || "none",
  ].join(":");
}

function progressMarkerPath() {
  const identity = `${provider}:${sessionId || cwd}`;
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return resolve(wakeStateDirectory(process.cwd()), `.coordinator-hook-${key}.json`);
}

function priorProgressSignature() {
  try {
    return JSON.parse(readFileSync(progressMarkerPath(), "utf8")).signature || null;
  } catch {
    return null;
  }
}

function recordProgressSignature(signature) {
  try {
    writeFileSync(progressMarkerPath(), `${JSON.stringify({
      provider,
      sessionId,
      cwd,
      collaborationId: decision.collaborationId,
      signature,
      recordedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
  } catch {
    // The hook still blocks safely if its best-effort loop marker cannot be persisted.
  }
}

if (decision.decision === "block") {
  const signature = progressSignature();
  const retried = input.stop_hook_active === true || input.stopHookActive === true;
  if (retried && signature && priorProgressSignature() === signature) {
    process.stdout.write(`${JSON.stringify({
      systemMessage: "Coordinator state did not advance after the previous hold-open. Allowing this host turn to stop; durable state and SessionStart recovery remain available.",
    })}\n`);
    process.exit(0);
  }
  if (signature) recordProgressSignature(signature);
  process.stdout.write(`${JSON.stringify({
    decision: provider === "antigravity" ? "deny" : "block",
    reason: decision.reason,
  })}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify(decision.systemMessage
  ? { systemMessage: decision.systemMessage }
  : {})}\n`);

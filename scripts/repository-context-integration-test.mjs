import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRepositoryContextTurnPrompt } from "../src/context-capsule.mjs";
import {
  createRepositoryContextDeltaKernel,
  readRepositoryContextBaseline,
} from "../src/repository-context-delta.mjs";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import { runConversation } from "../src/talk-protocol.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-context-integration-"));
const repository = "veliqon/example";
const collaborationId = "bridge-11111111-2222-4333-8444-555555555555";
const laneId = "issue-233";
const binding = { repository, collaborationId, laneId };

try {
  const journal = createRepositoryJournal({ directory: join(root, "journal") });
  await journal.append({
    identity: "initial",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "bounded initial capsule" } },
  });
  const kernel = createRepositoryContextDeltaKernel({
    journal,
    ...binding,
    maxEvents: 25,
    maxBytes: 8_000,
  });
  const preparePrompt = async ({ fullPrompt, compactPrompt, firstExposure, cursor }) => {
    const baseline = await readRepositoryContextBaseline({ journal, ...binding });
    const delta = firstExposure || !cursor ? null : await kernel.read({ cursor });
    return composeRepositoryContextTurnPrompt({
      fullPrompt,
      compactPrompt,
      firstExposure,
      binding,
      priorCursor: cursor,
      baseline,
      delta,
    });
  };

  const firstCalls = [];
  const first = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    preparePrompt,
    send: async (call) => {
      firstCalls.push(call);
      return { message: "Initial work complete.\nSTATUS: CONTINUE", sessionId: "codex-session" };
    },
  });
  assert.match(firstCalls[0].prompt, /Shared task:/);
  assert.equal(first.state.repositoryContextCursors.codex.afterSequence, 1);
  assert.equal(first.state.promptMetrics.fullPrompts, 1);

  const bounded = composeRepositoryContextTurnPrompt({
    fullPrompt: `critical-prefix ${"😀".repeat(200)} critical-suffix`,
    compactPrompt: "unused",
    firstExposure: true,
    binding,
    baseline: await readRepositoryContextBaseline({ journal, ...binding }),
    maxBytes: 192,
  });
  assert.ok(Buffer.byteLength(bounded.prompt, "utf8") <= 192);
  assert.equal(bounded.truncated, true);

  await journal.append({
    identity: "unseen-result",
    repository,
    issueNumber: 233,
    payload: {
      collaborationContext: {
        summary: "focused tests passed",
        token: ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_"),
      },
    },
  });
  const resumedCalls = [];
  const resumed = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: first.state,
    preparePrompt,
    send: async (call) => {
      resumedCalls.push(call);
      return { message: "Resume complete.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.doesNotMatch(resumedCalls[0].prompt, /Shared task:/, "a resumed provider must not receive the full task again");
  assert.match(resumedCalls[0].prompt, /focused tests passed/);
  assert.equal(resumedCalls[0].prompt.includes(["github", "pat", ""].join("_")), false);
  assert.equal(resumed.state.repositoryContextCursors.codex.afterSequence, 2);
  assert.equal(resumed.state.promptMetrics.deltaPrompts, 1);
  assert.ok(resumed.state.promptMetrics.avoidedBytes > 0);

  const deterministicCalls = [];
  const deterministic = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: resumed.state,
    preparePrompt,
    send: async (call) => {
      deterministicCalls.push(call);
      return { message: "No new repository events.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.equal(deterministic.state.repositoryContextCursors.codex.afterSequence, 2);
  assert.doesNotMatch(deterministicCalls[0].prompt, /focused tests passed/, "restart must not replay already-seen records");

  const corruptState = structuredClone(resumed.state);
  corruptState.repositoryContextCursors.codex.afterSequence = 999;
  const resyncCalls = [];
  const resynced = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: corruptState,
    preparePrompt,
    send: async (call) => {
      resyncCalls.push(call);
      return { message: "Resynchronized.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.match(resyncCalls[0].prompt, /repository_context_resync_receipt/);
  assert.match(resyncCalls[0].prompt, /corrupt_cursor/);
  assert.equal(resynced.state.contextResyncReceipts.at(-1).reason, "corrupt_cursor");
  assert.equal(resynced.state.repositoryContextCursors.codex.afterSequence, 2);
  assert.equal(resynced.state.promptMetrics.resyncPrompts, 1);

  const oversizedJournal = createRepositoryJournal({ directory: join(root, "oversized") });
  await oversizedJournal.append({
    identity: "oversized",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "x".repeat(2_000) } },
  });
  const oversizedKernel = createRepositoryContextDeltaKernel({ journal: oversizedJournal, ...binding, maxBytes: 256 });
  const oversizedDelta = await oversizedKernel.read();
  const oversizedBaseline = await readRepositoryContextBaseline({ journal: oversizedJournal, ...binding });
  const oversizedPrompt = composeRepositoryContextTurnPrompt({
    fullPrompt: "full prompt",
    compactPrompt: "compact prompt",
    firstExposure: false,
    binding,
    priorCursor: oversizedKernel.initialCursor(),
    baseline: oversizedBaseline,
    delta: oversizedDelta,
  });
  assert.equal(oversizedPrompt.kind, "resync");
  assert.equal(oversizedPrompt.receipt.reason, "oversized_record_skipped");
  assert.equal(oversizedPrompt.receipt.skipped[0].evidenceRetained, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository context integration tests passed: bounded first capsules, verified unseen deltas, resync receipts, redaction, byte savings, and deterministic restarts are verified.");

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
      cursorAtSequence: (sequence) => kernel.cursorAt(sequence),
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

  await journal.append({
    identity: "retry-after-failure",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "must survive failed dispatch" } },
  });
  const failed = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: resumed.state,
    preparePrompt,
    send: async () => { throw new Error("provider rejected dispatch"); },
  });
  assert.equal(failed.reason, "failed");
  assert.equal(failed.state.repositoryContextCursors.codex.afterSequence, 2, "failed dispatch must not acknowledge unseen context");
  const afterFailureCalls = [];
  const afterFailure = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: failed.state,
    preparePrompt,
    send: async (call) => {
      afterFailureCalls.push(call);
      return { message: "Retry received.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.match(afterFailureCalls[0].prompt, /must survive failed dispatch/);
  assert.equal(afterFailure.state.repositoryContextCursors.codex.afterSequence, 3);

  await journal.append({
    identity: "retry-after-indeterminate",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "must survive indeterminate dispatch" } },
  });
  const indeterminateError = Object.assign(new Error("transport lost"), { indeterminate: true });
  const indeterminate = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: afterFailure.state,
    preparePrompt,
    send: async () => { throw indeterminateError; },
  });
  assert.equal(indeterminate.reason, "indeterminate");
  assert.equal(indeterminate.state.repositoryContextCursors.codex.afterSequence, 3, "indeterminate dispatch must preserve the last confirmed cursor");
  const afterIndeterminateCalls = [];
  const afterIndeterminate = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: indeterminate.state,
    preparePrompt,
    send: async (call) => {
      afterIndeterminateCalls.push(call);
      return { message: "Recovered delivery.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.match(afterIndeterminateCalls[0].prompt, /must survive indeterminate dispatch/);
  assert.equal(afterIndeterminate.state.repositoryContextCursors.codex.afterSequence, 4);

  const deterministicCalls = [];
  const deterministic = await runConversation({
    task: "Implement issue 233 from a bounded full capsule.",
    agents: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    maxTurns: 1,
    initialState: afterIndeterminate.state,
    preparePrompt,
    send: async (call) => {
      deterministicCalls.push(call);
      return { message: "No new repository events.\nSTATUS: CONTINUE", sessionId: call.sessionId };
    },
  });
  assert.equal(deterministic.state.repositoryContextCursors.codex.afterSequence, 4);
  assert.doesNotMatch(deterministicCalls[0].prompt, /focused tests passed/, "restart must not replay already-seen records");

  const corruptState = structuredClone(afterIndeterminate.state);
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
  assert.equal(resynced.state.repositoryContextCursors.codex.afterSequence, 4);
  assert.equal(resynced.state.promptMetrics.resyncPrompts, 1);

  const oversizedJournal = createRepositoryJournal({ directory: join(root, "oversized") });
  await oversizedJournal.append({
    identity: "oversized",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "x".repeat(2_000) } },
  });
  await oversizedJournal.append({
    identity: "after-oversized",
    repository,
    issueNumber: 233,
    payload: { collaborationContext: { summary: "must be delivered after exact oversized skip" } },
  });
  const oversizedKernel = createRepositoryContextDeltaKernel({ journal: oversizedJournal, ...binding, maxBytes: 512 });
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
    cursorAtSequence: (sequence) => oversizedKernel.cursorAt(sequence),
  });
  assert.equal(oversizedPrompt.kind, "resync");
  assert.equal(oversizedPrompt.receipt.reason, "oversized_record_skipped");
  assert.equal(oversizedPrompt.receipt.skipped[0].evidenceRetained, true);
  assert.equal(oversizedPrompt.cursor.afterSequence, 1, "only the exact oversized record may be skipped");
  const afterOversized = await oversizedKernel.read({ cursor: oversizedPrompt.cursor });
  assert.deepEqual(afterOversized.records.map((record) => record.sequence), [2]);
  assert.match(JSON.stringify(afterOversized.records), /must be delivered after exact oversized skip/);

  const pagedJournal = createRepositoryJournal({ directory: join(root, "paged") });
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    await pagedJournal.append({
      identity: `page-${sequence}`,
      repository,
      issueNumber: 233,
      payload: { collaborationContext: { summary: `record-${sequence}-${"y".repeat(180)}` } },
    });
  }
  const pagedKernel = createRepositoryContextDeltaKernel({ journal: pagedJournal, ...binding, maxBytes: 8_000 });
  const pagedBaseline = await readRepositoryContextBaseline({ journal: pagedJournal, ...binding });
  let pagedCursor = pagedKernel.initialCursor();
  const observedSequences = [];
  for (let attempt = 0; attempt < 10 && pagedCursor.afterSequence < 5; attempt += 1) {
    const page = await pagedKernel.read({ cursor: pagedCursor });
    const prepared = composeRepositoryContextTurnPrompt({
      fullPrompt: "full prompt",
      compactPrompt: "compact reply contract",
      firstExposure: false,
      binding,
      priorCursor: pagedCursor,
      baseline: pagedBaseline,
      delta: page,
      cursorAtSequence: (sequence) => pagedKernel.cursorAt(sequence),
      maxBytes: 1_100,
    });
    assert.equal(prepared.kind, "delta");
    assert.ok(prepared.eventCount > 0, "a bounded page must make safe progress");
    assert.ok(prepared.eventCount < page.eventCount || page.eventCount === 1, "overflowing pages must split instead of acknowledging the tail");
    const delivered = page.records.slice(0, prepared.eventCount).map((record) => record.sequence);
    observedSequences.push(...delivered);
    assert.equal(prepared.cursor.afterSequence, delivered.at(-1));
    pagedCursor = prepared.cursor;
  }
  assert.deepEqual(observedSequences, [1, 2, 3, 4, 5], "page splitting must neither lose nor replay records");
  assert.equal((await pagedKernel.read({ cursor: pagedCursor })).eventCount, 0, "bounded delivery must terminate without livelock");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository context integration tests passed: bounded first capsules, verified unseen deltas, resync receipts, redaction, byte savings, and deterministic restarts are verified.");

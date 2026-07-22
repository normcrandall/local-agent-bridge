import assert from "node:assert/strict";
import { parseHandoffEnvelope, parseStatus, runConversation } from "../src/talk-protocol.mjs";

assert.equal(parseStatus("hello\nSTATUS: AGREED"), "AGREED");
assert.equal(parseStatus("no marker"), "CONTINUE");
assert.equal(parseStatus("STATUS: AGREED\nchanged my mind\nSTATUS: CONTINUE"), "CONTINUE");
assert.equal(parseStatus("STATUS: AGREED — the task has a verified conclusion."), "AGREED");

const parsedHandoff = parseHandoffEnvelope(`Completed the requested implementation.
HANDOFF: {"outcome":"completed","summary":"Implemented the change.","artifacts":["src/example.mjs"],"verification":["npm test: passed"],"commit":"abc1234","pullRequest":"https://github.com/owner/repo/pull/1","remaining":[],"nextAction":"chair_verify"}
STATUS: AGREED`);
assert.deepEqual(parsedHandoff, {
  outcome: "completed",
  summary: "Implemented the change.",
  artifacts: ["src/example.mjs"],
  verification: ["npm test: passed"],
  commit: "abc1234",
  pullRequest: "https://github.com/owner/repo/pull/1",
  remaining: [],
  nextAction: "chair_verify",
});
assert.throws(() => parseHandoffEnvelope('HANDOFF: {"outcome":"completed"}'), /summary/);

const scripted = [
  { message: "I propose interface A.\nSTATUS: CONTINUE", sessionId: "claude-1" },
  { message: "A handles the edge case; I agree.\nSTATUS: AGREED", sessionId: "codex-1" },
  { message: "Confirmed against the constraints.\nSTATUS: AGREED", sessionId: "claude-1" },
];
const calls = [];
const outcome = await runConversation({
  task: "Choose an interface",
  maxTurns: 6,
  send: async (call) => {
    calls.push(call);
    return scripted.shift();
  },
});

assert.equal(outcome.reason, "agreed");
assert.equal(outcome.turns.length, 3);
assert.deepEqual(calls.map((call) => call.agent), ["claude", "codex", "claude"]);
assert.equal(calls[2].sessionId, "claude-1");
assert.match(calls[1].prompt, /I propose interface A/);
assert.match(calls[0].prompt, /Shared task:\nChoose an interface/);
assert.match(calls[1].prompt, /Shared task:\nChoose an interface/, "a participant's first exposure receives the full task");
assert.doesNotMatch(calls[2].prompt, /Shared task:\nChoose an interface/, "a resumed provider receives only the new evidence delta");
assert.match(calls[2].prompt, /A handles the edge case/);
assert.match(calls[2].prompt, /Current compact contract: you are the reviewer/);
assert.match(calls[2].prompt, /HANDOFF receipt/);
assert.match(calls[2].prompt, /STATUS: NEEDS_USER/);
assert.deepEqual(outcome.state.participantCursors, { claude: 2, codex: 1 });
assert.equal(outcome.state.promptMetrics.fullPrompts, 2);
assert.equal(outcome.state.promptMetrics.deltaPrompts, 1);
assert.ok(outcome.state.promptMetrics.avoidedCharacters > 0);
assert.ok(outcome.state.promptMetrics.estimatedTokensSent > 0);

const handoffOutcome = await runConversation({
  task: "Implement a bounded change",
  agents: ["claude"],
  startAgent: "claude",
  mode: "work",
  writer: "claude",
  maxTurns: 1,
  send: async () => ({
    message: 'Done.\nHANDOFF: {"outcome":"completed","summary":"Change implemented.","artifacts":["src/change.mjs"],"verification":["npm test: passed"],"remaining":[],"nextAction":"chair_verify"}\nSTATUS: AGREED',
    sessionId: "claude-handoff",
  }),
});
assert.equal(handoffOutcome.turns[0].handoff.outcome, "completed");
assert.match(handoffOutcome.turns[0].handoff.summary, /implemented/);

const writerCalls = [];
await runConversation({
  task: "Plan then implement",
  agents: ["claude", "codex"],
  writer: "codex",
  mode: "work",
  maxTurns: 2,
  send: async (call) => {
    writerCalls.push(call);
    return { message: "Proceed.\nSTATUS: CONTINUE", sessionId: `${call.agent}-writer` };
  },
});
assert.deepEqual(writerCalls.map((call) => call.mode), ["review", "work"]);
assert.match(writerCalls[0].prompt, /Codex is the only writer/);
assert.match(writerCalls[1].prompt, /You are the only writer/);

const threeAgentScript = [
  { message: "Claude position.\nSTATUS: CONTINUE", sessionId: "claude-2" },
  { message: "Codex agrees.\nSTATUS: AGREED", sessionId: "codex-2" },
  { message: "Antigravity agrees.\nSTATUS: AGREED", sessionId: "agy-2" },
  { message: "Claude confirms.\nSTATUS: AGREED", sessionId: "claude-2" },
];
const threeAgentCalls = [];
const threeAgentOutcome = await runConversation({
  task: "Triangulate an architecture",
  agents: ["claude", "codex", "antigravity"],
  maxTurns: 6,
  send: async (call) => {
    threeAgentCalls.push(call);
    return threeAgentScript.shift();
  },
});
assert.equal(threeAgentOutcome.reason, "agreed");
assert.deepEqual(
  threeAgentCalls.map((call) => call.agent),
  ["claude", "codex", "antigravity", "claude"],
);
assert.equal(threeAgentCalls[3].sessionId, "claude-2");
assert.match(threeAgentCalls[3].prompt, /Antigravity agrees/);

const needsUser = await runConversation({
  task: "Pick a color",
  maxTurns: 4,
  send: async () => ({
    message: "Which brand palette should we use?\nSTATUS: NEEDS_USER",
    sessionId: "question",
  }),
});
assert.equal(needsUser.reason, "needs_user");
assert.equal(needsUser.turns.length, 1);

const skipped = [];
const fallbackOutcome = await runConversation({
  task: "Continue when a participant is unavailable",
  agents: ["claude", "codex", "antigravity"],
  maxTurns: 3,
  send: async ({ agent }) => {
    if (agent === "codex") throw new Error("Codex is not installed");
    return { message: `${agent} completed its pass.\nSTATUS: AGREED`, sessionId: `${agent}-fallback` };
  },
  onAgentUnavailable: async (failure) => skipped.push(failure),
});
assert.equal(fallbackOutcome.reason, "agreed");
assert.deepEqual(fallbackOutcome.state.availableAgents, ["claude", "antigravity"]);
assert.match(fallbackOutcome.state.unavailableAgents.codex, /not installed/);
assert.equal(skipped[0].agent, "codex");
assert.deepEqual(
  fallbackOutcome.turns.map((turn) => turn.agent),
  ["claude", "antigravity", "claude"],
);

const noProviderOutcome = await runConversation({
  task: "Fail clearly only when nobody is available",
  agents: ["claude", "codex"],
  maxTurns: 2,
  send: async ({ agent }) => { throw new Error(`${agent} unavailable`); },
});
assert.equal(noProviderOutcome.reason, "failed");
assert.equal(noProviderOutcome.state.availableAgents.length, 0);
assert.match(noProviderOutcome.error, /No requested model/);

const indeterminateError = new Error("MCP request timed out while provider state is unknown");
indeterminateError.indeterminate = true;
const indeterminateOutcome = await runConversation({
  task: "Preserve ownership when provider state is unknown",
  agents: ["claude", "codex"],
  writer: "codex",
  mode: "work",
  maxTurns: 2,
  startAgent: "codex",
  send: async () => { throw indeterminateError; },
});
assert.equal(indeterminateOutcome.reason, "indeterminate");
assert.equal(indeterminateOutcome.state.writer, "codex");
assert.deepEqual(indeterminateOutcome.state.availableAgents, ["claude", "codex"]);
assert.equal(indeterminateOutcome.state.activeCall.agent, "codex");
assert.equal(indeterminateOutcome.state.activeCall.status, "indeterminate");

const standaloneSecret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRcfiCYEXAMPLEKEY";
const standaloneOutcome = await runConversation({
  task: "Sanitize a standalone transcript",
  agents: ["claude"],
  maxTurns: 1,
  send: async () => ({
    message: `Observed ${standaloneSecret}.\nSTATUS: AGREED`,
    sessionId: "standalone-redaction",
  }),
});
assert.doesNotMatch(standaloneOutcome.turns[0].message, /wJalrXUtnFEMI/);
assert.match(standaloneOutcome.turns[0].message, /<REDACTED_ENV_SECRET>/);

console.log("Talk protocol tests passed without invoking any model.");

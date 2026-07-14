import assert from "node:assert/strict";
import { parseDecisionEnvelope, runConversation } from "../src/talk-protocol.mjs";
import { createDecisionReceipt, decisionDisposition } from "../src/decision-policy.mjs";

assert.equal(decisionDisposition({ category: "reversible_technical" }).action, "resolve_by_agents");
for (const category of ["external_authorization", "money", "legal_compliance", "destructive_irreversible", "user_preference"]) {
  const result = decisionDisposition({ category });
  assert.equal(result.action, "needs_user");
  assert.equal(result.authorityExpanded, false);
}
assert.equal(decisionDisposition({ category: "reversible_technical", additionalEscalations: ["reversible_technical"] }).action, "needs_user");

const resolved = createDecisionReceipt({
  question: "Which cache should we use?",
  category: "reversible_technical",
  alternatives: ["memory", "disk"],
  decision: "memory",
  confidence: 0.8,
  dissent: ["Antigravity prefers disk"],
  rollbackPath: "Switch the cache adapter to disk.",
  owner: "codex-chair",
});
assert.equal(resolved.action, "resolved");
assert.equal(resolved.authorityExpanded, false);

const money = createDecisionReceipt({ question: "Buy a service?", category: "money", owner: "claude" });
assert.equal(money.action, "needs_user");
assert.match(money.reason, /money/);
assert.throws(() => createDecisionReceipt({
  question: "Pick", category: "reversible_technical", alternatives: ["one"], decision: "one", confidence: 1, rollbackPath: "undo", owner: "codex",
}), /two alternatives/);

assert.deepEqual(parseDecisionEnvelope('DECISION: {"question":"Choose cache","category":"reversible_technical","owner":"claude"}\nSTATUS: CONTINUE'), {
  question: "Choose cache", category: "reversible_technical", owner: "claude",
});
assert.throws(() => parseDecisionEnvelope("DECISION: nope"), /valid single-line JSON/);
let malformedEscalated = false;
const malformed = await runConversation({
  task: "choose", maxTurns: 1, agents: ["claude"], startAgent: "claude",
  send: async () => ({ message: "DECISION: nope\nSTATUS: CONTINUE", sessionId: "s" }),
  onTurn: async (turn) => { malformedEscalated = Boolean(turn.decision?.invalid); },
  shouldStop: async () => malformedEscalated ? "needs_user" : false,
});
assert.equal(malformed.reason, "needs_user");

console.log("Decision policy tests passed: technical resolution, envelopes, tightened policy, and human-authority escalation.");

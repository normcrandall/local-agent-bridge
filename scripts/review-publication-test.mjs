import assert from "node:assert/strict";
import {
  assertReviewWorkspaceHead,
  localReviewPrompt,
  orderReviewProbes,
  recordReviewPublicationResult,
  resolveReviewPublication,
} from "../src/review-publication.mjs";

const githubReview = { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) };
assert.equal(assertReviewWorkspaceHead({ expectedHeadSha: "a".repeat(40), observedHeadSha: "A".repeat(40) }), true);
assert.throws(
  () => assertReviewWorkspaceHead({ expectedHeadSha: "a".repeat(40), observedHeadSha: "b".repeat(40) }),
  /workspace head mismatch/i,
);
const bound = await resolveReviewPublication({
  agent: "claude",
  githubReview,
  configuredLogin: async () => "claude-reviewer[bot]",
  createCredential: async (input) => {
    assert.equal(input.expectedLogin, "claude-reviewer[bot]");
    return { token: "short-lived" };
  },
});
assert.equal(bound.available, true);
assert.equal(bound.binding.expectedLogin, "claude-reviewer[bot]");

const unbound = await resolveReviewPublication({
  agent: "claude",
  githubReview,
  configuredLogin: async () => "claude-reviewer[bot]",
  createCredential: async () => { throw new Error("reviewer GitHub App lacks required permissions: statuses:write"); },
});
assert.equal(unbound.available, false);
assert.match(unbound.reason, /statuses:write/);

const partial = orderReviewProbes({
  requestedStartAgent: "claude",
  githubReview: { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) },
  probes: [
    { agent: "claude", available: true, reviewPublication: { available: false, reason: "reviewer App lacks statuses:write" } },
    { agent: "antigravity", available: true, reviewPublication: { available: true, reason: null } },
    { agent: "codex", available: false, reason: "transport closed" },
  ],
});
assert.deepEqual(partial.agents, ["antigravity", "claude"]);
assert.equal(partial.startAgent, "antigravity");
assert.equal(partial.publication.status, "partial");
assert.equal(partial.publication.humanApprovalRequired, false);
assert.match(partial.publication.localOnlyAgents.claude, /statuses:write/);

const degraded = orderReviewProbes({
  requestedStartAgent: "claude",
  githubReview: { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) },
  probes: [
    { agent: "claude", available: true, reviewPublication: { available: false, reason: "unbound" } },
    { agent: "antigravity", available: true, reviewPublication: { available: false, reason: "permission denied" } },
  ],
});
assert.deepEqual(degraded.agents, ["claude", "antigravity"]);
assert.equal(degraded.startAgent, "claude");
assert.equal(degraded.publication.status, "degraded");
assert.equal(degraded.publication.humanApprovalRequired, true);

const preflightPartial = {
  status: "partial",
  publishableAgents: ["claude"],
  publishedAgents: [],
  localOnlyAgents: { antigravity: "unbound" },
  humanApprovalRequired: false,
};
const failedPublishable = recordReviewPublicationResult(preflightPartial, {
  agent: "claude",
  unavailableReason: "transport closed",
});
assert.equal(failedPublishable.status, "degraded");
assert.equal(failedPublishable.humanApprovalRequired, true);
assert.deepEqual(failedPublishable.publishableAgents, []);
assert.match(failedPublishable.unavailableAgents.claude, /transport closed/);
const alreadyPublished = recordReviewPublicationResult(preflightPartial, { agent: "claude", published: true });
const laterFailure = recordReviewPublicationResult(alreadyPublished, {
  agent: "claude",
  unavailableReason: "transport closed after publication",
});
assert.equal(laterFailure.humanApprovalRequired, false);
assert.deepEqual(laterFailure.publishedAgents, ["claude"]);

const ordinary = orderReviewProbes({
  requestedStartAgent: "codex",
  githubReview: null,
  probes: [{ agent: "claude", available: true }, { agent: "codex", available: true }],
});
assert.deepEqual(ordinary.agents, ["claude", "codex"]);
assert.equal(ordinary.startAgent, "codex");
assert.equal(ordinary.publication, null);

const prompt = localReviewPrompt("Review this diff.", "reviewer App unavailable");
assert.match(prompt, /Complete the independent review and durable handoff/);
assert.match(prompt, /trusted human must approve the exact head/i);
assert.match(prompt, /do not claim.*formal GitHub review/i);

console.log("Review publication fallback tests passed: publishable-first ordering, local degradation, and trusted-human escalation.");

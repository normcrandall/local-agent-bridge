import assert from "node:assert/strict";
import {
  assertReviewWorkspaceHead,
  isRecoverablePublicationError,
  localReviewPrompt,
  orderReviewProbes,
  recordReviewPublicationResult,
  republishValidatedReview,
  resolveReviewPublication,
} from "../src/review-publication.mjs";
import { localReviewEnvelopePolicy, localReviewPublicationPolicy } from "../src/agent-pool.mjs";

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
    return { token: "short-lived", permissions: { contents: "read", pull_requests: "write", metadata: "read" } };
  },
});
assert.equal(bound.available, true);
assert.equal(bound.binding.expectedLogin, "claude-reviewer[bot]");
assert.equal(bound.binding.publishStatusGate, false);
assert.equal(bound.statusGateAvailable, false);

const boundWithStatus = await resolveReviewPublication({
  agent: "claude",
  githubReview,
  configuredLogin: async () => "claude-reviewer[bot]",
  createCredential: async () => ({ token: "short-lived", permissions: { statuses: "write" } }),
});
assert.equal(boundWithStatus.available, true);
assert.equal(boundWithStatus.binding.publishStatusGate, true);

const unbound = await resolveReviewPublication({
  agent: "claude",
  githubReview,
  configuredLogin: async () => "claude-reviewer[bot]",
  createCredential: async () => { throw new Error("reviewer GitHub App lacks required permissions: pull_requests:write"); },
});
assert.equal(unbound.available, false);
assert.match(unbound.reason, /pull_requests:write/);

const partial = orderReviewProbes({
  requestedStartAgent: "claude",
  githubReview: { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) },
  probes: [
    { agent: "claude", available: true, reviewPublication: { available: false, reason: "reviewer App lacks pull_requests:write" } },
    { agent: "antigravity", available: true, reviewPublication: { available: true, reason: null } },
    { agent: "codex", available: false, reason: "transport closed" },
  ],
});
assert.deepEqual(partial.agents, ["antigravity", "claude"]);
assert.equal(partial.startAgent, "antigravity");
assert.equal(partial.publication.status, "partial");
assert.equal(partial.publication.humanApprovalRequired, false);
assert.match(partial.publication.localOnlyAgents.claude, /pull_requests:write/);

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

// Recoverable-vs-terminal classification for publication retries.
assert.equal(isRecoverablePublicationError(new Error("ENOENT: no such file or directory, open '/w/x.md'")), true);
assert.equal(isRecoverablePublicationError(new Error("transport closed")), true);
assert.equal(isRecoverablePublicationError(new Error("reviewer identity mismatch")), false);
assert.equal(isRecoverablePublicationError(new Error("PAT fallback cannot APPROVE")), false);
assert.equal(isRecoverablePublicationError(new Error("head changed since authorization")), false);

// A validated Antigravity envelope is published without re-running the provider;
// a recoverable failure retries only the publication path against the same
// envelope, and the envelope is never re-parsed.
const validatedEnvelope = { handoff: "# Review\n\nVerified.", event: "APPROVE", body: "Looks good.", comments: [] };
let publishAttempts = 0;
const publishedReceipt = await republishValidatedReview({
  envelope: validatedEnvelope,
  publish: async (envelope, attempt) => {
    publishAttempts += 1;
    assert.equal(envelope, validatedEnvelope, "publish always receives the already-validated envelope");
    if (attempt === 1) throw new Error("ENOENT: no such file or directory, open '.bridge/handoffs/issue-58.md'");
    return { login: "antigravity-reviewer[bot]", url: "https://github.test/review/7" };
  },
});
assert.equal(publishAttempts, 2, "publication retried once without re-running the provider");
assert.equal(publishedReceipt.login, "antigravity-reviewer[bot]");

// A terminal (policy) failure is not retried.
let terminalAttempts = 0;
await assert.rejects(
  republishValidatedReview({
    envelope: validatedEnvelope,
    publish: async () => {
      terminalAttempts += 1;
      throw new Error("reviewer identity mismatch: refusing to publish");
    },
  }),
  /identity mismatch/,
);
assert.equal(terminalAttempts, 1, "terminal publication failure is surfaced immediately, not retried");

// A missing validated envelope is a programmer error, not a silent no-op.
await assert.rejects(
  republishValidatedReview({ envelope: null, publish: async () => ({}) }),
  /already-validated review envelope/,
);

const prompt = localReviewPrompt("Review this diff.", "reviewer App unavailable");
assert.match(prompt, /Complete the independent review and durable handoff/);
assert.match(prompt, /trusted human must approve the exact head/i);
assert.match(prompt, /do not claim.*formal GitHub review/i);

const noTarget = { available: true, binding: null, reason: null };
assert.equal(localReviewPublicationPolicy("ollama", noTarget), noTarget, "a local review without a PR target must preserve its null publication binding");
const localTarget = localReviewPublicationPolicy("ollama", {
  available: true,
  binding: { repository: "owner/repo", publishStatusGate: true },
  statusGateAvailable: true,
});
assert.equal(localTarget.binding.publishStatusGate, false);
assert.equal(localTarget.statusGateAvailable, false);
assert.equal(localTarget.authorizing, false);
const dockerTarget = localReviewPublicationPolicy("docker", {
  available: true,
  binding: { repository: "owner/repo", publishStatusGate: true },
  statusGateAvailable: true,
});
assert.equal(dockerTarget.binding.publishStatusGate, false);
assert.equal(dockerTarget.statusGateAvailable, false);
assert.equal(dockerTarget.authorizing, false);

const localAndCloud = orderReviewProbes({
  requestedStartAgent: "ollama",
  githubReview,
  probes: [
    { agent: "ollama", available: true, reviewPublication: { available: true, authorizing: false } },
    { agent: "claude", available: true, reviewPublication: { available: true, authorizing: true } },
  ],
});
assert.deepEqual(localAndCloud.agents, ["claude", "ollama"]);
assert.equal(localAndCloud.startAgent, "claude");
assert.deepEqual(localAndCloud.publication.authorizingAgents, ["claude"]);
assert.deepEqual(localAndCloud.publication.nonAuthorizingAgents, ["ollama"]);
assert.equal(localAndCloud.publication.humanApprovalRequired, false);

const localOnlyPublication = orderReviewProbes({
  requestedStartAgent: "ollama",
  githubReview,
  probes: [{ agent: "ollama", available: true, reviewPublication: { available: true, authorizing: false } }],
});
assert.equal(localOnlyPublication.publication.status, "available");
assert.equal(localOnlyPublication.publication.humanApprovalRequired, true);
const localPublished = recordReviewPublicationResult(localOnlyPublication.publication, { agent: "ollama", published: true });
assert.equal(localPublished.humanApprovalRequired, true);

const evaluationApproval = localReviewEnvelopePolicy("ollama", {
  event: "APPROVE",
  body: "No blockers found.",
  handoff: "# Review",
  comments: [],
});
assert.equal(evaluationApproval.event, "COMMENT");
assert.match(evaluationApproval.body, /non-authorizing/);
const evaluationRequestChanges = localReviewEnvelopePolicy("ollama", {
  event: "REQUEST_CHANGES",
  body: "A defect remains.",
  handoff: "# Review",
  comments: [],
});
assert.equal(evaluationRequestChanges.event, "COMMENT");
assert.match(evaluationRequestChanges.body, /request for changes \(non-authorizing\)/);
const dockerApproval = localReviewEnvelopePolicy("docker", {
  event: "APPROVE",
  body: "No blockers found.",
  handoff: "# Review",
  comments: [],
});
assert.equal(dockerApproval.event, "COMMENT");
assert.match(dockerApproval.body, /non-authorizing/);

console.log("Review publication fallback tests passed: publishable-first ordering, local degradation, and trusted-human escalation.");

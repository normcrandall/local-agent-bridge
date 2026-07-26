import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { reviewGateState, reviewMarker, submitBoundReview } from "../src/github-review-client.mjs";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import {
  assertReviewThreadReadiness,
  assertTrustedReviewerLogins,
  approvedSubmissionEvent,
  appendReviewTrustEvidence,
  configuredTrustedWriterLogins,
  constrainApprovalToReviewThreadState,
  createReviewerThreadController,
  evaluateReviewThreadState,
  parseReviewFinding,
  parseWriterDisposition,
  reviewFindingMarker,
  reviewReadinessReceiptIsCurrent,
  reviewThreadReceiptPath,
  readLatestReviewTrustEvidence,
  writerDispositionMarker,
} from "../src/github-review-threads.mjs";
import { inspectReviewTrustRoster } from "../src/review-trust-roster.mjs";
import { parseReviewEnvelope, reviewEnvelopeInstructions } from "../src/review-envelope.mjs";
import { ensureContainedHandoffPath, resolveContainedHandoffPath } from "../src/handoff-path.mjs";

const base = {
  apiUrl: "https://github.test",
  token: "secret-test-token",
  repository: "owner/repo",
  prNumber: 42,
  headSha: "a".repeat(40),
  expectedLogin: "review-bot",
  event: "REQUEST_CHANGES",
  body: "P1: Fix the boundary.",
  comments: [{
    path: "src/a.js",
    line: 8,
    side: "RIGHT",
    body: "Validate this input.",
    fixRecommendation: "Reject invalid input before mutation.",
  }],
};

const nextHeadSha = "b".repeat(40);
const findingBody = `Fix the boundary.\n\n${reviewFindingMarker({
  headSha: base.headSha,
  reviewerLogin: "reviewer-a[bot]",
  classification: "blocker",
  fixRecommendation: "Reject the invalid value before mutation.",
})}`;
const followUpBody = `Disposition: follow_up\n\n${writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "builder[bot]",
  disposition: "follow_up",
  rationale: "The compatibility cleanup is independent of this fix.",
  followUpUrl: "https://github.com/owner/repo/issues/149",
  repository: "owner/repo",
})}`;
assert.equal(parseReviewFinding(findingBody).reviewerLogin, "reviewer-a[bot]");
assert.equal(parseWriterDisposition(followUpBody).disposition, "follow_up");
assert.throws(() => writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "builder[bot]",
  disposition: "declined",
}), /requires a rationale/i);
assert.throws(() => writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "builder[bot]",
  disposition: "follow_up",
  followUpUrl: "https://github.com/other/repo/issues/1",
  repository: "owner/repo",
}), /linked owner\/repo GitHub issue/i);

const stateThread = (overrides = {}) => ({
  id: "state-thread",
  isResolved: false,
  comments: {
    nodes: [{
      body: findingBody,
      author: { login: "reviewer-a", __typename: "Bot" },
    }],
  },
  ...overrides,
});
const stateInput = {
  headSha: nextHeadSha,
  repository: "owner/repo",
  trustedReviewerLogins: ["reviewer-a[bot]", "reviewer-b[bot]"],
  trustedWriterLogins: ["builder[bot]"],
};
assert.deepEqual(
  configuredTrustedWriterLogins({
    builderRole: { expectedLogin: "builder[bot]" },
    appRoles: {
      roles: {
        writers: {
          claude: { configured: true, expectedLoginValid: true, expectedLogin: "claude-writer[bot]" },
          codex: { configured: true, expectedLoginValid: true, expectedLogin: "codex-writer[bot]" },
          invalid: { configured: true, expectedLoginValid: false, expectedLogin: "not trusted" },
        },
      },
    },
  }),
  ["builder[bot]", "claude-writer[bot]", "codex-writer[bot]"],
  "review readiness must trust configured provider writer Apps as well as the compatibility builder",
);
const unansweredState = evaluateReviewThreadState({ ...stateInput, threads: [stateThread()] });
assert.equal(unansweredState.ready, false);
assert.equal(unansweredState.unanswered[0].threadId, "state-thread");
assert.equal(reviewReadinessReceiptIsCurrent(unansweredState, base.headSha), false);

const staleDisposition = writerDispositionMarker({
  headSha: base.headSha,
  writerLogin: "builder[bot]",
  disposition: "fixed",
  repository: "owner/repo",
});
const staleState = evaluateReviewThreadState({
  ...stateInput,
  threads: [stateThread({
    comments: { nodes: [
      stateThread().comments.nodes[0],
      { body: staleDisposition, author: { login: "builder", __typename: "Bot" } },
    ] },
  })],
});
assert.equal(staleState.unanswered.length, 1, "a prior-head writer response expires on a refreshed head");

const resolvedFollowUp = stateThread({
  isResolved: true,
  comments: { nodes: [
    stateThread().comments.nodes[0],
    { body: followUpBody, url: "https://github.test/reply", author: { login: "builder", __typename: "Bot" } },
  ] },
});
const readyState = assertReviewThreadReadiness({ ...stateInput, threads: [resolvedFollowUp] });
assert.equal(readyState.ready, true);
assert.equal(reviewReadinessReceiptIsCurrent(readyState, nextHeadSha), true);
const providerWriterBody = `Disposition: fixed\n\n${writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "claude-writer[bot]",
  disposition: "fixed",
  repository: "owner/repo",
})}`;
const providerWriterState = assertReviewThreadReadiness({
  ...stateInput,
  trustedWriterLogins: ["builder[bot]", "claude-writer[bot]"],
  threads: [stateThread({
    isResolved: true,
    comments: { nodes: [
      stateThread().comments.nodes[0],
      { body: providerWriterBody, url: "https://github.test/provider-reply", author: { login: "claude-writer", __typename: "Bot" } },
    ] },
  })],
});
assert.equal(providerWriterState.ready, true, "a healthy configured provider-writer disposition satisfies the exact-head gate");

const staleRosterState = evaluateReviewThreadState({
  ...stateInput,
  repository: "owner/repo",
  prNumber: 42,
  trustRoster: {
    source: "github-app-roles",
    configuredWriterLogins: ["builder[bot]"],
    degraded: false,
    reason: null,
  },
  threads: [stateThread({
    isResolved: true,
    comments: { nodes: [
      stateThread().comments.nodes[0],
      { body: providerWriterBody, url: "https://github.test/provider-reply", author: { login: "claude-writer", __typename: "Bot" } },
    ] },
  })],
});
assert.equal(staleRosterState.ready, false);
assert.equal(staleRosterState.unanswered.length, 0, "a signed disposition is not falsely reported as absent");
assert.equal(staleRosterState.signerNotTrusted[0].signerNotTrusted.writerLogin, "claude-writer[bot]");
const staleRosterSubmission = constrainApprovalToReviewThreadState({
  event: "APPROVE",
  body: "Implementation is otherwise approved.",
  readiness: staleRosterState,
});
assert.equal(staleRosterSubmission.event, "COMMENT", "an out-of-roster signer remains fail closed");
assert.match(staleRosterSubmission.body, /owner\/repo PR #42 at b{12}/);
assert.match(staleRosterSubmission.body, /signer\(s\) are not in the active trusted writer roster/);
assert.match(staleRosterSubmission.body, /source=github-app-roles; degraded=no; configured writers=builder\[bot\]/);
const reopenedState = evaluateReviewThreadState({
  ...stateInput,
  threads: [{ ...resolvedFollowUp, isResolved: false }],
});
assert.equal(reopenedState.unresolved.length, 1, "a reopened actionable thread invalidates readiness");
assert.throws(
  () => assertTrustedReviewerLogins([]),
  /at least one trusted reviewer App login/i,
);
const blockedSubmission = constrainApprovalToReviewThreadState({
  event: "APPROVE",
  body: "The code is otherwise acceptable.",
  readiness: unansweredState,
  statusGateEnabled: false,
});
assert.equal(blockedSubmission.event, "COMMENT", "formal-review-only mode must withhold approval for actionable threads");
assert.equal(blockedSubmission.gateReviewState, null);
assert.match(blockedSubmission.body, /Approval withheld/);
const answeredPendingResolution = constrainApprovalToReviewThreadState({
  event: "APPROVE",
  body: "The exact-head disposition is satisfactory.",
  readiness: reopenedState,
  statusGateEnabled: true,
});
assert.equal(
  answeredPendingResolution.event,
  "APPROVE",
  "an answered thread must permit formal approval so its owning reviewer can resolve it",
);
assert.equal(
  answeredPendingResolution.gateReviewState,
  "COMMENT",
  "the optional status gate remains pending until the approved reviewer resolves the thread",
);
assert.equal(constrainApprovalToReviewThreadState({
  event: "APPROVE",
  body: "Approved.",
  readiness: readyState,
  statusGateEnabled: true,
}).gateReviewState, "APPROVE");

const wrongRepositoryDisposition = writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "builder[bot]",
  disposition: "follow_up",
  rationale: "Tracked elsewhere.",
  followUpUrl: "https://github.com/other/repo/issues/149",
  repository: "other/repo",
});
const wrongRepositoryState = evaluateReviewThreadState({
  ...stateInput,
  threads: [stateThread({
    comments: { nodes: [
      stateThread().comments.nodes[0],
      { body: wrongRepositoryDisposition, author: { login: "builder", __typename: "Bot" } },
    ] },
  })],
});
assert.equal(wrongRepositoryState.unanswered.length, 1, "a follow-up issue in another repository cannot satisfy readiness");
const dottedRepositoryDisposition = writerDispositionMarker({
  headSha: nextHeadSha,
  writerLogin: "builder[bot]",
  disposition: "follow_up",
  rationale: "Tracked in a similarly named repository.",
  followUpUrl: "https://github.com/owner/repoXjs/issues/149",
  repository: "owner/repoXjs",
});
assert.equal(
  parseWriterDisposition(dottedRepositoryDisposition, { repository: "owner/repo.js" }),
  null,
  "repository punctuation is escaped before matching a follow-up URL",
);
const alteredTrustState = evaluateReviewThreadState({
  ...stateInput,
  trustedReviewerLogins: ["reviewer-a[bot]"],
  threads: [stateThread()],
});
assert.notEqual(alteredTrustState.digest, unansweredState.digest, "the readiness digest binds the trusted reviewer set");

const malformedRoster = await inspectReviewTrustRoster({
  repository: "owner/repo",
  configPath: "/private/config/github-apps.json",
  expectedReviewerLogin: "reviewer-a[bot]",
  inspectRoles: async () => { throw new Error("Unable to read /private/config/github-apps.json: key at /secret/reviewer.pem"); },
  loadBuilderRole: async () => { throw new Error("must not be reached"); },
});
assert.equal(malformedRoster.evidence.degraded, true);
assert.equal(malformedRoster.trustedWriterLogins.length, 0, "malformed App config must fail closed");
assert.doesNotMatch(JSON.stringify(malformedRoster.evidence), /private|secret|\.pem/i, "durable diagnostics must not expose configuration or key paths");
const degradedBuilderRoster = await inspectReviewTrustRoster({
  repository: "owner/repo",
  configPath: "/private/config/github-apps.json",
  expectedReviewerLogin: "reviewer-a[bot]",
  inspectRoles: async () => ({
    roles: {
      writers: {
        claude: { configured: true, expectedLoginValid: true, expectedLogin: "claude-writer[bot]" },
      },
      reviewers: {},
    },
  }),
  loadBuilderRole: async () => { throw new Error("private key /secret/builder.pem missing"); },
});
assert.deepEqual(degradedBuilderRoster.evidence.configuredWriterLogins, ["claude-writer[bot]"], "configured identities remain inspectable even when none may be trusted");
assert.deepEqual(degradedBuilderRoster.trustedWriterLogins, [], "degraded inspection must never authorize the visible configured identities");

const evidenceRoot = await mkdtemp(join(tmpdir(), "review-trust-evidence-"));
try {
  await appendReviewTrustEvidence({
    repository: "owner/repo",
    prNumber: 42,
    headSha: nextHeadSha,
    stateRoot: evidenceRoot,
    evidence: {
      reviewerLogin: "reviewer-a[bot]",
      readinessDigest: staleRosterState.digest,
      configuredWriterLogins: ["builder[bot]"],
      rosterSource: "github-app-roles",
      degraded: true,
      degradationReason: malformedRoster.evidence.reason,
      signerNotTrusted: staleRosterState.signerNotTrusted,
    },
  });
  const durableTrust = await readLatestReviewTrustEvidence({
    repository: "owner/repo",
    prNumber: 42,
    headSha: nextHeadSha,
    stateRoot: evidenceRoot,
  });
  assert.equal(durableTrust.repository, "owner/repo");
  assert.equal(durableTrust.prNumber, 42);
  assert.equal(durableTrust.headSha, nextHeadSha);
  assert.equal(durableTrust.signerNotTrusted[0].writerLogin, "claude-writer[bot]");
  assert.doesNotMatch(JSON.stringify(durableTrust), /private|secret|\.pem/i);
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}

const stateResolutionCalls = [];
const owningReviewerController = createReviewerThreadController({
  readerClient: { reviewThreads: async () => [{ ...resolvedFollowUp, isResolved: false }] },
  resolverClient: {
    resolveReviewThread: async ({ threadId }) => {
      stateResolutionCalls.push(threadId);
      return { login: "builder[bot]", operation: "resolve_review_thread", threadId, headSha: nextHeadSha };
    },
  },
  expectedLogin: "reviewer-a[bot]",
  headSha: nextHeadSha,
  trustedWriterLogins: ["builder[bot]"],
  getSubmittedEvent: () => "APPROVE",
});
assert.equal(
  (await owningReviewerController.resolve({ threadId: "state-thread" })).authorizedBy,
  "reviewer-a[bot]",
);
assert.deepEqual(stateResolutionCalls, ["state-thread"]);
const failoverReviewerController = createReviewerThreadController({
  readerClient: { reviewThreads: async () => [{ ...resolvedFollowUp, isResolved: false }] },
  resolverClient: { resolveReviewThread: async () => ({}) },
  expectedLogin: "reviewer-b[bot]",
  headSha: nextHeadSha,
  trustedWriterLogins: ["builder[bot]"],
  getSubmittedEvent: () => "APPROVE",
});
await assert.rejects(
  failoverReviewerController.resolve({ threadId: "state-thread" }),
  /only a thread opened by that same reviewer/i,
);

const foreignAndPatState = evaluateReviewThreadState({
  ...stateInput,
  threads: [
    stateThread({
      id: "foreign",
      comments: { nodes: [{
        body: findingBody,
        author: { login: "untrusted-reviewer", __typename: "Bot" },
      }] },
    }),
    stateThread({
      id: "pat",
      comments: { nodes: [{
        body: findingBody,
        author: { login: "reviewer-a", __typename: "User" },
      }] },
    }),
  ],
});
assert.equal(foreignAndPatState.actionable.length, 0, "foreign and PAT-authored comments cannot enter the trusted gate");

const envelopeInstructions = reviewEnvelopeInstructions({
  githubReview: base,
  handoffPath: "docs/handoffs/task-12.md",
});
assert.match(envelopeInstructions, /owner\/repo PR #42/);
assert.match(envelopeInstructions, /BEGIN BOUND_GITHUB_REVIEW/);
const envelope = parseReviewEnvelope(`Independent review complete.\n---BEGIN BOUND_GITHUB_REVIEW---\n${JSON.stringify({
  handoff: "# Antigravity review\n\nVerified.",
  event: "APPROVE",
  body: "Antigravity independently verified the change.",
  comments: [],
})}\n---END BOUND_GITHUB_REVIEW---`);
assert.equal(envelope.event, "APPROVE");
assert.match(envelope.handoff, /Antigravity review/);
await assert.rejects(async () => parseReviewEnvelope("no envelope"), /required bound GitHub review envelope/);
assert.equal(approvedSubmissionEvent("APPROVED"), "APPROVE");
assert.equal(approvedSubmissionEvent("approved"), "APPROVE");
assert.equal(approvedSubmissionEvent("COMMENTED"), null);
assert.equal(approvedSubmissionEvent("PENDING"), null);
assert.equal(approvedSubmissionEvent(undefined), null);
assert.equal(
  reviewThreadReceiptPath({
    repository: "owner/repo",
    prNumber: 42,
    headSha: "a".repeat(40),
    expectedLogin: "reviewer[bot]",
    stateRoot: "/bridge-state",
  }),
  `/bridge-state/owner__repo--42--${"a".repeat(40)}--reviewer[bot].jsonl`,
);
for (const invalid of [
  { repository: "owner/repo/extra", prNumber: 42, headSha: "a".repeat(40), expectedLogin: "reviewer[bot]" },
  { repository: "../repo", prNumber: 42, headSha: "a".repeat(40), expectedLogin: "reviewer[bot]" },
  { repository: "owner/repo", prNumber: 0, headSha: "a".repeat(40), expectedLogin: "reviewer[bot]" },
  { repository: "owner/repo", prNumber: 42, headSha: "short", expectedLogin: "reviewer[bot]" },
  { repository: "owner/repo", prNumber: 42, headSha: "a".repeat(40), expectedLogin: "../reviewer" },
]) {
  assert.throws(() => reviewThreadReceiptPath({ ...invalid, stateRoot: "/bridge-state" }));
}

const ownedThread = {
  id: "PRRT_owned",
  isResolved: false,
  comments: { nodes: [{ author: { login: "example-reviewer", __typename: "Bot" } }] },
};
const foreignThread = {
  id: "PRRT_foreign",
  isResolved: false,
  comments: { nodes: [{ author: { login: "other-reviewer", __typename: "Bot" } }] },
};
const humanThreadWithMatchingLogin = {
  id: "PRRT_human",
  isResolved: false,
  comments: { nodes: [{ author: { login: "example-reviewer", __typename: "User" } }] },
};
let submittedEvent = null;
const resolvedThreadIds = [];
const reviewerThreadController = createReviewerThreadController({
  readerClient: {
    reviewThreads: async () => [ownedThread, foreignThread, humanThreadWithMatchingLogin],
  },
  resolverClient: {
    resolveReviewThread: async ({ threadId }) => {
      resolvedThreadIds.push(threadId);
      return { login: "builder[bot]", operation: "resolve_review_thread", threadId };
    },
  },
  expectedLogin: "example-reviewer[bot]",
  getSubmittedEvent: () => submittedEvent,
});
assert.deepEqual(await reviewerThreadController.read(), [ownedThread, foreignThread, humanThreadWithMatchingLogin]);
await assert.rejects(
  reviewerThreadController.resolve({ threadId: ownedThread.id }),
  /must submit.*APPROVE/i,
);
submittedEvent = "APPROVE";
await assert.rejects(
  reviewerThreadController.resolve({ threadId: foreignThread.id }),
  /only a thread opened by that same reviewer/i,
);
await assert.rejects(
  reviewerThreadController.resolve({ threadId: humanThreadWithMatchingLogin.id }),
  /only a thread opened by that same reviewer/i,
);
assert.deepEqual(await reviewerThreadController.resolve({ threadId: ownedThread.id }), {
  authorizedBy: "example-reviewer[bot]",
  executedBy: "builder[bot]",
  login: "builder[bot]",
  operation: "resolve_review_thread",
  threadId: ownedThread.id,
});
assert.deepEqual(resolvedThreadIds, [ownedThread.id]);
const patThreadController = createReviewerThreadController({
  readerClient: null,
  resolverClient: null,
  expectedLogin: "reviewer",
  getSubmittedEvent: () => "APPROVE",
});
await assert.rejects(patThreadController.read(), /requires the configured reviewer GitHub App/i);
await assert.rejects(
  patThreadController.resolve({ threadId: ownedThread.id }),
  /requires the configured reviewer GitHub App/i,
);
const missingExecutorController = createReviewerThreadController({
  readerClient: { reviewThreads: async () => [ownedThread] },
  resolverClient: null,
  expectedLogin: "example-reviewer[bot]",
  getSubmittedEvent: () => "APPROVE",
});
await assert.rejects(
  missingExecutorController.resolve({ threadId: ownedThread.id }),
  /requires the configured builder GitHub App executor/i,
);
const narrowedReaderClient = createBoundBuilderClient({
  token: "ghs_test",
  repository: "example/repo",
  expectedLogin: "example-reviewer[bot]",
  verifiedLogin: "example-reviewer[bot]",
  headSha: "0".repeat(40),
  prNumber: 1,
  allowedOperations: ["read_review_threads"],
});
await assert.rejects(
  narrowedReaderClient.resolveReviewThread({ threadId: "x" }),
  /not authorized/,
);
const narrowedExecutorClient = createBoundBuilderClient({
  token: "ghs_test",
  repository: "example/repo",
  expectedLogin: "example-builder[bot]",
  verifiedLogin: "example-builder[bot]",
  headSha: "0".repeat(40),
  prNumber: 1,
  allowedOperations: ["resolve_review_thread"],
});
for (const denied of [
  () => narrowedExecutorClient.merge({}),
  () => narrowedExecutorClient.pushBranch({ ref: "refs/heads/x", sha: "0".repeat(40) }),
  () => narrowedExecutorClient.replaceBranch({ ref: "refs/heads/x", sha: "0".repeat(40) }),
  () => narrowedExecutorClient.reviewThreads(),
  () => narrowedExecutorClient.replyReviewThread({ threadId: "x", body: "y" }),
  () => narrowedExecutorClient.ensurePullRequest({ title: "t", body: "b" }),
]) {
  await assert.rejects(denied(), /not authorized/);
}

// Shared handoff-path containment + recursive parent creation (used by Claude,
// Codex, and Antigravity handoff writes). Parent directories are created only
// after project-relative workspace containment is validated.
const containmentRoot = await mkdtemp(join(tmpdir(), "handoff-path-test-"));
const canonicalRoot = realpathSync(containmentRoot);
try {
  const nested = ensureContainedHandoffPath(containmentRoot, "deeply/nested/handoffs/issue-58.md");
  assert.equal(nested, join(canonicalRoot, "deeply/nested/handoffs/issue-58.md"));
  assert.equal(existsSync(join(canonicalRoot, "deeply/nested/handoffs")), true, "nested parent directories are created recursively");
  assert.equal(existsSync(nested), false, "only the parent is created, not the handoff file itself");
  // Validation without side effects still resolves the contained path.
  assert.equal(
    resolveContainedHandoffPath(containmentRoot, "a/b.md"),
    join(canonicalRoot, "a/b.md"),
  );
  assert.equal(existsSync(join(canonicalRoot, "a")), false, "resolve does not create directories");
  // Escapes are rejected before any directory is created.
  assert.throws(() => ensureContainedHandoffPath(containmentRoot, "../escape.md"), /stay inside the delegated/);
  assert.throws(() => ensureContainedHandoffPath(containmentRoot, "/etc/passwd"), /must be relative/);
  assert.equal(existsSync(join(containmentRoot, "..", "escape.md")), false);
  // A symlinked ancestor that points outside the workspace is rejected.
  symlinkSync(tmpdir(), join(containmentRoot, "linked-out"));
  assert.throws(
    () => ensureContainedHandoffPath(containmentRoot, "linked-out/evil.md"),
    /resolves outside the delegated/,
  );
  // A path naming an existing directory is rejected.
  assert.throws(() => ensureContainedHandoffPath(containmentRoot, "deeply/nested"), /must name a file/);
} finally {
  await rm(containmentRoot, { recursive: true, force: true });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeGitHub({ login = "review-bot", headSha = base.headSha, files = ["src/a.js"], reviews = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, "Bearer secret-test-token");
    if (url.endsWith("/user")) return json({ login });
    if (url.includes("/pulls/42/files")) return json(files.map((filename) => ({ filename })));
    if (url.includes("/pulls/42/reviews") && options.method !== "POST") return json(reviews);
    if (url.includes(`/commits/${base.headSha}/statuses`) && options.method !== "POST") return json([]);
    if (url.endsWith(`/statuses/${base.headSha}`) && options.method === "POST") {
      const payload = JSON.parse(options.body);
      return json({ id: 501, ...payload, creator: { login } }, 201);
    }
    if (url.endsWith("/pulls/42") && options.method !== "POST") return json({ head: { sha: headSha } });
    if (url.endsWith("/pulls/42/reviews") && options.method === "POST") {
      const payload = JSON.parse(options.body);
      return json({
        id: 99,
        html_url: "https://github.test/review/99",
        state: payload.event === "APPROVE" ? "APPROVED"
          : payload.event === "COMMENT" ? "COMMENTED" : "CHANGES_REQUESTED",
        user: { login },
      }, 201);
    }
    return json({ message: `Unexpected URL ${url}` }, 404);
  };
  return { fetchImpl, calls };
}

const successApi = fakeGitHub();
const submitted = await submitBoundReview({ ...base, fetchImpl: successApi.fetchImpl });
assert.equal(submitted.login, "review-bot");
assert.equal(submitted.idempotent, false);
assert.equal(submitted.gate.context, "agent-review");
assert.equal(submitted.gate.state, "failure");
const post = successApi.calls.find((call) => call.options.method === "POST");
const payload = JSON.parse(post.options.body);
assert.equal(payload.commit_id, base.headSha);
assert.equal(payload.event, "REQUEST_CHANGES");
assert.equal(payload.comments.length, 1);
assert.equal(payload.comments[0].path, base.comments[0].path);
assert.equal(parseReviewFinding(payload.comments[0].body).headSha, base.headSha);
assert.match(payload.body, /Blockers: 1/);
assert.match(payload.body, /Non-blocking suggestions: 0/);
assert.match(payload.body, /Testing sufficiency: not reported/);
assert.match(payload.body, /agent-bridge-review/);
const statusPost = successApi.calls.find((call) => call.url.endsWith(`/statuses/${base.headSha}`));
assert.deepEqual(JSON.parse(statusPost.options.body), {
  state: "failure",
  context: "agent-review",
  description: "Independent agent review requested changes.",
  target_url: "https://github.test/review/99",
});
assert.equal(reviewGateState("APPROVED").state, "success");
assert.equal(reviewGateState("COMMENTED").state, "pending");

const deferredApprovalApi = fakeGitHub({ login: "example-reviewer[bot]" });
const deferredApproval = await submitBoundReview({
  ...base,
  expectedLogin: "example-reviewer[bot]",
  verifiedLogin: "example-reviewer[bot]",
  event: "APPROVE",
  comments: [],
  gateReviewState: "COMMENT",
  fetchImpl: deferredApprovalApi.fetchImpl,
});
assert.equal(deferredApproval.state, "APPROVED");
assert.equal(deferredApproval.gate.state, "pending", "formal approval stays non-ready until thread resolution");

await assert.rejects(
  submitBoundReview({
    ...base,
    expectedLogin: "example-reviewer[bot]",
    verifiedLogin: "example-reviewer[bot]",
    event: "APPROVE",
    comments: [{
      ...base.comments[0],
      classification: "blocker",
      fixRecommendation: "Validate before mutating.",
    }],
    fetchImpl: fakeGitHub({ login: "example-reviewer[bot]" }).fetchImpl,
  }),
  /APPROVE review cannot introduce an actionable blocker/i,
);

const appApi = fakeGitHub({ login: "example-reviewer[bot]" });
const appSubmitted = await submitBoundReview({
  ...base,
  expectedLogin: "example-reviewer[bot]",
  verifiedLogin: "example-reviewer[bot]",
  fetchImpl: appApi.fetchImpl,
});
assert.equal(appSubmitted.login, "example-reviewer[bot]");
assert.equal(appApi.calls.some((call) => call.url.endsWith("/user")), false);

const formalReviewOnlyApi = fakeGitHub({ login: "example-reviewer[bot]" });
const formalReviewOnly = await submitBoundReview({
  ...base,
  expectedLogin: "example-reviewer[bot]",
  verifiedLogin: "example-reviewer[bot]",
  publishGate: false,
  fetchImpl: formalReviewOnlyApi.fetchImpl,
});
assert.equal(formalReviewOnly.login, "example-reviewer[bot]");
assert.equal(formalReviewOnly.gate, null);
assert.equal(formalReviewOnlyApi.calls.some((call) => call.url.endsWith(`/statuses/${base.headSha}`)), false);

await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ login: "wrong-user" }).fetchImpl }),
  /identity mismatch/,
);
await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ headSha: "b".repeat(40) }).fetchImpl }),
  /head changed/,
);
await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ files: ["src/other.js"] }).fetchImpl }),
  /not in the pull request diff/,
);
await assert.rejects(
  submitBoundReview({
    ...base,
    comments: [{
      path: base.comments[0].path,
      line: base.comments[0].line,
      side: base.comments[0].side,
      body: base.comments[0].body,
      classification: "blocker",
    }],
    fetchImpl: fakeGitHub().fetchImpl,
  }),
  /concrete fix recommendation/i,
);
await assert.rejects(
  submitBoundReview({
    ...base,
    comments: [{
      path: base.comments[0].path,
      line: base.comments[0].line,
      side: base.comments[0].side,
      body: base.comments[0].body,
    }],
    fetchImpl: fakeGitHub().fetchImpl,
  }),
  /explicit concrete fix recommendation/i,
  "REQUEST_CHANGES defaults to blocker and still requires an explicit fix recommendation",
);

const marker = reviewMarker(base);
const prior = {
  id: 77,
  html_url: "https://github.test/review/77",
  state: "CHANGES_REQUESTED",
  body: `Already posted\n${marker}`,
  user: { login: "review-bot" },
};
const idempotentApi = fakeGitHub({ reviews: [prior] });
const idempotent = await submitBoundReview({ ...base, fetchImpl: idempotentApi.fetchImpl });
assert.equal(idempotent.id, 77);
assert.equal(idempotent.idempotent, true);
assert.equal(idempotentApi.calls.filter((call) => call.options.method === "POST").length, 1);
assert.equal(idempotentApi.calls.find((call) => call.options.method === "POST").url.endsWith(`/statuses/${base.headSha}`), true);

const temporary = await mkdtemp(join(tmpdir(), "github-review-mcp-test-"));
const tokenFile = join(temporary, "token");
// Regression: the handoff lives under a nested parent directory that does not
// exist yet, so write_handoff must create it recursively before writing.
const handoffFile = join(temporary, "nested", "handoffs", "handoff.md");
await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
assert.equal(existsSync(join(temporary, "nested")), false, "nested handoff parent is absent before write_handoff");
let reviewPayload = null;
let statusPayload = null;
let reviewPostCount = 0;
let statusPostCount = 0;
const httpServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = request.method === "POST" ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  response.setHeader("content-type", "application/json");
  if (request.url === "/user") response.end(JSON.stringify({ login: "review-bot" }));
  else if (request.url === "/repos/owner/repo/pulls/42") response.end(JSON.stringify({ head: { sha: base.headSha } }));
  else if (request.url.startsWith("/repos/owner/repo/pulls/42/reviews?") && request.method === "GET") response.end("[]");
  else if (request.url.startsWith(`/repos/owner/repo/commits/${base.headSha}/statuses?`) && request.method === "GET") response.end("[]");
  else if (request.url === `/repos/owner/repo/statuses/${base.headSha}` && request.method === "POST") {
    statusPostCount += 1;
    statusPayload = payload;
    response.statusCode = 201;
    response.end(JSON.stringify({
      id: 502,
      ...statusPayload,
      creator: { login: "review-bot" },
    }));
  }
  else if (request.url === "/repos/owner/repo/pulls/42/reviews" && request.method === "POST") {
    reviewPostCount += 1;
    reviewPayload = payload;
    response.statusCode = 201;
    response.end(JSON.stringify({
      id: 123,
      html_url: "https://github.test/review/123",
      state: reviewPayload.event === "COMMENT" ? "COMMENTED" : "APPROVED",
      user: { login: "review-bot" },
    }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `Unexpected ${request.method} ${request.url}` }));
  }
});
httpServer.listen(0, "127.0.0.1");
await once(httpServer, "listening");
const port = httpServer.address().port;
const mcpClient = new Client({ name: "github-review-integration", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../src/github-review-bridge.mjs")],
  env: {
    ...process.env,
    GITHUB_REVIEW_REPOSITORY: "owner/repo",
    GITHUB_REVIEW_PR_NUMBER: "42",
    GITHUB_REVIEW_HEAD_SHA: base.headSha,
    GITHUB_REVIEW_EXPECTED_LOGIN: "review-bot",
    GITHUB_REVIEW_HANDOFF_PATH: handoffFile,
    GITHUB_REVIEW_TOKEN_FILE: tokenFile,
    GITHUB_APP_CONFIG: join(temporary, "not-configured.json"),
    GITHUB_REVIEW_API_URL: `http://127.0.0.1:${port}`,
  },
});
try {
  await mcpClient.connect(transport);
  const tools = await mcpClient.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "read_review_threads"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "resolve_review_thread"), false);
  const handoffResult = await mcpClient.callTool({
    name: "write_handoff",
    arguments: { content: "# Review handoff\n\nVerified independently." },
  });
  assert.notEqual(handoffResult.isError, true);
  assert.equal(handoffResult.structuredContent.handoffPath, handoffFile);
  assert.equal(existsSync(join(temporary, "nested", "handoffs")), true, "write_handoff created the missing nested parent directory");
  assert.match(await readFile(handoffFile, "utf8"), /Verified independently/);
  const rejectedApproval = await mcpClient.callTool({
    name: "submit_pr_review",
    arguments: { event: "APPROVE", body: "Approved after independent verification.", comments: [] },
  });
  assert.equal(rejectedApproval.isError, true);
  assert.match(rejectedApproval.content[0].text, /PAT fallback.*cannot APPROVE/i);
  const result = await mcpClient.callTool({
    name: "submit_pr_review",
    arguments: { event: "COMMENT", body: "Compatibility review comment.", comments: [] },
  });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.login, "review-bot");
  assert.equal(result.structuredContent.gate, null);
  assert.equal(reviewPayload.commit_id, base.headSha);
  assert.equal(reviewPayload.event, "COMMENT");
  assert.equal(statusPayload, null);
  assert.match(await readFile(handoffFile, "utf8"), /github\.test\/review\/123/);
  const duplicate = await mcpClient.callTool({
    name: "submit_pr_review",
    arguments: { event: "COMMENT", body: "A second payload must not create another review.", comments: [] },
  });
  assert.equal(duplicate.structuredContent.idempotent, true);
  assert.equal(reviewPostCount, 1);
  assert.equal(statusPostCount, 0);
} finally {
  await mcpClient.close().catch(() => {});
  httpServer.close();
  await once(httpServer, "close");
  await rm(temporary, { recursive: true, force: true });
}

console.log("Bound GitHub review tests passed: identity, exact SHA, App status gate, PAT comment-only mode, and idempotency.");

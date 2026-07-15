import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import { builderEnvelopeInstructions, parseBuilderEnvelope } from "../src/builder-envelope.mjs";

const headSha = "a".repeat(40);
const base = {
  apiUrl: "https://github.test",
  token: "builder-token",
  repository: "owner/repo",
  expectedLogin: "builder[bot]",
  verifiedLogin: "builder[bot]",
  headSha,
  prNumber: 42,
  headRef: "codex/feature",
  baseRef: "main",
  requiredReviewStatusContext: "agent-review",
  trustedReviewLogins: ["reviewer[bot]"],
  allowedOperations: ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge"],
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fakeGitHub({
  currentSha = headSha, wrongThread = false, existingPull = false,
  reviewStatus = "success", reviewLogin = "reviewer[bot]", reviewStatuses = null, reviews = [],
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || "GET", body });
    if (path === "/repos/owner/repo/pulls/42" && (options.method || "GET") === "GET") return json({
      number: 42, node_id: "PR_node", draft: true, merged: false, html_url: "https://github.test/pr/42", head: { sha: currentSha },
    });
    if (path === "/repos/owner/repo/git/ref/heads/codex/feature") return json({ object: { sha: currentSha } });
    if (path.startsWith("/repos/owner/repo/pulls?")) return json(existingPull ? [{
      number: 42, html_url: "https://github.test/pr/42", head: { sha: currentSha }, base: { ref: "main" }, state: "open",
    }] : []);
    if (path === "/repos/owner/repo/pulls/42" && options.method === "PATCH") return json({
      number: 42, html_url: "https://github.test/pr/42", head: { sha: currentSha }, base: { ref: "main" }, state: "open",
    });
    if (path === "/repos/owner/repo/pulls" && options.method === "POST") return json({
      number: 42, html_url: "https://github.test/pr/42", head: { sha: headSha }, base: { ref: "main" },
    }, 201);
    if (path === "/repos/owner/repo/pulls/42/merge") return json({ merged: true, sha: "b".repeat(40) });
    if (path.startsWith(`/repos/owner/repo/commits/${headSha}/statuses?per_page=100`)) {
      const statuses = reviewStatuses || [{
        context: "agent-review", state: reviewStatus, creator: { login: reviewLogin },
      }];
      const page = Number(new URL(url).searchParams.get("page") || 1);
      return json(statuses.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith("/repos/owner/repo/pulls/42/reviews?per_page=100")) {
      const page = Number(new URL(url).searchParams.get("page") || 1);
      return json(reviews.slice((page - 1) * 100, page * 100));
    }
    if (path === "/graphql") {
      if (body.query.includes("reviewThreads")) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: wrongThread ? [] : [{
        id: "thread-1", isResolved: false, comments: { nodes: [] },
      }] } } } } });
      if (body.query.includes("addPullRequestReviewThreadReply")) return json({ data: { addPullRequestReviewThreadReply: {
        comment: { id: "comment-1", url: "https://github.test/comment/1", author: { login: "builder[bot]" } },
      } } });
      if (body.query.includes("resolveReviewThread")) return json({ data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } } });
      if (body.query.includes("markPullRequestReadyForReview")) return json({ data: { markPullRequestReadyForReview: {
        pullRequest: { number: 42, url: "https://github.test/pr/42", isDraft: false, headRefOid: headSha },
      } } });
    }
    return json({ message: `unhandled ${path}` }, 404);
  };
  return { fetchImpl, calls };
}

const api = fakeGitHub();
const builder = createBoundBuilderClient({ ...base, fetchImpl: api.fetchImpl });
const ensured = await builder.ensurePullRequest({ title: "Feature", body: "Body" });
assert.equal(ensured.prNumber, 42);
assert.equal(ensured.login, "builder[bot]");
assert.ok(api.calls.some((call) => call.path.includes("pulls?state=open")));
const updateApi = fakeGitHub({ existingPull: true });
const updated = await createBoundBuilderClient({ ...base, fetchImpl: updateApi.fetchImpl }).ensurePullRequest({ title: "Updated", body: "Body" });
assert.equal(updated.prNumber, 42);
assert.ok(updateApi.calls.some((call) => call.method === "PATCH"));
const createAndContinueApi = fakeGitHub();
const createAndContinue = createBoundBuilderClient({ ...base, prNumber: null, fetchImpl: createAndContinueApi.fetchImpl });
assert.equal((await createAndContinue.ensurePullRequest({ title: "Created", body: "Body" })).prNumber, 42);
assert.equal((await createAndContinue.reviewThreads())[0].id, "thread-1");
const threads = await builder.reviewThreads();
assert.equal(threads[0].id, "thread-1");
const replied = await builder.replyReviewThread({ threadId: "thread-1", body: "Fixed." });
assert.equal(replied.url, "https://github.test/comment/1");
assert.match(api.calls.find((call) => call.body?.variables?.body)?.body.variables.body, /agent-bridge-builder:reply/);
assert.equal((await builder.resolveReviewThread({ threadId: "thread-1" })).idempotent, false);
assert.equal((await builder.markReady()).operation, "mark_ready");
const merged = await builder.merge({ method: "squash" });
assert.equal(merged.operation, "merge");
assert.equal(merged.reviewGate.login, "reviewer[bot]");
const paginatedStatuses = Array.from({ length: 101 }, (_, index) => ({
  context: index === 100 ? "agent-review" : `historical-${index}`,
  state: "success",
  creator: { login: "reviewer[bot]" },
}));
const paginatedStatusApi = fakeGitHub({ reviewStatuses: paginatedStatuses });
const paginatedStatusMerge = await createBoundBuilderClient({
  ...base,
  fetchImpl: paginatedStatusApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(paginatedStatusMerge.reviewGate.context, "agent-review");
assert.ok(paginatedStatusApi.calls.some((call) => call.path.includes("page=2")));
await assert.rejects(
  createBoundBuilderClient({ ...base, fetchImpl: fakeGitHub({ reviewStatus: "failure" }).fetchImpl }).merge({ method: "squash" }),
  /machine-review status.*not successful/i,
);
await assert.rejects(
  createBoundBuilderClient({ ...base, fetchImpl: fakeGitHub({ reviewLogin: "owner" }).fetchImpl }).merge({ method: "squash" }),
  /not authored by a configured reviewer App/i,
);
const appApprovalApi = fakeGitHub({
  reviewStatus: "pending",
  reviews: [{ id: 9, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T11:00:00Z", user: { login: "reviewer[bot]" } }],
});
const appApproved = await createBoundBuilderClient({ ...base, fetchImpl: appApprovalApi.fetchImpl }).merge({ method: "squash" });
assert.equal(appApproved.reviewGate.type, "trusted_app_review");
assert.equal(appApproved.reviewGate.login, "reviewer[bot]");
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [
        { id: 9, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T11:00:00Z", user: { login: "reviewer[bot]" } },
        { id: 10, state: "DISMISSED", commit_id: headSha, submitted_at: "2026-07-15T11:01:00Z", user: { login: "reviewer[bot]" } },
      ],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /No exact-head approval.*machine-review status.*not successful/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [{ id: 8, state: "APPROVED", commit_id: "c".repeat(40), submitted_at: "2026-07-15T10:00:00Z", user: { login: "reviewer[bot]" } }],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /No exact-head approval.*machine-review status.*not successful/i,
);
const humanApprovalApi = fakeGitHub({
  reviewStatus: "pending",
  reviews: [{ id: 10, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } }],
});
const humanApproved = await createBoundBuilderClient({
  ...base, trustedReviewLogins: [], trustedHumanReviewLogins: ["owner"], fetchImpl: humanApprovalApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(humanApproved.reviewGate.type, "human_approval");
assert.equal(humanApproved.reviewGate.login, "owner");
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["different-owner"],
    fetchImpl: humanApprovalApi.fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["owner"],
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [{ id: 11, state: "APPROVED", commit_id: "c".repeat(40), submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } }],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["owner"],
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [
        { id: 13, state: "CHANGES_REQUESTED", commit_id: headSha, submitted_at: "2026-07-15T12:01:00Z", user: { login: "owner" } },
        { id: 12, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } },
      ],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["owner", "security-owner"],
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [
        { id: 14, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } },
        { id: 15, state: "CHANGES_REQUESTED", commit_id: headSha, submitted_at: "2026-07-15T12:01:00Z", user: { login: "security-owner" } },
      ],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["owner"],
    fetchImpl: fakeGitHub({
      reviewStatus: "pending",
      reviews: [
        { id: 16, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } },
        { id: 17, state: "DISMISSED", commit_id: headSha, submitted_at: "2026-07-15T12:01:00Z", user: { login: "owner" } },
      ],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
const paginatedReviews = [
  { id: 18, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } },
  ...Array.from({ length: 99 }, (_, index) => ({
    id: 100 + index,
    state: "COMMENTED",
    commit_id: headSha,
    submitted_at: `2026-07-15T12:${String(index % 60).padStart(2, "0")}:30Z`,
    user: { login: `observer-${index}` },
  })),
  { id: 999, state: "CHANGES_REQUESTED", commit_id: headSha, submitted_at: "2026-07-15T14:00:00Z", user: { login: "owner" } },
];
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    trustedReviewLogins: [],
    trustedHumanReviewLogins: ["owner"],
    fetchImpl: fakeGitHub({ reviewStatus: "pending", reviews: paginatedReviews }).fetchImpl,
  }).merge({ method: "squash" }),
  /neither a trusted machine review nor a trusted human approval/i,
);
assert.throws(
  () => createBoundBuilderClient({ ...base, trustedHumanReviewLogins: ["builder[bot]"] }),
  /builder identity cannot be a trusted human reviewer/i,
);
await assert.rejects(
  createBoundBuilderClient({ ...base, prNumber: null, fetchImpl: api.fetchImpl }).merge({ method: "squash" }),
  /bound to a pull request/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    fetchImpl: fakeGitHub({ reviewStatuses: [
      { context: "agent-review", state: "success", creator: { login: "owner" } },
      { context: "agent-review", state: "success", creator: { login: "reviewer[bot]" } },
    ] }).fetchImpl,
  }).merge({ method: "squash" }),
  /not authored by a configured reviewer App/i,
);
const noMerge = createBoundBuilderClient({ ...base, allowedOperations: ["mark_ready"], fetchImpl: api.fetchImpl });
await assert.rejects(noMerge.merge({ method: "squash" }), /not authorized: merge/);

const staleApi = fakeGitHub({ currentSha: "c".repeat(40) });
const stale = createBoundBuilderClient({ ...base, fetchImpl: staleApi.fetchImpl });
await assert.rejects(stale.markReady(), /head changed/i);
await assert.rejects(stale.ensurePullRequest({ title: "Stale", body: "" }), /head ref changed/i);

const foreignApi = fakeGitHub({ wrongThread: true });
const foreign = createBoundBuilderClient({ ...base, fetchImpl: foreignApi.fetchImpl });
await assert.rejects(foreign.replyReviewThread({ threadId: "foreign", body: "No" }), /not part of the bound pull request/i);
await assert.rejects(foreign.resolveReviewThread({ threadId: "foreign" }), /not part of the bound pull request/i);

assert.throws(() => createBoundBuilderClient({ ...base, repository: "other/repo", headSha: "bad" }), /full commit SHA/);

const envelopeInstructions = builderEnvelopeInstructions({ githubBuilder: base, threads: [{ id: "thread-1" }] });
assert.match(envelopeInstructions, /thread-1/);
const envelope = parseBuilderEnvelope(`done\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [{ operation: "reply_review_thread", threadId: "thread-1", body: "Fixed" }],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.equal(envelope.operations[0].operation, "reply_review_thread");
assert.throws(() => parseBuilderEnvelope("missing"), /required bound GitHub builder envelope/);

console.log("Bound GitHub builder tests passed: PR lifecycle, exact head, trusted latest review gate, and merge paths.");

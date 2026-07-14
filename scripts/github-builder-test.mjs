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
  allowedOperations: ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge"],
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fakeGitHub({ currentSha = headSha, wrongThread = false, existingPull = false } = {}) {
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
assert.equal((await builder.merge({ method: "squash" })).operation, "merge");
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

console.log("Bound GitHub builder tests passed: create, reply, resolve, ready, merge, stale-head, and thread-scope paths.");

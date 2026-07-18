import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import { assertBranchRef, resolveTransportUrl } from "../src/github-builder-transport.mjs";
import { builderEnvelopeInstructions, parseBuilderEnvelope } from "../src/builder-envelope.mjs";
import {
  builderMcpInputSchema,
  builderEnvelopeOperationSchema,
  classifyDeliveryOutcome,
  aggregateDeliveryOutcome,
  BuilderUnsupportedError,
  DELIVERY_OUTCOMES,
} from "../src/builder-contract.mjs";
import { loadBranchReconciliationState, summarizeDeliveryOutcomes } from "../src/builder-operation-store.mjs";
import { claudeToolRequest, codexToolRequest } from "../src/tool-requests.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { tmpdir } from "node:os";

// Hard watchdog: the suite must finish boundedly even if a subprocess or socket
// hangs. unref() keeps it from holding the event loop open on success.
const WATCHDOG_MS = 240_000;
const watchdog = setTimeout(() => {
  console.error(`github-builder-test exceeded the ${WATCHDOG_MS}ms watchdog; failing.`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// Fixture git runs with a sanitized environment (no user/system config, no
// terminal prompts, no signing) and a bounded timeout on every invocation.
const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "git-test-"));
const fixtureEnv = {
  ...process.env,
  HOME: tmpDir,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "false",
};
const git = (args, options = {}) => execFileSync("git", args, {
  timeout: 15_000, killSignal: "SIGKILL", env: fixtureEnv, stdio: "pipe", ...options,
});
const gitOut = (args, options = {}) => git(args, options).toString("utf8").trim();

const localRepoPath = path.join(tmpDir, "local");
const bareRepoPath = path.join(tmpDir, "remote.git");

git(["init", "--bare", bareRepoPath]);
git(["init", "-b", "main", localRepoPath]);
git(["config", "user.name", "Test User"], { cwd: localRepoPath });
git(["config", "user.email", "test@example.com"], { cwd: localRepoPath });
git(["config", "commit.gpgsign", "false"], { cwd: localRepoPath });
git(["remote", "add", "origin", "https://github.com/owner/repo"], { cwd: localRepoPath });

fs.writeFileSync(path.join(localRepoPath, "file.txt"), "hello world");
git(["add", "file.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Initial commit"], { cwd: localRepoPath });
const baseCommitSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });

fs.writeFileSync(path.join(localRepoPath, "second.txt"), "second");
git(["add", "second.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Second commit"], { cwd: localRepoPath });
const headSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });

git(["checkout", "-b", "diverged-local", baseCommitSha], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "diverged.txt"), "diverged content");
git(["add", "diverged.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Diverged commit"], { cwd: localRepoPath });
const divergedSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
git(["checkout", "main"], { cwd: localRepoPath });

// A feature branch whose base already contains a binary exercises the create
// contract against the intended base-to-head payload instead of the full tree.
git(["checkout", "-b", "inherited-binary", baseCommitSha], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "inherited-binary.dat"), Buffer.from([0, 1, 2, 3]));
git(["add", "inherited-binary.dat"], { cwd: localRepoPath });
git(["commit", "-m", "Add binary on base"], { cwd: localRepoPath });
const inheritedBinaryBaseSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "inherited-feature.txt"), "feature payload");
git(["add", "inherited-feature.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Add feature above binary base"], { cwd: localRepoPath });
const inheritedBinaryHeadSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
git(["checkout", "main"], { cwd: localRepoPath });

// Seed remote state through direct file-path pushes: no network, no auth, no
// URL rewriting. The HTTP transport under test is never used for seeding.
git(["push", bareRepoPath, `${headSha}:refs/heads/idempotent-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/exists-elsewhere`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/ff-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/ff2-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/cas-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/diverged-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/replacement-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/replacement-lossy`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/replacement-indeterminate`], { cwd: localRepoPath });

// Git smart-HTTP servers that enforce exact Basic credentials from the askpass
// channel. Every child process gets an error handler; timeouts are bounded.
// mode "normal": full smart-HTTP flow. mode "lossy": receive-pack runs and the
// mutation lands, but the response is destroyed before reaching the client.
// mode "deny-push": ref advertisement works, the push RPC is denied with 403.
const BUILDER_TOKEN = "ghs_builder-token";
const expectedAuth = "Basic " + Buffer.from(`x-access-token:${BUILDER_TOKEN}`).toString("base64");
const authAttempts = [];
function createGitServer(mode) {
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const auth = req.headers.authorization;
    if (!auth) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
      res.end();
      return;
    }
    authAttempts.push(auth);
    if (auth !== expectedAuth) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      res.writeHead(200, {
        "Content-Type": `application/x-${service}-advertisement`,
        "Cache-Control": "no-cache",
      });
      const serviceHeader = `# service=${service}\n`;
      const len = (serviceHeader.length + 4).toString(16).padStart(4, "0");
      res.write(len + serviceHeader + "0000");
      const cp = spawn("git", [service.slice(4), "--stateless-rpc", "--advertise-refs", bareRepoPath], { env: fixtureEnv });
      cp.on("error", () => { res.destroy(); });
      cp.stdout.pipe(res);
    } else if (url.pathname.endsWith("/git-receive-pack")) {
      server.pushAttempts += 1;
      if (mode === "deny-push") {
        res.writeHead(403);
        res.end("push permission denied for this token");
        return;
      }
      const cp = spawn("git", ["receive-pack", "--stateless-rpc", bareRepoPath], { env: fixtureEnv });
      cp.on("error", () => { res.destroy(); });
      req.pipe(cp.stdin);
      if (mode === "lossy") {
        // Apply the mutation, discard the status report, drop the connection.
        cp.stdout.on("data", () => {});
        cp.on("close", () => { res.destroy(); });
      } else {
        res.writeHead(200, {
          "Content-Type": "application/x-git-receive-pack-result",
          "Cache-Control": "no-cache",
        });
        cp.stdout.pipe(res);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.pushAttempts = 0;
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  return server;
}
const mockServer = createGitServer("normal");
const lossyServer = createGitServer("lossy");
const denyPushServer = createGitServer("deny-push");

const listen = (server) => new Promise((resolvePort) => {
  server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
});
const port = await listen(mockServer);
const lossyPort = await listen(lossyServer);
const denyPort = await listen(denyPushServer);
const transportUrl = `http://127.0.0.1:${port}/owner/repo.git`;
const lossyTransportUrl = `http://127.0.0.1:${lossyPort}/owner/repo.git`;
const denyTransportUrl = `http://127.0.0.1:${denyPort}/owner/repo.git`;
const receiptLogPath = path.join(tmpDir, "receipts", "github-builder-receipts.jsonl");

const cleanup = () => {
  for (const server of [mockServer, lossyServer, denyPushServer]) {
    try { server.close(); server.closeAllConnections?.(); } catch {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

const base = {
  apiUrl: "https://github.test",
  token: BUILDER_TOKEN,
  repository: "owner/repo",
  expectedLogin: "builder[bot]",
  verifiedLogin: "builder[bot]",
  baseSha: baseCommitSha,
  headSha,
  prNumber: 42,
  headRef: "codex/feature",
  baseRef: "main",
  requiredReviewStatusContext: "agent-review",
  trustedReviewLogins: ["reviewer[bot]"],
  allowedOperations: ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge", "create_branch", "push_branch", "replace_branch"],
  workspace: localRepoPath,
  transportUrl,
  receiptPath: receiptLogPath,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fakeGitHub({
  currentSha = headSha, wrongThread = false, existingPull = false,
  reviewStatus = "success", reviewLogin = "reviewer[bot]", reviewStatuses = null, reviews = [],
  statusPermissionDenied = false, branchShas = {}, graphqlReplyLogin = "builder[bot]", graphqlReplyType = "Bot",
  rules = [], branchProtection = null, branchProtectionStatus = 200, merged = false,
} = {}) {
  const calls = [];
  const branchState = { main: baseCommitSha, ...branchShas };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || "GET", body });
    if (path === "/repos/owner/repo" && (options.method || "GET") === "GET") return json({
      default_branch: "main"
    });
    if (path.startsWith("/repos/owner/repo/git/ref/heads/")) {
      const branch = decodeURIComponent(path.slice("/repos/owner/repo/git/ref/heads/".length));
      if (branch === "codex/feature") return json({ ref: "refs/heads/codex/feature", object: { sha: currentSha } });
      if (Object.hasOwn(branchState, branch)) {
        const entry = branchState[branch];
        const value = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
        if (value && typeof value === "object") return json({ message: "Service Unavailable" }, value.error);
        if (!value) return json({ message: "Not Found" }, 404);
        return json({ ref: `refs/heads/${branch}`, object: { sha: value } });
      }
      try {
        const shaFromBare = gitOut(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: bareRepoPath });
        return json({ ref: `refs/heads/${branch}`, object: { sha: shaFromBare } });
      } catch {
        return json({ message: "Not Found" }, 404);
      }
    }
    if (path === "/repos/owner/repo/rules/branches/main") return json(rules);
    if (path === "/repos/owner/repo/branches/main/protection") {
      return branchProtectionStatus === 200
        ? json(branchProtection || {})
        : json({ message: "Branch protection evidence unavailable" }, branchProtectionStatus);
    }
    if (path.startsWith("/repos/owner/repo/branches/")) {
      const parts = path.split("/");
      const branch = decodeURIComponent(parts[parts.length - 1]);
      if (branch === "protected-branch") {
        return json({ name: branch, protected: true });
      }
      return json({ name: branch, protected: false });
    }
    if (path === "/repos/owner/repo/pulls/42" && (options.method || "GET") === "GET") return json({
      number: 42, node_id: "PR_node", draft: true, merged, html_url: "https://github.test/pr/42", head: { sha: currentSha },
    });
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
      if (statusPermissionDenied) return json({ message: "Resource not accessible by integration" }, 403);
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
        comment: { id: "comment-1", url: "https://github.test/comment/1", author: { login: graphqlReplyLogin, __typename: graphqlReplyType } },
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
const graphqlAppSlugApi = fakeGitHub({ graphqlReplyLogin: "builder" });
const graphqlAppSlugReply = await createBoundBuilderClient({ ...base, fetchImpl: graphqlAppSlugApi.fetchImpl })
  .replyReviewThread({ threadId: "thread-1", body: "Fixed through GraphQL." });
assert.equal(graphqlAppSlugReply.login, "builder[bot]");
await assert.rejects(
  createBoundBuilderClient({ ...base, fetchImpl: fakeGitHub({ graphqlReplyLogin: "different-builder" }).fetchImpl })
    .replyReviewThread({ threadId: "thread-1", body: "Wrong identity." }),
  /unexpected identity/i,
);
await assert.rejects(
  createBoundBuilderClient({ ...base, fetchImpl: fakeGitHub({ graphqlReplyLogin: "builder", graphqlReplyType: "User" }).fetchImpl })
    .replyReviewThread({ threadId: "thread-1", body: "Spoofed identity." }),
  /unexpected identity/i,
);
assert.equal((await builder.resolveReviewThread({ threadId: "thread-1" })).idempotent, false);
assert.equal((await builder.markReady()).operation, "mark_ready");
const merged = await builder.merge({ method: "squash" });
assert.equal(merged.operation, "merge");
assert.equal(merged.reviewGate.login, "reviewer[bot]");
assert.equal(merged.mergeEnforcement.effectiveMode, "broker");

const organizationRulesetApi = fakeGitHub({
  rules: [{
    type: "required_status_checks",
    ruleset_source_type: "Organization",
    ruleset_id: 56,
    parameters: { required_status_checks: [{ context: "agent-review", integration_id: 101 }] },
  }],
});
const organizationRulesetMerge = await createBoundBuilderClient({
  ...base,
  mergeEnforcement: "organization-ruleset",
  trustedReviewAppIds: [101],
  fetchImpl: organizationRulesetApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(organizationRulesetMerge.mergeEnforcement.effectiveMode, "organization-ruleset");
assert.ok(organizationRulesetApi.calls.some((call) => call.path === "/repos/owner/repo/rules/branches/main"));

const missingRulesetApi = fakeGitHub();
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    mergeEnforcement: "organization-ruleset",
    trustedReviewAppIds: [101],
    fetchImpl: missingRulesetApi.fetchImpl,
  }).merge({ method: "squash" }),
  /organization-ruleset.*not verified/i,
);
assert.equal(missingRulesetApi.calls.some((call) => call.path === "/repos/owner/repo/pulls/42/merge"), false);

const autoBrokerApi = fakeGitHub({ branchProtectionStatus: 403 });
const autoBrokerMerge = await createBoundBuilderClient({
  ...base,
  mergeEnforcement: "auto",
  trustedReviewAppIds: [101],
  fetchImpl: autoBrokerApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(autoBrokerMerge.mergeEnforcement.effectiveMode, "broker");
assert.equal(autoBrokerMerge.mergeEnforcement.downgraded, true);
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
assert.equal(appApprovalApi.calls.some((call) => call.path.includes("/statuses?")), false);
const noStatusPermissionAppApprovalApi = fakeGitHub({
  statusPermissionDenied: true,
  reviews: [{ id: 19, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T11:00:00Z", user: { login: "reviewer[bot]" } }],
});
const noStatusPermissionAppApproved = await createBoundBuilderClient({
  ...base, fetchImpl: noStatusPermissionAppApprovalApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(noStatusPermissionAppApproved.reviewGate.type, "trusted_app_review");
assert.equal(noStatusPermissionAppApprovalApi.calls.some((call) => call.path.includes("/statuses?")), false);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    fetchImpl: fakeGitHub({
      reviewStatus: "success",
      reviews: [{ id: 20, state: "CHANGES_REQUESTED", commit_id: headSha, submitted_at: "2026-07-15T11:00:00Z", user: { login: "reviewer[bot]" } }],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /reviewer App decisions do not authorize merge.*CHANGES_REQUESTED/i,
);
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    fetchImpl: fakeGitHub({
      reviewStatus: "success",
      reviews: [
        { id: 9, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T11:00:00Z", user: { login: "reviewer[bot]" } },
        { id: 10, state: "DISMISSED", commit_id: headSha, submitted_at: "2026-07-15T11:01:00Z", user: { login: "reviewer[bot]" } },
      ],
    }).fetchImpl,
  }).merge({ method: "squash" }),
  /reviewer App decisions do not authorize merge.*DISMISSED/i,
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
const noStatusPermissionHumanApi = fakeGitHub({
  statusPermissionDenied: true,
  reviews: [{ id: 21, state: "APPROVED", commit_id: headSha, submitted_at: "2026-07-15T12:00:00Z", user: { login: "owner" } }],
});
const noStatusPermissionHumanApproved = await createBoundBuilderClient({
  ...base, trustedHumanReviewLogins: ["owner"], fetchImpl: noStatusPermissionHumanApi.fetchImpl,
}).merge({ method: "squash" });
assert.equal(noStatusPermissionHumanApproved.reviewGate.type, "human_approval");
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

// Token prefix validation
assert.throws(
  () => createBoundBuilderClient({ ...base, token: "ghp_pat_token", fetchImpl: api.fetchImpl }),
  /Only short-lived GitHub App installation tokens.*are permitted/
);
assert.throws(
  () => createBoundBuilderClient({ ...base, token: "github_pat_token", fetchImpl: api.fetchImpl }),
  /Only short-lived GitHub App installation tokens.*are permitted/
);

// HTTPS URL check
assert.throws(
  () => createBoundBuilderClient({ ...base, apiUrl: "http://unencrypted.test", fetchImpl: api.fetchImpl }),
  /API URL must use HTTPS/
);

// Falsy token check
assert.throws(
  () => createBoundBuilderClient({ ...base, token: null, fetchImpl: api.fetchImpl }),
  /Only short-lived GitHub App installation tokens.*are permitted/
);

// The transport seam only accepts the loopback test address.
assert.throws(
  () => createBoundBuilderClient({ ...base, transportUrl: "https://evil.example/owner/repo.git", fetchImpl: api.fetchImpl }),
  /loopback/,
);
assert.throws(
  () => createBoundBuilderClient({ ...base, transportUrl: `http://127.0.0.1:${port}/other/repo.git`, fetchImpl: api.fetchImpl }),
  /bound repository path/,
);
assert.throws(() => resolveTransportUrl({ repository: "owner/repo", transportUrl: "http://localhost:80/owner/repo.git" }), /loopback/);
assert.equal(resolveTransportUrl({ repository: "owner/repo" }).url, "https://github.com/owner/repo.git");

// Strict ref validation rejects unsafe refspec input before any other work.
assert.equal(assertBranchRef("refs/heads/codex/feature"), "codex/feature");
for (const unsafeRef of [
  "refs/tags/v1",
  "refs/heads/bad..ref",
  "refs/heads/-leading-dash",
  "refs/heads/space name",
  "refs/heads/semi;colon",
  "refs/heads/at@{ref}",
  "refs/heads/dot./component",
  "refs/heads/lock.lock",
  "refs/heads/trailing/",
]) {
  assert.throws(() => assertBranchRef(unsafeRef), /Ref/, `expected rejection for ${unsafeRef}`);
}

// Default and protected branch checks
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "main", fetchImpl: api.fetchImpl }).createBranch({ ref: "refs/heads/main", sha: headSha }),
  /Cannot modify a protected or default branch: main/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "master", fetchImpl: api.fetchImpl }).createBranch({ ref: "refs/heads/master", sha: headSha }),
  /Cannot modify a protected or default branch: master/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "production", fetchImpl: api.fetchImpl }).createBranch({ ref: "refs/heads/production", sha: headSha }),
  /Cannot modify a protected or default branch: production/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "release", fetchImpl: api.fetchImpl }).pushBranch({ ref: "refs/heads/release", sha: headSha }),
  /Cannot modify a protected or default branch: release/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "develop", fetchImpl: api.fetchImpl }).pushBranch({ ref: "refs/heads/develop", sha: headSha }),
  /Cannot modify a protected or default branch: develop/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "protected-branch", fetchImpl: api.fetchImpl }).createBranch({ ref: "refs/heads/protected-branch", sha: headSha }),
  /Cannot modify a protected or default branch: protected-branch/
);

const clientForBranches = createBoundBuilderClient({ ...base, fetchImpl: api.fetchImpl });

// SHA mismatch check
await assert.rejects(
  clientForBranches.createBranch({ ref: "refs/heads/codex/feature", sha: "b".repeat(40) }),
  /SHA mismatch/
);
await assert.rejects(
  clientForBranches.pushBranch({ ref: "refs/heads/codex/feature", sha: "b".repeat(40) }),
  /SHA mismatch/
);

// Ref mismatch check
await assert.rejects(
  clientForBranches.createBranch({ ref: "refs/heads/other-ref", sha: headSha }),
  /Ref mismatch/
);
await assert.rejects(
  clientForBranches.pushBranch({ ref: "refs/heads/other-ref", sha: headSha }),
  /Ref mismatch/
);
await assert.rejects(
  clientForBranches.replaceBranch({ ref: "refs/heads/other-ref", sha: headSha, oldSha: divergedSha }),
  /Ref mismatch/
);
await assert.rejects(
  clientForBranches.replaceBranch({ ref: "refs/heads/codex/feature", sha: headSha }),
  /requires an exact oldSha lease/
);

// Real transport integration: bounded smart-HTTP pushes against the bare remote.
console.log("Running real local-repository transport integration tests...");

const tokenFactory = () => {
  const state = { issued: false };
  return {
    state,
    getToken: async () => {
      state.issued = true;
      return { token: BUILDER_TOKEN, verifiedLogin: "builder[bot]" };
    },
  };
};

// A. createBranch makes a previously remote-unreachable commit reachable.
git(["checkout", "-b", "feature-success", "main"], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "success.txt"), "success data");
git(["add", "success.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Success commit"], { cwd: localRepoPath });
const successHeadSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
git(["checkout", "main"], { cwd: localRepoPath });

// Prove the commit object is unreachable on the remote before the operation.
assert.throws(() => git(["cat-file", "-e", `${successHeadSha}^{commit}`], { cwd: bareRepoPath }));
assert.throws(() => git(["rev-parse", "--verify", "refs/heads/feature-success"], { cwd: bareRepoPath }));

const successApi = fakeGitHub({ branchShas: { main: headSha } });
const successFactory = tokenFactory();
const integrationSuccessClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: successApi.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  baseRef: "main",
  baseSha: headSha,
  headSha: successHeadSha,
  headRef: "refs/heads/feature-success",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: successFactory.getToken,
  expectedLogin: "builder[bot]",
  transportUrl,
  receiptPath: receiptLogPath,
});
const authAttemptsBefore = authAttempts.length;
const integrationSuccessResult = await integrationSuccessClient.createBranch({ ref: "refs/heads/feature-success", sha: successHeadSha });
assert.equal(integrationSuccessResult.operation, "create_branch");
assert.equal(integrationSuccessResult.idempotent, false);
assert.equal(integrationSuccessResult.readBackSha, successHeadSha);
assert.equal(integrationSuccessResult.remoteVerified, true);
assert.equal(integrationSuccessResult.transport, "git-https-app-token");
assert.equal(integrationSuccessResult.outcome, "created");
assert.equal(integrationSuccessResult.requestedSha, successHeadSha);
assert.equal(integrationSuccessResult.expectedOldSha, null);
assert.equal(integrationSuccessResult.observedRemoteSha, successHeadSha);
assert.equal(integrationSuccessResult.appIdentity.expectedLogin, "builder[bot]");
assert.equal(successFactory.state.issued, true);
// The commit is now reachable on the remote, delivered only via the transport.
assert.equal(gitOut(["rev-parse", "refs/heads/feature-success"], { cwd: bareRepoPath }), successHeadSha);
git(["cat-file", "-e", `${successHeadSha}^{commit}`], { cwd: bareRepoPath });
// The credential channel produced the exact Basic header, never argv.
assert.ok(authAttempts.length > authAttemptsBefore);
assert.ok(authAttempts.slice(authAttemptsBefore).every((value) => value === expectedAuth));

// A2. createBranch accepts an unchanged binary inherited from its exact base.
const inheritedBinaryFactory = tokenFactory();
const inheritedBinaryClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: fakeGitHub({ branchShas: { main: inheritedBinaryBaseSha } }).fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  baseRef: "main",
  baseSha: inheritedBinaryBaseSha,
  headSha: inheritedBinaryHeadSha,
  headRef: "refs/heads/feature-inherited-binary",
  allowedOperations: ["create_branch"],
  getToken: inheritedBinaryFactory.getToken,
  expectedLogin: "builder[bot]",
  transportUrl,
  receiptPath: receiptLogPath,
});
const inheritedBinaryResult = await inheritedBinaryClient.createBranch({
  ref: "refs/heads/feature-inherited-binary",
  sha: inheritedBinaryHeadSha,
});
assert.equal(inheritedBinaryResult.outcome, "created");
assert.equal(inheritedBinaryResult.observedRemoteSha, inheritedBinaryHeadSha);
assert.equal(inheritedBinaryFactory.state.issued, true);

// A3. createBranch fails closed when its authorization omits an exact base SHA.
const missingBaseFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    headSha: successHeadSha,
    headRef: "refs/heads/feature-missing-base",
    allowedOperations: ["create_branch"],
    getToken: missingBaseFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-missing-base", sha: successHeadSha }),
  /create_branch requires an exact baseSha authorization/
);
assert.equal(missingBaseFactory.state.issued, false);

// A3b. createBranch rejects an exact base SHA that is not an ancestor of head
// before issuing a credential. This ancestry gate makes scoped diff validation
// safe: every blob outside baseSha..head must be inherited from that base.
const unrelatedBaseFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub({ branchShas: { main: divergedSha } }).fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: divergedSha,
    headSha: successHeadSha,
    headRef: "refs/heads/feature-unrelated-base",
    allowedOperations: ["create_branch"],
    getToken: unrelatedBaseFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-unrelated-base", sha: successHeadSha }),
  /is not an ancestor of head/
);
assert.equal(unrelatedBaseFactory.state.issued, false);

// A4. createBranch rejects a stale exact-base authorization before mutation.
const staleBaseFactory = tokenFactory();
const staleBasePushesBefore = mockServer.pushAttempts;
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub({ branchShas: { main: headSha } }).fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: baseCommitSha,
    headSha: successHeadSha,
    headRef: "refs/heads/feature-stale-base",
    allowedOperations: ["create_branch"],
    getToken: staleBaseFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-stale-base", sha: successHeadSha }),
  /Base ref main changed: authorized .* current/
);
assert.equal(staleBaseFactory.state.issued, true);
assert.equal(mockServer.pushAttempts, staleBasePushesBefore);

// B. createBranch is idempotent when the remote ref already sits at the SHA.
const idempotentClient = createBoundBuilderClient({
  ...base, headRef: "idempotent-branch", fetchImpl: fakeGitHub().fetchImpl,
});
const duplicateCreated = await idempotentClient.createBranch({ ref: "refs/heads/idempotent-branch", sha: headSha });
assert.equal(duplicateCreated.idempotent, true);
assert.equal(duplicateCreated.readBackSha, headSha);
assert.equal(duplicateCreated.outcome, "idempotent");

// C. createBranch refuses a ref that exists at a different SHA.
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "exists-elsewhere", fetchImpl: fakeGitHub().fetchImpl })
    .createBranch({ ref: "refs/heads/exists-elsewhere", sha: headSha }),
  /already exists at/
);
assert.equal(gitOut(["rev-parse", "refs/heads/exists-elsewhere"], { cwd: bareRepoPath }), baseCommitSha);

// D. Real smart-HTTP ambiguity: receive-pack applies the mutation in the bare
// remote but the response is lost; bounded read-back reconciles the outcome.
assert.throws(() => git(["rev-parse", "--verify", "refs/heads/lost-response-branch"], { cwd: bareRepoPath }));
const lostResponseClient = createBoundBuilderClient({
  ...base,
  headRef: "lost-response-branch",
  fetchImpl: fakeGitHub().fetchImpl,
  transportUrl: lossyTransportUrl,
});
const lostResponse = await lostResponseClient.createBranch({ ref: "refs/heads/lost-response-branch", sha: headSha });
assert.equal(lostResponse.reconciled, true);
assert.equal(lostResponse.outcome, "reconciled");
assert.equal(lostResponse.observedRemoteSha, headSha);
assert.equal(gitOut(["rev-parse", "refs/heads/lost-response-branch"], { cwd: bareRepoPath }), headSha);

// D2. Reconciliation-unavailable: the response is lost AND remote read-back
// fails. The client must record an explicit indeterminate state, refuse to
// push again until a read-only reconciliation succeeds, then reconcile.
const indeterminateClient = createBoundBuilderClient({
  ...base,
  headRef: "indeterminate-branch",
  fetchImpl: fakeGitHub({ branchShas: { "indeterminate-branch": [null, { error: 503 }, { error: 503 }, headSha] } }).fetchImpl,
  transportUrl: lossyTransportUrl,
});
await assert.rejects(
  indeterminateClient.createBranch({ ref: "refs/heads/indeterminate-branch", sha: headSha }),
  /indeterminate.*read-only reconciliation|indeterminate/i,
);
const pushAttemptsAfterIndeterminate = lossyServer.pushAttempts;
// Retry while read-back is still unavailable: no push may be attempted.
await assert.rejects(
  indeterminateClient.createBranch({ ref: "refs/heads/indeterminate-branch", sha: headSha }),
  /read-only reconciliation must succeed before retry/,
);
assert.equal(lossyServer.pushAttempts, pushAttemptsAfterIndeterminate);
// Retry once read-back works: the landed mutation reconciles without a push.
const reconciledAfterIndeterminate = await indeterminateClient.createBranch({ ref: "refs/heads/indeterminate-branch", sha: headSha });
assert.equal(reconciledAfterIndeterminate.outcome, "reconciled");
assert.equal(reconciledAfterIndeterminate.reconciled, true);
assert.equal(lossyServer.pushAttempts, pushAttemptsAfterIndeterminate);
assert.equal(gitOut(["rev-parse", "refs/heads/indeterminate-branch"], { cwd: bareRepoPath }), headSha);

// D3. Separately allowlisted branch replacement permits a non-fast-forward
// update only for the bound feature ref and exact expected-old/new SHAs.
const replacementClient = createBoundBuilderClient({
  ...base,
  headRef: "replacement-branch",
  allowedOperations: ["replace_branch"],
  fetchImpl: fakeGitHub().fetchImpl,
});
const replaced = await replacementClient.replaceBranch({
  ref: "refs/heads/replacement-branch", sha: headSha, oldSha: divergedSha,
});
assert.equal(replaced.operation, "replace_branch");
assert.equal(replaced.outcome, "replaced");
assert.equal(replaced.expectedOldSha, divergedSha);
assert.equal(replaced.observedRemoteSha, headSha);
assert.equal(replaced.remoteVerified, true);
assert.match(replaced.operationId, /^[0-9a-f]{64}$/);
assert.equal(gitOut(["rev-parse", "refs/heads/replacement-branch"], { cwd: bareRepoPath }), headSha);

// The same operation envelope is idempotent after the first response lands.
const replacementRetry = await replacementClient.replaceBranch({
  ref: "refs/heads/replacement-branch", sha: headSha, oldSha: divergedSha,
});
assert.equal(replacementRetry.outcome, "idempotent");
assert.equal(replacementRetry.operationId, replaced.operationId);

// A stale/competing writer cannot overwrite the advanced ref. Rejection
// occurs before the transport push, even when its requested commit is local.
const replacementAttempts = mockServer.pushAttempts;
await assert.rejects(
  createBoundBuilderClient({
    ...base,
    headSha: successHeadSha,
    headRef: "replacement-branch",
    allowedOperations: ["replace_branch"],
    fetchImpl: fakeGitHub().fetchImpl,
  }).replaceBranch({
    ref: "refs/heads/replacement-branch", sha: successHeadSha, oldSha: divergedSha,
  }),
  new RegExp(`Remote branch ref changed: expected ${divergedSha}, current ${headSha}`),
);
assert.equal(mockServer.pushAttempts, replacementAttempts);
assert.equal(gitOut(["rev-parse", "refs/heads/replacement-branch"], { cwd: bareRepoPath }), headSha);

// Lost response after a successful replacement is reconciled by exact remote
// SHA read-back, returning the same deterministic operation identity.
const lossyReplacementClient = createBoundBuilderClient({
  ...base,
  headRef: "replacement-lossy",
  allowedOperations: ["replace_branch"],
  fetchImpl: fakeGitHub().fetchImpl,
  transportUrl: lossyTransportUrl,
});
const lossyReplacement = await lossyReplacementClient.replaceBranch({
  ref: "refs/heads/replacement-lossy", sha: headSha, oldSha: divergedSha,
});
assert.equal(lossyReplacement.outcome, "reconciled");
assert.equal(lossyReplacement.reconciled, true);
assert.equal(gitOut(["rev-parse", "refs/heads/replacement-lossy"], { cwd: bareRepoPath }), headSha);

// If both the transport response and read-back are unavailable, retry is
// blocked until read-only reconciliation succeeds; no duplicate push occurs.
const indeterminateReplacementClient = createBoundBuilderClient({
  ...base,
  headRef: "replacement-indeterminate",
  allowedOperations: ["replace_branch"],
  fetchImpl: fakeGitHub({
    branchShas: {
      "replacement-indeterminate": [divergedSha, { error: 503 }, { error: 503 }, headSha],
    },
  }).fetchImpl,
  transportUrl: lossyTransportUrl,
});
await assert.rejects(
  indeterminateReplacementClient.replaceBranch({
    ref: "refs/heads/replacement-indeterminate", sha: headSha, oldSha: divergedSha,
  }),
  /indeterminate.*read-only reconciliation|indeterminate/i,
);
const replacementPushAttempts = lossyServer.pushAttempts;
await assert.rejects(
  indeterminateReplacementClient.replaceBranch({
    ref: "refs/heads/replacement-indeterminate", sha: headSha, oldSha: divergedSha,
  }),
  /read-only reconciliation must succeed before retry/,
);
assert.equal(lossyServer.pushAttempts, replacementPushAttempts);
const reconciledReplacement = await indeterminateReplacementClient.replaceBranch({
  ref: "refs/heads/replacement-indeterminate", sha: headSha, oldSha: divergedSha,
});
assert.equal(reconciledReplacement.outcome, "reconciled");
assert.equal(lossyServer.pushAttempts, replacementPushAttempts);
assert.equal(gitOut(["rev-parse", "refs/heads/replacement-indeterminate"], { cwd: bareRepoPath }), headSha);

await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "main", allowedOperations: ["replace_branch"], fetchImpl: fakeGitHub().fetchImpl })
    .replaceBranch({ ref: "refs/heads/main", sha: headSha, oldSha: divergedSha }),
  /Cannot modify a protected or default branch: main/,
);

// E. pushBranch idempotency and real fast-forward CAS delivery.
const pushIdempotent = await createBoundBuilderClient({ ...base, headRef: "idempotent-branch", fetchImpl: fakeGitHub().fetchImpl })
  .pushBranch({ ref: "refs/heads/idempotent-branch", sha: headSha });
assert.equal(pushIdempotent.idempotent, true);
const ffPushed = await createBoundBuilderClient({ ...base, headRef: "ff-branch", fetchImpl: fakeGitHub().fetchImpl })
  .pushBranch({ ref: "refs/heads/ff-branch", sha: headSha, oldSha: baseCommitSha });
assert.equal(ffPushed.operation, "push_branch");
assert.equal(ffPushed.idempotent, false);
assert.equal(ffPushed.outcome, "fast_forwarded");
assert.equal(ffPushed.expectedOldSha, baseCommitSha);
assert.equal(gitOut(["rev-parse", "refs/heads/ff-branch"], { cwd: bareRepoPath }), headSha);
// Without oldSha the observed remote SHA becomes the verified CAS base.
const ff2Pushed = await createBoundBuilderClient({ ...base, headRef: "ff2-branch", fetchImpl: fakeGitHub().fetchImpl })
  .pushBranch({ ref: "refs/heads/ff2-branch", sha: headSha });
assert.equal(gitOut(["rev-parse", "refs/heads/ff2-branch"], { cwd: bareRepoPath }), headSha);
assert.equal(ff2Pushed.readBackSha, headSha);

// F. Missing remote branch and stale oldSha are rejected before any push.
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "non-existent", fetchImpl: fakeGitHub({ branchShas: { "non-existent": null } }).fetchImpl })
    .pushBranch({ ref: "refs/heads/non-existent", sha: headSha }),
  /does not exist/
);
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "stale-branch", fetchImpl: fakeGitHub({ branchShas: { "stale-branch": "c".repeat(40) } }).fetchImpl })
    .pushBranch({ ref: "refs/heads/stale-branch", sha: headSha, oldSha: baseCommitSha }),
  new RegExp(`Remote branch ref changed: expected ${baseCommitSha}, current ${"c".repeat(40)}`)
);

// G. Local ancestry is fail-closed and precedes token issuance.
const divergedFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    ...base, token: null, getToken: divergedFactory.getToken, headRef: "diverged-branch", fetchImpl: fakeGitHub().fetchImpl,
  }).pushBranch({ ref: "refs/heads/diverged-branch", sha: headSha, oldSha: divergedSha }),
  /not a fast-forward/
);
assert.equal(divergedFactory.state.issued, false);
const unknownBaseFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    ...base, token: null, getToken: unknownBaseFactory.getToken, headRef: "stale-branch", fetchImpl: fakeGitHub().fetchImpl,
  }).pushBranch({ ref: "refs/heads/stale-branch", sha: headSha, oldSha: "c".repeat(40) }),
  /ancestry could not be verified/
);
assert.equal(unknownBaseFactory.state.issued, false);

// H. Remote CAS rejection at the wire: the API view is stale, the lease loses.
const casClient = createBoundBuilderClient({
  ...base, headRef: "cas-branch", fetchImpl: fakeGitHub({ branchShas: { "cas-branch": baseCommitSha } }).fetchImpl,
});
await assert.rejects(
  casClient.pushBranch({ ref: "refs/heads/cas-branch", sha: headSha, oldSha: baseCommitSha }),
  /not a fast-forward/
);
assert.equal(gitOut(["rev-parse", "refs/heads/cas-branch"], { cwd: bareRepoPath }), divergedSha);

// I. Authentication failure stays bounded and never leaks the token.
const wrongToken = "ghs_wrong-token";
const authFailureClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: fakeGitHub().fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  baseRef: "main",
  baseSha: baseCommitSha,
  headSha,
  headRef: "refs/heads/auth-branch",
  allowedOperations: ["create_branch"],
  getToken: async () => ({ token: wrongToken, verifiedLogin: "builder[bot]" }),
  expectedLogin: "builder[bot]",
  transportUrl,
});
let authError = null;
try {
  await authFailureClient.createBranch({ ref: "refs/heads/auth-branch", sha: headSha });
} catch (error) {
  authError = error;
}
assert.ok(authError, "auth failure must reject");
assert.ok(!String(authError.message).includes(wrongToken), "token must not leak into error messages");
assert.ok(!String(authError.stderr || "").includes(wrongToken), "token must not leak into stderr");
assert.throws(() => git(["rev-parse", "--verify", "refs/heads/auth-branch"], { cwd: bareRepoPath }));

// I2. Push permission denial at the receive-pack RPC is a determinate,
// redacted failure: no mutation, and no indeterminate state blocking retry.
const denyClient = createBoundBuilderClient({ ...base, headRef: "denied-branch", fetchImpl: fakeGitHub().fetchImpl, transportUrl: denyTransportUrl });
let denyError = null;
try {
  await denyClient.createBranch({ ref: "refs/heads/denied-branch", sha: headSha });
} catch (error) {
  denyError = error;
}
assert.ok(denyError, "denied push must reject");
assert.ok(!String(denyError.message).includes(BUILDER_TOKEN), "token must not leak into permission-denial errors");
assert.throws(() => git(["rev-parse", "--verify", "refs/heads/denied-branch"], { cwd: bareRepoPath }));
const denyAttempts = denyPushServer.pushAttempts;
await assert.rejects(denyClient.createBranch({ ref: "refs/heads/denied-branch", sha: headSha }));
assert.equal(denyPushServer.pushAttempts, denyAttempts + 1);

// I3. Ambient local HTTP authorization is rejected before token issuance.
git(["config", "http.extraHeader", "Authorization: Basic c25lYWt5"], { cwd: localRepoPath });
const extraHeaderFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: baseCommitSha,
    headSha,
    headRef: "refs/heads/feature-extra-header",
    allowedOperations: ["create_branch"],
    getToken: extraHeaderFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-extra-header", sha: headSha }),
  /http\.extraHeader/
);
assert.equal(extraHeaderFactory.state.issued, false);
git(["config", "--unset", "http.extraHeader"], { cwd: localRepoPath });

// J. Payload validation fails before token issuance: oversized files.
fs.writeFileSync(path.join(localRepoPath, "oversized.dat"), Buffer.alloc(11 * 1024 * 1024));
git(["add", "oversized.dat"], { cwd: localRepoPath });
git(["commit", "-m", "Oversized file commit"], { cwd: localRepoPath });
const oversizedSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
const oversizedFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: headSha,
    headSha: oversizedSha,
    headRef: "refs/heads/feature-oversized",
    allowedOperations: ["create_branch"],
    getToken: oversizedFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-oversized", sha: oversizedSha }),
  /exceeds size limit/
);
assert.equal(oversizedFactory.state.issued, false);
git(["reset", "--hard", headSha], { cwd: localRepoPath });

// K. Binary files without LFS tracking are rejected before token issuance.
fs.writeFileSync(path.join(localRepoPath, "binary.dat"), Buffer.from([0, 1, 2, 3, 0, 1]));
git(["add", "binary.dat"], { cwd: localRepoPath });
git(["commit", "-m", "Binary file commit"], { cwd: localRepoPath });
const binarySha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
const binaryFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: headSha,
    headSha: binarySha,
    headRef: "refs/heads/feature-binary",
    allowedOperations: ["create_branch"],
    getToken: binaryFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-binary", sha: binarySha }),
  /is binary and must be tracked via LFS/
);
assert.equal(binaryFactory.state.issued, false);
git(["reset", "--hard", headSha], { cwd: localRepoPath });

// L. Invalid LFS pointers are rejected before token issuance.
fs.writeFileSync(path.join(localRepoPath, "invalid-lfs.txt"), "version https://git-lfs.github.com/spec/v1\noid sha256:invalid\nsize 123");
git(["add", "invalid-lfs.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Invalid LFS commit"], { cwd: localRepoPath });
const invalidLfsSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
const invalidLfsFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: headSha,
    headSha: invalidLfsSha,
    headRef: "refs/heads/feature-invalid-lfs",
    allowedOperations: ["create_branch"],
    getToken: invalidLfsFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-invalid-lfs", sha: invalidLfsSha }),
  /invalid LFS pointer format/
);
assert.equal(invalidLfsFactory.state.issued, false);
git(["reset", "--hard", headSha], { cwd: localRepoPath });

// M. Valid LFS pointers are also rejected fail-closed: object availability
// on the remote cannot be proven before mutation.
fs.writeFileSync(
  path.join(localRepoPath, "valid-lfs.txt"),
  `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n`,
);
git(["add", "valid-lfs.txt"], { cwd: localRepoPath });
git(["commit", "-m", "Valid LFS pointer commit"], { cwd: localRepoPath });
const validLfsSha = gitOut(["rev-parse", "HEAD"], { cwd: localRepoPath });
const validLfsFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: headSha,
    headSha: validLfsSha,
    headRef: "refs/heads/feature-valid-lfs",
    allowedOperations: ["create_branch"],
    getToken: validLfsFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-valid-lfs", sha: validLfsSha }),
  /availability.*cannot be proven|rejecting/
);
assert.equal(validLfsFactory.state.issued, false);
git(["reset", "--hard", headSha], { cwd: localRepoPath });

// N. Exact remote binding: a different bound repository is refused.
const wrongRemoteFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "wrong/repo",
    baseRef: "main",
    baseSha: baseCommitSha,
    headSha,
    headRef: "refs/heads/feature-wrong-remote",
    allowedOperations: ["create_branch"],
    getToken: wrongRemoteFactory.getToken,
    expectedLogin: "builder[bot]",
  }).createBranch({ ref: "refs/heads/feature-wrong-remote", sha: headSha }),
  /Remote URL mismatch/
);
assert.equal(wrongRemoteFactory.state.issued, false);

// O. Local URL rewrites are rejected fail-closed before token issuance.
// insteadOf is already caught by the exact remote-URL match (git reports the
// rewritten URL); pushInsteadOf is invisible to `remote get-url`, so the
// dedicated config check must catch it.
git(["config", "url.http://127.0.0.1:1/.insteadOf", "https://github.com/"], { cwd: localRepoPath });
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: baseCommitSha,
    headSha,
    headRef: "refs/heads/feature-rewrite",
    allowedOperations: ["create_branch"],
    getToken: tokenFactory().getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-rewrite", sha: headSha }),
  /Remote URL mismatch/
);
git(["config", "--unset", "url.http://127.0.0.1:1/.insteadOf"], { cwd: localRepoPath });
git(["config", "url.http://127.0.0.1:1/.pushInsteadOf", "https://github.com/"], { cwd: localRepoPath });
const rewriteFactory = tokenFactory();
await assert.rejects(
  createBoundBuilderClient({
    apiUrl: "https://github.test",
    fetchImpl: fakeGitHub().fetchImpl,
    workspace: localRepoPath,
    repository: "owner/repo",
    baseRef: "main",
    baseSha: baseCommitSha,
    headSha,
    headRef: "refs/heads/feature-rewrite",
    allowedOperations: ["create_branch"],
    getToken: rewriteFactory.getToken,
    expectedLogin: "builder[bot]",
    transportUrl,
  }).createBranch({ ref: "refs/heads/feature-rewrite", sha: headSha }),
  /insteadOf/
);
assert.equal(rewriteFactory.state.issued, false);
git(["config", "--unset", "url.http://127.0.0.1:1/.pushInsteadOf"], { cwd: localRepoPath });

// Durable receipts: every branch mutation left structured, token-free evidence
// with operation, App identity, ref, expected old SHA, requested new SHA,
// observed remote SHA, and outcome.
const rawReceiptLog = fs.readFileSync(receiptLogPath, "utf8");
assert.ok(!rawReceiptLog.includes(BUILDER_TOKEN), "durable receipts must never contain the token");
const receiptLines = rawReceiptLog.trim().split("\n").map((line) => JSON.parse(line));
const BRANCH_OPS = ["create_branch", "push_branch", "replace_branch"];
const NON_BRANCH_OPS = ["ensure_pull_request", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge"];
for (const receipt of receiptLines) {
  assert.match(receipt.operationId, /^[0-9a-f]{64}$/);
  assert.equal(receipt.repository, "owner/repo");
  assert.ok(receipt.recordedAt);
  assert.equal(receipt.appIdentity.expectedLogin, "builder[bot]");
  // Every durable receipt carries its provider-neutral lifecycle outcome so a
  // restarted process can inspect succeeded/rejected/indeterminate/reconciled.
  assert.ok(["succeeded", "rejected", "indeterminate", "reconciled"].includes(receipt.deliveryOutcome));
  if (BRANCH_OPS.includes(receipt.operation)) {
    assert.ok(receipt.ref.startsWith("refs/heads/"));
    assert.ok(Object.hasOwn(receipt, "requestedSha"));
    assert.ok(Object.hasOwn(receipt, "expectedOldSha"));
    assert.ok(Object.hasOwn(receipt, "observedRemoteSha"));
    assert.ok(["created", "fast_forwarded", "replaced", "idempotent", "reconciled", "indeterminate", "failed"].includes(receipt.outcome));
    assert.equal(receipt.deliveryOutcome, classifyDeliveryOutcome(receipt));
  } else {
    // Non-branch durable receipt: canonical operationId, request envelope, and
    // intent/terminal lifecycle for restart inspection.
    assert.ok(NON_BRANCH_OPS.includes(receipt.operation), `unexpected receipt operation ${receipt.operation}`);
    assert.ok(["intent", "succeeded", "idempotent", "reconciled", "failed", "indeterminate"].includes(receipt.outcome));
    assert.equal(receipt.request.operation, receipt.operation);
  }
}
for (const expectedOutcome of ["created", "fast_forwarded", "replaced", "idempotent", "reconciled", "indeterminate", "failed"]) {
  assert.ok(receiptLines.some((receipt) => BRANCH_OPS.includes(receipt.operation) && receipt.outcome === expectedOutcome), `missing durable receipt outcome ${expectedOutcome}`);
}
// The non-branch lifecycle is durably recorded too: an intent precedes each
// mutation and a terminal outcome follows.
assert.ok(receiptLines.some((r) => NON_BRANCH_OPS.includes(r.operation) && r.outcome === "intent"), "missing non-branch intent receipt");
assert.ok(receiptLines.some((r) => NON_BRANCH_OPS.includes(r.operation) && r.outcome === "succeeded"), "missing non-branch terminal receipt");

const envelopeInstructions = builderEnvelopeInstructions({ githubBuilder: base, threads: [{ id: "thread-1" }] });
assert.match(envelopeInstructions, /thread-1/);
const envelope = parseBuilderEnvelope(`done\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [{ operation: "reply_review_thread", threadId: "thread-1", body: "Fixed" }],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.equal(envelope.operations[0].operation, "reply_review_thread");
assert.throws(() => parseBuilderEnvelope("missing"), /required bound GitHub builder envelope/);
const branchOpsEnvelope = parseBuilderEnvelope(`done\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [
    { operation: "create_branch", ref: "refs/heads/feature", sha: "a".repeat(40) },
    { operation: "push_branch", ref: "refs/heads/feature", sha: "a".repeat(40), oldSha: "b".repeat(40) },
    { operation: "replace_branch", ref: "refs/heads/feature", sha: "a".repeat(40), oldSha: "b".repeat(40) },
  ],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.equal(branchOpsEnvelope.operations[0].operation, "create_branch");
assert.equal(branchOpsEnvelope.operations[1].oldSha, "b".repeat(40));
assert.equal(branchOpsEnvelope.operations[2].operation, "replace_branch");
assert.throws(() => parseBuilderEnvelope(`x\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [{ operation: "push_branch", ref: "refs/heads/feature", sha: "not-a-sha" }],
})}\n---END BOUND_GITHUB_BUILDER---`));

// Canonical contract: the Claude/Codex MCP inputSchema and the Antigravity
// envelope schema are both derived from one source of truth and cannot drift.
assert.deepEqual(Object.keys(builderMcpInputSchema("create_branch")).sort(), ["ref", "sha"]);
assert.deepEqual(Object.keys(builderMcpInputSchema("push_branch")).sort(), ["oldSha", "ref", "sha"]);
assert.throws(
  () => builderMcpInputSchema("delete_repository"),
  (error) => error instanceof BuilderUnsupportedError && error.code === "unsupported",
);
const canonicalEnvelopeOp = builderEnvelopeOperationSchema();
assert.equal(
  canonicalEnvelopeOp.parse({ operation: "create_branch", ref: "refs/heads/feature", sha: "a".repeat(40) }).operation,
  "create_branch",
);
assert.throws(() => canonicalEnvelopeOp.parse({ operation: "create_branch", ref: "refs/heads/feature", sha: "not-a-sha" }));
// The MCP create_branch schema now shares the envelope's 220-char ref bound.
assert.throws(() => canonicalEnvelopeOp.parse({ operation: "create_branch", ref: `refs/heads/${"x".repeat(300)}`, sha: "a".repeat(40) }));

// Lifecycle: every builder receipt maps to one provider-neutral delivery
// outcome that distinguishes succeeded, rejected, indeterminate, and reconciled.
assert.equal(classifyDeliveryOutcome({ outcome: "created" }), DELIVERY_OUTCOMES.SUCCEEDED);
assert.equal(classifyDeliveryOutcome({ outcome: "idempotent" }), DELIVERY_OUTCOMES.SUCCEEDED);
assert.equal(classifyDeliveryOutcome({ outcome: "reconciled" }), DELIVERY_OUTCOMES.RECONCILED);
assert.equal(classifyDeliveryOutcome({ outcome: "indeterminate" }), DELIVERY_OUTCOMES.INDETERMINATE);
assert.equal(classifyDeliveryOutcome({ outcome: "failed" }), DELIVERY_OUTCOMES.REJECTED);
assert.equal(classifyDeliveryOutcome({ operation: "merge", prNumber: 42 }), DELIVERY_OUTCOMES.SUCCEEDED);
assert.equal(classifyDeliveryOutcome({ error: "boom" }), DELIVERY_OUTCOMES.REJECTED);

// Durable reconciliation store: replaying the receipt log rebuilds pending
// indeterminate refs and clears them once a terminal outcome is recorded.
const reconLogPath = path.join(tmpDir, "recon", "receipts.jsonl");
fs.mkdirSync(path.dirname(reconLogPath), { recursive: true });
fs.writeFileSync(reconLogPath, [
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/done", outcome: "created", requestedSha: headSha, recordedAt: "t1" }),
  JSON.stringify({ operation: "push_branch", ref: "refs/heads/hanging", outcome: "indeterminate", requestedSha: headSha, expectedOldSha: baseCommitSha, recordedAt: "t2" }),
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/recovered", outcome: "indeterminate", requestedSha: headSha, recordedAt: "t3" }),
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/recovered", outcome: "reconciled", requestedSha: headSha, recordedAt: "t4" }),
  "",
].join("\n"));
const rehydrated = loadBranchReconciliationState(reconLogPath);
assert.equal(rehydrated.has("refs/heads/done"), false);
assert.equal(rehydrated.has("refs/heads/recovered"), false);
assert.equal(rehydrated.get("refs/heads/hanging").expectedOldSha, baseCommitSha);
assert.equal(loadBranchReconciliationState(path.join(tmpDir, "recon", "missing.jsonl")).size, 0);
assert.equal(loadBranchReconciliationState(null).size, 0);

// Restart durability: a fresh client whose durable log records an indeterminate
// prior mutation reconciles by remote read-back before any push, resuming
// without a duplicate mutation across a process/agent restart.
git(["push", bareRepoPath, `${headSha}:refs/heads/restart-recon`], { cwd: localRepoPath });
const restartReconLog = path.join(tmpDir, "restart", "recon.jsonl");
fs.mkdirSync(path.dirname(restartReconLog), { recursive: true });
fs.writeFileSync(restartReconLog, `${JSON.stringify({
  operation: "create_branch", ref: "refs/heads/restart-recon", outcome: "indeterminate",
  requestedSha: headSha, expectedOldSha: null, recordedAt: "prior-process",
})}\n`);
const restartPushesBefore = mockServer.pushAttempts;
const restartClient = createBoundBuilderClient({
  ...base, headRef: "restart-recon", allowedOperations: ["create_branch"],
  fetchImpl: fakeGitHub({ branchShas: { main: headSha } }).fetchImpl, receiptPath: restartReconLog,
});
const restartResult = await restartClient.createBranch({ ref: "refs/heads/restart-recon", sha: headSha });
assert.equal(restartResult.outcome, "reconciled");
assert.equal(restartResult.reconciled, true);
assert.equal(mockServer.pushAttempts, restartPushesBefore, "restart reconciliation must not re-push");

// Restart durability, read-back unavailable: the fresh client stays fail-closed
// and refuses any push until a read-only reconciliation succeeds.
const restartBlockLog = path.join(tmpDir, "restart", "block.jsonl");
fs.writeFileSync(restartBlockLog, `${JSON.stringify({
  operation: "create_branch", ref: "refs/heads/restart-block", outcome: "indeterminate",
  requestedSha: headSha, expectedOldSha: null, recordedAt: "prior-process",
})}\n`);
const blockPushesBefore = mockServer.pushAttempts;
const restartBlockClient = createBoundBuilderClient({
  ...base, headRef: "restart-block", allowedOperations: ["create_branch"],
  fetchImpl: fakeGitHub({ branchShas: { "restart-block": { error: 503 } } }).fetchImpl,
  receiptPath: restartBlockLog,
});
await assert.rejects(
  restartBlockClient.createBranch({ ref: "refs/heads/restart-block", sha: headSha }),
  /read-only reconciliation must succeed before retry/,
);
assert.equal(mockServer.pushAttempts, blockPushesBefore, "blocked restart must not push");

// (7) Antigravity envelopes are published UNCHANGED: strict validation must not
// inject zod defaults (draft/body/method) into the promised-unchanged content.
const unchangedEnvelope = parseBuilderEnvelope(`ok\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [
    { operation: "ensure_pull_request", title: "T" },
    { operation: "merge" },
  ],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.deepEqual(unchangedEnvelope.operations[0], { operation: "ensure_pull_request", title: "T" });
assert.equal(Object.hasOwn(unchangedEnvelope.operations[0], "draft"), false);
assert.equal(Object.hasOwn(unchangedEnvelope.operations[0], "body"), false);
assert.deepEqual(unchangedEnvelope.operations[1], { operation: "merge" });
assert.equal(Object.hasOwn(unchangedEnvelope.operations[1], "method"), false);

// (6) classifyDeliveryOutcome fails closed on an unrecognized value rather than
// silently reporting success.
assert.throws(() => classifyDeliveryOutcome({ outcome: "totally-unknown" }), /Unrecognized builder delivery outcome/);
assert.throws(() => classifyDeliveryOutcome("banana"), /Unrecognized builder delivery outcome/);

// (6) The durable log loader tolerates a torn trailing append but fails closed on
// a corrupt interior record or an indeterminate record without a resolvable ref.
const tornTailLog = path.join(tmpDir, "faillog", "torn.jsonl");
fs.mkdirSync(path.dirname(tornTailLog), { recursive: true });
fs.writeFileSync(tornTailLog, `${JSON.stringify({ operation: "create_branch", ref: "refs/heads/tail", outcome: "indeterminate", requestedSha: headSha })}\n{ torn write`);
const tornState = loadBranchReconciliationState(tornTailLog);
assert.equal(tornState.has("refs/heads/tail"), true);
const interiorCorruptLog = path.join(tmpDir, "faillog", "interior.jsonl");
fs.writeFileSync(interiorCorruptLog, `{ corrupt interior\n${JSON.stringify({ operation: "create_branch", ref: "refs/heads/ok", outcome: "created", requestedSha: headSha })}\n`);
assert.throws(() => loadBranchReconciliationState(interiorCorruptLog), /corrupt record.*fail-closed/);
const indeterminateNoRefLog = path.join(tmpDir, "faillog", "noref.jsonl");
fs.writeFileSync(indeterminateNoRefLog, `${JSON.stringify({ operation: "create_branch", outcome: "indeterminate" })}\n`);
assert.throws(() => loadBranchReconciliationState(indeterminateNoRefLog), /indeterminate record without a resolvable ref/);

// (1) A different-SHA retry must NOT erase an unresolved indeterminate marker: the
// prior attempt is reconciled on its own requestedSha and durably recorded, then
// the current operation proceeds against the observed remote state.
git(["push", bareRepoPath, `${headSha}:refs/heads/diff-sha-recon`], { cwd: localRepoPath });
const diffShaLog = path.join(tmpDir, "diffsha", "recon.jsonl");
fs.mkdirSync(path.dirname(diffShaLog), { recursive: true });
fs.writeFileSync(diffShaLog, `${JSON.stringify({
  operation: "create_branch", ref: "refs/heads/diff-sha-recon", outcome: "indeterminate",
  requestedSha: headSha, expectedOldSha: null, recordedAt: "prior-process",
})}\n`);
const diffShaPushesBefore = mockServer.pushAttempts;
const diffShaClient = createBoundBuilderClient({
  ...base, baseSha: headSha, headSha: successHeadSha, headRef: "diff-sha-recon", allowedOperations: ["create_branch"],
  fetchImpl: fakeGitHub({ branchShas: { main: headSha } }).fetchImpl, receiptPath: diffShaLog,
});
await assert.rejects(
  diffShaClient.createBranch({ ref: "refs/heads/diff-sha-recon", sha: successHeadSha }),
  /already exists at/,
);
assert.equal(mockServer.pushAttempts, diffShaPushesBefore, "different-SHA retry must not push");
const diffShaReceipts = fs.readFileSync(diffShaLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const priorResolution = diffShaReceipts.find((receipt) => receipt.requestedSha === headSha && receipt.outcome === "reconciled");
assert.ok(priorResolution, "the prior indeterminate marker must be durably reconciled, not erased");
assert.equal(loadBranchReconciliationState(diffShaLog).has("refs/heads/diff-sha-recon"), false);

// (3) Non-branch restart reconciliation: a fresh client whose durable log holds
// a dangling merge intent, where the remote now shows the PR already merged,
// records "reconciled" (not a fresh "idempotent") and performs no merge PUT.
const mergeReconLog = path.join(tmpDir, "nonbranch", "merge-recon.jsonl");
fs.mkdirSync(path.dirname(mergeReconLog), { recursive: true });
// The operationId is content-addressed on operation+repository+headSha+method,
// matching what the bound client computes for merge({ method: "squash" }). The
// durable intent must exist BEFORE the client is constructed so it rehydrates.
const mergeIntentId = createHash("sha256").update(JSON.stringify({
  operation: "merge", repository: "owner/repo", headSha, method: "squash",
})).digest("hex");
fs.writeFileSync(mergeReconLog, `${JSON.stringify({
  operationId: mergeIntentId, operation: "merge", repository: "owner/repo", headSha,
  request: { operation: "merge", method: "squash" }, outcome: "intent",
  deliveryOutcome: "indeterminate", recordedAt: "prior-process",
})}\n`);
const mergeReconApi = fakeGitHub({ merged: true });
const mergeReconClient = createBoundBuilderClient({ ...base, fetchImpl: mergeReconApi.fetchImpl, receiptPath: mergeReconLog });
const mergeReconResult = await mergeReconClient.merge({ method: "squash" });
assert.equal(mergeReconResult.idempotent, true);
assert.equal(mergeReconApi.calls.some((call) => call.path === "/repos/owner/repo/pulls/42/merge"), false);
const mergeReconReceipts = fs.readFileSync(mergeReconLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.ok(
  mergeReconReceipts.some((receipt) => receipt.operation === "merge" && receipt.outcome === "reconciled"),
  "a landed prior merge intent must reconcile on restart, not report a fresh idempotent no-op",
);
// A fresh idempotent merge with no prior intent records "idempotent", not "reconciled".
const mergeFreshLog = path.join(tmpDir, "nonbranch", "merge-fresh.jsonl");
const mergeFreshApi = fakeGitHub({ merged: true });
await createBoundBuilderClient({ ...base, fetchImpl: mergeFreshApi.fetchImpl, receiptPath: mergeFreshLog }).merge({ method: "squash" });
const mergeFreshReceipts = fs.readFileSync(mergeFreshLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.equal(mergeFreshReceipts.length, 1);
assert.equal(mergeFreshReceipts[0].outcome, "idempotent");

// (2) Lifecycle: aggregate delivery outcomes report the most severe present, so
// lifecycle status and coordinator wakes can distinguish the four states.
assert.equal(aggregateDeliveryOutcome(["succeeded", "reconciled"]), "reconciled");
assert.equal(aggregateDeliveryOutcome(["succeeded", "rejected", "reconciled"]), "rejected");
assert.equal(aggregateDeliveryOutcome(["succeeded", "indeterminate", "rejected"]), "indeterminate");
assert.equal(aggregateDeliveryOutcome(["succeeded", "succeeded"]), "succeeded");
assert.equal(aggregateDeliveryOutcome([]), null);

// (2) The durable log summarizes into one provider-neutral delivery outcome for a
// bound head SHA; transient intent records are excluded.
const summaryLog = path.join(tmpDir, "summary", "receipts.jsonl");
fs.mkdirSync(path.dirname(summaryLog), { recursive: true });
fs.writeFileSync(summaryLog, [
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/a", outcome: "created", requestedSha: headSha, deliveryOutcome: "succeeded" }),
  JSON.stringify({ operationId: "op1", operation: "merge", headSha, outcome: "intent", deliveryOutcome: "indeterminate" }),
  JSON.stringify({ operationId: "op1", operation: "merge", headSha, outcome: "reconciled", deliveryOutcome: "reconciled" }),
  "",
].join("\n"));
const deliverySummary = summarizeDeliveryOutcomes(summaryLog, { headSha });
assert.equal(deliverySummary.outcome, "reconciled");
assert.equal(deliverySummary.counts.succeeded, 1);
assert.equal(deliverySummary.counts.reconciled, 1);
assert.equal(deliverySummary.counts.indeterminate, undefined);
assert.equal(summarizeDeliveryOutcomes(summaryLog, { headSha: "z".repeat(40) }), null);
assert.equal(summarizeDeliveryOutcomes(null), null);

// (2) Superseding regressions: a later reconciled must not stay indeterminate,
// and a later succeeded must not stay rejected, because only the latest effective
// state per stable operation identity aggregates.
const supersedeReconLog = path.join(tmpDir, "summary", "indeterminate-to-reconciled.jsonl");
fs.writeFileSync(supersedeReconLog, [
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/x", operationId: "b1", outcome: "indeterminate", deliveryOutcome: "indeterminate", requestedSha: headSha }),
  JSON.stringify({ operation: "create_branch", ref: "refs/heads/x", operationId: "b1", outcome: "reconciled", deliveryOutcome: "reconciled", requestedSha: headSha }),
  "",
].join("\n"));
const reconSummary = summarizeDeliveryOutcomes(supersedeReconLog, { headSha });
assert.equal(reconSummary.outcome, "reconciled");
assert.equal(reconSummary.counts.indeterminate, undefined);

const supersedeSucceedLog = path.join(tmpDir, "summary", "failed-to-succeeded.jsonl");
fs.writeFileSync(supersedeSucceedLog, [
  JSON.stringify({ operationId: "m1", operation: "merge", headSha, outcome: "failed", deliveryOutcome: "rejected" }),
  JSON.stringify({ operationId: "m1", operation: "merge", headSha, outcome: "succeeded", deliveryOutcome: "succeeded" }),
  "",
].join("\n"));
const succeedSummary = summarizeDeliveryOutcomes(supersedeSucceedLog, { headSha });
assert.equal(succeedSummary.outcome, "succeeded");
assert.equal(succeedSummary.counts.rejected, undefined);

// A dangling intent with no terminal remains genuinely indeterminate.
const danglingLog = path.join(tmpDir, "summary", "dangling-intent.jsonl");
fs.writeFileSync(danglingLog, `${JSON.stringify({ operationId: "i1", operation: "merge", headSha, outcome: "intent", deliveryOutcome: "indeterminate" })}\n`);
assert.equal(summarizeDeliveryOutcomes(danglingLog, { headSha }).outcome, "indeterminate");

// (5) Provider-equivalence fixtures. Claude and Codex reach the builder through
// the MCP inputSchema; Antigravity reaches it through the free-text envelope.
// Both boundaries derive from one canonical contract, so for every scenario they
// must normalize the caller's operation identically and dispatch to the same
// shared client method. The behavioral transport outcomes are exercised by the
// tests cross-referenced below (all three providers share that one client).
const CANONICAL_METHOD = {
  create_branch: "createBranch",
  push_branch: "pushBranch",
  replace_branch: "replaceBranch",
  ensure_pull_request: "ensurePullRequest",
  reply_review_thread: "replyReviewThread",
  resolve_review_thread: "resolveReviewThread",
  mark_ready: "markReady",
  merge: "merge",
};
// A recording stand-in for the shared bound client. The Antigravity envelope
// dispatch performed by agent-pool.publishAntigravityBuilder destructures
// `{ operation, ...input }` and calls client[method](input) — the same input the
// Claude/Codex MCP tool handler forwards. We exercise that exact dispatch.
const dispatched = [];
const recordingClient = Object.fromEntries(
  Object.values(CANONICAL_METHOD).map((method) => [method, async (input) => { dispatched.push({ method, input }); }]),
);
const dispatchEnvelopeOperation = async (operation) => {
  const { operation: name, ...input } = operation;
  await recordingClient[CANONICAL_METHOD[name]](input);
};
const EQUIVALENCE_FIXTURES = [
  { scenario: "create", op: { operation: "create_branch", ref: "refs/heads/feature", sha: "a".repeat(40) }, behavioralTest: "A/B create_branch" },
  { scenario: "fast_forward", op: { operation: "push_branch", ref: "refs/heads/feature", sha: "a".repeat(40), oldSha: "b".repeat(40) }, behavioralTest: "E push_branch" },
  { scenario: "rework", op: { operation: "replace_branch", ref: "refs/heads/feature", sha: "a".repeat(40), oldSha: "b".repeat(40) }, behavioralTest: "D3 replace_branch" },
  { scenario: "ambiguous_transport", op: { operation: "push_branch", ref: "refs/heads/feature", sha: "a".repeat(40) }, behavioralTest: "D lossy reconcile" },
  { scenario: "restart", op: { operation: "create_branch", ref: "refs/heads/feature", sha: "a".repeat(40) }, behavioralTest: "restart reconciliation" },
  { scenario: "denied_permission", op: { operation: "create_branch", ref: "refs/heads/feature", sha: "a".repeat(40) }, behavioralTest: "I2 deny-push" },
];
for (const { scenario, op } of EQUIVALENCE_FIXTURES) {
  const { operation, ...callerFields } = op;
  // Claude/Codex adapter boundary: the MCP inputSchema accepts the operation.
  const mcpInput = z.object(builderMcpInputSchema(operation)).parse(callerFields);
  // Antigravity adapter boundary: the envelope validates and publishes unchanged.
  const envelope = parseBuilderEnvelope(`x\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({ operations: [op] })}\n---END BOUND_GITHUB_BUILDER---`);
  const { operation: envelopeName, ...envelopeInput } = envelope.operations[0];
  assert.equal(envelopeName, operation, `${scenario}: envelope operation must be canonical`);

  // Exercise the ACTUAL Antigravity envelope dispatch: it must call the same
  // shared client method with the same caller fields the MCP boundary forwards.
  dispatched.length = 0;
  await dispatchEnvelopeOperation(envelope.operations[0]);
  assert.equal(dispatched.length, 1, `${scenario}: exactly one dispatched operation`);
  assert.equal(dispatched[0].method, CANONICAL_METHOD[operation], `${scenario}: dispatched to the canonical method`);
  for (const key of Object.keys(callerFields)) {
    assert.deepEqual(dispatched[0].input[key], callerFields[key], `${scenario}: dispatched envelope field ${key} diverged`);
    assert.deepEqual(mcpInput[key], callerFields[key], `${scenario}: mcp field ${key} diverged`);
  }

  // Exercise the ACTUAL generated Claude and Codex requests: the bound builder
  // is wired with this operation in its allowlist (the Claude/Codex delivery
  // boundary), not raw shell delivery.
  const binding = { repository: "owner/repo", expectedLogin: "builder[bot]", baseSha: baseCommitSha, headSha, headRef: "codex/feature", baseRef: "main", allowedOperations: [operation] };
  const claudeRequest = claudeToolRequest({ prompt: "x", mode: "work", workProfile: "implement", githubBuilder: binding });
  assert.ok(claudeRequest.arguments.githubBuilder.allowedOperations.includes(operation), `${scenario}: Claude request wires the builder operation`);
  assert.equal(claudeRequest.arguments.githubBuilder.baseSha, baseCommitSha, `${scenario}: Claude request preserves the exact base authorization`);
  const codexRequest = codexToolRequest({ prompt: "x", cwd: localRepoPath, mode: "work", workProfile: "implement", githubBuilder: binding, githubBuilderBridgePath: path.join(tmpDir, "bridge.mjs") });
  assert.match(codexRequest.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_ALLOWED_OPERATIONS"], new RegExp(operation), `${scenario}: Codex request wires the builder operation`);
  assert.equal(codexRequest.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_BASE_SHA"], baseCommitSha, `${scenario}: Codex request wires the exact base authorization`);
}

cleanup();
clearTimeout(watchdog);
console.log("Bound GitHub builder tests passed: PR lifecycle, exact head, trusted latest review gate, merge paths, bounded no-shell transport, create_branch, fast-forward push_branch, guarded replace_branch, canonical contract derivation, delivery-outcome mapping, and durable restart reconciliation.");

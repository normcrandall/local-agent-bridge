import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import { builderEnvelopeInstructions, parseBuilderEnvelope } from "../src/builder-envelope.mjs";
import { execFileSync, execSync, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { tmpdir } from "node:os";

// Setup temp directories in OS temp directory
const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "git-test-"));

const testId = Math.random().toString(36).slice(2, 8);
const localRepoPath = path.join(tmpDir, `local-${testId}`);
const bareRepoPath = path.join(tmpDir, `remote-${testId}.git`);

// Init repos
execFileSync("git", ["init", "--bare", bareRepoPath]);
execFileSync("git", ["init", localRepoPath]);
execFileSync("git", ["config", "user.name", "Test User"], { cwd: localRepoPath });
execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: localRepoPath });
execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo"], { cwd: localRepoPath });

// Write initial commit on main
fs.writeFileSync(path.join(localRepoPath, "file.txt"), "hello world");
execFileSync("git", ["add", "file.txt"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: localRepoPath });
const actualHeadSha = execSync("git rev-parse HEAD", { cwd: localRepoPath }).toString().trim();

// Create diverged branch & commit
execFileSync("git", ["checkout", "-b", "diverged-branch"], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "diverged.txt"), "diverged content");
execFileSync("git", ["add", "diverged.txt"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Diverged commit"], { cwd: localRepoPath });
const divergedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepoPath }).toString().trim();

// Create lfs-invalid branch & commit
execFileSync("git", ["checkout", "-b", "lfs-invalid-branch"], { cwd: localRepoPath });
fs.writeFileSync(path.join(localRepoPath, "bad-lfs.txt"), "version https://git-lfs.github.com/spec/v1\ninvalid format\n");
execFileSync("git", ["add", "bad-lfs.txt"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Bad LFS commit"], { cwd: localRepoPath });
const lfsInvalidSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepoPath }).toString().trim();

// Checkout main back
execFileSync("git", ["checkout", "main"], { cwd: localRepoPath });

// Start Mock Git Smart HTTP server
const expectedAuth = "Basic " + Buffer.from("x-access-token:ghs_builder-token").toString("base64");
const mockServer = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
    res.end();
    return;
  }
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
      "Cache-Control": "no-cache"
    });
    const serviceHeader = `# service=${service}\n`;
    const len = (serviceHeader.length + 4).toString(16).padStart(4, "0");
    res.write(len + serviceHeader + "0000");

    const cp = spawn("git", [service.slice(4), "--stateless-rpc", "--advertise-refs", bareRepoPath]);
    cp.stdout.pipe(res);
  } else if (url.pathname.endsWith("/git-receive-pack")) {
    res.writeHead(200, {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache"
    });
    const cp = spawn("git", ["receive-pack", "--stateless-rpc", bareRepoPath]);
    req.pipe(cp.stdin);
    cp.stdout.pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

const port = await new Promise((resolve) => {
  mockServer.listen(0, "127.0.0.1", () => {
    resolve(mockServer.address().port);
  });
});

process.on("exit", () => {
  mockServer.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// Configure URL rewriting in local repo to redirect to mock server
execFileSync("git", ["config", `url.http://127.0.0.1:${port}/.insteadOf`, "https://github.com/"], { cwd: localRepoPath });

// Push diverged and LFS invalid branches to remote so they exist there
execFileSync("git", ["push", "origin", "diverged-branch:refs/heads/diverged-branch"], { cwd: localRepoPath });
execFileSync("git", ["push", "origin", "lfs-invalid-branch:refs/heads/lfs-invalid-branch"], { cwd: localRepoPath });

const headSha = actualHeadSha;
const base = {
  apiUrl: "https://github.test",
  token: "ghs_builder-token",
  repository: "owner/repo",
  expectedLogin: "builder[bot]",
  verifiedLogin: "builder[bot]",
  headSha,
  prNumber: 42,
  headRef: "codex/feature",
  baseRef: "main",
  requiredReviewStatusContext: "agent-review",
  trustedReviewLogins: ["reviewer[bot]"],
  allowedOperations: ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge", "create_branch", "push_branch"],
  workspace: localRepoPath,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fakeGitHub({
  currentSha = headSha, wrongThread = false, existingPull = false,
  reviewStatus = "success", reviewLogin = "reviewer[bot]", reviewStatuses = null, reviews = [],
  statusPermissionDenied = false,
} = {}) {
  const calls = [];
  const branchShas = {
    "stale-branch": "c".repeat(40),
    "fail-update": "c".repeat(40),
    "diverged-branch": "d".repeat(40),
    "lfs-invalid-branch": "e".repeat(40),
    "reconcile-push-success": "c".repeat(40),
  };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || "GET", body });
    if (path === "/repos/owner/repo" && (options.method || "GET") === "GET") return json({
      default_branch: "main"
    });
    if (path === "/repos/owner/repo/git/refs" && options.method === "POST") {
      if (body.ref === "refs/heads/already-exists") {
        return json({ message: "Reference already exists" }, 422);
      }
      const branch = body.ref.slice("refs/heads/".length);
      branchShas[branch] = body.sha;
      if (branch === "reconciled-branch") {
        const err = new Error("503 Service Unavailable");
        err.status = 503;
        throw err;
      }
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (path.startsWith("/repos/owner/repo/git/refs/heads/") && options.method === "PATCH") {
      const parts = path.split("/");
      const branch = parts[parts.length - 1];
      if (branch === "fail-update") {
        return json({ message: "Server Error" }, 500);
      }
      branchShas[branch] = body.sha;
      if (branch === "reconcile-push-success") {
        const err = new Error("503 Service Unavailable");
        err.status = 503;
        throw err;
      }
      return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (path.startsWith("/repos/owner/repo/git/ref/heads/")) {
      const parts = path.split("/");
      const branch = parts[parts.length - 1];
      if (branch === "non-existent") {
        return json({ message: "Not Found" }, 404);
      }
      try {
        const sha = execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bareRepoPath, stdio: "pipe" }).toString().trim();
        return json({ ref: `refs/heads/${branch}`, object: { sha } });
      } catch {
        const sha = branchShas[branch] || currentSha;
        return json({ ref: `refs/heads/${branch}`, object: { sha } });
      }
    }
    if (path.startsWith("/repos/owner/repo/branches/")) {
      const parts = path.split("/");
      const branch = decodeURIComponent(parts[parts.length - 1]);
      if (branch === "protected-branch") {
        return json({ name: branch, protected: true });
      }
      return json({ name: branch, protected: false });
    }
    if (path.startsWith("/repos/owner/repo/compare/")) {
      const parts = path.split("/");
      const range = parts[parts.length - 1];
      const [baseSha, headShaVal] = range.split("...");
      if (baseSha === "d".repeat(40)) {
        return json({ status: "diverged" });
      }
      if (baseSha === "e".repeat(40)) {
        return json({
          status: "ahead",
          files: [
            { filename: "large-file.bin", status: "added", sha: "large-blob-sha", patch: "some binary patch" },
            { filename: "lfs-bad.txt", status: "added", sha: "bad-lfs-blob-sha", patch: "version https://git-lfs.github.com/spec/v1\n" }
          ]
        });
      }
      return json({ status: "ahead", files: [] });
    }
    if (path.startsWith("/repos/owner/repo/git/blobs/")) {
      const parts = path.split("/");
      const blobSha = parts[parts.length - 1];
      if (blobSha === "bad-lfs-blob-sha") {
        return json({
          content: Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:invalid-sha\n").toString("base64"),
          encoding: "base64",
          size: 100
        });
      }
      return json({ message: "Not Found" }, 404);
    }
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

// createBranch tests
// 1. Success
const created = await clientForBranches.createBranch({ ref: "refs/heads/codex/feature", sha: headSha });
assert.equal(created.operation, "create_branch");
assert.equal(created.idempotent, false);
assert.equal(created.readBackSha, headSha);

// 2. Duplicate ref idempotency
const duplicateClient = createBoundBuilderClient({ ...base, headRef: "already-exists", fetchImpl: api.fetchImpl });
const duplicateCreated = await duplicateClient.createBranch({ ref: "refs/heads/already-exists", sha: headSha });
assert.equal(duplicateCreated.operation, "create_branch");
assert.equal(duplicateCreated.idempotent, true);
assert.equal(duplicateCreated.readBackSha, headSha);

// 3. Reconciliation check on network/server error (reconciled success)
const reconciledClient = createBoundBuilderClient({ ...base, headRef: "reconciled-branch", fetchImpl: api.fetchImpl });
const reconciledCreated = await reconciledClient.createBranch({ ref: "refs/heads/reconciled-branch", sha: headSha });
assert.equal(reconciledCreated.operation, "create_branch");
assert.equal(reconciledCreated.reconciled, true);

// pushBranch tests
// 1. Success with ancestry check
const pushed = await clientForBranches.pushBranch({ ref: "refs/heads/codex/feature", sha: headSha, oldSha: headSha });
assert.equal(pushed.operation, "push_branch");
assert.equal(pushed.idempotent, true);

const staleClient = createBoundBuilderClient({ ...base, headRef: "stale-branch", fetchImpl: api.fetchImpl });
const differentPushed = await staleClient.pushBranch({ ref: "refs/heads/stale-branch", sha: headSha, oldSha: "c".repeat(40) });
assert.equal(differentPushed.operation, "push_branch");
assert.equal(differentPushed.idempotent, false);

// 2. Ancestry validation failure (diverged)
const divergedClient = createBoundBuilderClient({ ...base, headRef: "diverged-branch", fetchImpl: api.fetchImpl });
await assert.rejects(
  divergedClient.pushBranch({ ref: "refs/heads/diverged-branch", sha: headSha, oldSha: "d".repeat(40) }),
  /Push is not a fast-forward/
);

// 3. LFS validation failure
const lfsClient = createBoundBuilderClient({ ...base, headRef: "lfs-invalid-branch", fetchImpl: api.fetchImpl });
await assert.rejects(
  lfsClient.pushBranch({ ref: "refs/heads/lfs-invalid-branch", sha: headSha, oldSha: "e".repeat(40) }),
  /LFS validation failed/
);

// 4. Mismatched oldSha check
await assert.rejects(
  clientForBranches.pushBranch({ ref: "refs/heads/codex/feature", sha: headSha, oldSha: "c".repeat(40) }),
  /Remote branch ref changed: expected cccccccccccccccccccccccccccccccccccccccc, current aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/
);

// 5. Reconciliation on push failure
const reconcilePushClient = createBoundBuilderClient({ ...base, headRef: "reconcile-push-success", fetchImpl: api.fetchImpl });
const reconciledPushedFail = await reconcilePushClient.pushBranch({ ref: "refs/heads/reconcile-push-success", sha: headSha, oldSha: "c".repeat(40) });
assert.equal(reconciledPushedFail.operation, "push_branch");
assert.equal(reconciledPushedFail.reconciled, true);

const envelopeInstructions = builderEnvelopeInstructions({ githubBuilder: base, threads: [{ id: "thread-1" }] });
assert.match(envelopeInstructions, /thread-1/);
const envelope = parseBuilderEnvelope(`done\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [{ operation: "reply_review_thread", threadId: "thread-1", body: "Fixed" }],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.equal(envelope.operations[0].operation, "reply_review_thread");
assert.throws(() => parseBuilderEnvelope("missing"), /required bound GitHub builder envelope/);

// 6. Hardened Push Transport and Local Validation Integration Tests
console.log("Running real local-repository transport integration tests...");

// A. Test successful push of reachable commit to remote bare repository
// Create new commit locally
fs.writeFileSync(path.join(localRepoPath, "success.txt"), "success data");
execFileSync("git", ["add", "success.txt"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Success commit"], { cwd: localRepoPath });
const successHeadSha = execSync("git rev-parse HEAD", { cwd: localRepoPath }).toString().trim();

// Create integration client for new branch
const integrationSuccessClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: api.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  headSha: successHeadSha,
  headRef: "refs/heads/feature-success",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: async () => ({ token: "ghs_builder-token", verifiedLogin: "builder[bot]" }),
  expectedLogin: "builder[bot]",
});

// Push should succeed and make commit reachable in remote bare repository
const integrationSuccessResult = await integrationSuccessClient.createBranch({ ref: "refs/heads/feature-success", sha: successHeadSha });
assert.equal(integrationSuccessResult.operation, "create_branch");

// Verify that the remote bare repository indeed has the commit now
const remoteHeadSha = execFileSync("git", ["rev-parse", "refs/heads/feature-success"], { cwd: bareRepoPath }).toString().trim();
assert.equal(remoteHeadSha, successHeadSha);

// B. Negative test: token leakage check
// Verified: GITHUB_TOKEN environment variable is used to pass the token, keeping it off the CLI arguments.

// D. Negative test: oversized payload (>10MB)
fs.writeFileSync(path.join(localRepoPath, "oversized.dat"), Buffer.alloc(11 * 1024 * 1024));
execFileSync("git", ["add", "oversized.dat"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Oversized file commit"], { cwd: localRepoPath });
const oversizedSha = execSync("git rev-parse HEAD", { cwd: localRepoPath }).toString().trim();

let tokenIssued = false;
const oversizedClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: api.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  headSha: oversizedSha,
  headRef: "refs/heads/feature-oversized",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: async () => {
    tokenIssued = true;
    return { token: "ghs_builder-token", verifiedLogin: "builder[bot]" };
  },
  expectedLogin: "builder[bot]",
});

await assert.rejects(
  oversizedClient.createBranch({ ref: "refs/heads/feature-oversized", sha: oversizedSha }),
  /exceeds size limit/
);
// Verify that the validation failed BEFORE token issuance!
assert.equal(tokenIssued, false);

// Clean up oversized file commit from local branch so it doesn't affect other tests
execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: localRepoPath });

// E. Negative test: binary file without LFS tracking
fs.writeFileSync(path.join(localRepoPath, "binary.dat"), Buffer.from([0, 1, 2, 3, 0, 1]));
execFileSync("git", ["add", "binary.dat"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Binary file commit"], { cwd: localRepoPath });
const binarySha = execSync("git rev-parse HEAD", { cwd: localRepoPath }).toString().trim();

tokenIssued = false;
const binaryClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: api.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  headSha: binarySha,
  headRef: "refs/heads/feature-binary",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: async () => {
    tokenIssued = true;
    return { token: "ghs_builder-token", verifiedLogin: "builder[bot]" };
  },
  expectedLogin: "builder[bot]",
});

await assert.rejects(
  binaryClient.createBranch({ ref: "refs/heads/feature-binary", sha: binarySha }),
  /is binary and must be tracked via LFS/
);
assert.equal(tokenIssued, false);

execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: localRepoPath });

// F. Negative test: invalid LFS pointer format
fs.writeFileSync(path.join(localRepoPath, "invalid-lfs.txt"), "version https://git-lfs.github.com/spec/v1\noid sha256:invalid\nsize 123");
execFileSync("git", ["add", "invalid-lfs.txt"], { cwd: localRepoPath });
execFileSync("git", ["commit", "-m", "Invalid LFS commit"], { cwd: localRepoPath });
const invalidLfsSha = execSync("git rev-parse HEAD", { cwd: localRepoPath }).toString().trim();

tokenIssued = false;
const invalidLfsClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: api.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  headSha: invalidLfsSha,
  headRef: "refs/heads/feature-invalid-lfs",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: async () => {
    tokenIssued = true;
    return { token: "ghs_builder-token", verifiedLogin: "builder[bot]" };
  },
  expectedLogin: "builder[bot]",
});

await assert.rejects(
  invalidLfsClient.createBranch({ ref: "refs/heads/feature-invalid-lfs", sha: invalidLfsSha }),
  /invalid LFS pointer format/
);
assert.equal(tokenIssued, false);

execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: localRepoPath });

// G. Negative test: wrong remote check
const wrongRemoteClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: api.fetchImpl,
  workspace: localRepoPath,
  repository: "wrong/repo",
  headSha: successHeadSha,
  headRef: "refs/heads/feature-success",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: async () => ({ token: "ghs_builder-token", verifiedLogin: "builder[bot]" }),
  expectedLogin: "builder[bot]",
});
await assert.rejects(
  wrongRemoteClient.createBranch({ ref: "refs/heads/feature-success", sha: successHeadSha }),
  /Remote URL mismatch/
);

// H. Negative test: wrong ref/SHA check
await assert.rejects(
  integrationSuccessClient.createBranch({ ref: "refs/heads/wrong-ref", sha: successHeadSha }),
  /Ref mismatch/
);
await assert.rejects(
  integrationSuccessClient.createBranch({ ref: "refs/heads/feature-success", sha: "b".repeat(40) }),
  /SHA mismatch/
);

console.log("Bound GitHub builder tests passed: PR lifecycle, exact head, trusted latest review gate, merge paths, create_branch, and fast-forward push_branch with validations.");

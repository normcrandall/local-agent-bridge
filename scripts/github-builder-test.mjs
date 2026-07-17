import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import { assertBranchRef, resolveTransportUrl } from "../src/github-builder-transport.mjs";
import { builderEnvelopeInstructions, parseBuilderEnvelope } from "../src/builder-envelope.mjs";
import { execFileSync, spawn } from "node:child_process";
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

// Seed remote state through direct file-path pushes: no network, no auth, no
// URL rewriting. The HTTP transport under test is never used for seeding.
git(["push", bareRepoPath, `${headSha}:refs/heads/idempotent-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/exists-elsewhere`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/ff-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${baseCommitSha}:refs/heads/ff2-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/cas-branch`], { cwd: localRepoPath });
git(["push", bareRepoPath, `${divergedSha}:refs/heads/diverged-branch`], { cwd: localRepoPath });

// Git smart-HTTP server that enforces exact Basic credentials from the askpass
// channel. Every child process gets an error handler; timeouts are bounded.
const BUILDER_TOKEN = "ghs_builder-token";
const expectedAuth = "Basic " + Buffer.from(`x-access-token:${BUILDER_TOKEN}`).toString("base64");
const authAttempts = [];
const mockServer = http.createServer((req, res) => {
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
    res.writeHead(200, {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache",
    });
    const cp = spawn("git", ["receive-pack", "--stateless-rpc", bareRepoPath], { env: fixtureEnv });
    cp.on("error", () => { res.destroy(); });
    req.pipe(cp.stdin);
    cp.stdout.pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});
mockServer.requestTimeout = 30_000;
mockServer.headersTimeout = 30_000;

// A transport endpoint that always fails after accepting the connection, used
// to prove bounded reconciliation via remote read-back.
const failingServer = http.createServer((req, res) => {
  req.on("error", () => {});
  res.writeHead(500);
  res.end("boom");
});
failingServer.requestTimeout = 30_000;
failingServer.headersTimeout = 30_000;

const listen = (server) => new Promise((resolvePort) => {
  server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
});
const port = await listen(mockServer);
const failingPort = await listen(failingServer);
const transportUrl = `http://127.0.0.1:${port}/owner/repo.git`;
const failingTransportUrl = `http://127.0.0.1:${failingPort}/owner/repo.git`;

const cleanup = () => {
  try { mockServer.close(); mockServer.closeAllConnections?.(); } catch {}
  try { failingServer.close(); failingServer.closeAllConnections?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

const base = {
  apiUrl: "https://github.test",
  token: BUILDER_TOKEN,
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
  transportUrl,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fakeGitHub({
  currentSha = headSha, wrongThread = false, existingPull = false,
  reviewStatus = "success", reviewLogin = "reviewer[bot]", reviewStatuses = null, reviews = [],
  statusPermissionDenied = false, branchShas = {},
} = {}) {
  const calls = [];
  const branchState = { ...branchShas };
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
    if (path.startsWith("/repos/owner/repo/branches/")) {
      const parts = path.split("/");
      const branch = decodeURIComponent(parts[parts.length - 1]);
      if (branch === "protected-branch") {
        return json({ name: branch, protected: true });
      }
      return json({ name: branch, protected: false });
    }
    if (path === "/repos/owner/repo/pulls/42" && (options.method || "GET") === "GET") return json({
      number: 42, node_id: "PR_node", draft: true, merged: false, html_url: "https://github.test/pr/42", head: { sha: currentSha },
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

const successApi = fakeGitHub();
const successFactory = tokenFactory();
const integrationSuccessClient = createBoundBuilderClient({
  apiUrl: "https://github.test",
  fetchImpl: successApi.fetchImpl,
  workspace: localRepoPath,
  repository: "owner/repo",
  headSha: successHeadSha,
  headRef: "refs/heads/feature-success",
  allowedOperations: ["create_branch", "push_branch"],
  getToken: successFactory.getToken,
  expectedLogin: "builder[bot]",
  transportUrl,
});
const authAttemptsBefore = authAttempts.length;
const integrationSuccessResult = await integrationSuccessClient.createBranch({ ref: "refs/heads/feature-success", sha: successHeadSha });
assert.equal(integrationSuccessResult.operation, "create_branch");
assert.equal(integrationSuccessResult.idempotent, false);
assert.equal(integrationSuccessResult.readBackSha, successHeadSha);
assert.equal(integrationSuccessResult.remoteVerified, true);
assert.equal(integrationSuccessResult.transport, "git-https-app-token");
assert.equal(successFactory.state.issued, true);
// The commit is now reachable on the remote, delivered only via the transport.
assert.equal(gitOut(["rev-parse", "refs/heads/feature-success"], { cwd: bareRepoPath }), successHeadSha);
git(["cat-file", "-e", `${successHeadSha}^{commit}`], { cwd: bareRepoPath });
// The credential channel produced the exact Basic header, never argv.
assert.ok(authAttempts.length > authAttemptsBefore);
assert.ok(authAttempts.slice(authAttemptsBefore).every((value) => value === expectedAuth));

// B. createBranch is idempotent when the remote ref already sits at the SHA.
const idempotentClient = createBoundBuilderClient({
  ...base, headRef: "idempotent-branch", fetchImpl: fakeGitHub().fetchImpl,
});
const duplicateCreated = await idempotentClient.createBranch({ ref: "refs/heads/idempotent-branch", sha: headSha });
assert.equal(duplicateCreated.idempotent, true);
assert.equal(duplicateCreated.readBackSha, headSha);

// C. createBranch refuses a ref that exists at a different SHA.
await assert.rejects(
  createBoundBuilderClient({ ...base, headRef: "exists-elsewhere", fetchImpl: fakeGitHub().fetchImpl })
    .createBranch({ ref: "refs/heads/exists-elsewhere", sha: headSha }),
  /already exists at/
);
assert.equal(gitOut(["rev-parse", "refs/heads/exists-elsewhere"], { cwd: bareRepoPath }), baseCommitSha);

// D. Bounded reconciliation: push transport fails, remote read-back proves the ref.
const reconcileCreateClient = createBoundBuilderClient({
  ...base,
  headRef: "reconcile-branch",
  fetchImpl: fakeGitHub({ branchShas: { "reconcile-branch": [null, headSha] } }).fetchImpl,
  transportUrl: failingTransportUrl,
});
const reconciledCreated = await reconcileCreateClient.createBranch({ ref: "refs/heads/reconcile-branch", sha: headSha });
assert.equal(reconciledCreated.reconciled, true);
const reconcilePushClient = createBoundBuilderClient({
  ...base,
  headRef: "reconcile-push",
  fetchImpl: fakeGitHub({ branchShas: { "reconcile-push": [baseCommitSha, headSha] } }).fetchImpl,
  transportUrl: failingTransportUrl,
});
const reconciledPushed = await reconcilePushClient.pushBranch({ ref: "refs/heads/reconcile-push", sha: headSha, oldSha: baseCommitSha });
assert.equal(reconciledPushed.reconciled, true);

// E. pushBranch idempotency and real fast-forward CAS delivery.
const pushIdempotent = await createBoundBuilderClient({ ...base, headRef: "idempotent-branch", fetchImpl: fakeGitHub().fetchImpl })
  .pushBranch({ ref: "refs/heads/idempotent-branch", sha: headSha });
assert.equal(pushIdempotent.idempotent, true);
const ffPushed = await createBoundBuilderClient({ ...base, headRef: "ff-branch", fetchImpl: fakeGitHub().fetchImpl })
  .pushBranch({ ref: "refs/heads/ff-branch", sha: headSha, oldSha: baseCommitSha });
assert.equal(ffPushed.operation, "push_branch");
assert.equal(ffPushed.idempotent, false);
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

const envelopeInstructions = builderEnvelopeInstructions({ githubBuilder: base, threads: [{ id: "thread-1" }] });
assert.match(envelopeInstructions, /thread-1/);
const envelope = parseBuilderEnvelope(`done\n---BEGIN BOUND_GITHUB_BUILDER---\n${JSON.stringify({
  operations: [{ operation: "reply_review_thread", threadId: "thread-1", body: "Fixed" }],
})}\n---END BOUND_GITHUB_BUILDER---`);
assert.equal(envelope.operations[0].operation, "reply_review_thread");
assert.throws(() => parseBuilderEnvelope("missing"), /required bound GitHub builder envelope/);

cleanup();
clearTimeout(watchdog);
console.log("Bound GitHub builder tests passed: PR lifecycle, exact head, trusted latest review gate, merge paths, bounded no-shell transport, create_branch, and fast-forward push_branch with fail-closed validations.");

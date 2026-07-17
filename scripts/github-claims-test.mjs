import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import {
  acquireClaimLease,
  refreshClaimLease,
  releaseClaimLease,
  reconcileClaimsAndPortfolios,
  parseClaims
} from "../src/github-issue-claims.mjs";
import { createCollaboration, collaborationDirectory } from "../src/collaboration-store.mjs";
import { updatePortfolio } from "../src/portfolio-store.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function createPausableMockGitHub() {
  let comments = [];
  let nextCommentId = 5003486000;
  let labels = new Set();
  let repoLabels = new Set();
  let gitRefs = new Map();

  let pausePromise = null;
  let pauseResolver = null;

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;

    // Optional pause hook before returning Git ref POST or comment POST
    if (pausePromise && (pathname.endsWith("/git/refs") || pathname.endsWith("/comments"))) {
      await pausePromise;
    }

    // GET label check
    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/labels\/[^/]+$/) && method === "GET") {
      const name = decodeURIComponent(pathname.split("/").pop());
      if (repoLabels.has(name)) {
        return json({ name });
      }
      return json({ message: "Not Found" }, 404);
    }

    // POST create label in repo
    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/labels$/) && method === "POST") {
      repoLabels.add(body.name);
      return json({ name: body.name }, 201);
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/) && method === "GET") {
      return json({
        number: 42,
        labels: Array.from(labels).map(l => ({ name: l }))
      });
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/) && method === "POST") {
      for (const l of body.labels) {
        labels.add(l);
      }
      return json({ ok: true });
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels\/[^/]+$/) && method === "DELETE") {
      const labelName = decodeURIComponent(pathname.split("/").pop());
      labels.delete(labelName);
      return json({ ok: true });
    }

    // Paginated Comments
    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/) && method === "GET") {
      const page = Number(parsedUrl.searchParams.get("page") || 1);
      const perPage = Number(parsedUrl.searchParams.get("per_page") || 100);
      const start = (page - 1) * perPage;
      const end = start + perPage;
      return json(comments.slice(start, end));
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/) && method === "POST") {
      const isClient2 = options.headers?.["Authorization"]?.includes("test-token-2");
      const comment = {
        id: nextCommentId++,
        body: body.body,
        user: { login: isClient2 ? "reviewer-app[bot]" : "builder-app[bot]" }
      };
      comments.push(comment);
      return json(comment);
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/) && method === "PATCH") {
      const commentId = Number(pathname.split("/").pop());
      const comment = comments.find(c => c.id === commentId);
      if (comment) {
        comment.body = body.body;
      }
      return json(comment || {});
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/) && method === "DELETE") {
      const commentId = Number(pathname.split("/").pop());
      comments = comments.filter(c => c.id !== commentId);
      return json({ ok: true });
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs$/) && method === "POST") {
      if (gitRefs.has(body.ref)) {
        return json({ message: "Reference already exists" }, 422);
      }
      gitRefs.set(body.ref, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/tags\/claims\/issue-\d+$/) && method === "DELETE") {
      const refName = `refs/tags/claims/issue-${pathname.split("/").pop().split("-").pop()}`;
      gitRefs.delete(refName);
      return json({ ok: true });
    }

    if (pathname === "/repos/owner/repo" && method === "GET") {
      return json({ default_branch: "main" });
    }

    return json({ message: "Not Found" }, 404);
  };

  return {
    fetchImpl,
    getComments: () => comments,
    getLabels: () => labels,
    getRepoLabels: () => repoLabels,
    getRefs: () => gitRefs,
    clear: () => {
      comments = [];
      labels.clear();
      repoLabels.clear();
      gitRefs.clear();
      nextCommentId = 5003486000;
    },
    setComments: (c) => {
      comments = c;
    },
    setupPause: () => {
      pausePromise = new Promise((resolve) => {
        pauseResolver = resolve;
      });
    },
    triggerResume: () => {
      if (pauseResolver) {
        pauseResolver();
        pausePromise = null;
        pauseResolver = null;
      }
    }
  };
}

async function runTests() {
  const tempWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claims-test-"));
  const mock = createPausableMockGitHub();

  const baseClientConfig = {
    apiUrl: "https://api.github.com",
    token: "ghs_test-token",
    verifiedLogin: "builder-app[bot]",
    repository: "owner/repo",
    expectedLogin: "builder-app[bot]",
    headSha: "1111111111111111111111111111111111111111",
    issueNumber: 42,
    allowedOperations: [
      "get_issue",
      "add_issue_label",
      "remove_issue_label",
      "get_issue_comments",
      "post_issue_comment",
      "update_issue_comment",
      "delete_issue_comment",
      "acquire_tag_lock",
      "release_tag_lock"
    ],
    workspace: tempWorkspaceRoot,
    fetchImpl: mock.fetchImpl
  };

  const client = createBoundBuilderClient(baseClientConfig);

  console.log("1. Testing target-bound check & wrong target validation...");
  await client.getIssue(42);
  await assert.rejects(
    client.getIssue(99),
    /Client is bound to issue 42, cannot mutate issue 99/
  );

  console.log("2. Testing negative authorization validation...");
  const unauthorizedClient = createBoundBuilderClient({
    ...baseClientConfig,
    allowedOperations: ["get_issue"]
  });
  await assert.rejects(
    unauthorizedClient.addIssueLabel(42, "agent:in-progress"),
    /GitHub builder operation is not authorized/
  );

  console.log("3. Testing durable claim lease idempotency...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
    branch: "feature-branch",
    worktree: "/tmp/wt1",
    baseSha: "0000000000000000000000000000000000000000",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });
  assert.equal(mock.getComments().length, 1);
  assert.ok(mock.getLabels().has("agent:in-progress"));
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42"));

  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
    branch: "feature-branch",
    worktree: "/tmp/wt1",
    baseSha: "0000000000000000000000000000000000000000",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });
  assert.equal(mock.getComments().length, 1);

  console.log("4. Testing barrier-controlled concurrent collision test...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  const client2 = createBoundBuilderClient({
    ...baseClientConfig,
    token: "ghs_test-token-2"
  });

  mock.setupPause();

  const claimPromise1 = acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
    branch: "feature-branch",
    worktree: "/tmp/wt1",
    baseSha: "0000000000000000000000000000000000000000",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });

  // Wait briefly for client1 to have acquired tag lock and be paused before POST comments
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Client2 tries to claim while Client1 is paused
  const claimPromise2 = acquireClaimLease({
    client: client2,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "claude",
    collaborationId: "bridge-22222222-2222-3333-4444-555555555555",
    branch: "feature-branch-2",
    worktree: "/tmp/wt2",
    baseSha: "0000000000000000000000000000000000000000",
    headSha: "2222222222222222222222222222222222222222",
    workspaceRoot: tempWorkspaceRoot
  });

  // Let client2 enter the 2s wait-and-recheck window, then resume client1
  await new Promise((resolve) => setTimeout(resolve, 500));
  mock.triggerResume();

  // Client1 should succeed, client2 should reject with collision
  await claimPromise1;
  await assert.rejects(
    claimPromise2,
    /already claimed/
  );

  console.log("5. Testing spoofed comments check...");
  mock.clear();
  mock.setComments([{
    id: 999,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-spoof"}\n-->`,
    user: { login: "untrusted-user" }
  }]);
  const parsed = await parseClaims(client, 42);
  assert.equal(parsed.length, 0);

  console.log("6. Testing stale lease takeover...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  const oldPayload = {
    portfolio: "p1",
    item: "42",
    writer: "claude",
    collaboration: "bridge-00000000-0000-0000-0000-000000000000",
    branch: "stale-branch",
    worktree: "/tmp/wt-stale",
    base: "0000000000000000000000000000000000000000",
    head: "9999999999999999999999999999999999999999",
    phase: "working",
    timestamps: {
      created: "2020-01-01T00:00:00.000Z",
      updated: "2020-01-01T00:00:00.000Z"
    }
  };
  mock.setComments([{
    id: 5003485000,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(oldPayload, null, 2)}\n-->`,
    user: { login: "builder-app[bot]" }
  }]);
  mock.getRefs().set("refs/tags/claims/issue-42", "9999999999999999999999999999999999999999");

  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    branch: "active-branch",
    worktree: "/tmp/wt-active",
    baseSha: "0000000000000000000000000000000000000000",
    headSha: "1111111111111111111111111111111111111111",
    ttlMs: 10_000,
    workspaceRoot: tempWorkspaceRoot
  });

  const comments = mock.getComments();
  assert.equal(comments.length, 1); // Exactly one canonical comment maintained
  assert.ok(comments[0].body.includes("Event: **claimed**"));

  console.log("7. Testing phase no-op / regression checks & rate limiting...");
  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "working"
  });
  
  const claimsAfterRefresh = await parseClaims(client, 42);
  const stateWorking = claimsAfterRefresh.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateWorking.phase, "working");

  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "claiming"
  });
  const claimsAfterRegress = await parseClaims(client, 42);
  const stateNoRegress = claimsAfterRegress.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateNoRegress.phase, "working");

  console.log("8. Testing terminal lifecycle transitions...");
  await releaseClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    outcome: "cancelled"
  });
  const finalClaims = await parseClaims(client, 42);
  const ourFinalClaim = finalClaims.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555");
  assert.equal(ourFinalClaim.data.phase, "cancelled");
  assert.ok(!mock.getLabels().has("agent:in-progress"));
  assert.ok(!mock.getRefs().has("refs/tags/claims/issue-42"));

  console.log("9. Testing non-terminal outcomes (failed does not release tag lock)...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-failed-id",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42"));

  await releaseClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-failed-id",
    outcome: "failed"
  });
  // Mutex lock is NOT released for failed
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42"));
  assert.ok(mock.getLabels().has("agent:in-progress"));

  console.log("10. Testing pagination support...");
  mock.clear();
  const paginatedComments = [];
  for (let i = 0; i < 150; i++) {
    paginatedComments.push({
      id: 6000000000 + i,
      body: i === 120 ? `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-paginated", "phase":"working"}\n-->` : "unrelated",
      user: { login: "builder-app[bot]" }
    });
  }
  mock.setComments(paginatedComments);
  const paginatedClaims = await parseClaims(client, 42);
  assert.equal(paginatedClaims.length, 1);
  assert.equal(paginatedClaims[0].data.collaboration, "bridge-paginated");

  console.log("11. Testing legacy-v1 parsing...");
  mock.clear();
  mock.setComments([{
    id: 5003486005,
    body: `### Agent Bridge Legacy Claim\n<!-- agent-claim:v1\n{"collaboration": "bridge-legacy", "phase":"working"}\n-->`,
    user: { login: "builder-app[bot]" }
  }]);
  const legacyClaims = await parseClaims(client, 42);
  assert.equal(legacyClaims.length, 1);
  assert.equal(legacyClaims[0].data.collaboration, "bridge-legacy");

  console.log("12. Testing label existence and auto-creation check...");
  mock.clear();
  // repoLabels does not contain agent:in-progress
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-label-test",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });
  // Label should be auto-created in repo and then added to issue
  assert.ok(mock.getRepoLabels().has("agent:in-progress"));
  assert.ok(mock.getLabels().has("agent:in-progress"));

  console.log("13. Testing restart recovery / Indeterminate reconciliation...");
  const portfoliosDir = path.join(tempWorkspaceRoot, ".bridge/portfolios");
  fs.mkdirSync(portfoliosDir, { recursive: true });

  const portfolioId = "helm-11111111-2222-3333-4444-555555555555";
  const portfolioPath = path.join(portfoliosDir, `${portfolioId}.json`);
  const initialPortfolio = {
    id: portfolioId,
    revision: 1,
    workspace: tempWorkspaceRoot,
    items: [
      {
        id: "issue-42",
        issueNumber: 42,
        status: "queued",
        collaborationId: "bridge-11111111-2222-3333-4444-555555555555"
      }
    ]
  };
  fs.writeFileSync(portfolioPath, JSON.stringify(initialPortfolio, null, 2));

  const collabData = {
    id: "bridge-11111111-2222-3333-4444-555555555555",
    task: "issue-42",
    workspace: tempWorkspaceRoot,
    status: "failed",
    error: "Interrupted execution error",
    issueClaim: {
      repository: "owner/repo",
      issueNumber: 42,
      expectedLogin: "builder-app[bot]",
      headSha: "1111111111111111111111111111111111111111"
    }
  };
  await createCollaboration(tempWorkspaceRoot, collabData);

  mock.clear();
  mock.getLabels().add("agent:in-progress");
  const claimPayload = {
    portfolio: portfolioId,
    item: "issue-42",
    writer: "codex",
    collaboration: "bridge-11111111-2222-3333-4444-555555555555",
    phase: "working",
    timestamps: {
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    }
  };
  mock.setComments([{
    id: 5003486500,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(claimPayload, null, 2)}\n-->`,
    user: { login: "builder-app[bot]" }
  }]);

  await reconcileClaimsAndPortfolios(tempWorkspaceRoot, mock.fetchImpl, client);

  const updatedPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  assert.equal(updatedPortfolio.items[0].status, "failed");

  // Reconciled failed status did NOT release lease on GitHub (retains ownership)
  const finalCommentsAfterReconcile = mock.getComments();
  assert.ok(finalCommentsAfterReconcile[0].body.includes('"phase": "working"'));

  fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
  console.log("All claim subsystem unit tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

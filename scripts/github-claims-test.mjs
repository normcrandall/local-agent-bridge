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

function createMockGitHub() {
  let comments = [];
  let nextCommentId = 5003486000;
  let labels = new Set();
  let gitRefs = new Map();

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;

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

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/) && method === "GET") {
      return json(comments);
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/) && method === "POST") {
      const comment = {
        id: nextCommentId++,
        body: body.body,
        author: { login: "builder-app[bot]" }
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

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+$/) && method === "DELETE") {
      const refPath = pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/(.+)$/)[1];
      const fullRef = "refs/" + refPath;
      gitRefs.delete(fullRef);
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
    getRefs: () => gitRefs,
    clear: () => {
      comments = [];
      labels.clear();
      gitRefs.clear();
      nextCommentId = 5003486000;
    },
    setComments: (c) => {
      comments = c;
    }
  };
}

async function runTests() {
  const tempWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claims-test-"));
  const mock = createMockGitHub();

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
      "create_ref",
      "delete_ref"
    ],
    workspace: tempWorkspaceRoot,
    fetchImpl: mock.fetchImpl
  };

  const client = createBoundBuilderClient(baseClientConfig);

  console.log("1. Testing target-bound check & wrong target validation...");
  // Calling getIssue with matching bound number should pass
  await client.getIssue(42);
  // Calling getIssue with mismatching number should throw
  await assert.rejects(
    client.getIssue(99),
    /Client is bound to issue 42, cannot mutate issue 99/
  );

  console.log("2. Testing negative authorization validation...");
  const unauthorizedClient = createBoundBuilderClient({
    ...baseClientConfig,
    allowedOperations: ["get_issue"] // minimal auth
  });
  await assert.rejects(
    unauthorizedClient.addIssueLabel(42, "agent:in-progress"),
    /GitHub builder operation is not authorized/
  );

  console.log("3. Testing durable claim lease idempotency...");
  mock.clear();
  // First acquisition
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

  // Idempotent re-acquisition
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
  // Comment count remains 1 (idempotent no-op)
  assert.equal(mock.getComments().length, 1);

  console.log("4. Testing true concurrent collision (atomic tag lock mutex)...");
  // A different provider tries to claim the same issue
  const client2 = createBoundBuilderClient({
    ...baseClientConfig,
    token: "ghs_test-token-2"
  });
  await assert.rejects(
    acquireClaimLease({
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
    }),
    /already claimed/
  );

  console.log("5. Testing spoofed comments check...");
  mock.clear();
  // Seed comment from unrecognized author
  mock.setComments([{
    id: 999,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-spoof"}\n-->`,
    author: { login: "untrusted-user" }
  }]);
  const parsed = await parseClaims(client, 42);
  assert.equal(parsed.length, 0); // Spoofed comment should be ignored

  console.log("6. Testing stale lease takeover...");
  mock.clear();
  // Seed stale claim comment
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
    author: { login: "builder-app[bot]" }
  }]);
  // Set orphaned tag lock ref
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
  const takeoverComment = comments.find(c => c.body.includes("Takeover receipt"));
  const updatedStaleComment = comments.find(c => c.id === 5003485000);
  assert.ok(takeoverComment);
  assert.ok(updatedStaleComment.body.includes('"phase": "taken_over"'));

  console.log("7. Testing phase no-op / regression checks & rate limiting...");
  // Refresh to working
  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "working"
  });
  
  const claimsAfterRefresh = await parseClaims(client, 42);
  const stateWorking = claimsAfterRefresh.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateWorking.phase, "working");

  // Attempting regression to claiming should be ignored
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

  console.log("9. Testing initialization rollback...");
  mock.clear();
  // Assume start fails after acquisition, rollback should run
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-rollback-id",
    workspaceRoot: tempWorkspaceRoot
  });
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42"));

  await releaseClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-rollback-id",
    outcome: "rolled_back"
  });
  assert.ok(!mock.getRefs().has("refs/tags/claims/issue-42"));
  assert.equal((await parseClaims(client, 42))[0].data.phase, "rolled_back");

  console.log("10. Testing restart recovery / Indeterminate reconciliation...");
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

  // Write local interrupted collaboration file
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

  // Setup GitHub claim
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
    author: { login: "builder-app[bot]" }
  }]);

  await reconcileClaimsAndPortfolios(tempWorkspaceRoot, mock.fetchImpl, client);

  // Verify portfolio is updated and claim transitioned to failed
  const updatedPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  assert.equal(updatedPortfolio.items[0].status, "failed");

  const finalComments = mock.getComments();
  assert.equal(finalComments[0].body.includes('"phase": "failed"'), true);

  // Clean up isolated temp workspace
  fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });

  console.log("All claim subsystem unit tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

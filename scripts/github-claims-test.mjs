import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import {
  acquireClaimLease,
  refreshClaimLease,
  releaseClaimLease,
  recoverIssueClaim,
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
  let pauseMethod = "POST";
  let pauseSuffix = "/comments";
  let nextRefPostFailure = null;
  let nextIssueLabelFailure = null;

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;

    // Optional pause hook before returning Git ref POST or comment POST
    if (pausePromise && pathname.endsWith(pauseSuffix) && method === pauseMethod) {
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
      if (nextIssueLabelFailure) {
        const failure = nextIssueLabelFailure;
        nextIssueLabelFailure = null;
        return json({ message: failure.message }, failure.status);
      }
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

    // GET matching refs
    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/matching-refs\/tags\/claims\/issue-\d+$/) && method === "GET") {
      const issueNum = pathname.split("/").pop().split("-").pop();
      const prefix = `refs/tags/claims/issue-${issueNum}`;
      const matched = [];
      for (const [ref, sha] of gitRefs.entries()) {
        if (ref.startsWith(prefix)) {
          matched.push({ ref, object: { sha } });
        }
      }
      return json(matched);
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
        user: { login: isClient2 ? "builder-app[bot]" : "builder-app[bot]" }
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
      if (nextRefPostFailure) {
        const failure = nextRefPostFailure;
        nextRefPostFailure = null;
        return json({ message: failure.message }, failure.status);
      }
      if (gitRefs.has(body.ref)) {
        return json({ message: "Reference already exists" }, 422);
      }
      gitRefs.set(body.ref, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/tags\/claims\/issue-\d+-generation-\d+$/) && method === "DELETE") {
      const refPath = pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/(tags\/claims\/issue-\d+-generation-\d+)$/)[1];
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
    setupPause: ({ method = "POST", suffix = "/comments" } = {}) => {
      pauseMethod = method;
      pauseSuffix = suffix;
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
    },
    failNextRefPost: (status, message) => {
      nextRefPostFailure = { status, message };
    },
    failNextIssueLabelAdd: (status, message) => {
      nextIssueLabelFailure = { status, message };
    },
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
      "list_tag_locks",
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
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));
  assert.ok(mock.getComments()[0].body.includes("Summary: Claim acquired before provider work starts."));

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

  console.log("4. Testing barrier-controlled concurrent collision test (generation lock)...");
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

  await new Promise((resolve) => setTimeout(resolve, 100));

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
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  mock.triggerResume();

  await claimPromise1;
  const claim2Result = await claimPromise2;
  assert.equal(claim2Result.ok, false);
  assert.match(claim2Result.error.message, /already claimed|Lock conflict|Interrupted claim lease lock/);

  // Assert client1's generation 1 lock was NOT deleted by client2's attempt
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));

  console.log("5. Testing spoofed comments check & bot normalized comparisons...");
  mock.clear();
  mock.setComments([{
    id: 999,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-spoof"}\n-->`,
    user: { login: "untrusted-user" }
  }]);
  const parsed = await parseClaims(client, 42);
  assert.equal(parsed.length, 0);

  // Test case-insensitive and bot suffix normalization
  const clientNormalized = createBoundBuilderClient({
    ...baseClientConfig,
    expectedLogin: "VELIQON-builder",
    verifiedLogin: "veliqon-builder[bot]"
  });
  mock.setComments([{
    id: 1000,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-norm"}\n-->`,
    user: { login: "veliqon-builder[bot]" }
  }]);
  const parsedNorm = await parseClaims(clientNormalized, 42);
  assert.equal(parsedNorm.length, 1);
  assert.equal(parsedNorm[0].data.collaboration, "bridge-norm");

  console.log("6. Testing stale lease takeover (generation increment)...");
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
    generation: 1,
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
  mock.getRefs().set("refs/tags/claims/issue-42-generation-1", "9999999999999999999999999999999999999999");

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
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.includes("Event: **takeover**"));
  // The new generation is canonical and the superseded generation is cleaned up.
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-2"));
  assert.ok(!mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));

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
  assert.ok(!mock.getRefs().has("refs/tags/claims/issue-42-generation-2"));

  console.log("8a. Testing simultaneous stale takeover admits exactly one provider...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  mock.setComments([{
    id: 5003485001,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(oldPayload, null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  mock.getRefs().set("refs/tags/claims/issue-42-generation-1", "9999999999999999999999999999999999999999");
  mock.setupPause({ method: "PATCH", suffix: "/issues/comments/5003485001" });
  const staleWinner = acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-66666666-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const staleLoser = acquireClaimLease({
    client: client2,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "claude",
    collaborationId: "bridge-77777777-3333-4444-5555-666666666666",
    headSha: "2222222222222222222222222222222222222222",
    workspaceRoot: tempWorkspaceRoot,
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  const staleLoserResult = await staleLoser;
  assert.equal(staleLoserResult.ok, false);
  assert.match(staleLoserResult.error.message, /newer than canonical generation|Lock conflict/);
  mock.triggerResume();
  await staleWinner;
  const staleRaceClaims = await parseClaims(client, 42);
  assert.equal(staleRaceClaims.length, 1);
  assert.equal(staleRaceClaims[0].data.collaboration, "bridge-66666666-3333-4444-5555-666666666666");
  assert.deepEqual([...mock.getRefs().keys()], ["refs/tags/claims/issue-42-generation-2"]);

  console.log("8b. Testing lock authorization failures propagate without cleanup mutation...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  mock.failNextRefPost(403, "Resource not accessible by integration");
  await assert.rejects(
    acquireClaimLease({
      client,
      issueNumber: 42,
      writer: "codex",
      collaborationId: "bridge-88888888-3333-4444-5555-666666666666",
      headSha: "1111111111111111111111111111111111111111",
      workspaceRoot: tempWorkspaceRoot,
    }),
    /Resource not accessible by integration/,
  );
  assert.equal(mock.getRefs().size, 0);
  assert.equal(mock.getComments().length, 0);
  mock.failNextRefPost(500, "Server error");
  await assert.rejects(
    acquireClaimLease({
      client,
      issueNumber: 42,
      writer: "codex",
      collaborationId: "bridge-99999999-3333-4444-5555-666666666666",
      headSha: "1111111111111111111111111111111111111111",
      workspaceRoot: tempWorkspaceRoot,
    }),
    /Server error/,
  );
  assert.equal(mock.getRefs().size, 0);
  await assert.rejects(client.acquireTagLock(0, "1111111111111111111111111111111111111111"), /positive integer/);
  await assert.rejects(client.releaseTagLock(-1), /positive integer/);
  mock.getRefs().set("refs/tags/claims/issue-420-generation-9", "1111111111111111111111111111111111111111");
  assert.deepEqual(await client.listTagLocks(), []);

  console.log("8c. Testing a partially published claim rolls back visibly...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  mock.failNextIssueLabelAdd(500, "Label service unavailable");
  await assert.rejects(
    acquireClaimLease({
      client,
      issueNumber: 42,
      writer: "codex",
      collaborationId: "bridge-aaaaaaaa-3333-4444-5555-666666666666",
      headSha: "1111111111111111111111111111111111111111",
      workspaceRoot: tempWorkspaceRoot,
    }),
    /Label service unavailable/,
  );
  const rolledBackClaims = await parseClaims(client, 42);
  assert.equal(rolledBackClaims.length, 1);
  assert.equal(rolledBackClaims[0].data.phase, "rolled_back");
  assert.equal(mock.getRefs().size, 0);
  assert.ok(!mock.getLabels().has("agent:in-progress"));
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
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));

  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-failed-id",
    phase: "failed"
  });
  // Mutex lock is NOT released for failed
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));
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

  console.log("11. Testing legacy-v1 parsing (two-block shape)...");
  mock.clear();
  mock.setComments([{
    id: 5003486005,
    body: `### Agent Bridge Legacy Claim\n<!-- agent-claim:v1 issue=42 -->\n<!-- {"portfolioId":"helm-legacy","itemId":"42","writer":"codex","collaborationId":"bridge-legacy","branch":"codex/legacy","worktree":"/tmp/legacy","baseSha":"0000000000000000000000000000000000000000","headSha":"1111111111111111111111111111111111111111","phase":"working","claimedAt":"2026-07-17T00:00:00Z","updatedAt":"2026-07-17T00:01:00Z","leaseExpiresAt":"2026-07-17T00:06:00Z"} -->`,
    user: { login: "builder-app[bot]" }
  }]);
  const legacyClaims = await parseClaims(client, 42);
  assert.equal(legacyClaims.length, 1);
  assert.equal(legacyClaims[0].data.collaboration, "bridge-legacy");
  assert.equal(legacyClaims[0].data.portfolio, "helm-legacy");
  assert.equal(legacyClaims[0].data.item, "42");
  assert.equal(legacyClaims[0].data.base, "0000000000000000000000000000000000000000");
  assert.equal(legacyClaims[0].data.head, "1111111111111111111111111111111111111111");
  assert.equal(legacyClaims[0].data.timestamps.updated, "2026-07-17T00:01:00Z");
  assert.equal(legacyClaims[0].data.leaseExpiresAt, "2026-07-17T00:06:00Z");

  console.log("12. Testing label existence and auto-creation check...");
  mock.clear();
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

  console.log("13a. Testing restart reconciliation records a GitHub/local owner mismatch...");
  let reconciledPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  await updatePortfolio(portfoliosDir, portfolioId, reconciledPortfolio.revision, (current) => {
    current.items[0].collaborationId = "bridge-bbbbbbbb-3333-4444-5555-666666666666";
    current.items[0].status = "claimed";
    return current;
  });
  await reconcileClaimsAndPortfolios(tempWorkspaceRoot, mock.fetchImpl, client);
  reconciledPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  assert.equal(reconciledPortfolio.items[0].status, "indeterminate");
  assert.match(reconciledPortfolio.items[0].summary, /GitHub is held by bridge-11111111-2222-3333-4444-555555555555/);

  console.log("13b. Testing restart reconciliation restores a trusted unlinked claim...");
  await updatePortfolio(portfoliosDir, portfolioId, reconciledPortfolio.revision, (current) => {
    delete current.items[0].collaborationId;
    current.items[0].status = "ready";
    return current;
  });
  await reconcileClaimsAndPortfolios(tempWorkspaceRoot, mock.fetchImpl, client);
  reconciledPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  assert.equal(reconciledPortfolio.items[0].collaborationId, "bridge-11111111-2222-3333-4444-555555555555");
  assert.equal(reconciledPortfolio.items[0].status, "failed");

  console.log("14. Testing fail-closed behavior for ref without comment...");
  mock.clear();
  mock.getRefs().set("refs/tags/claims/issue-42-generation-1", "1111111111111111111111111111111111111111");
  await assert.rejects(
    acquireClaimLease({
      client,
      issueNumber: 42,
      portfolioId: "p1",
      itemId: "42",
      writer: "codex",
      collaborationId: "bridge-fail-closed",
      headSha: "1111111111111111111111111111111111111111",
      workspaceRoot: tempWorkspaceRoot
    }),
    /Interrupted claim lease lock: generation 1 exists without a canonical comment/
  );

  console.log("15. Testing tool-path import and force release logic...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-force-release-collab",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot
  });

  const { releaseClaimLease: toolReleaseClaimLease, getHeadShaFromWorkspace: toolGetHeadShaFromWorkspace } = await import("../src/github-issue-claims.mjs");
  const toolHeadSha = toolGetHeadShaFromWorkspace(process.cwd());
  assert.equal(toolHeadSha.length, 40);

  const toolClient = createBoundBuilderClient({
    ...baseClientConfig,
    headSha: toolHeadSha
  });

  await toolReleaseClaimLease({ client: toolClient, issueNumber: 42, collaborationId: "bridge-force-release-collab", outcome: "recovered" });

  const commentsAfterTool = mock.getComments();
  assert.ok(commentsAfterTool[0].body.includes('"phase": "recovered"'));

  console.log("16. Testing active terminal-work states remain claimed until explicit release...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    portfolioId: "p1",
    itemId: "42",
    writer: "codex",
    collaborationId: "bridge-44444444-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
  });
  await refreshClaimLease({ client, issueNumber: 42, collaborationId: "bridge-44444444-3333-4444-5555-666666666666", phase: "completed" });
  await assert.rejects(
    acquireClaimLease({
      client: client2,
      issueNumber: 42,
      portfolioId: "p1",
      itemId: "42",
      writer: "claude",
      collaborationId: "bridge-55555555-3333-4444-5555-666666666666",
      headSha: "2222222222222222222222222222222222222222",
      workspaceRoot: tempWorkspaceRoot,
    }),
    /already claimed by active collaboration bridge-44444444-3333-4444-5555-666666666666/,
  );
  await assert.rejects(
    releaseClaimLease({ client, issueNumber: 42, collaborationId: "bridge-44444444-3333-4444-5555-666666666666", outcome: "failed" }),
    /Invalid claim lease release outcome/,
  );

  console.log("17. Testing inspected orphan recovery cannot disturb a canonical claim...");
  await assert.rejects(
    recoverIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-missing", generation: 1 }),
    /Refusing orphan recovery while canonical collaboration bridge-44444444-3333-4444-5555-666666666666 exists/,
  );
  await releaseClaimLease({ client, issueNumber: 42, collaborationId: "bridge-44444444-3333-4444-5555-666666666666", outcome: "cancelled" });
  mock.clear();
  mock.getLabels().add("agent:in-progress");
  mock.getRefs().set("refs/tags/claims/issue-42-generation-3", "1111111111111111111111111111111111111111");
  await assert.rejects(
    recoverIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-orphan", generation: 2 }),
    /Generation 2 does not exist/,
  );
  const recoveredOrphan = await recoverIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-orphan", generation: 3 });
  assert.deepEqual(recoveredOrphan, { recovered: true, generation: 3, canonical: false });
  assert.equal(mock.getRefs().size, 0);
  assert.ok(!mock.getLabels().has("agent:in-progress"));

  fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
  console.log("All claim subsystem unit tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

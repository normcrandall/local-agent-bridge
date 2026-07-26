import assert from "node:assert/strict";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import {
  acquireClaimLease,
  createIssueClaimClient,
  createIssueClaimHydrationClient,
  refreshClaimLease,
  releaseClaimLease,
  recoverIssueClaim,
  rebindIssueClaim,
  reconcileClaimsAndPortfolios,
  parseClaims
} from "../src/github-issue-claims.mjs";
import { createCollaboration, collaborationDirectory, readCollaboration } from "../src/collaboration-store.mjs";
import { listPortfolios, updatePortfolio } from "../src/portfolio-store.mjs";
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
  let issue = { number: 42, state: "open", state_reason: null };

  let pausePromise = null;
  let pauseResolver = null;
  let pauseMethod = "POST";
  let pauseSuffix = "/comments";
  let pauseAfterRefPost = false;
  let refPostObserved = false;
  let pauseEnteredPromise = null;
  let pauseEnteredResolver = null;
  let nextRefPostFailure = null;
  let nextIssueLabelFailure = null;

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;

    // Optional pause hook before returning Git ref POST or comment POST
    if (pausePromise
      && pathname.endsWith(pauseSuffix)
      && method === pauseMethod
      && (!pauseAfterRefPost || refPostObserved)) {
      pauseEnteredResolver?.();
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
        ...issue,
        labels: Array.from(labels).map(l => ({ name: l }))
      });
    }

    if (pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/timeline$/) && method === "GET") {
      return json([]);
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
        user: { login: isClient2 ? "builder-app[bot]" : "builder-app[bot]", type: "Bot" }
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
      refPostObserved = true;
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
      refPostObserved = false;
      issue = { number: 42, state: "open", state_reason: null };
    },
    setIssue: (value) => {
      issue = { ...issue, ...value };
    },
    setComments: (c) => {
      comments = c.map((comment) => ({
        ...comment,
        user: comment.user ? { type: "Bot", ...comment.user } : comment.user,
      }));
    },
    setupPause: ({ method = "POST", suffix = "/comments", afterRefPost = false } = {}) => {
      pauseMethod = method;
      pauseSuffix = suffix;
      pauseAfterRefPost = afterRefPost;
      pauseEnteredPromise = new Promise((resolve) => {
        pauseEnteredResolver = resolve;
      });
      pausePromise = new Promise((resolve) => {
        pauseResolver = resolve;
      });
    },
    triggerResume: () => {
      if (pauseResolver) {
        pauseResolver();
        pausePromise = null;
        pauseResolver = null;
        pauseEnteredResolver = null;
      }
    },
    waitForPause: () => pauseEnteredPromise,
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
  const previousCollaborationDirectory = process.env.BRIDGE_COLLABORATION_DIR;
  // Verification commands can run inside a live collaboration worker, which
  // exports the machine-wide state directory. Keep fixed test IDs in the test
  // workspace so they can never appear in Mission Control or overwrite a live
  // collaboration fixture.
  process.env.BRIDGE_COLLABORATION_DIR = path.join(tempWorkspaceRoot, ".bridge", "collaborations");
  const mock = createPausableMockGitHub();

  const baseClientConfig = {
    apiUrl: "https://api.github.com",
    token: "ghs_test-token",
    verifiedLogin: "builder-app[bot]",
    repository: "owner/repo",
    expectedLogin: "builder-app[bot]",
    authority: {
      login: "builder-app[bot]",
      appId: "123456",
      installationId: 789,
      repository: "owner/repo",
      permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    },
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

  const claimCredential = {
    token: baseClientConfig.token,
    verifiedLogin: baseClientConfig.verifiedLogin,
    expectedLogin: baseClientConfig.expectedLogin,
    appId: baseClientConfig.authority.appId,
    installationId: baseClientConfig.authority.installationId,
    permissions: baseClientConfig.authority.permissions,
  };
  const claimClientArgs = {
    credential: claimCredential,
    repository: baseClientConfig.repository,
    expectedLogin: baseClientConfig.expectedLogin,
    headSha: baseClientConfig.headSha,
    issueNumber: baseClientConfig.issueNumber,
    workspace: baseClientConfig.workspace,
    apiUrl: baseClientConfig.apiUrl,
    fetchImpl: mock.fetchImpl,
  };
  const client = createIssueClaimClient(claimClientArgs);
  assert.deepStrictEqual(client.authority, baseClientConfig.authority);

  const hydrationClient = createIssueClaimHydrationClient(claimClientArgs);
  assert.deepStrictEqual(hydrationClient.authority, baseClientConfig.authority);
  await hydrationClient.getIssue(42);
  await hydrationClient.getIssueComments(42);
  const forbiddenHydrationMutations = [
    ["update_issue_project_single_select", () => hydrationClient.updateIssueProjectSingleSelect(42, "Status", "Working")],
    ["add_issue_label", () => hydrationClient.addIssueLabel(42, "agent:in-progress")],
    ["remove_issue_label", () => hydrationClient.removeIssueLabel(42, "agent:in-progress")],
    ["post_issue_comment", () => hydrationClient.postIssueComment(42, "not permitted")],
    ["update_issue_comment", () => hydrationClient.updateIssueComment(1, "not permitted")],
    ["delete_issue_comment", () => hydrationClient.deleteIssueComment(1)],
    ["list_tag_locks", () => hydrationClient.listTagLocks()],
    ["acquire_tag_lock", () => hydrationClient.acquireTagLock(1, baseClientConfig.headSha)],
    ["release_tag_lock", () => hydrationClient.releaseTagLock(1)],
  ];
  for (const [operation, invoke] of forbiddenHydrationMutations) {
    await assert.rejects(
      invoke,
      new RegExp(`GitHub builder operation is not authorized: ${operation}`),
      `hydration clients must reject mutation operation ${operation}`,
    );
  }
  const hydrationCannotWiden = createIssueClaimHydrationClient({
    ...claimClientArgs,
    allowedOperations: ["merge", "add_issue_label"],
  });
  await assert.rejects(
    hydrationCannotWiden.addIssueLabel(42, "agent:in-progress"),
    /GitHub builder operation is not authorized/,
  );

  assert.throws(
    () => createIssueClaimClient({
      ...claimClientArgs,
      credential: { token: "ghs_test-token", verifiedLogin: "builder-app[bot]" },
    }),
    /authority does not match/,
  );
  assert.throws(
    () => createIssueClaimClient({
      ...claimClientArgs,
      credential: { ...claimCredential, verifiedLogin: "other-app[bot]" },
    }),
    /Issue-claim client identity mismatch/,
  );
  assert.throws(
    () => createIssueClaimHydrationClient({
      ...claimClientArgs,
      credential: { ...claimCredential, verifiedLogin: "other-app[bot]" },
    }),
    /Issue-claim hydration client identity mismatch/,
  );
  const cannotWiden = createIssueClaimClient({ ...claimClientArgs, allowedOperations: ["merge"] });
  await assert.rejects(
    cannotWiden.merge({ method: "squash" }),
    /GitHub builder operation is not authorized/,
  );
  assert.throws(
    () => createIssueClaimClient({
      ...claimClientArgs,
      credential: { ...claimCredential, token: "ghp_pat" },
    }),
    /short-lived GitHub App installation tokens/,
  );
  assert.throws(
    () => createIssueClaimClient({
      ...claimClientArgs,
      credential: { ...claimCredential, verifiedLogin: null },
    }),
    /credential-verified GitHub App login/,
  );

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
  const unboundClient = createBoundBuilderClient({
    ...baseClientConfig,
    authority: undefined,
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
    workspaceRoot: tempWorkspaceRoot,
    lifecyclePolicy: { labels: { queued: "workflow:queued" } },
  });
  assert.equal(mock.getComments().length, 1);
  assert.ok(mock.getLabels().has("agent:in-progress"));
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-1"));
  assert.ok(mock.getComments()[0].body.includes("Summary: Claim acquired before provider work starts."));
  let acquired = (await parseClaims(client, 42))[0];
  assert.deepEqual(acquired.data.authority, {
    login: baseClientConfig.authority.login,
    appId: baseClientConfig.authority.appId,
    installationId: baseClientConfig.authority.installationId,
    repository: baseClientConfig.authority.repository,
  });
  assert.equal(acquired.data.lifecyclePolicy.labels.queued, "workflow:queued");
  assert.equal(acquired.data.lifecycle.labelPolicy.queued, "workflow:queued");
  assert.equal(acquired.data.lifecycle.state, "queued", "the first published claim comment already contains its lifecycle ledger");
  assert.equal(mock.getComments()[0].body.includes("ghs_test-token"), false);

  const malformedAuthorityBody = mock.getComments()[0].body.replace(
    '"login": "builder-app[bot]"',
    '"login": "builder-app"',
  );
  mock.setComments([{ ...mock.getComments()[0], body: malformedAuthorityBody }]);
  const rebound = await rebindIssueClaim({
    client,
    issueNumber: 42,
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
  });
  assert.equal(rebound.rebound, true);
  acquired = (await parseClaims(client, 42))[0];
  assert.equal(acquired.data.authority.login, "builder-app[bot]");

  const missingAuthority = { ...acquired.data };
  delete missingAuthority.authority;
  mock.setComments([{
    ...mock.getComments()[0],
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(missingAuthority, null, 2)}\n-->`,
  }]);
  await assert.rejects(
    rebindIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-11111111-2222-3333-4444-555555555555" }),
    /Release the inspected claim before mutation/,
  );
  await releaseClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
    outcome: "recovered",
  });
  assert.equal((await parseClaims(client, 42))[0].data.phase, "recovered");

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
    workspaceRoot: tempWorkspaceRoot,
  });
  acquired = (await parseClaims(client, 42))[0];
  assert.equal(acquired.data.authority.permissions, undefined, "claim identity must not embed time-varying token permissions");

  const changedPermissionAuthority = {
    ...baseClientConfig.authority,
    permissions: { ...baseClientConfig.authority.permissions, contents: "read" },
  };
  const changedPermissionClient = createBoundBuilderClient({ ...baseClientConfig, authority: changedPermissionAuthority });
  assert.equal((await rebindIssueClaim({
    client: changedPermissionClient,
    issueNumber: 42,
    collaborationId: "bridge-11111111-2222-3333-4444-555555555555",
  })).rebound, false, "permission observations must not churn stable claim identity or its bounded history");

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
    verifiedLogin: "veliqon-builder[bot]",
    authority: {
      ...baseClientConfig.authority,
      login: "veliqon-builder[bot]",
    },
  });
  mock.setComments([{
    id: 1000,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-norm"}\n-->`,
    user: { login: "veliqon-builder[bot]" }
  }]);
  const parsedNorm = await parseClaims(clientNormalized, 42);
  assert.equal(parsedNorm.length, 1);
  assert.equal(parsedNorm[0].data.collaboration, "bridge-norm");
  mock.setComments([{
    id: 1001,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{"collaboration": "bridge-human-spoof"}\n-->`,
    user: { login: "veliqon-builder", type: "User" },
  }]);
  assert.equal((await parseClaims(clientNormalized, 42)).length, 0);

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

  const failoverHistoryBeforeWriterChange = stateWorking.history.filter((entry) => entry.event === "writer_failover").length;
  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "working",
    writer: "claude",
    summary: "Writer metadata refreshed after an ordinary continuation.",
  });
  const claimsAfterWriterChange = await parseClaims(client, 42);
  const stateAfterWriterChange = claimsAfterWriterChange.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateAfterWriterChange.writer, "claude");
  assert.equal(
    stateAfterWriterChange.history.filter((entry) => entry.event === "writer_failover").length,
    failoverHistoryBeforeWriterChange,
    "a bare writer refresh must not fabricate a provider failover",
  );

  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "working",
    writer: "codex",
    writerFailover: {
      from: "claude",
      to: "codex",
      failureClass: "transport",
      reason: "Claude transport closed."
    },
    summary: "Claude failed; writer transferred to Codex."
  });
  const claimsAfterWriterFailover = await parseClaims(client, 42);
  const stateAfterWriterFailover = claimsAfterWriterFailover.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateAfterWriterFailover.writer, "codex");
  assert.equal(stateAfterWriterFailover.history[0].event, "writer_failover");
  assert.equal(stateAfterWriterFailover.history[0].previousWriter, "claude");
  assert.equal(stateAfterWriterFailover.history[0].writer, "codex");
  assert.equal(stateAfterWriterFailover.history[0].failureClass, "transport");
  assert.equal(stateAfterWriterFailover.history[0].reason, "Claude transport closed.");
  assert.match(mock.getComments()[0].body, /Transfer: `claude` → `codex`/);
  assert.match(mock.getComments()[0].body, /Cause: `transport` — Claude transport closed\./);

  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "reviewing",
  });
  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "working",
    summary: "A delayed writer heartbeat arrived after review began.",
  });
  const stateAfterDelayedHeartbeat = (await parseClaims(client, 42)).find(
    (claim) => claim.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555",
  ).data;
  assert.equal(stateAfterDelayedHeartbeat.phase, "reviewing");
  assert.equal(
    stateAfterDelayedHeartbeat.lifecycle.state,
    "reviewing",
    "a stale heartbeat cannot regress the semantic lifecycle behind the clamped claim phase",
  );

  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "claiming"
  });
  const claimsAfterRegress = await parseClaims(client, 42);
  const stateNoRegress = claimsAfterRegress.find(c => c.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555").data;
  assert.equal(stateNoRegress.phase, "reviewing");
  const transitionsBeforeUnknownPhase = stateNoRegress.lifecycle.transitions.length;
  await refreshClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-33333333-3333-3333-4444-555555555555",
    phase: "provider_magic_state",
    summary: "Unknown provider phase observed without inventing implementation progress.",
  });
  const stateAfterUnknownPhase = (await parseClaims(client, 42)).find(
    (claim) => claim.data.collaboration === "bridge-33333333-3333-3333-4444-555555555555",
  ).data;
  assert.equal(
    stateAfterUnknownPhase.lifecycle.transitions.length,
    transitionsBeforeUnknownPhase,
    "an unknown provider phase does not fabricate a semantic lifecycle transition",
  );

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

  console.log("8aa. Testing post-lock revalidation prevents stale-snapshot takeover...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  mock.setComments([{
    id: 5003485002,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(oldPayload, null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  mock.getRefs().set("refs/tags/claims/issue-42-generation-1", "9999999999999999999999999999999999999999");
  mock.setupPause({ method: "GET", suffix: "/comments", afterRefPost: true });
  const staleSnapshotTakeover = acquireClaimLease({
    client,
    issueNumber: 42,
    writer: "codex",
    collaborationId: "bridge-cccccccc-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await mock.waitForPause();
  const refreshedPayload = {
    ...oldPayload,
    collaboration: "bridge-dddddddd-3333-4444-5555-666666666666",
    timestamps: { created: new Date().toISOString(), updated: new Date().toISOString() },
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  mock.setComments([{
    id: 5003485002,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(refreshedPayload, null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  mock.triggerResume();
  const staleSnapshotResult = await staleSnapshotTakeover;
  assert.equal(staleSnapshotResult.ok, false);
  assert.match(staleSnapshotResult.error.message, /became active for collaboration bridge-dddddddd/);
  assert.deepEqual([...mock.getRefs().keys()], ["refs/tags/claims/issue-42-generation-1"]);
  assert.equal((await parseClaims(client, 42))[0].data.collaboration, "bridge-dddddddd-3333-4444-5555-666666666666");

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
      lifecyclePolicy: { labels: { queued: null } },
    }),
    /Label service unavailable/,
  );
  const rolledBackClaims = await parseClaims(client, 42);
  assert.equal(rolledBackClaims.length, 1);
  assert.equal(rolledBackClaims[0].data.phase, "rolled_back");
  assert.equal(mock.getRefs().size, 0);
  assert.ok(!mock.getLabels().has("agent:in-progress"));
  console.log("8d. Testing label permission degradation preserves the durable claim...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  mock.failNextIssueLabelAdd(403, "Resource not accessible by integration");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    writer: "codex",
    collaborationId: "bridge-bbbbbbbb-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
    lifecyclePolicy: { labels: { queued: null } },
  });
  const degradedLabelClaim = (await parseClaims(client, 42))[0];
  assert.equal(degradedLabelClaim.data.claimLabel.applied, false);
  assert.equal(degradedLabelClaim.data.claimLabel.status, 403);
  assert.equal(mock.getRefs().size, 1, "label permission degradation retains claim ownership");
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

  console.log("11a. Testing timestamp-less legacy claims expire instead of renewing on parse...");
  mock.setComments([{
    id: 5003486006,
    body: `### Agent Bridge Legacy Claim\n<!-- agent-claim:v1 issue=42 -->\n<!-- {"writer":"claude","collaborationId":"bridge-eeeeeeee-3333-4444-5555-666666666666","phase":"working"} -->`,
    user: { login: "builder-app[bot]" },
  }]);
  const timestampLessLegacy = await parseClaims(client, 42);
  assert.equal(timestampLessLegacy[0].data.timestamps.created, null);
  assert.equal(timestampLessLegacy[0].data.timestamps.updated, null);
  await acquireClaimLease({
    client,
    issueNumber: 42,
    writer: "codex",
    collaborationId: "bridge-ffffffff-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
  });
  assert.equal((await parseClaims(client, 42))[0].data.generation, 2);

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

  console.log("13c. Testing authoritative closed outcome reconciliation...");
  mock.setIssue({ state: "closed", state_reason: "not_planned" });
  await reconcileClaimsAndPortfolios(tempWorkspaceRoot, mock.fetchImpl, client);
  reconciledPortfolio = JSON.parse(fs.readFileSync(portfolioPath, "utf8"));
  assert.equal(reconciledPortfolio.items[0].status, "obsolete");
  assert.equal(reconciledPortfolio.items[0].semanticLifecycle.state, "obsolete");
  const reconciledCollaboration = await readCollaboration(
    tempWorkspaceRoot,
    "bridge-11111111-2222-3333-4444-555555555555",
  );
  assert.equal(reconciledCollaboration.status, "obsolete");
  assert.equal(reconciledCollaboration.semanticLifecycle.state, "obsolete");
  assert.equal((await parseClaims(client, 42))[0].data.phase, "obsolete");

  console.log("13d. Testing isolated claim failures, retained ownership, and transient recovery...");
  const isolatedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claim-reconciliation-test-"));
  const isolatedPortfolios = path.join(isolatedWorkspace, ".bridge", "portfolios");
  fs.mkdirSync(isolatedPortfolios, { recursive: true });
  const badPortfolioId = "helm-00000000-0000-4000-8000-000000000001";
  const transientPortfolioId = "helm-00000000-0000-4000-8000-000000000002";
  const noClientPortfolioId = "helm-00000000-0000-4000-8000-000000000003";
  const malformedPortfolioId = "helm-00000000-0000-4000-8000-000000000004";
  const goodPortfolioId = "helm-00000000-0000-4000-8000-000000000005";
  const unwritableFailurePortfolioId = "helm-00000000-0000-4000-8000-000000000006";
  const corruptPortfolioId = "helm-00000000-0000-4000-8000-000000000007";
  const badCollaborationId = "bridge-00000000-0000-4000-8000-000000000001";
  const transientCollaborationId = "bridge-00000000-0000-4000-8000-000000000002";
  const noClientCollaborationId = "bridge-00000000-0000-4000-8000-000000000003";
  const malformedCollaborationId = "bridge-00000000-0000-4000-8000-000000000004";
  const goodCollaborationId = "bridge-00000000-0000-4000-8000-000000000005";
  const unwritableFailureCollaborationId = "bridge-00000000-0000-4000-8000-000000000006";
  const claimFor = ({ portfolio, item, collaboration, authority }) => ({
    portfolio,
    item,
    writer: "codex",
    collaboration,
    phase: "working",
    authority,
    head: "1111111111111111111111111111111111111111",
    timestamps: {
      created: new Date().toISOString(),
      updated: new Date(0).toISOString(),
    },
  });
  const writeReconciliationPortfolio = ({ id, issueNumber, collaborationId, updatedAt }) => {
    fs.writeFileSync(path.join(isolatedPortfolios, `${id}.json`), JSON.stringify({
      id,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
      workspace: isolatedWorkspace,
      items: [{
        id: `issue-${issueNumber}`,
        issueNumber,
        status: "claimed",
        collaborationId,
      }],
    }, null, 2));
  };
  writeReconciliationPortfolio({ id: badPortfolioId, issueNumber: 42, collaborationId: badCollaborationId, updatedAt: "2026-01-01T00:00:05.000Z" });
  writeReconciliationPortfolio({ id: transientPortfolioId, issueNumber: 43, collaborationId: transientCollaborationId, updatedAt: "2026-01-01T00:00:04.000Z" });
  writeReconciliationPortfolio({ id: noClientPortfolioId, issueNumber: 44, collaborationId: noClientCollaborationId, updatedAt: "2026-01-01T00:00:03.000Z" });
  writeReconciliationPortfolio({ id: malformedPortfolioId, issueNumber: 45, collaborationId: malformedCollaborationId, updatedAt: "2026-01-01T00:00:02.000Z" });
  writeReconciliationPortfolio({ id: unwritableFailurePortfolioId, issueNumber: 47, collaborationId: unwritableFailureCollaborationId, updatedAt: "2026-01-01T00:00:01.500Z" });
  writeReconciliationPortfolio({ id: goodPortfolioId, issueNumber: 46, collaborationId: goodCollaborationId, updatedAt: "2026-01-01T00:00:01.000Z" });
  for (const [id, issueNumber] of [
    [badCollaborationId, 42],
    [transientCollaborationId, 43],
    [noClientCollaborationId, 44],
    [malformedCollaborationId, 45],
    [unwritableFailureCollaborationId, 47],
    [goodCollaborationId, 46],
  ]) {
    await createCollaboration(isolatedWorkspace, {
      id,
      task: `issue-${issueNumber}`,
      workspace: isolatedWorkspace,
      status: "working",
      writer: "codex",
      issueClaim: {
        repository: "owner/repo",
        issueNumber,
        expectedLogin: "builder-app[bot]",
        headSha: "1111111111111111111111111111111111111111",
      },
    });
  }
  const badMock = createPausableMockGitHub();
  const transientMock = createPausableMockGitHub();
  const malformedMock = createPausableMockGitHub();
  const goodMock = createPausableMockGitHub();
  badMock.getRefs().set("refs/tags/claims/issue-42-generation-1", baseClientConfig.headSha);
  badMock.setComments([{
    id: 5003486600,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(claimFor({
      portfolio: badPortfolioId,
      item: "issue-42",
      collaboration: badCollaborationId,
      authority: { ...baseClientConfig.authority, appId: "legacy-app" },
    }), null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  transientMock.setComments([{
    id: 5003486601,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(claimFor({
      portfolio: transientPortfolioId,
      item: "issue-43",
      collaboration: transientCollaborationId,
      authority: baseClientConfig.authority,
    }), null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  malformedMock.setComments([{
    id: 5003486602,
    body: "### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{not valid json}\n-->",
    user: { login: "builder-app[bot]" },
  }]);
  goodMock.setComments([{
    id: 5003486603,
    body: `### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n${JSON.stringify(claimFor({
      portfolio: goodPortfolioId,
      item: "issue-46",
      collaboration: goodCollaborationId,
      authority: baseClientConfig.authority,
    }), null, 2)}\n-->`,
    user: { login: "builder-app[bot]" },
  }]);
  const badClaimClient = createIssueClaimClient({ ...claimClientArgs, issueNumber: 42, workspace: isolatedWorkspace, fetchImpl: badMock.fetchImpl });
  const transientBaseClient = createIssueClaimClient({ ...claimClientArgs, issueNumber: 43, workspace: isolatedWorkspace, fetchImpl: transientMock.fetchImpl });
  let transientIssueReads = 0;
  const transientClaimClient = new Proxy(transientBaseClient, {
    get(target, property, receiver) {
      if (property !== "getIssue") return Reflect.get(target, property, receiver);
      return async (...args) => {
        transientIssueReads += 1;
        if (transientIssueReads === 1) {
          const error = new Error("GitHub issue lifecycle temporarily unavailable");
          error.status = 503;
          throw error;
        }
        return target.getIssue(...args);
      };
    },
  });
  const malformedClaimClient = createIssueClaimClient({ ...claimClientArgs, issueNumber: 45, workspace: isolatedWorkspace, fetchImpl: malformedMock.fetchImpl });
  const goodClaimClient = createIssueClaimClient({ ...claimClientArgs, issueNumber: 46, workspace: isolatedWorkspace, fetchImpl: goodMock.fetchImpl });
  const reconciliationOrder = [];
  const reconciliationClient = ({ issueNumber }) => {
    reconciliationOrder.push(issueNumber);
    if (issueNumber === 42) return badClaimClient;
    if (issueNumber === 43) return transientClaimClient;
    if (issueNumber === 44) return null;
    if (issueNumber === 45) return malformedClaimClient;
    if (issueNumber === 47) {
      fs.rmSync(path.join(isolatedPortfolios, `${unwritableFailurePortfolioId}.json`));
      return null;
    }
    return goodClaimClient;
  };
  // Pin the first-pass ordering so this regression proves that unhealthy
  // authority records are visited before, and cannot abort, later healthy work.
  for (const [portfolio, updatedAt] of [
    [badPortfolioId, "2026-01-01T00:00:05.000Z"],
    [transientPortfolioId, "2026-01-01T00:00:04.000Z"],
    [noClientPortfolioId, "2026-01-01T00:00:03.000Z"],
    [malformedPortfolioId, "2026-01-01T00:00:02.000Z"],
    [unwritableFailurePortfolioId, "2026-01-01T00:00:01.500Z"],
    [goodPortfolioId, "2026-01-01T00:00:01.000Z"],
  ]) {
    const portfolioFile = path.join(isolatedPortfolios, `${portfolio}.json`);
    const state = JSON.parse(fs.readFileSync(portfolioFile, "utf8"));
    state.updatedAt = updatedAt;
    fs.writeFileSync(portfolioFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  assert.deepEqual(
    (await listPortfolios(isolatedPortfolios)).map((portfolio) => portfolio.items[0].issueNumber),
    [42, 43, 44, 45, 47, 46],
  );
  fs.writeFileSync(path.join(isolatedPortfolios, `${corruptPortfolioId}.json`), "{not valid portfolio json}\n");
  const firstSweep = await reconcileClaimsAndPortfolios(
    isolatedWorkspace,
    fetch,
    reconciliationClient,
  );
  assert.deepEqual(reconciliationOrder, [42, 43, 44, 45, 47, 46]);
  assert.ok(firstSweep.failures.some((failure) => failure.portfolioId === corruptPortfolioId && failure.stage === "portfolio-read"));
  assert.ok(firstSweep.failures.some((failure) => failure.portfolioId === unwritableFailurePortfolioId && failure.recordError), "failure-recorder write errors must be reported without aborting the sweep");
  const isolatedBadPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${badPortfolioId}.json`), "utf8"));
  let isolatedTransientPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${transientPortfolioId}.json`), "utf8"));
  const isolatedNoClientPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${noClientPortfolioId}.json`), "utf8"));
  const isolatedMalformedPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${malformedPortfolioId}.json`), "utf8"));
  const isolatedGoodPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${goodPortfolioId}.json`), "utf8"));
  assert.equal(isolatedBadPortfolio.items[0].status, "indeterminate");
  assert.match(isolatedBadPortfolio.items[0].summary, /GitHub App ID changed/);
  assert.match(isolatedBadPortfolio.items[0].summary, /Release the inspected claim.*reacquire/i);
  assert.equal(badMock.getRefs().get("refs/tags/claims/issue-42-generation-1"), baseClientConfig.headSha);
  assert.equal((await parseClaims(badClaimClient, 42))[0].data.phase, "working");
  assert.equal(isolatedTransientPortfolio.items[0].status, "claimed");
  assert.match(isolatedTransientPortfolio.items[0].summary, /transient GitHub failure/);
  assert.match(isolatedTransientPortfolio.items[0].summary, /retained claim remains held.*retry automatically/i);
  assert.doesNotMatch(transientMock.getComments()[0].body, /Reconciled local collaboration status/);
  assert.equal(isolatedNoClientPortfolio.items[0].status, "indeterminate");
  assert.match(isolatedNoClientPortfolio.items[0].summary, /No builder App client is configured/);
  assert.equal(isolatedMalformedPortfolio.items[0].status, "indeterminate");
  assert.match(isolatedMalformedPortfolio.items[0].summary, /Malformed trusted canonical claim/);
  assert.match(isolatedMalformedPortfolio.items[0].summary, /release it without mutation.*reacquire/i);
  assert.equal(isolatedGoodPortfolio.items[0].status, "claimed");
  assert.match(goodMock.getComments()[0].body, /Reconciled local collaboration status working after broker restart/);
  assert.doesNotMatch(badMock.getComments()[0].body, /Reconciled local collaboration status/);

  await reconcileClaimsAndPortfolios(isolatedWorkspace, fetch, reconciliationClient);
  isolatedTransientPortfolio = JSON.parse(fs.readFileSync(path.join(isolatedPortfolios, `${transientPortfolioId}.json`), "utf8"));
  assert.equal(isolatedTransientPortfolio.items[0].status, "claimed");
  assert.match(isolatedTransientPortfolio.items[0].summary, /Claim lease reconciled with local collaboration status working/);
  assert.match(transientMock.getComments()[0].body, /Reconciled local collaboration status working after broker restart/);
  fs.rmSync(isolatedWorkspace, { recursive: true, force: true });

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
    releaseClaimLease({
      client: unboundClient,
      issueNumber: 42,
      collaborationId: "bridge-44444444-3333-4444-5555-666666666666",
      outcome: "cancelled",
    }),
    /Claim mutation requires a verified GitHub App authority binding/,
  );
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

  console.log("17. Testing inspected orphan recovery cannot disturb a fresh canonical claim...");
  mock.getRefs().set("refs/tags/claims/issue-42-generation-2", "2222222222222222222222222222222222222222");
  await assert.rejects(
    recoverIssueClaim({
      client,
      issueNumber: 42,
      collaborationId: "bridge-missing",
      generation: 2,
      workspaceRoot: tempWorkspaceRoot,
    }),
    /canonical collaboration bridge-44444444-3333-4444-5555-666666666666 is still active/,
  );
  await releaseClaimLease({ client, issueNumber: 42, collaborationId: "bridge-44444444-3333-4444-5555-666666666666", outcome: "cancelled" });
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-2"));
  const recoveredBesideCanonical = await recoverIssueClaim({
    client,
    issueNumber: 42,
    collaborationId: "bridge-orphan-after-release",
    generation: 2,
    workspaceRoot: tempWorkspaceRoot,
  });
  assert.deepEqual(recoveredBesideCanonical, {
    recovered: true,
    generation: 2,
    canonical: false,
    previousCanonicalGeneration: 1,
  });
  assert.equal(mock.getRefs().size, 0);

  console.log("17a. Testing release repairs a concurrent claim-label removal race...");
  mock.clear();
  mock.getRepoLabels().add("agent:in-progress");
  await acquireClaimLease({
    client,
    issueNumber: 42,
    writer: "codex",
    collaborationId: "bridge-12121212-3333-4444-5555-666666666666",
    headSha: "1111111111111111111111111111111111111111",
    workspaceRoot: tempWorkspaceRoot,
  });
  mock.setupPause({ method: "DELETE", suffix: "/labels/agent%3Ain-progress" });
  const releasingClaim = releaseClaimLease({
    client,
    issueNumber: 42,
    collaborationId: "bridge-12121212-3333-4444-5555-666666666666",
    outcome: "cancelled",
  });
  await mock.waitForPause();
  await acquireClaimLease({
    client: client2,
    issueNumber: 42,
    writer: "claude",
    collaborationId: "bridge-13131313-3333-4444-5555-666666666666",
    headSha: "2222222222222222222222222222222222222222",
    workspaceRoot: tempWorkspaceRoot,
  });
  mock.triggerResume();
  await releasingClaim;
  assert.ok(mock.getLabels().has("agent:in-progress"));
  assert.equal((await parseClaims(client, 42))[0].data.collaboration, "bridge-13131313-3333-4444-5555-666666666666");

  console.log("17b. Testing orphan recovery without any canonical comment...");
  mock.clear();
  mock.getLabels().add("agent:in-progress");
  mock.getRefs().set("refs/tags/claims/issue-42-generation-3", "1111111111111111111111111111111111111111");
  await assert.rejects(
    recoverIssueClaim({ client: unboundClient, issueNumber: 42, collaborationId: "bridge-orphan", generation: 3 }),
    /Claim mutation requires a verified GitHub App authority binding/,
  );
  assert.ok(mock.getRefs().has("refs/tags/claims/issue-42-generation-3"));
  assert.ok(mock.getLabels().has("agent:in-progress"));
  await assert.rejects(
    recoverIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-orphan", generation: 2 }),
    /Generation 2 does not exist/,
  );
  const recoveredOrphan = await recoverIssueClaim({ client, issueNumber: 42, collaborationId: "bridge-orphan", generation: 3 });
  assert.deepEqual(recoveredOrphan, { recovered: true, generation: 3, canonical: false, previousCanonicalGeneration: null });
  assert.equal(mock.getRefs().size, 0);
  assert.ok(!mock.getLabels().has("agent:in-progress"));

  fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
  if (previousCollaborationDirectory === undefined) delete process.env.BRIDGE_COLLABORATION_DIR;
  else process.env.BRIDGE_COLLABORATION_DIR = previousCollaborationDirectory;
  console.log("All claim subsystem unit tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

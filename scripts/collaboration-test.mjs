import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCollaboration, readCollaboration } from "../src/collaboration-store.mjs";
import { collaborationIdentity } from "../src/collaboration-identity.mjs";
import { buildClaimedIssueContext } from "../src/claimed-issue-context.mjs";
import { recordMergeDeliveryReceipt } from "../src/merge-delivery-receipts.mjs";
// Issue #55 dispatch/narrative fixtures: command allowlist admission and command-aware narrative.
import "./issue-40-autonomy-test.mjs";
import "./issue-55-allowlist-test.mjs";
import "./issue-55-narrative-test.mjs";
// Issue #55 fail-closed provider capability boundary (integration via delegated pool.send).
import "./issue-55-capability-boundary-test.mjs";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "agent-collaboration-test-"));
process.env.BRIDGE_COLLABORATION_DIR = stateDirectory;
const cleanWorkspace = join(root, ".bridge", "test-workspaces", stateDirectory.split("/").at(-1));
const unbornWorkspace = `${cleanWorkspace}-unborn`;
await mkdir(cleanWorkspace, { recursive: true });
await writeFile(join(cleanWorkspace, "README.md"), "# Clean collaboration fixture\n");
await mkdir(join(cleanWorkspace, ".agent-bridge"), { recursive: true });
await writeFile(join(cleanWorkspace, ".agent-bridge", "delivery-policy.json"), `${JSON.stringify({
  version: 1,
  verificationRoles: { quick: ["git diff --check"] },
}, null, 2)}\n`);
for (const args of [
  ["init", "-q"],
  ["config", "user.email", "bridge@example.test"],
  ["config", "user.name", "Bridge Test"],
  ["remote", "add", "origin", "https://github.com/veliqon/collaboration-fixture.git"],
  ["add", "README.md", ".agent-bridge/delivery-policy.json"],
  ["commit", "-qm", "fixture"],
]) {
  const result = spawnSync("git", args, { cwd: cleanWorkspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to prepare collaboration fixture: ${result.stderr || result.stdout}`);
}
await mkdir(unbornWorkspace, { recursive: true });
{
  const result = spawnSync("git", ["init", "-q"], { cwd: unbornWorkspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to prepare unborn collaboration fixture: ${result.stderr || result.stdout}`);
}
const fakeCodex = join(stateDirectory, "codex");
await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${resolve(root, "scripts/fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(fakeCodex, 0o700);
const githubAppKey = join(stateDirectory, "github-app.pem");
const githubTlsKey = join(stateDirectory, "github-tls-key.pem");
const githubTlsCert = join(stateDirectory, "github-tls-cert.pem");
const githubAppsConfig = join(stateDirectory, "github-apps.json");
const providerLaunchMarker = join(stateDirectory, "hydration-provider-launched");
const hydrationEventLog = join(stateDirectory, "hydration-events.log");
const hydrationProvider = join(stateDirectory, "hydration-claude");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
await writeFile(githubAppKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const tls = spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", githubTlsKey, "-out", githubTlsCert, "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
], { encoding: "utf8" });
if (tls.status !== 0) throw new Error(`Unable to prepare loopback GitHub TLS fixture: ${tls.stderr}`);
await chmod(githubTlsKey, 0o600);
await writeFile(githubAppsConfig, `${JSON.stringify({
  version: 1,
  roles: {
    builder: {
      appId: "123456",
      expectedLogin: "test-builder[bot]",
      privateKeyPath: githubAppKey,
      installations: { veliqon: 222 },
    },
    reviewers: {
      claude: {
        appId: "123456",
        expectedLogin: "test-builder[bot]",
        privateKeyPath: githubAppKey,
        installations: { veliqon: 222 },
      },
    },
  },
})}\n`, { mode: 0o600 });
await writeFile(hydrationProvider, `#!/bin/sh\nif [ "$1" != "--version" ]; then\n  printf launched > "${providerLaunchMarker}"\n  printf 'provider:launch\\n' >> "${hydrationEventLog}"\nfi\nexec "${process.execPath}" "${resolve(root, "scripts/fake-claude.mjs")}" "$@"\n`);
await chmod(hydrationProvider, 0o700);

const githubFixture = {
  failHydration: false,
  events: [],
  comments: [],
  tagLocked: false,
};
function fixtureJson(response, value, status = 200, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}
const githubServer = createHttpsServer({
  key: await readFile(githubTlsKey),
  cert: await readFile(githubTlsCert),
}, async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  const path = request.url;
  githubFixture.events.push({ method: request.method, path, body });
  await appendFile(hydrationEventLog, `github:${request.method}:${path}\n`);
  if (path === "/app") return fixtureJson(response, { slug: "test-builder" });
  if (path === "/app/installations/222/access_tokens") return fixtureJson(response, {
    token: "ghs_test_installation_token",
    expires_at: "2099-01-01T00:00:00Z",
    permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
  }, 201);
  if (path === "/repos/veliqon/collaboration-fixture/issues/98") {
    if (githubFixture.failHydration) return fixtureJson(response, { message: "private issue denied" }, 403);
    return fixtureJson(response, { number: 98, title: "Hydration ordering", body: "Acceptance", state: "open", labels: [] });
  }
  if (path?.startsWith("/repos/veliqon/collaboration-fixture/issues/98/comments")) {
    if (request.method === "POST") {
      const comment = { id: 9001, body: body.body, user: { login: "test-builder[bot]", type: "Bot" } };
      githubFixture.comments = [comment];
      return fixtureJson(response, comment, 201);
    }
    return fixtureJson(response, githubFixture.comments);
  }
  if (path === "/repos/veliqon/collaboration-fixture/issues/comments/9001" && request.method === "PATCH") {
    githubFixture.comments[0].body = body.body;
    return fixtureJson(response, githubFixture.comments[0]);
  }
  if (path?.includes("/dependencies/")) return fixtureJson(response, []);
  if (path?.startsWith("/repos/veliqon/collaboration-fixture/issues/98/timeline")) return fixtureJson(response, []);
  if (path === "/graphql") return fixtureJson(response, { data: { repository: { issue: { projectItems: { nodes: [] } } } } });
  if (path?.startsWith("/repos/veliqon/collaboration-fixture/git/matching-refs/tags/claims/issue-98")) {
    return fixtureJson(response, githubFixture.tagLocked
      ? [{ ref: "refs/tags/claims/issue-98-generation-1", object: { sha: "a".repeat(40) } }]
      : []);
  }
  if (path === "/repos/veliqon/collaboration-fixture/git/refs" && request.method === "POST") {
    githubFixture.tagLocked = true;
    return fixtureJson(response, { ref: body.ref, object: { sha: body.sha } }, 201);
  }
  if (path?.startsWith("/repos/veliqon/collaboration-fixture/labels/")) return fixtureJson(response, { name: decodeURIComponent(path.split("/").at(-1)) });
  if (path === "/repos/veliqon/collaboration-fixture/issues/98/labels" && request.method === "POST") return fixtureJson(response, body.labels || []);
  return fixtureJson(response, { message: `Unexpected fixture route ${request.method} ${path}` }, 404);
});
await new Promise((resolvePromise) => githubServer.listen(0, "127.0.0.1", resolvePromise));
const githubApiUrl = `https://127.0.0.1:${githubServer.address().port}`;
const cleanProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !name.startsWith("BRIDGE_")
    && !["CLAUDE_BRIDGE_ACTIVE", "CODEX_BRIDGE_ACTIVE", "ANTIGRAVITY_BRIDGE_ACTIVE"].includes(name)
  )),
);
const env = {
  ...cleanProcessEnv,
  AGENT_BRIDGE_TEST_MODE: "1",
  BRIDGE_COLLABORATION_DIR: stateDirectory,
  CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs"),
  AGY_BIN: "/bin/echo",
  AGENT_BRIDGE_GITHUB_APPS_CONFIG: githubAppsConfig,
  GITHUB_BUILDER_API_URL: githubApiUrl,
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
};
const terminalReconcileId = "bridge-00000000-0000-4000-8000-000000000001";
await writeFile(join(stateDirectory, `${terminalReconcileId}.json`), `${JSON.stringify({
  id: terminalReconcileId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  status: "turn_limit", task: "stale terminal metadata", workspace: root, agents: ["claude"],
  workerPid: 999999, workerOwner: { id: terminalReconcileId, pid: 999999 },
  runtime: { turnCount: 1, activeCall: { agent: "claude", status: "running" } },
})}\n`);

async function connect(name, extraEnv = {}) {
  const client = new Client({ name, version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: [resolve(root, "scripts/collaboration-bridge-mcp.sh")],
    cwd: root,
    env: { ...env, ...extraEnv },
  });
  await client.connect(transport);
  return client;
}

async function waitForStop(client, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let view;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: id, detail: "full", includeTurns: 20 },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    view = result.structuredContent;
    if (!["queued", "running", "recovering", "cancelling"].includes(view.status)) return view;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${id}; last status: ${view?.status}`);
}

async function acknowledgeWake(client, view, summary = "Coordinator processed the wake event.") {
  assert.equal(view.coordinatorWake?.actionable, true);
  assert.equal(view.coordinatorWake?.status, "pending");
  const result = await client.callTool({
    name: "acknowledge_coordinator_wake",
    arguments: {
      collaborationId: view.id,
      sequence: view.coordinatorWake.sequence,
      provider: view.coordinatorWake.provider,
      summary,
      action: "processed",
    },
  });
  assert.equal(result.structuredContent.coordinatorWake.status, "acknowledged");
  return result.structuredContent;
}

let firstClient;
let secondClient;
let nestedClient;
let fallbackClient;
let heartbeatClient;
let cancellationClient;
let codexFallbackClient;
let completionClient;
let receiptClient;
let capacityClient;
let recoveryClient;
let mixedFailureClient;
let reviewRaceClaudeClient;
let reviewRaceAntigravityClient;
try {
  firstClient = await connect("collaboration-test-app-one", { CLAUDE_BIN: hydrationProvider });
  const tools = await firstClient.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "acknowledge_coordinator_wake",
    "acknowledge_handoff",
    "archive_collaboration",
    "authorize_portfolio_merge",
    "begin_portfolio_merge_validation",
    "cancel_collaboration",
    "cleanup_writer_checkout",
    "continue_collaboration",
    "create_portfolio",
    "enqueue_portfolio_merge",
    "get_collaboration",
    "get_context_capsule",
    "get_portfolio",
    "inspect_repository_footprints",
    "list_collaborations",
    "list_portfolios",
    "merge_pull_request",
    "plan_portfolio",
    "prune_collaborations",
    "rebind_issue_claim",
    "reconcile_portfolio_footprint",
    "record_decision",
    "record_native_chair_turn",
    "record_portfolio_merge",
    "record_portfolio_merge_validation",
    "record_verification_receipt",
    "recover_portfolio_merge_validation",
    "recover_writer_checkout",
    "refresh_portfolio_target",
    "release_issue_claim",
    "replay_incident",
    "retire_writer_checkout",
    "start_collaboration",
    "update_portfolio_item",
    "wait_for_portfolio_lane",
  ]);
  const claimedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: cleanWorkspace, encoding: "utf8" }).stdout.trim();
  const claimedStart = {
    task: "Exercise real claimed-start hydration ordering.",
    workspace: cleanWorkspace,
    agents: ["claude"],
    startAgent: "claude",
    mode: "review",
    maxTurns: 1,
    providerFailover: { enabled: false },
    issueClaim: {
      repository: "veliqon/collaboration-fixture",
      issueNumber: 98,
      expectedLogin: "test-builder[bot]",
      branch: "main",
      headSha: claimedHead,
    },
  };

  // Exercise the real MCP start handler. A required-read failure must stop
  // before any repository mutation and before the provider process exists.
  githubFixture.failHydration = true;
  githubFixture.events = [];
  await writeFile(hydrationEventLog, "");
  await rm(providerLaunchMarker, { force: true });
  const rejectedClaimedStart = await firstClient.callTool({
    name: "start_collaboration",
    arguments: claimedStart,
  });
  assert.equal(rejectedClaimedStart.isError, true);
  assert.match(rejectedClaimedStart.content?.[0]?.text || "", /private issue denied/);
  assert.ok(githubFixture.events.some((event) => event.method === "GET" && event.path === "/repos/veliqon/collaboration-fixture/issues/98"));
  assert.ok(!githubFixture.events.some((event) => (
    event.path?.startsWith("/repos/veliqon/collaboration-fixture/")
    && event.method !== "GET"
  )), "failed hydration must perform no claim mutation");
  await assert.rejects(readFile(providerLaunchMarker), /ENOENT/);

  // On success, the same real path reads the required issue facts, publishes
  // the lease, and only then allows the provider supervisor to launch.
  githubFixture.failHydration = false;
  githubFixture.events = [];
  githubFixture.comments = [];
  githubFixture.tagLocked = false;
  await writeFile(hydrationEventLog, "");
  const acceptedClaimedStart = await firstClient.callTool({
    name: "start_collaboration",
    arguments: claimedStart,
  });
  assert.notEqual(acceptedClaimedStart.isError, true, acceptedClaimedStart.content?.[0]?.text || "claimed start failed");
  await waitForStop(firstClient, acceptedClaimedStart.structuredContent.id);
  assert.equal(await readFile(providerLaunchMarker, "utf8"), "launched");
  const orderedEvents = (await readFile(hydrationEventLog, "utf8")).trim().split("\n");
  const requiredReadIndex = orderedEvents.findIndex((event) => event === "github:GET:/repos/veliqon/collaboration-fixture/issues/98");
  const claimMutationIndex = orderedEvents.findIndex((event) => event === "github:POST:/repos/veliqon/collaboration-fixture/git/refs");
  const providerLaunchIndex = orderedEvents.indexOf("provider:launch");
  assert.ok(requiredReadIndex >= 0 && claimMutationIndex > requiredReadIndex, "claim mutation must follow required hydration");
  assert.ok(providerLaunchIndex > claimMutationIndex, "provider launch must follow claim publication");

  const namedVerification = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Resolve a repository-owned named verification role",
      workspace: cleanWorkspace,
      agents: ["claude"],
      maxTurns: 1,
      verificationRole: "quick",
    },
  });
  assert.notEqual(namedVerification.isError, true, namedVerification.content?.map((item) => item.text || "").join("\n"));
  assert.equal(namedVerification.structuredContent.verificationRole, "quick");
  assert.deepEqual(namedVerification.structuredContent.requestedVerificationCommands, ["git diff --check"]);
  await waitForStop(firstClient, namedVerification.structuredContent.id);

  // Two callers may race to start independent exact-head reviews. Provider
  // selection is part of compatibility, so the identity lock must serialize
  // only matching retries and must never collapse Claude into Antigravity.
  reviewRaceClaudeClient = await connect("collaboration-review-race-claude", { FAKE_CLAUDE_DELAY_MS: "3000" });
  reviewRaceAntigravityClient = await connect("collaboration-review-race-antigravity");
  const reviewRaceBase = {
    task: "Independently review the same exact PR head.",
    workspace: cleanWorkspace,
    mode: "review",
    maxTurns: 1,
    handoffPath: ".bridge/test-handoffs/reuse-race.md",
    githubReview: {
      repository: "veliqon/collaboration-fixture",
      prNumber: 248,
      headSha: claimedHead,
      expectedLogins: {
        claude: "test-builder[bot]",
        antigravity: "test-antigravity-reviewer[bot]",
      },
    },
  };
  const [claudeRaceStart, antigravityRaceStart] = await Promise.all([
    reviewRaceClaudeClient.callTool({
      name: "start_collaboration",
      arguments: { ...reviewRaceBase, agents: ["claude"], startAgent: "claude" },
    }),
    reviewRaceAntigravityClient.callTool({
      name: "start_collaboration",
      arguments: { ...reviewRaceBase, agents: ["antigravity"], startAgent: "antigravity" },
    }),
  ]);
  assert.notEqual(claudeRaceStart.isError, true, claudeRaceStart.content?.[0]?.text || "Claude race start failed");
  assert.notEqual(antigravityRaceStart.isError, true, antigravityRaceStart.content?.[0]?.text || "Antigravity race start failed");
  assert.notEqual(
    claudeRaceStart.structuredContent.id,
    antigravityRaceStart.structuredContent.id,
    "concurrent provider-specific exact-head reviews must create independent collaborations",
  );
  const claudeCompatibleRetry = await reviewRaceClaudeClient.callTool({
    name: "start_collaboration",
    arguments: { ...reviewRaceBase, agents: ["claude"], startAgent: "claude" },
  });
  assert.equal(claudeCompatibleRetry.structuredContent.id, claudeRaceStart.structuredContent.id,
    "a compatible same-provider retry must reuse its live collaboration");
  assert.equal(claudeCompatibleRetry.structuredContent.resume?.reused, true);
  assert.deepEqual(claudeCompatibleRetry.structuredContent.resume?.compatibility?.matchedDimensions, [
    "requestedProviderRoster",
    "effectiveProviderRoster",
    "startAgent",
    "nativeChair",
    "explicitModels",
    "modelFallbacks",
    "allowClaudeFable",
    "handoffPath",
    "githubReviewerIdentityConstraints",
    "githubBuilderAuthorityConstraints",
  ]);
  assert.deepEqual(claudeCompatibleRetry.structuredContent.resume?.compatibility?.requestedProviderRoster, ["claude"]);
  assert.deepEqual(claudeCompatibleRetry.structuredContent.resume?.compatibility?.effectiveProviderRoster, ["claude"]);
  assert.equal(claudeCompatibleRetry.structuredContent.resume?.compatibility?.startAgent, "claude");
  await Promise.all([
    waitForStop(reviewRaceClaudeClient, claudeRaceStart.structuredContent.id),
    waitForStop(reviewRaceAntigravityClient, antigravityRaceStart.structuredContent.id),
  ]);

  const rotationRaceBase = {
    ...reviewRaceBase,
    task: "Exercise exact-head reviewer rotation compatibility.",
    agents: ["claude", "antigravity"],
  };
  const [rotationZero, rotationOne] = await Promise.all([0, 1].map((taskNumber) => (
    reviewRaceClaudeClient.callTool({
      name: "start_collaboration",
      arguments: { ...rotationRaceBase, taskNumber },
    })
  )));
  assert.notEqual(rotationZero.structuredContent.id, rotationOne.structuredContent.id,
    "task rotation that selects a different effective start agent must not reuse the sibling review");
  assert.equal(rotationZero.structuredContent.startAgent, "claude");
  assert.equal(rotationOne.structuredContent.startAgent, "antigravity");
  await Promise.all([
    waitForStop(reviewRaceClaudeClient, rotationZero.structuredContent.id),
    waitForStop(reviewRaceClaudeClient, rotationOne.structuredContent.id),
  ]);

  const chairCompatibilityBase = {
    ...reviewRaceBase,
    task: "Exercise native-chair reuse compatibility.",
    agents: ["claude", "antigravity"],
    startAgent: "claude",
  };
  const [hostlessReview, chairedReview] = await Promise.all([
    reviewRaceClaudeClient.callTool({ name: "start_collaboration", arguments: chairCompatibilityBase }),
    reviewRaceAntigravityClient.callTool({
      name: "start_collaboration",
      arguments: {
        ...chairCompatibilityBase,
        agents: ["codex", "claude", "antigravity"],
        startAgent: "codex",
        chair: {
          provider: "codex",
          sessionId: "reuse-race-native-chair",
          workspace: cleanWorkspace,
          allowSameProviderDelegation: false,
        },
      },
    }),
  ]);
  assert.notEqual(hostlessReview.structuredContent.id, chairedReview.structuredContent.id,
    "a native-chair wake route must not reuse a hostless collaboration with the same delegated roster");
  assert.equal(hostlessReview.structuredContent.chair, null);
  assert.equal(chairedReview.structuredContent.chair.provider, "codex");
  assert.deepEqual(chairedReview.structuredContent.agents, ["claude", "antigravity"],
    "native-chair filtering must be reflected in the effective reuse roster");
  assert.deepEqual(chairedReview.structuredContent.requestedAgents, ["codex", "claude", "antigravity"]);
  await Promise.all([
    waitForStop(reviewRaceClaudeClient, hostlessReview.structuredContent.id),
    waitForStop(reviewRaceAntigravityClient, chairedReview.structuredContent.id),
  ]);

  const governedBuilderBase = {
    task: "Exercise GitHub builder authority reuse compatibility.",
    workspace: cleanWorkspace,
    agents: ["claude"],
    startAgent: "claude",
    mode: "work",
    writer: "claude",
    workProfile: "implement",
    maxTurns: 1,
    providerFailover: { enabled: false },
    issueTarget: { repository: "veliqon/collaboration-fixture", issueNumber: 98 },
    githubBuilder: {
      repository: "veliqon/collaboration-fixture",
      issueNumber: 98,
      prNumber: 248,
      headSha: claimedHead,
      expectedLogin: "test-builder[bot]",
      allowedOperations: ["read_review_threads"],
    },
  };
  const governedBuilderIdentity = collaborationIdentity({
    workspace: cleanWorkspace,
    mode: "work",
    writer: "claude",
    agents: ["claude"],
    requestedAgents: ["claude"],
    startAgent: "claude",
    githubBuilder: governedBuilderBase.githubBuilder,
  });
  const governedBuilderId = "bridge-24800000-0000-4000-8000-000000000001";
  await createCollaboration(root, {
    id: governedBuilderId,
    identityKey: governedBuilderIdentity,
    task: governedBuilderBase.task,
    workspace: cleanWorkspace,
    status: "running",
    mode: "work",
    writer: "claude",
    agents: ["claude"],
    startAgent: "claude",
    githubBuilder: governedBuilderBase.githubBuilder,
    runtime: { activeCall: { agent: "claude", status: "running" } },
  });
  const governedBuilderRetry = await reviewRaceClaudeClient.callTool({
    name: "start_collaboration",
    arguments: governedBuilderBase,
  });
  assert.equal(governedBuilderRetry.structuredContent.id, governedBuilderId,
    "an identical builder authority retry must reuse the compatible live lane");
  assert.equal(governedBuilderRetry.structuredContent.resume?.reused, true);
  const changedBuilderLogin = await reviewRaceAntigravityClient.callTool({
    name: "start_collaboration",
    arguments: {
      ...governedBuilderBase,
      githubBuilder: { ...governedBuilderBase.githubBuilder, expectedLogin: "other-builder[bot]" },
    },
  });
  assert.equal(changedBuilderLogin.isError, true,
    "a changed builder login must reach fresh authorization preflight rather than reuse the live lane");
  assert.match(changedBuilderLogin.content?.[0]?.text || "", /Writer hydration|self-contained writer checkout|GitHub-governed implementation/i);
  const implementationBuilderOperations = await reviewRaceAntigravityClient.callTool({
    name: "start_collaboration",
    arguments: {
      ...governedBuilderBase,
      githubBuilder: {
        ...governedBuilderBase.githubBuilder,
        allowedOperations: ["push_branch", "ensure_pull_request"],
      },
    },
  });
  assert.notEqual(implementationBuilderOperations.isError, true,
    "an implement-phase writer must retain its hydrated future publication route without requiring pre-existing verification receipts");
  assert.notEqual(implementationBuilderOperations.structuredContent.id, governedBuilderId,
    "wider implementation authority must not reuse the narrower live lane");
  assert.equal(implementationBuilderOperations.structuredContent.workProfile, "implement");
  await waitForStop(reviewRaceAntigravityClient, implementationBuilderOperations.structuredContent.id);
  const unverifiedDeliveryBuilder = await reviewRaceAntigravityClient.callTool({
    name: "start_collaboration",
    arguments: {
      ...governedBuilderBase,
      task: "Exercise receipt-gated GitHub delivery start.",
      workProfile: "deliver",
      githubBuilder: {
        ...governedBuilderBase.githubBuilder,
        allowedOperations: ["push_branch", "ensure_pull_request"],
      },
    },
  });
  assert.equal(unverifiedDeliveryBuilder.isError, true,
    "a deliver-phase writer must still fail closed without an exact verified head");
  assert.match(unverifiedDeliveryBuilder.content?.[0]?.text || "", /verifiedHeadSha|verification receipts/i);

  // issueClaim is the primary collaboration target, but it must not mask a
  // changed exact-head PR review binding. Seed a live compatible lane, prove an
  // exact retry reaches lookup and reuses it, then prove a changed review head
  // misses lookup and reaches the later claim-identity preflight instead.
  const claimedReviewReuseBase = {
    task: "Exercise claimed exact-head review reuse compatibility.",
    workspace: cleanWorkspace,
    agents: ["claude"],
    startAgent: "claude",
    mode: "review",
    maxTurns: 1,
    handoffPath: ".bridge/test-handoffs/claimed-review-reuse.md",
    issueClaim: {
      repository: "veliqon/collaboration-fixture",
      issueNumber: 98,
      expectedLogin: "other-builder[bot]",
      headSha: claimedHead,
    },
    githubReview: {
      repository: "veliqon/collaboration-fixture",
      prNumber: 251,
      headSha: claimedHead,
      expectedLogins: { claude: "test-builder[bot]" },
    },
  };
  const claimedReviewIdentity = collaborationIdentity({
    ...claimedReviewReuseBase,
    requestedAgents: claimedReviewReuseBase.agents,
  });
  const claimedReviewId = "bridge-24800000-0000-4000-8000-000000000002";
  await createCollaboration(root, {
    id: claimedReviewId,
    identityKey: claimedReviewIdentity,
    task: claimedReviewReuseBase.task,
    workspace: cleanWorkspace,
    status: "running",
    mode: "review",
    agents: ["claude"],
    requestedAgents: ["claude"],
    startAgent: "claude",
    handoffPath: claimedReviewReuseBase.handoffPath,
    issueClaim: claimedReviewReuseBase.issueClaim,
    githubReview: claimedReviewReuseBase.githubReview,
    runtime: { activeCall: { agent: "claude", status: "running" } },
  });
  const claimedReviewRetry = await reviewRaceClaudeClient.callTool({
    name: "start_collaboration",
    arguments: claimedReviewReuseBase,
  });
  assert.equal(claimedReviewRetry.structuredContent.id, claimedReviewId,
    "an identical claimed exact-head review must reuse its compatible live lane");
  assert.equal(claimedReviewRetry.structuredContent.resume?.reused, true);
  const changedClaimedReviewHead = await reviewRaceAntigravityClient.callTool({
    name: "start_collaboration",
    arguments: {
      ...claimedReviewReuseBase,
      githubReview: { ...claimedReviewReuseBase.githubReview, headSha: "f".repeat(40) },
    },
  });
  assert.equal(changedClaimedReviewHead.isError, true,
    "a changed exact review head must miss lookup and run fresh preflight");
  assert.match(changedClaimedReviewHead.content?.[0]?.text || "", /Issue claim builder identity mismatch/i);
  const targetSha = "a".repeat(40);
  const firstHead = "b".repeat(40);
  const plannedPortfolio = await firstClient.callTool({
    name: "plan_portfolio",
    arguments: {
      maxParallel: 2,
      items: [
        { id: "101", issueNumber: 101, title: "First", priority: 10, paths: ["src/first"] },
        { id: "102", issueNumber: 102, title: "Second", priority: 9, blockedBy: ["101"], paths: ["src/second"] },
        { id: "103", title: "Third", priority: 8, paths: ["src/third"] },
      ],
    },
  });
  assert.deepEqual(plannedPortfolio.structuredContent.schedule.selected.map((item) => item.id), ["101", "103"]);
  let portfolio = (await firstClient.callTool({
    name: "create_portfolio",
    arguments: {
      objective: "Deliver independent work safely",
      workspace: ".",
      maxParallel: 2,
      targetBranch: "main",
      targetSha,
      items: [
        { id: "101", issueNumber: 101, title: "First", priority: 10, paths: ["src/first"] },
        { id: "102", issueNumber: 102, title: "Second", priority: 9, blockedBy: ["101"], paths: ["src/second"] },
      ],
    },
  })).structuredContent;
  assert.match(portfolio.id, /^helm-/);
  assert.equal(portfolio.repository, "normcrandall/local-agent-bridge", "create_portfolio must derive one stable GitHub repository identity from the workspace remote");
  portfolio = (await firstClient.callTool({
    name: "update_portfolio_item",
    arguments: {
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      itemId: "102",
      status: "ready",
      triageStatus: "triaged",
    },
  })).structuredContent;
  assert.equal(portfolio.items.find((item) => item.id === "102").triageStatus, "triaged", "triage-ahead completion must be writable through the control plane");
  const timingLane = await createCollaboration(root, {
    task: "Track the complete portfolio merge path",
    workspace: root,
    agents: ["claude"],
    status: "agreed",
    runtime: { turnCount: 1 },
  });
  portfolio = (await firstClient.callTool({
    name: "update_portfolio_item",
    arguments: {
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      itemId: "101",
      status: "implementing",
      writer: "claude",
      collaborationId: timingLane.id,
    },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "enqueue_portfolio_merge",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", prNumber: 11, headSha: firstHead, priority: 10 },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "begin_portfolio_merge_validation",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead },
  })).structuredContent;
  portfolio = (await firstClient.callTool({
    name: "record_portfolio_merge_validation",
    arguments: { portfolioId: portfolio.id, expectedRevision: portfolio.revision, itemId: "101", outcome: "passed", checks: ["npm test"] },
  })).structuredContent;
  const mergeAuthorizationResult = await firstClient.callTool({
    name: "authorize_portfolio_merge",
    arguments: { portfolioId: portfolio.id, itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead },
  });
  assert.equal(mergeAuthorizationResult.structuredContent.authorization.authorized, true);
  await recordMergeDeliveryReceipt(resolve(stateDirectory, "merge-receipts"), {
    repository: portfolio.repository,
    issueNumber: 101,
    prNumber: 11,
    approvedHeadSha: firstHead,
    mergedSha: "c".repeat(40),
    issueRecording: { status: "recorded", commentUrl: "https://github.com/normcrandall/local-agent-bridge/issues/101#issuecomment-1" },
  });
  const recordedMerge = await firstClient.callTool({
    name: "record_portfolio_merge",
    arguments: {
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      itemId: "101",
      expectedTargetSha: targetSha,
      expectedHeadSha: firstHead,
      mergedSha: "c".repeat(40),
    },
  });
  assert.notEqual(recordedMerge.isError, true, recordedMerge.content?.[0]?.text || "record_portfolio_merge failed");
  portfolio = recordedMerge.structuredContent;
  assert.equal(portfolio.items.find((item) => item.id === "101").status, "merged");
  assert.equal(portfolio.schedule.selected[0].id, "102");
  const timedMergeLane = (await firstClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: timingLane.id, detail: "full", includeTurns: 0 },
  })).structuredContent;
  for (const span of ["merge_coordinator_wait", "merge_ci_validation", "merge_policy_wait", "github_merge_execution"]) {
    assert.ok(timedMergeLane.performanceSummary.byName[span], `portfolio merge timing must include ${span}`);
  }

  const failedLaneId = "bridge-00000000-0000-4000-8000-000000000040";
  let failedLanePortfolio = (await firstClient.callTool({
    name: "create_portfolio",
    arguments: {
      objective: "Do not park on a success-only signal",
      workspace: ".",
      maxParallel: 1,
      targetBranch: "main",
      targetSha,
      items: [{ id: "40", title: "Rework", priority: 10, paths: ["src/rework"] }],
    },
  })).structuredContent;
  failedLanePortfolio = (await firstClient.callTool({
    name: "update_portfolio_item",
    arguments: {
      portfolioId: failedLanePortfolio.id,
      expectedRevision: failedLanePortfolio.revision,
      itemId: "40",
      status: "repairing",
      writer: "antigravity",
      collaborationId: failedLaneId,
      headSha: "d".repeat(40),
    },
  })).structuredContent;
  await writeFile(join(stateDirectory, `${failedLaneId}.json`), `${JSON.stringify({
    id: failedLaneId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    status: "failed",
    task: "Repair lane #40",
    workspace: root,
    agents: ["antigravity"],
    error: "No requested model is currently available.",
    runtime: {
      turnCount: 0,
      availableAgents: [],
      unavailableAgents: { antigravity: "Model unavailable." },
    },
  })}\n`);
  const failedLane = await firstClient.callTool({
    name: "wait_for_portfolio_lane",
    arguments: {
      portfolioId: failedLanePortfolio.id,
      itemId: "40",
      expectedHeadSha: "d".repeat(40),
      waitSeconds: 0,
    },
  });
  assert.equal(failedLane.structuredContent.outcome, "lane_stopped");
  assert.equal(failedLane.structuredContent.nextAction, "reassign_writer");
  assert.equal(failedLane.structuredContent.collaboration.status, "failed");
  assert.match(failedLane.structuredContent.reason, /No requested model/);
  assert.equal(failedLane.structuredContent.item.status, "failed");

  const reconciledTerminal = await firstClient.callTool({
    name: "get_collaboration", arguments: { collaborationId: terminalReconcileId, detail: "full", includeTurns: 0 },
  });
  assert.equal(reconciledTerminal.structuredContent.runtime.activeCall, null);
  assert.equal(reconciledTerminal.structuredContent.workerPid, null);

  const unsafeAutonomousDelivery = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Reject delivery without a bound builder",
      agents: ["claude"],
      mode: "work",
      writer: "claude",
      workProfile: "deliver",
      maxTurns: 1,
    },
  });
  assert.equal(unsafeAutonomousDelivery.isError, true);
  assert.match(
    unsafeAutonomousDelivery.content?.[0]?.text || "",
    /Autonomous delivery requires a bound githubBuilder/,
  );

  const integrityContext = buildClaimedIssueContext({
    repository: "normcrandall/local-agent-bridge",
    issueNumber: 99,
    issue: { title: "Integrity fixture", body: "Original acceptance.", labels: [] },
    comments: [],
    capturedAt: "2026-07-26T00:00:00Z",
  });
  const tamperedTask = `Implement issue #99.\n\n${integrityContext.text.replace("Original acceptance.", "Modified acceptance.")}`;
  const tamperedCollaboration = await createCollaboration(root, {
    task: tamperedTask,
    taskBase: tamperedTask,
    issueContext: integrityContext.metadata,
    workspace: cleanWorkspace,
    agents: ["claude"],
    mode: "review",
    status: "turn_limit",
    runtime: { turnCount: 1, activeCall: null },
  });
  const rejectedTamperedContinuation = await firstClient.callTool({
    name: "continue_collaboration",
    arguments: {
      collaborationId: tamperedCollaboration.id,
      message: "This must fail before provider continuation.",
      additionalTurns: 1,
    },
  });
  assert.equal(rejectedTamperedContinuation.isError, true);
  assert.match(rejectedTamperedContinuation.content?.[0]?.text || "", /Claimed issue context sha256 mismatch/);

  const missingIntegrityMetadata = await createCollaboration(root, {
    task: `Implement issue #99.\n\n${integrityContext.text}`,
    taskBase: `Implement issue #99.\n\n${integrityContext.text}`,
    issueTarget: { repository: "normcrandall/local-agent-bridge", issueNumber: 99 },
    workspace: cleanWorkspace,
    agents: ["claude"],
    mode: "review",
    status: "turn_limit",
    runtime: { turnCount: 0, activeCall: null },
  });
  const rejectedMissingMetadata = await firstClient.callTool({
    name: "continue_collaboration",
    arguments: {
      collaborationId: missingIntegrityMetadata.id,
      message: "This must also fail before provider continuation.",
      additionalTurns: 1,
    },
  });
  assert.equal(rejectedMissingMetadata.isError, true);
  assert.match(rejectedMissingMetadata.content?.[0]?.text || "", /integrity metadata is missing/);

  const tamperedWorkerCollaboration = await createCollaboration(root, {
    task: tamperedTask,
    taskBase: tamperedTask,
    issueContext: integrityContext.metadata,
    workspace: cleanWorkspace,
    agents: ["claude"],
    startAgent: "claude",
    mode: "review",
    status: "queued",
    runtime: {
      sessions: { claude: null },
      turnCount: 0,
      activeCall: null,
      availableAgents: ["claude"],
      unavailableAgents: {},
    },
  });
  const rejectedTamperedWorker = spawnSync(
    process.execPath,
    [resolve(root, "scripts/collaboration-worker.mjs"), tamperedWorkerCollaboration.id],
    {
      cwd: root,
      env: {
        ...env,
        BRIDGE_RUNTIME_ROOT: root,
        BRIDGE_WORKSPACE_ROOT: root,
        BRIDGE_COLLABORATION_DIR: stateDirectory,
      },
      encoding: "utf8",
    },
  );
  assert.equal(rejectedTamperedWorker.status, 1, "direct worker launch must fail before provider dispatch");
  const failedTamperedWorker = await readCollaboration(root, tamperedWorkerCollaboration.id);
  assert.equal(failedTamperedWorker.status, "failed");
  assert.match(failedTamperedWorker.error, /Claimed issue context sha256 mismatch/);
  assert.equal(failedTamperedWorker.runtime.turnCount, 0, "integrity rejection must happen before a provider turn");

  const unbornStarted = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review a freshly initialized repository before its first commit",
      workspace: unbornWorkspace,
      agents: ["claude"],
      maxTurns: 1,
      verificationCommands: ["npm test"],
      deliveryProfile: "local-only",
    },
  });
  assert.notEqual(unbornStarted.isError, true);
  assert.equal(unbornStarted.structuredContent.evidence.repository, null);
  assert.deepEqual(unbornStarted.structuredContent.verificationCommands, ["npm test"]);
  const unbornFirstRun = await waitForStop(firstClient, unbornStarted.structuredContent.id);
  assert.equal(unbornFirstRun.status, "turn_limit", unbornFirstRun.error || "unborn repository first run failed");
  const unbornContinued = await firstClient.callTool({
    name: "continue_collaboration",
    arguments: {
      collaborationId: unbornStarted.structuredContent.id,
      message: "Continue without exact-head evidence until the first commit exists.",
      additionalTurns: 1,
    },
  });
  assert.notEqual(unbornContinued.isError, true);
  assert.equal(unbornContinued.structuredContent.evidence.repository, null);
  assert.deepEqual(unbornContinued.structuredContent.verificationCommands, ["npm test"]);
  const unbornSecondRun = await waitForStop(firstClient, unbornStarted.structuredContent.id);
  assert.equal(unbornSecondRun.status, "turn_limit", unbornSecondRun.error || "unborn repository continuation failed");

  const started = await firstClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Verify portable collaboration state",
      workspace: cleanWorkspace,
      agents: ["claude"],
      maxTurns: 2,
      modelFallbacks: { claude: ["claude-opus-4-6", "claude-sonnet-5"], codex: ["5.6 terra"] },
      providerFailover: { enabled: false, agents: ["claude"] },
      allowClaudeFable: true,
      verificationCommands: ["npm test"],
      handoffPath: ".bridge/test-handoffs/collaboration-review.md",
      deliveryProfile: "local-only",
    },
  });
  assert.notEqual(started.isError, true);
  const initialEvidenceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: cleanWorkspace, encoding: "utf8" }).stdout.trim();
  const id = started.structuredContent.id;
  assert.match(id, /^bridge-[0-9a-f-]{36}$/);
  await firstClient.close();
  firstClient = null;

  secondClient = await connect("collaboration-test-app-two");
  const firstRun = await waitForStop(secondClient, id);
  assert.equal(firstRun.status, "turn_limit", firstRun.error || "first run failed");
  assert.equal(firstRun.runtime.turnCount, 2);
  assert.equal(firstRun.turns.length, 2);
  assert.deepEqual(firstRun.modelFallbacks, {
    claude: ["claude-opus-4-6", "claude-sonnet-5"],
    codex: ["5.6 terra"],
  });
  assert.equal(firstRun.allowClaudeFable, true);
  assert.deepEqual(firstRun.providerFailover, { enabled: false, agents: ["claude"] });
  assert.match(firstRun.turns[0].message, /--fallback-model/);
  assert.match(firstRun.turns[0].message, /claude-opus-4-6,claude-sonnet-5/);
  assert.match(firstRun.turns[0].message, /Bash\(npm test\)/);
  assert.match(firstRun.turns[0].message, /collaboration-review\.md/);

  receiptClient = await connect("collaboration-test-observed-receipt", { FAKE_CLAUDE_TOOL_EVENT: "1" });
  const receiptStarted = await receiptClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Capture exact-command review evidence",
      workspace: cleanWorkspace,
      agents: ["claude"],
      mode: "review",
      maxTurns: 1,
      verificationCommands: ["npm test"],
    },
  });
  const receiptRun = await waitForStop(receiptClient, receiptStarted.structuredContent.id);
  assert.equal(receiptRun.verificationReceipts.length, 1);
  assert.equal(receiptRun.verificationReceipts[0].command, "npm test");
  assert.equal(receiptRun.verificationReceipts[0].source, "claude");
  assert.equal(receiptRun.verificationReceipts[0].attestation, "observed");
  const receiptEvents = (await readFile(join(stateDirectory, `${receiptRun.id}.jsonl`), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(receiptEvents.some((event) => event.type === "verification_receipt_recorded"));

  completionClient = await connect("collaboration-test-completion", { FAKE_CLAUDE_HANDOFF: "1" });
  const completionStarted = await completionClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Return a durable completion receipt",
      agents: ["claude"],
      maxTurns: 1,
    },
  });
  const completionRun = await waitForStop(completionClient, completionStarted.structuredContent.id);
  assert.equal(completionRun.status, "agreed");
  assert.equal(completionRun.completion.phase, "awaiting_chair_verification");
  assert.equal(completionRun.completion.sequence, 1);
  assert.equal(completionRun.completion.acknowledged, false);
  assert.equal(completionRun.completion.lastHandoff.outcome, "completed");
  const completionCompact = await completionClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: completionRun.id, detail: "status", includeTurns: 0 },
  });
  assert.equal(completionCompact.structuredContent.completion.nextAction, "chair_verify");
  const prematureContinue = await completionClient.callTool({
    name: "continue_collaboration",
    arguments: { collaborationId: completionRun.id, message: "Continue without verifying", additionalTurns: 1 },
  });
  assert.equal(prematureContinue.isError, true);
  assert.match(prematureContinue.content.map((item) => item.text || "").join("\n"), /unacknowledged HANDOFF sequence 1/);
  const acknowledged = await completionClient.callTool({
    name: "acknowledge_handoff",
    arguments: {
      collaborationId: completionRun.id,
      sequence: 1,
      accepted: true,
      summary: "Chair verified the handoff.",
      verification: ["npm test: passed independently"],
      remaining: [],
    },
  });
  assert.equal(acknowledged.structuredContent.completion.phase, "verified_complete");
  assert.equal(acknowledged.structuredContent.completion.acknowledged, true);

  const chaired = await secondClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review work owned by the native Codex chair",
      agents: ["codex", "claude"],
      startAgent: "codex",
      chair: { provider: "codex", sessionId: "native-thread-1", workspace: root },
      maxTurns: 1,
      deliveryProfile: "local-only",
    },
  });
  assert.notEqual(chaired.isError, true);
  assert.deepEqual(chaired.structuredContent.agents, ["claude"]);
  assert.equal(chaired.structuredContent.chair.source, "native-chair");
  const chairedDone = await waitForStop(secondClient, chaired.structuredContent.id);
  assert.equal(chairedDone.status, "turn_limit");
  const prematureNativeReceipt = await secondClient.callTool({
    name: "record_native_chair_turn",
    arguments: { collaborationId: chairedDone.id, summary: "Must wait for wake acknowledgement.", artifacts: [], verification: [] },
  });
  assert.equal(prematureNativeReceipt.isError, true);
  assert.match(prematureNativeReceipt.content.map((item) => item.text || "").join("\n"), /unacknowledged coordinator wake 1/);
  await acknowledgeWake(secondClient, chairedDone, "Codex received the peer review completion.");
  const nativeReceipt = await secondClient.callTool({
    name: "record_native_chair_turn",
    arguments: { collaborationId: chairedDone.id, summary: "Codex implemented locally.", artifacts: ["src/example.mjs"], verification: ["tests passed"] },
  });
  assert.equal(nativeReceipt.structuredContent.receipt.source, "native-chair");
  const protectedDecision = await secondClient.callTool({
    name: "record_decision",
    arguments: {
      collaborationId: chairedDone.id,
      question: "May the workflow spend money?",
      category: "money",
      owner: "user",
    },
  });
  assert.equal(protectedDecision.structuredContent.status, "needs_user");
  const protectedView = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: chairedDone.id, detail: "full", includeTurns: 0 },
  });
  assert.equal(protectedView.structuredContent.coordinatorWake.sequence, 2);
  assert.equal(protectedView.structuredContent.coordinatorWake.actionable, false);
  const resumedAfterUser = await secondClient.callTool({
    name: "continue_collaboration",
    arguments: { collaborationId: chairedDone.id, message: "The user declined the spend; continue without it.", additionalTurns: 1 },
  });
  assert.notEqual(resumedAfterUser.isError, true);
  assert.equal(resumedAfterUser.structuredContent.coordinatorWake.sequence, 2);
  assert.equal(resumedAfterUser.structuredContent.coordinatorWake.status, "acknowledged");
  await secondClient.callTool({ name: "cancel_collaboration", arguments: { collaborationId: chairedDone.id } });
  const archivedChair = await secondClient.callTool({ name: "archive_collaboration", arguments: { collaborationId: chairedDone.id } });
  assert.equal(archivedChair.structuredContent.archived, true);
  const rotatedNative = await secondClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review task zero after the native Codex chair implements it",
      agents: ["codex", "claude"], taskNumber: 0, mode: "work",
      chair: { provider: "codex", sessionId: "native-thread-2", workspace: root },
      maxTurns: 1,
      deliveryProfile: "local-only",
    },
  });
  assert.notEqual(rotatedNative.isError, true);
  assert.equal(rotatedNative.structuredContent.chairOwnsWork, true);
  assert.equal(rotatedNative.structuredContent.mode, "review");
  assert.equal(rotatedNative.structuredContent.rotation.writer, "codex");
  await waitForStop(secondClient, rotatedNative.structuredContent.id);

  const compactPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id },
  });
  assert.deepEqual(compactPoll.structuredContent.turns, []);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "task"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "requestedVerificationCommands"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "verificationCommands"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "performance"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent, "verificationReceipts"), false);
  assert.equal(Object.hasOwn(compactPoll.structuredContent.evidence.repository, "changedFiles"), false);
  assert.equal(compactPoll.structuredContent.evidence.estimatedAvoidedMs, 0);
  assert.ok(compactPoll.structuredContent.performanceSummary);
  assert.doesNotMatch(compactPoll.content[0].text, /Latest turn/);

  const zeroTurnPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id, detail: "full", includeTurns: 0 },
  });
  assert.deepEqual(zeroTurnPoll.structuredContent.turns, []);
  assert.match(zeroTurnPoll.structuredContent.task, /portable collaboration state/);

  const incrementalPoll = await secondClient.callTool({
    name: "get_collaboration",
    arguments: { collaborationId: id, detail: "full", includeTurns: 20, afterTurn: 1 },
  });
  assert.deepEqual(incrementalPoll.structuredContent.turns.map((turn) => turn.number), [2]);

  const verificationReceipt = await secondClient.callTool({
    name: "record_verification_receipt",
    arguments: {
      collaborationId: id,
      command: "npm test",
      exitCode: 0,
      startedAt: "2026-07-22T12:00:00.000Z",
      completedAt: "2026-07-22T12:00:05.000Z",
      source: "chair",
      attestation: "authoritative",
      outputDigest: "a".repeat(64),
      outputSummary: "Offline fixture gate passed.",
    },
  });
  assert.notEqual(verificationReceipt.isError, true, "a clean exact-head gate may mint a reusable receipt");
  assert.equal(verificationReceipt.structuredContent.receipt.command, "npm test");

  const continued = await secondClient.callTool({
    name: "continue_collaboration",
    arguments: {
      collaborationId: id,
      message: "Continue from this second app with the same collaboration.",
      additionalTurns: 2,
      modelFallbacks: { codex: ["5.6 base"] },
    },
  });
  assert.notEqual(continued.isError, true);
  assert.equal(continued.structuredContent.cleanup, null);
  const secondRun = await waitForStop(secondClient, id);
  assert.equal(secondRun.status, "turn_limit", secondRun.error || "second run failed");
  assert.equal(secondRun.runtime.turnCount, 4);
  assert.equal(secondRun.turns.length, 4);
  assert.deepEqual(secondRun.modelFallbacks, {
    claude: ["claude-opus-4-6", "claude-sonnet-5"],
    codex: ["5.6 base"],
  });
  assert.equal(secondRun.allowClaudeFable, false, "Fable authorization must not survive collaboration continuation");
  assert.deepEqual(secondRun.providerFailover, { enabled: false, agents: ["claude"] });
  assert.match(secondRun.turns[2].message, /Continue from this second app/);
  assert.match(secondRun.turns[2].message, /Bash\(npm test\)/, "Claude must retain narrow permission to challenge and rerun a reused receipt");
  assert.match(secondRun.turns[2].message, /Broker-attested verification receipts reused/);
  assert.equal(secondRun.evidence.avoidedCommands, 1);
  assert.deepEqual(secondRun.verificationCommands, []);
  assert.match(secondRun.task, /Broker-attested verification receipts reused/);
  assert.doesNotMatch(secondRun.taskBase, /Broker-cached exact-head evidence/);
  assert.match(secondRun.turns[2].message, /collaboration-review\.md/);

  await writeFile(join(cleanWorkspace, "SECOND.md"), "# New exact head\n");
  for (const args of [["add", "SECOND.md"], ["commit", "-qm", "advance fixture"]]) {
    const result = spawnSync("git", args, { cwd: cleanWorkspace, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Unable to advance collaboration fixture: ${result.stderr || result.stdout}`);
  }
  const advancedEvidenceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: cleanWorkspace, encoding: "utf8" }).stdout.trim();
  assert.notEqual(advancedEvidenceHead, initialEvidenceHead);
  const refreshedContinuation = await secondClient.callTool({
    name: "continue_collaboration",
    arguments: { collaborationId: id, message: "Refresh after the checked-out head advanced.", additionalTurns: 1 },
  });
  assert.notEqual(refreshedContinuation.isError, true);
  const refreshedRun = await waitForStop(secondClient, id);
  assert.equal(refreshedRun.runtime.turnCount, 5);
  assert.match(refreshedRun.task, new RegExp(advancedEvidenceHead));
  assert.doesNotMatch(refreshedRun.task, new RegExp(initialEvidenceHead), "continuation task must replace stale exact-head evidence");
  assert.equal(refreshedRun.evidence.avoidedCommands, 0, "an old-head receipt must not suppress a new-head gate");
  assert.deepEqual(refreshedRun.verificationCommands, ["npm test"]);

  const listed = await secondClient.callTool({ name: "list_collaborations", arguments: {} });
  assert.equal(listed.structuredContent.collaborations[0].id, id);
  const cancelled = await secondClient.callTool({
    name: "cancel_collaboration",
    arguments: { collaborationId: id },
  });
  assert.equal(cancelled.structuredContent.status, "cancelled");

  nestedClient = await connect("collaboration-test-nested", { BRIDGE_DELEGATED_SESSION: "1" });
  const nested = await nestedClient.callTool({
    name: "start_collaboration",
    arguments: { task: "must be blocked", agents: ["claude", "antigravity"] },
  });
  assert.equal(nested.isError, true);
  assert.match(JSON.stringify(nested.content), /Nested collaboration mutation blocked/);

  fallbackClient = await connect("collaboration-test-fallback", {
    AGY_BIN: "/usr/bin/false",
  });
  const fallbackStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Proceed with Claude when Antigravity is unavailable",
      agents: ["claude", "antigravity"],
      maxTurns: 2,
    },
  });
  assert.notEqual(fallbackStarted.isError, true);
  const fallbackRun = await waitForStop(fallbackClient, fallbackStarted.structuredContent.id);
  assert.equal(fallbackRun.status, "turn_limit", fallbackRun.error || "fallback run failed");
  assert.deepEqual(fallbackRun.runtime.availableAgents, ["claude"]);
  assert.match(fallbackRun.runtime.unavailableAgents.antigravity, /exited|failed/i);
  assert.deepEqual(fallbackRun.turns.map((turn) => turn.agent), ["claude", "claude"]);

  const writerFailoverStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Continue the work lane with the next eligible writer",
      workspace: cleanWorkspace,
      agents: ["antigravity", "claude"],
      startAgent: "antigravity",
      writer: "antigravity",
      mode: "work",
      deliveryProfile: "local-only",
      workProfile: "implement",
      maxTurns: 1,
    },
  });
  const writerFailoverRun = await waitForStop(fallbackClient, writerFailoverStarted.structuredContent.id);
  assert.equal(writerFailoverRun.runtime.writer, "claude");
  assert.deepEqual(writerFailoverRun.turns.map((turn) => turn.agent), ["claude"]);
  assert.match(writerFailoverRun.runtime.unavailableAgents.antigravity, /exited|failed/i);
  assert.equal(writerFailoverRun.providerFailoverState.status, "transferred");
  assert.deepEqual(
    {
      from: writerFailoverRun.providerFailoverState.lastTransition.from,
      to: writerFailoverRun.providerFailoverState.lastTransition.to,
      phase: writerFailoverRun.providerFailoverState.lastTransition.phase,
    },
    { from: "antigravity", to: "claude", phase: "turn" },
  );

  recoveryClient = await connect("collaboration-test-provider-recovery", {
    AGY_BIN: resolve(root, "scripts/fake-antigravity.mjs"),
    FAKE_ANTIGRAVITY_OVERLOAD_MODELS: "provider-configured model",
  });
  const recoveryStarted = await recoveryClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Recover automatically when the only requested provider is temporarily unavailable",
      agents: ["antigravity"],
      maxTurns: 1,
      modelFallbacks: { antigravity: [] },
      providerRecovery: { enabled: true, maxAttempts: 1, backoffSeconds: [1] },
    },
  });
  const recoveryRun = await waitForStop(recoveryClient, recoveryStarted.structuredContent.id);
  assert.equal(recoveryRun.status, "failed");
  assert.equal(recoveryRun.providerRecoveryState.attempts, 1);
  assert.equal(recoveryRun.providerRecoveryState.status, "exhausted");
  assert.match(recoveryRun.error, /All requested providers failed/);
  assert.match(recoveryRun.error, /transient_capacity/);

  mixedFailureClient = await connect("collaboration-test-mixed-provider-failure", {
    CLAUDE_BIN: "/usr/bin/false",
    AGY_BIN: resolve(root, "scripts/fake-antigravity.mjs"),
    FAKE_ANTIGRAVITY_OVERLOAD_MODELS: "provider-configured model",
  });
  const mixedFailureStarted = await mixedFailureClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Do not convert a mixed provider failure into a capacity recovery loop",
      agents: ["claude", "antigravity"],
      maxTurns: 1,
      modelFallbacks: { antigravity: [] },
      providerRecovery: { enabled: true, maxAttempts: 2, backoffSeconds: [1] },
    },
  });
  const mixedFailureRun = await waitForStop(mixedFailureClient, mixedFailureStarted.structuredContent.id);
  assert.equal(mixedFailureRun.status, "failed");
  assert.equal(mixedFailureRun.providerRecoveryState.attempts, 0);
  assert.notEqual(mixedFailureRun.providerRecoveryState.status, "exhausted");
  assert.match(mixedFailureRun.error, /Claude Code \((?:transport|provider_failure)\)/);
  assert.match(mixedFailureRun.error, /Antigravity \(transient_capacity\)/);

  const singleTurnStarted = await fallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Run exactly one bounded peer handoff",
      agents: ["claude"],
      maxTurns: 1,
    },
  });
  assert.notEqual(singleTurnStarted.isError, true);
  const singleTurnRun = await waitForStop(fallbackClient, singleTurnStarted.structuredContent.id);
  assert.equal(singleTurnRun.status, "turn_limit", singleTurnRun.error || "single-turn run failed");
  assert.equal(singleTurnRun.runtime.turnCount, 1);
  assert.equal(singleTurnRun.turns.length, 1);

  codexFallbackClient = await connect("collaboration-test-codex-model-fallback", {
    CODEX_BRIDGE_CODEX_BIN: fakeCodex,
    BRIDGE_CODEX_HOME: join(stateDirectory, "codex-home"),
    FAKE_CODEX_OVERLOAD_MODELS: "5.6 sol",
  });
  const codexFallbackStarted = await codexFallbackClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Finish the Codex turn after a model overload",
      agents: ["codex"],
      maxTurns: 1,
      models: { codex: "5.6 sol" },
      modelFallbacks: { codex: ["5.6 terra"] },
    },
  });
  assert.notEqual(codexFallbackStarted.isError, true);
  const codexFallbackRun = await waitForStop(codexFallbackClient, codexFallbackStarted.structuredContent.id);
  assert.equal(codexFallbackRun.status, "turn_limit", codexFallbackRun.error || "Codex fallback run failed");
  assert.equal(codexFallbackRun.runtime.turnCount, 1);
  assert.deepEqual(codexFallbackRun.turns[0].metadata.modelRouting, {
    requestedModel: "5.6 sol",
    model: "5.6 terra",
    fallbackUsed: true,
    attemptedModels: ["5.6 sol", "5.6 terra"],
    fallbackModels: ["5.6 terra"],
    fallbackManagedBy: "bridge",
  });

  heartbeatClient = await connect("collaboration-test-heartbeat", { FAKE_CLAUDE_DELAY_MS: "1200" });
  const heartbeatStarted = await heartbeatClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Expose provider-authored progress while work is active",
      agents: ["claude", "antigravity"],
      startAgent: "claude",
      maxTurns: 2,
    },
  });
  const heartbeatId = heartbeatStarted.structuredContent.id;
  let activeView;
  const activeDeadline = Date.now() + 5_000;
  while (Date.now() < activeDeadline) {
    const activeResult = await heartbeatClient.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: heartbeatId, includeTurns: 2 },
    });
    activeView = activeResult.structuredContent;
    if (activeView.runtime?.activeCall?.summary?.includes("Inspecting the requested files")) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(activeView.runtime.activeCall.agent, "claude");
  assert.equal(activeView.runtime.activeCall.status, "running");
  assert.match(activeView.runtime.activeCall.summary, /Inspecting the requested files/);
  assert.ok(activeView.runtime.activeCall.heartbeatAt);
  const heartbeatRun = await waitForStop(heartbeatClient, heartbeatId);
  assert.ok(["agreed", "turn_limit"].includes(heartbeatRun.status), heartbeatRun.error || "heartbeat run failed");

  capacityClient = await connect("collaboration-test-provider-capacity", { FAKE_CLAUDE_DELAY_MS: "2000" });
  const capacityStarts = await Promise.all([1, 2, 3].map((number) => capacityClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: `Parallel read-only review ${number}`,
      agents: ["claude"],
      maxTurns: 1,
      providerConcurrency: { claude: { work: 1, review: 2 } },
    },
  })));
  const capacityIds = capacityStarts.map((result) => result.structuredContent.id);
  let capacityViews = [];
  const capacityDeadline = Date.now() + 5_000;
  while (Date.now() < capacityDeadline) {
    capacityViews = await Promise.all(capacityIds.map(async (collaborationId) => {
      const result = await capacityClient.callTool({
        name: "get_collaboration",
        arguments: { collaborationId, detail: "full", includeTurns: 0 },
      });
      return result.structuredContent;
    }));
    const leased = capacityViews.filter((view) => view.runtime?.activeCall?.capacity?.slot);
    const waiting = capacityViews.filter((view) => view.runtime?.activeCall?.phase === "waiting_capacity");
    if (leased.length === 2 && waiting.length === 1) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.equal(
    capacityViews.filter((view) => view.runtime?.activeCall?.capacity?.slot).length,
    2,
    JSON.stringify(capacityViews.map((view) => ({
      status: view.status,
      error: view.error,
      activeCall: view.runtime?.activeCall,
    })), null, 2),
  );
  assert.equal(capacityViews.filter((view) => view.runtime?.activeCall?.phase === "waiting_capacity").length, 1);
  const capacityRuns = await Promise.all(capacityIds.map((collaborationId) => waitForStop(
    capacityClient,
    collaborationId,
    10_000,
  )));
  assert.ok(capacityRuns.every((view) => view.runtime.turnCount === 1));

  cancellationClient = await connect("collaboration-test-active-cancellation", { FAKE_CLAUDE_DELAY_MS: "10000" });
  const cancellationStarted = await cancellationClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Cancel an active provider process",
      agents: ["claude", "antigravity"],
      startAgent: "claude",
      maxTurns: 2,
    },
  });
  const cancellationId = cancellationStarted.structuredContent.id;
  const cancellationDeadline = Date.now() + 5_000;
  let cancellationView;
  while (Date.now() < cancellationDeadline) {
    const result = await cancellationClient.callTool({
      name: "get_collaboration",
      arguments: { collaborationId: cancellationId, includeTurns: 2 },
    });
    cancellationView = result.structuredContent;
    if (cancellationView.runtime?.activeCall) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(cancellationView.runtime.activeCall.agent, "claude");
  const activeCancellation = await cancellationClient.callTool({
    name: "cancel_collaboration",
    arguments: { collaborationId: cancellationId },
  });
  assert.equal(activeCancellation.structuredContent.status, "cancelled");
  assert.equal(activeCancellation.structuredContent.workerPid, null);
  assert.equal(activeCancellation.structuredContent.runtime.activeCall, null);

  // Issue #55: integration through the real start/worker path. A review whose only
  // verification gate re-enters the same live provider-capacity pool must terminate with
  // a typed provider_self_deadlock event BEFORE any provider work call, registering no
  // waiter or slot. Uses the offline fake-claude harness; no real provider is invoked.
  const selfDeadlockStarted = await secondClient.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Review with a self-referential provider-capacity gate",
      agents: ["claude"],
      startAgent: "claude",
      mode: "review",
      maxTurns: 2,
      verificationCommands: ["npm run test:provider-concurrency"],
      handoffPath: ".bridge/test-handoffs/self-deadlock-review.md",
    },
  });
  const selfDeadlockId = selfDeadlockStarted.structuredContent.id;
  const selfDeadlockRun = await waitForStop(secondClient, selfDeadlockId);
  assert.equal(selfDeadlockRun.status, "failed", selfDeadlockRun.error || "expected self-deadlock failure");
  assert.equal(selfDeadlockRun.turns.length, 0, "no provider turn may occur before the guard");
  const selfDeadlockEvents = (await readFile(join(stateDirectory, `${selfDeadlockId}.jsonl`), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const deadlockEvent = selfDeadlockEvents.find((event) => event.type === "provider_self_deadlock");
  assert.ok(deadlockEvent, "a typed provider_self_deadlock event must be recorded");
  assert.equal(deadlockEvent.code, "provider_self_deadlock");
  assert.equal(deadlockEvent.agent, "claude");
  assert.ok(
    !selfDeadlockEvents.some((event) => event.type === "agent_started"),
    "no provider client/work call may launch before the self-deadlock guard",
  );
  const selfDeadlockCapacityDir = join(stateDirectory, "capacity", "claude", "review");
  let selfDeadlockCapacityNames = [];
  try { selfDeadlockCapacityNames = await readdir(selfDeadlockCapacityDir); } catch { selfDeadlockCapacityNames = []; }
  for (const name of selfDeadlockCapacityNames) {
    if (!name.endsWith(".wait") && !name.endsWith(".slot")) continue;
    const entry = JSON.parse(await readFile(join(selfDeadlockCapacityDir, name), "utf8"));
    assert.notEqual(entry.collaborationId, selfDeadlockId, "no waiter/slot may reference the self-deadlocked collaboration");
  }
  console.log("Issue #55 worker self-deadlock integration test passed.");

  const cpTestResult = spawnSync(process.execPath, [resolve(root, "scripts/collaboration-control-plane-test.mjs")], { stdio: "inherit" });
  assert.equal(cpTestResult.status, 0, "Control plane unit tests failed");

  console.log("Persistent collaboration and unavailable-provider fallback tests passed without invoking any model.");
} finally {
  await firstClient?.close().catch(() => {});
  await secondClient?.close().catch(() => {});
  await nestedClient?.close().catch(() => {});
  await fallbackClient?.close().catch(() => {});
  await heartbeatClient?.close().catch(() => {});
  await cancellationClient?.close().catch(() => {});
  await codexFallbackClient?.close().catch(() => {});
  await completionClient?.close().catch(() => {});
  await receiptClient?.close().catch(() => {});
  await capacityClient?.close().catch(() => {});
  await recoveryClient?.close().catch(() => {});
  await mixedFailureClient?.close().catch(() => {});
  await reviewRaceClaudeClient?.close().catch(() => {});
  await reviewRaceAntigravityClient?.close().catch(() => {});
  await new Promise((resolvePromise) => githubServer.close(resolvePromise));
  try {
    const supervisor = JSON.parse(await readFile(join(stateDirectory, "supervisor.json"), "utf8"));
    process.kill(supervisor.pid, "SIGTERM");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      let alive = false;
      try {
        process.kill(supervisor.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === "EPERM";
      }
      if (!alive) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  } catch {}
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(cleanWorkspace, { recursive: true, force: true });
  await rm(unbornWorkspace, { recursive: true, force: true });
  await rm(resolve(root, ".bridge/test-handoffs"), { recursive: true, force: true });
}

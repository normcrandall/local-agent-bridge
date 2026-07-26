import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hydrateClaimedIssueTask } from "../src/claimed-issue-context.mjs";
import { createEvidenceStore } from "../src/evidence-store.mjs";
import { createProductionGitHubLifecycleAdapter } from "../src/github-lifecycle.mjs";
import { reconcilePublishedReview } from "../src/github-review-workflow.mjs";
import { captureRepositoryEvidence } from "../src/repository-evidence.mjs";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import { createRepositorySnapshotCache } from "../src/repository-snapshot-cache.mjs";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "agent-bridge-snapshot-integration-"));
const repository = "owner/repo";
const headSha = "a".repeat(40);
let nowMs = Date.parse("2026-07-26T12:00:00.000Z");
const now = () => new Date(nowMs).toISOString();

try {
  const snapshotCache = createRepositorySnapshotCache({
    journal: createRepositoryJournal({ directory: join(root, "journal"), now }),
    now,
    defaultFreshnessMs: 60_000,
  });
  let issueLoads = 0;
  const issueClient = {
    async getIssue() {
      issueLoads += 1;
      return {
        number: 232,
        title: "Cache GitHub reads",
        body: "Integrate cacheable reads.",
        state: "open",
        updated_at: "2026-07-26T11:59:00.000Z",
        labels: [{ name: "enhancement" }],
        user: { login: "owner" },
      };
    },
    async getIssueComments() { return []; },
    async getIssueDependencies() { return { blockedBy: [], blocking: [] }; },
    async getIssueTimeline() { return []; },
    async getIssueProjectItems() { return []; },
  };
  const hydrationInput = {
    client: issueClient,
    repository,
    issueNumber: 232,
    task: "Implement #232.",
    capturedAt: now(),
    snapshotCache,
    evidenceScope: { repository, headSha },
  };
  const firstHydration = await hydrateClaimedIssueTask(hydrationInput);
  const secondHydration = await hydrateClaimedIssueTask({ ...hydrationInput, capturedAt: "2026-07-26T12:00:01.000Z" });
  assert.equal(firstHydration.cache, "miss");
  assert.equal(secondHydration.cache, "hit");
  assert.equal(issueLoads, 1, "a fresh issue snapshot avoids all repeated GitHub hydration reads");
  assert.equal(secondHydration.metadata.provenance.capturedAt, firstHydration.metadata.provenance.capturedAt, "cache hits retain the actual snapshot provenance time");

  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["config", "user.email", "bridge@example.test"], { cwd: repo });
  await run("git", ["config", "user.name", "Bridge Test"], { cwd: repo });
  await run("git", ["remote", "add", "origin", `https://github.com/${repository}.git`], { cwd: repo });
  await writeFile(join(repo, "a.mjs"), "export const a = 1;\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "base"], { cwd: repo });
  const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, "a.mjs"), "export const a = 2;\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "head"], { cwd: repo });
  const exactHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const evidenceStore = createEvidenceStore({ directory: join(root, "evidence"), now });
  const repositoryCache = createRepositorySnapshotCache({
    journal: createRepositoryJournal({ directory: join(root, "repository-journal"), now }),
    now,
  });
  const firstEvidence = await captureRepositoryEvidence({ workspace: repo, store: evidenceStore, snapshotCache: repositoryCache, baseSha, headSha: exactHead });
  const secondEvidence = await captureRepositoryEvidence({ workspace: repo, store: evidenceStore, snapshotCache: repositoryCache, baseSha, headSha: exactHead });
  assert.deepEqual(firstEvidence.changedFiles, ["a.mjs"]);
  assert.deepEqual(secondEvidence.cache, { repositoryMap: "hit", diff: "hit" });
  assert.ok(secondEvidence.cacheMetrics.avoidedLoads >= 2);

  let lifecycleReads = 0;
  const lifecycle = createProductionGitHubLifecycleAdapter({
    async getIssue(number) { lifecycleReads += 1; return { number, state: "open", labels: [], updated_at: now() }; },
    async addIssueLabel() {},
    async removeIssueLabel() {},
    async updateIssueProjectSingleSelect() {},
  }, { snapshotCache, repository, headSha });
  assert.equal((await lifecycle.getIssueSnapshot(232)).cache, "miss", "raw lifecycle context is isolated from the hydrated aggregate schema");
  await lifecycle.getIssue(232);
  await lifecycle.getIssue(232);
  assert.equal(lifecycleReads, 3, "lifecycle authority never accepts the cached issue state");

  const readiness = { headSha, ready: true, unresolved: [], unanswered: [] };
  let readinessReads = 0;
  let headChecks = 0;
  const review = await reconcilePublishedReview({
    result: { state: "APPROVED", url: "https://github.test/reviews/1" },
    requestedEvent: "APPROVE",
    expectedLogin: "reviewer[bot]",
    headSha,
    repository,
    prNumber: 9,
    snapshotCache,
    readReadiness: async () => { readinessReads += 1; return readiness; },
    resolveThread: async () => assert.fail("no thread should be resolved"),
    assertCurrentHead: async () => { headChecks += 1; return { headSha }; },
  });
  assert.equal(review.reviewSnapshot.cache, "miss");
  assert.equal(review.reviewSnapshot.usableForAuthorization, false);
  assert.equal(review.pullRequestSnapshot, null, "exact-head assertions are never cached as pull-request detail");
  assert.equal(review.reviewResolution.complete, true);
  assert.ok(headChecks >= 2, "a cached review snapshot never replaces live exact-head fences");
  assert.equal(readinessReads, 2, "the live miss is reused once, while final readiness remains live");

  let pullDetailReads = 0;
  let threadDetailReads = 0;
  const detailLifecycle = createProductionGitHubLifecycleAdapter({
    async getIssue(number) { return { number, state: "open", labels: [], updated_at: now() }; },
    async getPullRequest(number) {
      pullDetailReads += 1;
      return { number, state: "open", mergeable: true, head: { sha: headSha }, updated_at: now() };
    },
    async reviewThreads() {
      threadDetailReads += 1;
      return [{ id: "thread-1", isResolved: false }];
    },
    async addIssueLabel() {},
    async removeIssueLabel() {},
    async updateIssueProjectSingleSelect() {},
  }, { snapshotCache, repository, headSha });
  const pullDetail = await detailLifecycle.getPullRequestSnapshot(9);
  const threadDetail = await detailLifecycle.getReviewThreadsSnapshot(9);
  assert.equal(pullDetail.cache, "miss", "pull-request detail has a producer-specific subject");
  assert.equal(threadDetail.cache, "miss", "raw review threads cannot alias the workflow readiness aggregate");
  assert.equal(pullDetail.value.mergeable, true);
  assert.equal(threadDetail.value[0].id, "thread-1");
  assert.equal(pullDetailReads, 1);
  assert.equal(threadDetailReads, 1);
  const isolatedSubjects = (await snapshotCache.inspect({ repository })).entries
    .map(({ entry }) => entry.key.subject)
    .filter((subject) => subject.startsWith("pr:9"));
  assert.deepEqual(isolatedSubjects.sort(), ["pr:9:detail", "pr:9:readiness", "pr:9:threads"], "review, PR detail, and raw-thread producers have disjoint cache identities");

  nowMs += 61_000;
  let refreshLoads = 0;
  const refreshed = await snapshotCache.getOrLoad({
    repository,
    kind: "pull_request",
    subject: "pr:9",
    headSha,
    freshnessMs: 60_000,
    load: async () => { refreshLoads += 1; return { data: { number: 9, headSha } }; },
  });
  assert.equal(refreshed.cache, "miss", "the removed authority-assertion cache leaves the generic PR subject unused");
  nowMs += 61_000;
  assert.equal((await snapshotCache.getOrLoad({
    repository,
    kind: "pull_request",
    subject: "pr:9",
    headSha,
    freshnessMs: 60_000,
    load: async () => { refreshLoads += 1; return { data: { number: 9, headSha } }; },
  })).cache, "refresh");
  assert.equal(refreshLoads, 2);
  const metrics = snapshotCache.metrics();
  assert.ok(metrics.hits >= 1);
  assert.ok(metrics.misses >= 2);
  assert.ok(metrics.refreshes >= 1);
  assert.ok(metrics.avoidedLoads >= 1);

  const boundedCache = createRepositorySnapshotCache({
    journal: createRepositoryJournal({ directory: join(root, "bounded-journal"), now }),
    now,
    maxEntryBytes: 512,
  });
  const oversized = await boundedCache.getOrLoad({
    repository,
    kind: "diff",
    subject: "oversized",
    headSha,
    load: async () => ({ data: { body: "x".repeat(2_000) } }),
  });
  assert.equal(oversized.cache, "live_uncached");
  assert.equal(oversized.degradation.code, "ENTRY_TOO_LARGE");
  assert.match(oversized.digest, /^[0-9a-f]{64}$/, "oversized live evidence retains a digest even when it is not cached");
  assert.equal(oversized.value.body.length, 2_000, "cache bounds cannot erase a successful live read");

  const identityCache = createRepositorySnapshotCache({
    journal: createRepositoryJournal({ directory: join(root, "identity-journal"), now }),
    now,
  });
  const identityStore = createEvidenceStore({ directory: join(root, "identity-evidence"), now });
  await run("git", ["remote", "set-url", "origin", join(root, "local-origin.git")], { cwd: repo });
  const localEvidence = await captureRepositoryEvidence({
    workspace: repo,
    store: identityStore,
    snapshotCache: identityCache,
    baseSha,
    headSha: exactHead,
  });
  assert.match(localEvidence.repository, /^local\/[0-9a-f]{16}$/);
  assert.equal((await identityCache.inspect()).entries.length, 0, "an unresolved workspace identity must not bind the shared repository journal");
  const governedEvidence = await captureRepositoryEvidence({
    workspace: repo,
    store: identityStore,
    snapshotCache: identityCache,
    repository,
    baseSha,
    headSha: exactHead,
  });
  assert.deepEqual(governedEvidence.cache, { repositoryMap: "miss", diff: "miss" });
  assert.equal((await identityCache.inspect({ repository })).status, "clean", "a later governed lane remains able to use the shared journal");
  await run("git", ["remote", "set-url", "origin", `https://github.com/${repository}.git`], { cwd: repo });

  const corruptJournal = createRepositoryJournal({ directory: join(root, "corrupt-journal"), now });
  const corruptCache = createRepositorySnapshotCache({ journal: corruptJournal, now });
  await corruptCache.put({ repository, kind: "issue", subject: "issue:1", sourceRevision: 1, data: { state: "open" } });
  await appendFile(corruptJournal.path, "{broken:");
  const recoveredLive = await corruptCache.getOrLoad({
    repository,
    kind: "issue",
    subject: "issue:1",
    load: async () => ({ data: { state: "closed" } }),
  });
  assert.equal(recoveredLive.cache, "live_uncached");
  assert.equal(recoveredLive.value.state, "closed");
  assert.equal(recoveredLive.degradation.code, "CORRUPT_CACHE_RECORD");
  assert.equal((await corruptCache.inspect()).status, "corrupt", "corrupt cache evidence remains inspectable after live degradation");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository snapshot integration tests passed: GitHub and Git reads cache safely while live authority fences remain mandatory.");

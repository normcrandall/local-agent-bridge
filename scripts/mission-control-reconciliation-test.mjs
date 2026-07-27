import assert from "node:assert/strict";
import { applyRepositoryJournalCheckpoint } from "../src/mission-control-journal-state.mjs";
import { createMissionControlJournalFirstReconciler, mergeMissionControlRemote } from "../src/mission-control-reconciliation.mjs";
import { reconcileMissionControlRemote } from "../src/mission-control-remote.mjs";

const head = "a".repeat(40);
const digest = "b".repeat(64);
const lane = {
  id: "bridge-11111111-2222-3333-4444-555555555555",
  repository: "owner/repo",
  workspace: "/tmp/repo",
  issueNumber: 234,
  prNumber: 254,
  headSha: head,
  lifecyclePhase: "running",
  updatedAt: "2026-07-26T12:00:00.000Z",
  narrative: { summary: "Starting", updatedAt: "2026-07-26T12:00:00.000Z" },
  repositoryJournal: { sequence: 7, digest },
};

const journalLane = applyRepositoryJournalCheckpoint(lane, {
  sequence: 8,
  digest: "c".repeat(64),
  recordedAt: "2026-07-26T12:01:00.000Z",
  binding: { repository: "owner/repo", issueNumber: 234, pullRequestNumber: 254, headSha: head },
  payload: { repositoryRuntime: {
    collaborationId: lane.id, phase: "reviewing", writer: "codex", previousWriter: null,
    headSha: head, branch: "codex/issue-234", summary: "Reviewing the exact head.", terminal: false,
  } },
});
assert.equal(journalLane.lifecyclePhase, "reviewing");
assert.equal(journalLane.repositoryJournal.sequence, 8);
assert.equal(journalLane.narrative.source, "repository_journal");

const snapshot = {
  streamId: "mission-control-one",
  eventCursor: 20,
  lanes: [lane],
  operatorLanes: [lane],
  providerCapacity: {},
};
const ticket = { revisions: new Map([[`${lane.repository}\0${lane.id}`, {
  repository: lane.repository, laneId: lane.id, issueNumber: 234, prNumber: 254,
  headSha: head, journalSequence: 7, journalDigest: digest,
}]]) };
const remote = {
  status: "current", observedAt: "2026-07-26T12:02:00.000Z", providerCapacity: { codex: { work: { inUse: 1, limit: 5 } } },
  lanes: [{
    repository: lane.repository, laneId: lane.id, observedHeadSha: head, exactHead: true,
    binding: { repository: lane.repository, laneId: lane.id, issueNumber: 234, prNumber: 254, headSha: head, journalSequence: 7, journalDigest: digest },
    pullRequest: { number: 254, state: "open", headSha: head }, reviews: [{ state: "APPROVED" }], ci: { headSha: head, combinedState: "success" },
  }],
};
const merged = mergeMissionControlRemote(snapshot, remote, ticket);
assert.equal(merged.lanes[0].github.ci.combinedState, "success");
assert.equal(merged.lanes[0].lifecyclePhase, "running", "remote facts cannot replace local lifecycle");

const advanced = structuredClone(snapshot);
advanced.lanes[0].repositoryJournal.sequence = 8;
advanced.operatorLanes[0].repositoryJournal.sequence = 8;
assert.equal(mergeMissionControlRemote(advanced, remote, ticket).lanes[0].github, undefined, "advanced local journal rejects stale remote response");

const wrongHeadRemote = structuredClone(remote);
wrongHeadRemote.lanes[0].observedHeadSha = "e".repeat(40);
const wrongHeadMerged = mergeMissionControlRemote(snapshot, wrongHeadRemote, ticket);
assert.equal(wrongHeadMerged.lanes[0].github.ci, null, "CI from a different head is withheld");
assert.deepEqual(wrongHeadMerged.lanes[0].github.reviews, [], "reviews from a different head are withheld");

let resolveRemote;
let calls = 0;
const updates = [];
const reconciler = createMissionControlJournalFirstReconciler({
  refreshMs: 60_000,
  onUpdate: (value) => updates.push(value.reconciliation.status),
  reconcile: () => { calls += 1; return new Promise((resolve) => { resolveRemote = resolve; }); },
});
reconciler.observeLocal(snapshot);
const first = reconciler.refresh();
const duplicate = reconciler.refresh();
assert.equal(first.started, true);
assert.equal(duplicate.started, false);
assert.equal(calls, 1, "concurrent refreshes deduplicate");
resolveRemote(remote);
await first.promise;
assert.equal(reconciler.snapshot.value.reconciliation.status, "current");
assert.ok(updates.includes("refreshing"));
reconciler.stop();

let abortObserved = false;
const cancellable = createMissionControlJournalFirstReconciler({
  reconcile: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { abortObserved = true; resolve({ status: "current", lanes: [] }); }, { once: true });
  }),
});
cancellable.observeLocal(snapshot);
const cancellation = cancellable.refresh();
cancellable.cancel();
assert.equal((await cancellation.promise).status, "cancelled");
assert.equal(abortObserved, true, "generation cancellation aborts the broker request");

let clock = 1_000;
let recoveryAttempt = 0;
const recovering = createMissionControlJournalFirstReconciler({
  now: () => clock,
  refreshMs: 60_000,
  reconcile: async () => {
    recoveryAttempt += 1;
    if (recoveryAttempt === 1) throw new Error("temporary remote failure");
    return remote;
  },
});
recovering.observeLocal(snapshot);
await recovering.refresh().promise;
assert.equal(recovering.snapshot.value.reconciliation.status, "degraded");
clock += 60_000;
await recovering.refresh().promise;
assert.equal(recovering.snapshot.value.reconciliation.status, "current", "quiet periodic refresh can recover remote facts");
recovering.stop();

const responses = new Map([
  ["/repos/owner/repo/issues/234", { number: 234, state: "open", title: "Journal first", html_url: "https://github.test/issue/234", updated_at: "2026-07-26T12:00:00Z", labels: [{ name: "agent:implementing" }] }],
  ["/repos/owner/repo/pulls/254", { number: 254, state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", html_url: "https://github.test/pr/254", updated_at: "2026-07-26T12:00:00Z", head: { sha: head }, base: { sha: "d".repeat(40), ref: "main" } }],
  ["/repos/owner/repo/pulls/254/reviews?per_page=100", [{ id: 1, state: "APPROVED", user: { login: "reviewer[bot]" }, submitted_at: "2026-07-26T12:00:00Z", commit_id: head }]],
  [`/repos/owner/repo/commits/${head}/status`, { state: "success", statuses: [{ context: "agent-review", state: "success" }] }],
  [`/repos/owner/repo/commits/${head}/check-runs?per_page=100`, { check_runs: [{ name: "gates", status: "completed", conclusion: "success" }] }],
]);
const result = await reconcileMissionControlRemote({
  tickets: [{ repository: "owner/repo", laneId: lane.id, issueNumber: 234, prNumber: 254, headSha: head, journalSequence: 7, journalDigest: digest }],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]" }),
  fetchImpl: async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = responses.get(path);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, headers: { get: () => null }, json: async () => body };
  },
});
assert.equal(result.status, "current");
assert.equal(result.lanes[0].exactHead, true);
assert.equal(result.lanes[0].ci.checks[0].conclusion, "success");
assert.equal(result.lanes[0].provenance.source, "github_app");

const rateLimitedHead = "f".repeat(40);
const rateLimited = await reconcileMissionControlRemote({
  tickets: [{ repository: "owner/rate-limited", laneId: "rate-limit-lane", issueNumber: 1, prNumber: 2, headSha: rateLimitedHead, journalSequence: 1, journalDigest: "1".repeat(64) }],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]" }),
  fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/issues/1")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ number: 1, state: "open", labels: [] }) };
    if (path.endsWith("/pulls/2")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ number: 2, state: "open", head: { sha: rateLimitedHead }, base: {} }) };
    return { ok: false, status: 403, headers: { get: (name) => name === "retry-after" ? "60" : null }, json: async () => ({}) };
  },
});
assert.equal(rateLimited.status, "degraded");
assert.ok(rateLimited.failures.some((failure) => failure.reason === "rate_limited"));
assert.equal(rateLimited.lanes[0].pullRequest.state, "open", "partial remote facts survive a rate-limited source");

const offline = await reconcileMissionControlRemote({
  tickets: [{ repository: "owner/offline", laneId: "offline-lane", issueNumber: 1, headSha: null, journalSequence: 1, journalDigest: "2".repeat(64) }],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]" }),
  fetchImpl: async () => { throw new TypeError("fetch failed"); },
});
assert.equal(offline.status, "offline");

const slowController = new AbortController();
const slow = reconcileMissionControlRemote({
  tickets: [{ repository: "owner/slow", laneId: "slow-lane", issueNumber: 1, headSha: null, journalSequence: 1, journalDigest: "3".repeat(64) }],
  stateRoot: "/tmp/mission-control-test-state",
  signal: slowController.signal,
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]" }),
  fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
});
slowController.abort();
await assert.rejects(slow, (error) => error.name === "AbortError", "slow remote reconciliation aborts on disconnect/shutdown");

console.log("mission control reconciliation tests passed");

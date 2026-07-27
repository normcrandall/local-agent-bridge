import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRepositoryJournalCheckpoint, clearMissionControlJournalCache, projectRepositoryJournalState } from "../src/mission-control-journal-state.mjs";
import { createMissionControlJournalFirstReconciler, mergeMissionControlRemote } from "../src/mission-control-reconciliation.mjs";
import { reconcileMissionControlRemote } from "../src/mission-control-remote.mjs";
import { createRepositoryJournal } from "../src/repository-journal.mjs";

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

function allowedLaneFor(ticket) {
  return {
    id: ticket.laneId,
    repository: ticket.repository,
    issueNumber: ticket.issueNumber || null,
    prNumber: ticket.prNumber || null,
    headSha: ticket.headSha || null,
    repositoryJournal: {
      sequence: ticket.journalSequence || 0,
      digest: ticket.journalDigest || null,
    },
  };
}

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

const newerLocalLane = applyRepositoryJournalCheckpoint({
  ...lane,
  updatedAt: "2026-07-26T12:02:00.000Z",
}, {
  sequence: 9,
  digest: "d".repeat(64),
  recordedAt: "2026-07-26T12:01:30.000Z",
  binding: { repository: "owner/repo", issueNumber: 234, pullRequestNumber: 254, headSha: head },
  payload: { repositoryRuntime: {
    collaborationId: lane.id, phase: "failed", writer: "codex", previousWriter: null,
    headSha: head, branch: "codex/issue-234", summary: "Older terminal checkpoint.", terminal: true,
  } },
});
assert.equal(newerLocalLane.lifecyclePhase, "running", "an older terminal checkpoint cannot replace newer local lifecycle state");

const sharedJournalRepository = await mkdtemp(join(tmpdir(), "mission-control-shared-journal-"));
try {
  execFileSync("git", ["init", "-q", sharedJournalRepository]);
  const sharedJournal = createRepositoryJournal({
    directory: join(sharedJournalRepository, ".git", "agent-bridge", "repository-runtime", "issue-234"),
  });
  for (const [index, collaborationId] of [lane.id, "bridge-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"].entries()) {
    await sharedJournal.append({
      identity: `checkpoint-${index}`,
      repository: "owner/repo",
      issueNumber: 234,
      headSha: head,
      payload: { repositoryRuntime: {
        collaborationId, phase: index === 0 ? "working" : "reviewing", writer: "codex", previousWriter: null,
        headSha: head, branch: `codex/shared-${index}`, summary: `Shared journal lane ${index}.`, terminal: false,
      } },
    });
  }
  clearMissionControlJournalCache();
  const sharedProjected = await projectRepositoryJournalState([
    { ...lane, workspace: sharedJournalRepository },
    { ...lane, id: "bridge-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", workspace: sharedJournalRepository },
  ], { concurrency: 2 });
  assert.deepEqual(sharedProjected.map((value) => value.repositoryJournal.sequence), [1, 2], "lanes sharing one issue journal each receive their own collaboration checkpoint");
  assert.deepEqual(sharedProjected.map((value) => value.lifecyclePhase), ["working", "reviewing"]);
} finally {
  clearMissionControlJournalCache();
  await rm(sharedJournalRepository, { recursive: true, force: true });
}

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

const mixedCaseSnapshot = structuredClone(snapshot);
mixedCaseSnapshot.lanes[0].repository = "Owner/Repo";
mixedCaseSnapshot.operatorLanes[0].repository = "Owner/Repo";
assert.equal(mergeMissionControlRemote(mixedCaseSnapshot, remote, ticket).lanes[0].github.ci.combinedState, "success", "repository matching is case-insensitive");

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
reconciler.observeLocal(structuredClone(snapshot));
assert.equal(reconciler.snapshot.value.lanes[0].github.ci.combinedState, "success", "valid remote facts remain visible across local redraws");
reconciler.stop();

let scopedTickets = null;
const scopedReconciler = createMissionControlJournalFirstReconciler({
  reconcile: async ({ tickets }) => {
    scopedTickets = tickets;
    return { status: "current", observedAt: "2026-07-26T12:03:00.000Z", lanes: [], providerCapacity: {}, failures: [] };
  },
});
scopedReconciler.observeLocal({
  ...structuredClone(snapshot),
  operatorLanes: [],
});
await scopedReconciler.refresh().promise;
assert.deepEqual(scopedTickets, [], "hidden lanes retained outside the operator scope must not trigger remote reconciliation");
scopedReconciler.stop();

let resolveStaleStream;
const staleStream = createMissionControlJournalFirstReconciler({
  reconcile: () => new Promise((resolve) => { resolveStaleStream = resolve; }),
});
staleStream.observeLocal(snapshot);
const staleRefresh = staleStream.refresh();
staleStream.observeLocal({ ...structuredClone(snapshot), streamId: "mission-control-two" });
resolveStaleStream(remote);
assert.equal((await staleRefresh.promise).status, "stale_stream");
assert.equal(staleStream.snapshot.value.reconciliation.status, "local", "a stream transition cannot leave reconciliation stuck as refreshing");
assert.equal(staleStream.refresh().started, true, "a stream transition permits immediate reconciliation of the new stream");
staleStream.stop();

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

const rejectingCancellation = createMissionControlJournalFirstReconciler({
  reconcile: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }),
});
rejectingCancellation.observeLocal(snapshot);
const rejectedCancellation = rejectingCancellation.refresh();
rejectingCancellation.cancel();
assert.equal((await rejectedCancellation.promise).status, "cancelled", "an AbortError after cancellation is handled without dereferencing cleared controller state");

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
const primaryTicket = { repository: "owner/repo", laneId: lane.id, issueNumber: 234, prNumber: 254, headSha: head, journalSequence: 7, journalDigest: digest };
const result = await reconcileMissionControlRemote({
  tickets: [primaryTicket],
  allowedLanes: [allowedLaneFor(primaryTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "1", installationId: "2" }),
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

const cachedWithoutAuthentication = await reconcileMissionControlRemote({
  tickets: [primaryTicket],
  allowedLanes: [allowedLaneFor(primaryTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => { throw new Error("credential unavailable"); },
  fetchImpl: async () => { throw new Error("cache hit must not fetch"); },
});
assert.equal(cachedWithoutAuthentication.status, "degraded");
assert.equal(cachedWithoutAuthentication.lanes.length, 0, "cached GitHub facts are not returned before current credential authorization");

await assert.rejects(reconcileMissionControlRemote({
  tickets: [{ ...primaryTicket, laneId: "forged-lane" }],
  allowedLanes: [allowedLaneFor(primaryTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "1", installationId: "2" }),
  fetchImpl: async () => { throw new Error("unauthorized tickets must not fetch"); },
}), /not authorized by the live control plane/);

const rateLimitedHead = "f".repeat(40);
const rateLimitedTicket = { repository: "owner/rate-limited", laneId: "rate-limit-lane", issueNumber: 1, prNumber: 2, headSha: rateLimitedHead, journalSequence: 1, journalDigest: "1".repeat(64) };
const rateLimited = await reconcileMissionControlRemote({
  tickets: [rateLimitedTicket],
  allowedLanes: [allowedLaneFor(rateLimitedTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "3", installationId: "4" }),
  fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/issues/1")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ number: 1, state: "open", labels: [] }) };
    if (path.endsWith("/pulls/2")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ number: 2, state: "open", head: { sha: rateLimitedHead }, base: {} }) };
    return { ok: false, status: 403, headers: { get: (name) => name === "retry-after" ? "60" : null }, json: async () => ({}) };
  },
});
assert.equal(rateLimited.status, "partial");
assert.ok(rateLimited.failures.some((failure) => failure.reason === "rate_limited"));
assert.equal(rateLimited.failures.find((failure) => failure.reason === "rate_limited").retryAfterSeconds, 60);
assert.equal(rateLimited.lanes[0].pullRequest.state, "open", "partial remote facts survive a rate-limited source");

const failedPullTicket = { repository: "owner/pull-failed", laneId: "pull-failed-lane", issueNumber: 1, prNumber: 2, headSha: "9".repeat(40), journalSequence: 1, journalDigest: "4".repeat(64) };
const failedPull = await reconcileMissionControlRemote({
  tickets: [failedPullTicket],
  allowedLanes: [allowedLaneFor(failedPullTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "9", installationId: "10" }),
  fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/issues/1")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ number: 1, state: "open", labels: [] }) };
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  },
});
assert.equal(failedPull.lanes[0].observedHeadSha, null);
assert.equal(failedPull.lanes[0].exactHead, false, "a failed pull-request read cannot claim exact-head freshness from the requested ticket");
assert.equal(failedPull.lanes[0].ci, null, "head-bound CI is withheld when the pull-request head was not observed");

const offlineTicket = { repository: "owner/offline", laneId: "offline-lane", issueNumber: 1, headSha: null, journalSequence: 1, journalDigest: "2".repeat(64) };
const offline = await reconcileMissionControlRemote({
  tickets: [offlineTicket],
  allowedLanes: [allowedLaneFor(offlineTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "5", installationId: "6" }),
  fetchImpl: async () => { throw new TypeError("fetch failed"); },
});
assert.equal(offline.status, "offline");

const slowController = new AbortController();
const slowTicket = { repository: "owner/slow", laneId: "slow-lane", issueNumber: 1, headSha: null, journalSequence: 1, journalDigest: "3".repeat(64) };
const slow = reconcileMissionControlRemote({
  tickets: [slowTicket],
  allowedLanes: [allowedLaneFor(slowTicket)],
  stateRoot: "/tmp/mission-control-test-state",
  signal: slowController.signal,
  createCredential: async () => ({ token: "ghs_test", verifiedLogin: "builder[bot]", appId: "7", installationId: "8" }),
  fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
});
slowController.abort();
await assert.rejects(slow, (error) => error.name === "AbortError", "slow remote reconciliation aborts on disconnect/shutdown");

console.log("mission control reconciliation tests passed");

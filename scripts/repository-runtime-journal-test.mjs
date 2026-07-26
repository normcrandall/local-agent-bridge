import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepositoryRuntimeJournal,
  shouldCheckpointWorkerFailure,
} from "../src/repository-runtime-journal.mjs";
import {
  publishRepositoryLifecycleCheckpoint,
  repositoryJournalPublicationState,
} from "../src/repository-lifecycle-publication.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-runtime-journal-"));
const head = "a".repeat(40);
let clockMs = Date.UTC(2026, 6, 26, 20, 0, 0);
const now = () => new Date(clockMs).toISOString();
const advance = (milliseconds) => { clockMs += milliseconds; };

function runtime() {
  return createRepositoryRuntimeJournal({
    workspace: root,
    directory: join(root, "journal"),
    repository: "Veliqon/Example",
    issueNumber: 231,
    pullRequestNumber: 42,
    now,
    leaseMs: 100,
    maxAttempts: 4,
    baseBackoffMs: 50,
    maxBackoffMs: 200,
    terminalHorizonMs: 86_400_000,
  });
}

try {
  assert.equal(shouldCheckpointWorkerFailure(new Error("provider failed")), true);
  const rejectedPublication = new Error("terminal publication rejected");
  rejectedPublication.code = "REPOSITORY_LIFECYCLE_PUBLICATION_REJECTED";
  assert.equal(shouldCheckpointWorkerFailure(rejectedPublication), false,
    "a rejected terminal publication must not enqueue a contradictory failed checkpoint");

  let adapter = runtime();
  const first = await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "provider_progress",
    writer: "codex",
    headSha: head,
    branch: "codex/issue-231",
    summary: "A verbose heartbeat that must not reach GitHub.",
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.checkpoint.phase, "working");
  assert.equal(first.checkpoint.summary, "codex collaboration checkpoint: working.");

  const duplicate = await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "running",
    writer: "codex",
    headSha: head,
    branch: "codex/issue-231",
    summary: "A different heartbeat still collapses to the same checkpoint.",
  });
  assert.equal(duplicate.idempotent, true, "active heartbeats must collapse to one durable checkpoint");

  let attempts = 0;
  let result = await adapter.publishPending({
    workerId: "worker-before-network-loss",
    async publish() {
      attempts += 1;
      const error = new Error("network unavailable");
      error.code = "ENETUNREACH";
      throw error;
    },
  });
  assert.equal(result[0].status, "retry_scheduled");
  assert.equal((await adapter.inspect()).pending.length, 1, "offline publication must remain durable");

  advance(50);
  adapter = runtime();
  const published = [];
  result = await adapter.publishPending({
    workerId: "worker-after-restart",
    async publish(checkpoint, entry) {
      published.push({ checkpoint, entry });
      return { commentId: 7 };
    },
  });
  assert.equal(result[0].status, "published");
  assert.equal(published.length, 1);
  assert.equal(published[0].entry.binding.issueNumber, 231);
  assert.equal((await adapter.inspect()).acknowledged.length, 1);

  assert.equal((await adapter.publishPending({ workerId: "duplicate-drain", publish: async () => { throw new Error("must not replay"); } })).length, 0,
    "acknowledged checkpoints must not be published twice");

  await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "reviewing",
    writer: "claude",
    headSha: head,
  });
  const [crashedLease] = await adapter.outbox.claim({ workerId: "crashed-worker", leaseDurationMs: 25 });
  assert.equal(crashedLease.status, "leased");
  advance(26);
  adapter = runtime();
  result = await adapter.publishPending({ workerId: "replacement-worker", publish: async () => ({ recovered: true }) });
  assert.equal(result[0].status, "published", "an expired crash lease must be recovered after restart");

  await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "completed",
    writer: "codex",
    headSha: head,
    terminal: true,
    summary: "Implementation and focused verification completed.   Ready for review.",
  });
  result = await adapter.publishPending({ workerId: "terminal-worker", publish: async (checkpoint) => {
    assert.equal(checkpoint.summary, "Implementation and focused verification completed. Ready for review.");
  } });
  assert.equal(result[0].status, "published");

  const retention = await adapter.retain({ maxRecords: 3 });
  assert.ok(retention.checkpointedItems >= 3);
  adapter = runtime();
  const retained = await adapter.inspect();
  assert.equal(retained.pending.length, 0);
  assert.equal(retained.acknowledged.length, 3, "terminal and prior delivery evidence must survive retention and restart");

  const advancedHead = "b".repeat(40);
  let refreshes = 0;
  const terminalDrift = await publishRepositoryLifecycleCheckpoint({
    checkpoint: {
      kind: "refresh",
      terminal: true,
      headSha: head,
      collaborationId: "bridge-terminal-head-drift",
      phase: "completed",
      summary: "Completed at the observed head.",
      writer: "codex",
      previousWriter: null,
    },
    entry: { binding: { issueNumber: 231 } },
    currentMetadata: { headSha: advancedHead, branch: "codex/advanced", worktree: root },
    client: {},
    workspaceRoot: root,
    async refreshClaimLease(input) {
      refreshes += 1;
      assert.equal(input.phase, "completed");
      assert.equal(input.headSha, advancedHead, "terminal publication must use the current workspace metadata");
      return { published: true };
    },
    async releaseClaimLease() { throw new Error("release should not run"); },
  });
  assert.deepEqual(terminalDrift, { published: true });
  assert.equal(refreshes, 1, "terminal checkpoints must publish after workspace head drift");

  const staleHeartbeat = await publishRepositoryLifecycleCheckpoint({
    checkpoint: {
      kind: "refresh",
      terminal: false,
      headSha: head,
      collaborationId: "bridge-active-head-drift",
      phase: "working",
      summary: "Old heartbeat.",
      writer: "codex",
      previousWriter: null,
    },
    entry: { binding: { issueNumber: 231 } },
    currentMetadata: { headSha: advancedHead, branch: "codex/advanced", worktree: root },
    client: {},
    workspaceRoot: root,
    async refreshClaimLease() { throw new Error("stale heartbeat must be skipped"); },
    async releaseClaimLease() { throw new Error("release should not run"); },
  });
  assert.equal(staleHeartbeat.skipped, "superseded_head");

  const authorityDirectory = join(root, "authority-redrive");
  const authorityRuntime = () => createRepositoryRuntimeJournal({
    workspace: root,
    directory: authorityDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
    maxAttempts: 4,
    baseBackoffMs: 50,
    maxBackoffMs: 200,
  });
  let authority = authorityRuntime();
  await authority.enqueue({
    collaborationId: "bridge-authority-redrive",
    phase: "completed",
    writer: "codex",
    headSha: advancedHead,
    terminal: true,
  });
  result = await authority.publishPending({
    workerId: "worker-with-expired-authority",
    async publish() {
      const error = new Error("installation cannot access this repository");
      error.status = 403;
      throw error;
    },
  });
  assert.equal(result[0].status, "dead_letter", "lost authority must still fail closed immediately");
  assert.equal((await authority.inspect()).deadLetter.length, 1);

  authority = authorityRuntime();
  assert.equal((await authority.redriveAuthorityFailures()).redriven, 0,
    "a routine checkpoint must not infer that GitHub authority was restored");
  assert.equal((await authority.redriveAuthorityFailures({ authorityRestored: true })).redriven, 1,
    "a new bound credential may explicitly re-drive the dead letter once");
  result = await authority.publishPending({
    workerId: "worker-with-restored-authority",
    async publish() { return { restored: true }; },
  });
  assert.equal(result[0].status, "published");
  assert.equal((await authority.inspect()).acknowledged.length, 1,
    "the original idempotency key must become acknowledged after authority is restored");

  const revokedDirectory = join(root, "revoked-authority");
  const revokedRuntime = () => createRepositoryRuntimeJournal({
    workspace: root,
    directory: revokedDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
    maxAttempts: 4,
  });
  let revoked = revokedRuntime();
  await revoked.enqueue({
    collaborationId: "bridge-revoked-authority",
    phase: "completed",
    writer: "codex",
    headSha: advancedHead,
    terminal: true,
  });
  const rejectAuthority = async () => {
    const error = new Error("resource forbidden");
    error.status = 403;
    throw error;
  };
  await revoked.publishPending({ workerId: "revoked-first", publish: rejectAuthority });
  assert.equal((await revoked.redriveAuthorityFailures({ authorityRestored: true })).redriven, 1);
  await revoked.publishPending({ workerId: "revoked-second", publish: rejectAuthority });
  const bounded = await revoked.redriveAuthorityFailures({ authorityRestored: true });
  assert.deepEqual(bounded, { redriven: 0, eligible: 0, exhausted: 1 },
    "a permanently revoked credential must remain dead-lettered after one bounded redrive");

  const reclaimedDirectory = join(root, "reclaimed-before-authority-failure");
  const reclaimed = createRepositoryRuntimeJournal({
    workspace: root,
    directory: reclaimedDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
    leaseMs: 25,
    maxAttempts: 4,
  });
  await reclaimed.enqueue({
    collaborationId: "bridge-reclaimed-authority",
    phase: "completed",
    writer: "codex",
    headSha: advancedHead,
    terminal: true,
  });
  const [abandonedLease] = await reclaimed.outbox.claim({ workerId: "crashed-before-publication", leaseDurationMs: 25 });
  assert.equal(abandonedLease.claimCount, 1);
  advance(26);
  const [reclaimedLease] = await reclaimed.outbox.claim({ workerId: "replacement-publisher" });
  assert.equal(reclaimedLease.claimCount, 2);
  await reclaimed.outbox.fail({
    leaseId: reclaimedLease.lease.leaseId,
    failure: { statusCode: 403, message: "authority unavailable after reclaim" },
  });
  assert.equal((await reclaimed.redriveAuthorityFailures({ authorityRestored: true })).redriven, 1,
    "ordinary lease reclamation must not consume the one authority-redrive allowance");
  assert.equal((await reclaimed.inspect()).pending[0].redriveCount, 1);

  const hiddenDirectory = join(root, "hidden-resource");
  const hidden = createRepositoryRuntimeJournal({
    workspace: root,
    directory: hiddenDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
  });
  await hidden.enqueue({
    collaborationId: "bridge-hidden-resource",
    phase: "completed",
    writer: "codex",
    headSha: advancedHead,
    terminal: true,
  });
  await hidden.publishPending({ workerId: "hidden-first", async publish() {
    const error = new Error("not found");
    error.status = 404;
    throw error;
  } });
  assert.equal((await hidden.redriveAuthorityFailures({ authorityRestored: true })).redriven, 0,
    "permission-shaped 404 responses require operator diagnosis rather than automatic redrive");

  const throttledDirectory = join(root, "secondary-rate-limit");
  const throttled = createRepositoryRuntimeJournal({
    workspace: root,
    directory: throttledDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
    maxAttempts: 4,
    baseBackoffMs: 50,
    maxBackoffMs: 5_000,
  });
  await throttled.enqueue({
    collaborationId: "bridge-secondary-rate-limit",
    phase: "working",
    writer: "codex",
    headSha: advancedHead,
  });
  result = await throttled.publishPending({ workerId: "throttled-worker", async publish() {
    const error = new Error("You have exceeded a secondary rate limit");
    error.status = 403;
    error.retryAfter = "2";
    throw error;
  } });
  assert.equal(result[0].status, "retry_scheduled", "secondary 403 throttling must not dead-letter");
  const throttledState = repositoryJournalPublicationState(await throttled.inspect());
  assert.equal(throttledState.offline, false, "rate limiting is not a network outage");
  assert.equal(throttledState.rateLimited, true);
  assert.equal(throttledState.publicationState, "rate_limited");

  const offlineDirectory = join(root, "offline-backoff");
  const offlineRuntime = createRepositoryRuntimeJournal({
    workspace: root,
    directory: offlineDirectory,
    repository: "veliqon/example",
    issueNumber: 231,
    now,
    maxAttempts: 4,
    baseBackoffMs: 50,
    maxBackoffMs: 200,
  });
  await offlineRuntime.enqueue({
    collaborationId: "bridge-offline-backoff",
    phase: "working",
    writer: "codex",
    headSha: advancedHead,
  });
  await offlineRuntime.publishPending({
    workerId: "offline-worker",
    async publish() {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNRESET" };
      throw error;
    },
  });
  const backoffInspection = await offlineRuntime.inspect();
  assert.equal(backoffInspection.pending[0].status, "backoff");
  assert.equal(repositoryJournalPublicationState(backoffInspection).offline, true,
    "offline must remain true while publication sits in backoff between drain attempts");
  assert.equal((await offlineRuntime.publishPending({ workerId: "too-early", async publish() {} })).length, 0);
  assert.equal(repositoryJournalPublicationState(await offlineRuntime.inspect()).offline, true,
    "an empty drain during backoff must not report the repository journal online");

  console.log("repository runtime journal integration tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

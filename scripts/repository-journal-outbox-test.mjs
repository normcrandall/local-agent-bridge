import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import {
  createRepositoryJournalOutbox,
  REPOSITORY_JOURNAL_OUTBOX_VERSION,
} from "../src/repository-journal-outbox.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-repository-outbox-"));
const head = "a".repeat(40);
let clockMs = Date.UTC(2026, 6, 26, 16, 0, 0);
const now = () => new Date(clockMs).toISOString();
const advance = (ms) => { clockMs += ms; };

try {
  const directory = join(root, "outbox");
  const journal = createRepositoryJournal({ directory, now });
  const outbox = createRepositoryJournalOutbox({
    journal,
    now,
    leaseMs: 1_000,
    maxAttempts: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    maxPayloadBytes: 1_024,
  });

  const first = await outbox.enqueue({
    repository: "Veliqon/Example",
    operation: "issue_summary",
    idempotencyKey: "issue-207:complete",
    issueNumber: 207,
    pullRequestNumber: 42,
    headSha: head.toUpperCase(),
    payload: { summary: "Implemented", counts: { findings: 0 } },
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.entry.version, REPOSITORY_JOURNAL_OUTBOX_VERSION);
  assert.equal(first.entry.binding.repository, "veliqon/example");
  assert.equal(first.entry.binding.headSha, head);

  advance(1_000);
  const equivalent = await outbox.enqueue({
    repository: "veliqon/example",
    operation: "issue_summary",
    idempotencyKey: "issue-207:complete",
    issueNumber: 207,
    pullRequestNumber: 42,
    headSha: head,
    payload: { counts: { findings: 0 }, summary: "Implemented" },
  });
  assert.equal(equivalent.idempotent, true);
  await assert.rejects(
    outbox.enqueue({
      repository: "veliqon/example",
      operation: "issue_summary",
      idempotencyKey: "issue-207:complete",
      issueNumber: 207,
      pullRequestNumber: 42,
      headSha: head,
      payload: { summary: "Different" },
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  await assert.rejects(
    outbox.enqueue({ repository: "veliqon/example", operation: "x", idempotencyKey: "secret", payload: { api_token: "nope" } }),
    (error) => error.code === "SECRET_FIELD",
  );
  await assert.rejects(
    outbox.enqueue({ repository: "veliqon/example", operation: "x", idempotencyKey: "camel-secret", payload: { privateKey: "nope" } }),
    (error) => error.code === "SECRET_FIELD",
  );
  await assert.rejects(
    outbox.enqueue({ repository: "veliqon/example", operation: "x", idempotencyKey: "large", payload: { text: "x".repeat(2_000) } }),
    (error) => error.code === "PAYLOAD_TOO_LARGE",
  );

  const [lease] = await outbox.claim({ workerId: "publisher-a" });
  assert.equal(lease.status, "leased");
  assert.equal(lease.claimCount, 1);
  assert.equal((await outbox.claim({ workerId: "publisher-b" })).length, 0, "an active lease must exclude other workers");
  await assert.rejects(outbox.ack({ leaseId: lease.lease.leaseId, headSha: "b".repeat(40) }), (error) => error.code === "HEAD_MISMATCH");
  const acknowledged = await outbox.ack({ leaseId: lease.lease.leaseId, headSha: head });
  assert.equal(acknowledged.entry.status, "acknowledged");
  assert.equal((await outbox.inspect()).acknowledged.length, 1);
  const acknowledgedReplay = await outbox.enqueue({
    repository: "veliqon/example",
    operation: "issue_summary",
    idempotencyKey: "issue-207:complete",
    issueNumber: 207,
    pullRequestNumber: 42,
    headSha: head,
    payload: { summary: "Implemented", counts: { findings: 0 } },
  });
  assert.equal(acknowledgedReplay.idempotent, true);
  assert.equal(acknowledgedReplay.entry.status, "acknowledged",
    "idempotent enqueue must reconstruct the complete current state instead of replaying publication");

  await outbox.enqueue({ repository: "veliqon/example", operation: "pr_comment", idempotencyKey: "retry", payload: { body: "summary" } });
  const [retryLease] = await outbox.claim({ workerId: "publisher-a" });
  const retry = await outbox.fail({
    leaseId: retryLease.lease.leaseId,
    failure: { kind: "network", message: "reset", retryAfterMs: 250 },
  });
  assert.equal(retry.terminal, false);
  assert.equal(retry.retryAt, new Date(clockMs + 250).toISOString(), "retry-after must dominate the first exponential delay");
  assert.equal((await outbox.claim({ workerId: "publisher-b" })).length, 0, "backoff entries must not be due early");
  advance(250);
  const [secondAttempt] = await outbox.claim({ workerId: "publisher-b" });
  assert.equal(secondAttempt.claimCount, 2);
  const serverRetry = await outbox.fail({ leaseId: secondAttempt.lease.leaseId, failure: { statusCode: 503, message: "unavailable" } });
  assert.equal(serverRetry.terminal, false);
  assert.equal(serverRetry.retryAt, new Date(clockMs + 200).toISOString());
  advance(200);
  const [thirdAttempt] = await outbox.claim({ workerId: "publisher-c" });
  const exhausted = await outbox.fail({ leaseId: thirdAttempt.lease.leaseId, failure: { statusCode: 429, retryAfterMs: 50 } });
  assert.equal(exhausted.terminal, true, "the final allowed attempt must dead-letter even for a retryable failure");

  await outbox.enqueue({ repository: "veliqon/example", operation: "status", idempotencyKey: "auth", payload: {} });
  const [authLease] = await outbox.claim({ workerId: "publisher-a" });
  const auth = await outbox.fail({ leaseId: authLease.lease.leaseId, failure: { statusCode: 401, message: "bad credentials" } });
  assert.equal(auth.terminal, true);

  await outbox.enqueue({ repository: "veliqon/example", operation: "status", idempotencyKey: "policy", payload: {} });
  const [policyLease] = await outbox.claim({ workerId: "publisher-a" });
  const policy = await outbox.fail({ leaseId: policyLease.lease.leaseId, failure: { kind: "policy", message: "forbidden by policy" } });
  assert.equal(policy.terminal, true);

  await outbox.enqueue({ repository: "veliqon/example", operation: "status", idempotencyKey: "expired", payload: {} });
  const [expiring] = await outbox.claim({ workerId: "publisher-crashed", leaseDurationMs: 50 });
  assert.equal(expiring.claimCount, 1);
  advance(51);

  const restarted = createRepositoryJournalOutbox({
    journal: createRepositoryJournal({ directory, now }),
    now,
    leaseMs: 1_000,
    maxAttempts: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
  });
  const [reclaimed] = await restarted.claim({ workerId: "publisher-after-restart" });
  assert.equal(reclaimed.idempotencyKey, "expired");
  assert.equal(reclaimed.claimCount, 2, "an expired lease must be reclaimed as the next bounded attempt");
  await restarted.ack({ leaseId: reclaimed.lease.leaseId });

  const inspection = await restarted.inspect();
  assert.deepEqual(inspection.deadLetter.map((entry) => entry.idempotencyKey), ["retry", "auth", "policy"]);
  assert.deepEqual(inspection.acknowledged.map((entry) => entry.idempotencyKey), ["issue-207:complete", "expired"]);
  assert.equal(inspection.pending.length, 0);

  const raceDirectory = join(root, "race");
  const raceJournal = createRepositoryJournal({ directory: raceDirectory, now });
  const raceA = createRepositoryJournalOutbox({ journal: raceJournal, now });
  const raceB = createRepositoryJournalOutbox({ journal: createRepositoryJournal({ directory: raceDirectory, now }), now });
  await raceA.enqueue({ repository: "veliqon/race", operation: "publish", idempotencyKey: "one-winner", payload: {} });
  const raced = await Promise.all([raceA.claim({ workerId: "a" }), raceB.claim({ workerId: "b" })]);
  assert.equal(raced.flat().length, 1, "deterministic claim identity must allow only one concurrent lease winner");

  const gapDirectory = join(root, "history-gap");
  const gapJournal = createRepositoryJournal({ directory: gapDirectory, now });
  const gapOutbox = createRepositoryJournalOutbox({ journal: gapJournal, now });
  await gapOutbox.enqueue({ repository: "veliqon/gap", operation: "publish", idempotencyKey: "retained-child", payload: {} });
  const [gapLease] = await gapOutbox.claim({ workerId: "publisher" });
  await gapJournal.retain({ maxRecords: 1 });
  await assert.rejects(gapOutbox.inspect(), (error) => error.code === "OUTBOX_HISTORY_GAP",
    "partial retention must fail closed rather than erase the idempotency state");

  const versionDirectory = join(root, "future-version");
  const versionJournal = createRepositoryJournal({ directory: versionDirectory, now });
  await versionJournal.append({
    identity: "future-outbox",
    repository: "veliqon/version",
    payload: { repositoryOutbox: { version: REPOSITORY_JOURNAL_OUTBOX_VERSION + 1, event: "enqueued" } },
  });
  const versionOutbox = createRepositoryJournalOutbox({ journal: versionJournal, now });
  await assert.rejects(versionOutbox.inspect(), (error) => error.code === "UNSUPPORTED_VERSION",
    "newer outbox records must fail closed instead of disappearing from reconstructed state");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository journal outbox tests passed: idempotency, leases, retry policy, exact-head guard, restart reclaim, inspection, and payload safety.");

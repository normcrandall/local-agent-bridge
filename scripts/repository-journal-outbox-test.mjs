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
  await gapOutbox.claim({ workerId: "publisher" });
  await assert.rejects(gapJournal.retain({ maxRecords: 1 }), (error) => error.code === "RETENTION_UNSAFE",
    "generic retention must refuse to trim outbox history without reconstruction checkpoints");

  const retentionDirectory = join(root, "safe-retention");
  const retentionJournal = createRepositoryJournal({ directory: retentionDirectory, now });
  const retentionOutbox = createRepositoryJournalOutbox({
    journal: retentionJournal,
    now,
    leaseMs: 1_000,
    maxAttempts: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
  });
  await retentionOutbox.enqueue({ repository: "veliqon/retention", operation: "publish", idempotencyKey: "acknowledged", payload: { state: "ack" } });
  let [retentionLease] = await retentionOutbox.claim({ workerId: "publisher" });
  await retentionOutbox.ack({ leaseId: retentionLease.lease.leaseId });
  await retentionOutbox.enqueue({ repository: "veliqon/retention", operation: "publish", idempotencyKey: "dead-letter", payload: { state: "dead" } });
  [retentionLease] = await retentionOutbox.claim({ workerId: "publisher" });
  await retentionOutbox.fail({ leaseId: retentionLease.lease.leaseId, failure: { kind: "policy", message: "denied" } });
  await retentionOutbox.enqueue({ repository: "veliqon/retention", operation: "publish", idempotencyKey: "backoff", payload: { state: "backoff" } });
  [retentionLease] = await retentionOutbox.claim({ workerId: "publisher" });
  await retentionOutbox.fail({ leaseId: retentionLease.lease.leaseId, failure: { kind: "network", message: "reset" } });
  await retentionOutbox.enqueue({ repository: "veliqon/retention", operation: "publish", idempotencyKey: "leased", payload: { state: "leased" } });
  [retentionLease] = await retentionOutbox.claim({ workerId: "publisher" });
  const leasedId = retentionLease.lease.leaseId;
  await retentionOutbox.enqueue({ repository: "veliqon/retention", operation: "publish", idempotencyKey: "pending", payload: { state: "pending" } });

  const retentionReceipt = await retentionOutbox.retain({ maxRecords: 5 });
  assert.equal(retentionReceipt.checkpointedItems, 5);
  assert.equal(retentionReceipt.protectedOutboxItems, 5);
  assert.equal(retentionReceipt.bounded, true, "the protected checkpoint floor must be explicit and bounded");
  const retainedRecords = await retentionJournal.read();
  assert.equal(retainedRecords.every((record) => record.payload.repositoryOutbox.event === "checkpoint"), true,
    "safe retention should compact historical transitions to current-state checkpoints");

  const retentionRestart = createRepositoryJournalOutbox({
    journal: createRepositoryJournal({ directory: retentionDirectory, now }),
    now,
    leaseMs: 1_000,
    maxAttempts: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
  });
  const retainedInspection = await retentionRestart.inspect();
  assert.deepEqual(retainedInspection.acknowledged.map((entry) => entry.idempotencyKey), ["acknowledged"]);
  assert.deepEqual(retainedInspection.deadLetter.map((entry) => entry.idempotencyKey), ["dead-letter"]);
  assert.deepEqual(retainedInspection.pending.map((entry) => entry.idempotencyKey), ["backoff", "leased", "pending"]);
  await retentionRestart.ack({ leaseId: leasedId });
  const replayedAck = await retentionRestart.enqueue({
    repository: "veliqon/retention",
    operation: "publish",
    idempotencyKey: "acknowledged",
    payload: { state: "ack" },
  });
  assert.equal(replayedAck.idempotent, true);
  assert.equal(replayedAck.entry.status, "acknowledged", "compaction must preserve idempotency state");
  await assert.rejects(retentionRestart.enqueue({
    repository: "veliqon/retention",
    operation: "publish",
    idempotencyKey: "acknowledged",
    payload: { state: "different" },
  }), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  const secondRetention = await retentionRestart.retain({ maxRecords: 5 });
  assert.equal(secondRetention.checkpointedItems, 5, "restart-safe retention must be idempotently repeatable");
  assert.ok(secondRetention.removed > 0, "a fresh checkpoint epoch must let the retention floor advance on every run");
  assert.equal((await retentionJournal.read()).length <= retentionReceipt.retained, true,
    "repeated retention must not be permanently pinned by old terminal-item checkpoints");

  const generousRetentionDirectory = join(root, "generous-safe-retention");
  const generousRetentionJournal = createRepositoryJournal({ directory: generousRetentionDirectory, now });
  const generousRetentionOutbox = createRepositoryJournalOutbox({
    journal: generousRetentionJournal,
    now,
    leaseMs: 1_000,
  });
  for (const idempotencyKey of ["one", "two", "three"]) {
    await generousRetentionOutbox.enqueue({
      repository: "veliqon/generous-retention",
      operation: "publish",
      idempotencyKey,
      payload: { idempotencyKey },
    });
  }
  await generousRetentionOutbox.claim({ workerId: "publisher", limit: 3 });
  const generousRetentionReceipt = await generousRetentionOutbox.retain({ maxRecords: 5 });
  assert.equal(generousRetentionReceipt.retained, 3,
    "retention must start at the checkpoint floor when liveItems < maxRecords < records.length");
  const generousRetentionRestart = createRepositoryJournalOutbox({
    journal: createRepositoryJournal({ directory: generousRetentionDirectory, now }),
    now,
    leaseMs: 1_000,
  });
  assert.deepEqual((await generousRetentionRestart.inspect()).pending.map((entry) => entry.idempotencyKey), ["one", "three", "two"],
    "a generous retention cap must remain replayable instead of retaining orphan lifecycle events");

  const atomicDirectory = join(root, "atomic-retention");
  const atomicJournal = createRepositoryJournal({ directory: atomicDirectory, now });
  const atomicOutbox = createRepositoryJournalOutbox({ journal: atomicJournal, now });
  await atomicOutbox.enqueue({ repository: "veliqon/atomic", operation: "publish", idempotencyKey: "in-flight", payload: {} });
  const [atomicRetention, atomicClaims] = await Promise.all([
    atomicOutbox.retain({ maxRecords: 1 }),
    atomicOutbox.claim({ workerId: "atomic-publisher" }),
  ]);
  assert.equal(atomicRetention.bounded, true);
  assert.equal(atomicClaims.length, 1, "claim racing retention must still acquire exactly one durable lease");
  assert.equal((await atomicOutbox.claim({ workerId: "duplicate-publisher" })).length, 0,
    "retention must not revoke an in-flight lease or permit duplicate publication");
  await atomicOutbox.ack({ leaseId: atomicClaims[0].lease.leaseId });

  const staleDirectory = join(root, "stale-checkpoint-termination");
  const staleJournal = createRepositoryJournal({ directory: staleDirectory, now });
  const staleOutbox = createRepositoryJournalOutbox({ journal: staleJournal, now });
  await staleOutbox.enqueue({ repository: "veliqon/stale", operation: "publish", idempotencyKey: "stale", payload: {} });
  await staleOutbox.retain({ maxRecords: 1 });
  const staleCheckpoint = (await staleJournal.read())[0];
  await staleOutbox.claim({ workerId: "first-publisher" });
  await staleJournal.append({
    identity: "injected-stale-checkpoint",
    ...staleCheckpoint.binding,
    payload: staleCheckpoint.payload,
  });
  const staleClaimStart = Date.now();
  assert.deepEqual(await staleOutbox.claim({ workerId: "second-publisher" }), [],
    "a duplicate claim identity behind a stale checkpoint must terminate without spinning");
  assert.ok(Date.now() - staleClaimStart < 1_000);

  const horizonDirectory = join(root, "terminal-horizon");
  const horizonJournal = createRepositoryJournal({ directory: horizonDirectory, now });
  const horizonOutbox = createRepositoryJournalOutbox({ journal: horizonJournal, now, terminalHorizonMs: 1_000 });
  for (let index = 0; index < 12; index += 1) {
    await horizonOutbox.enqueue({ repository: "veliqon/horizon", operation: "publish", idempotencyKey: `ack-${index}`, payload: { index } });
    const [claimed] = await horizonOutbox.claim({ workerId: "publisher" });
    await horizonOutbox.ack({ leaseId: claimed.lease.leaseId });
  }
  await horizonOutbox.enqueue({ repository: "veliqon/horizon", operation: "publish", idempotencyKey: "unpublished", payload: {} });
  advance(1_001);
  const horizonReceipt = await horizonOutbox.retain({ maxRecords: 1 });
  assert.equal(horizonReceipt.droppedTerminalItems, 12, "aged acknowledged history must not grow the retention floor forever");
  assert.equal(horizonReceipt.checkpointedItems, 1);
  assert.equal(horizonReceipt.bounded, true);
  assert.deepEqual((await horizonOutbox.inspect()).pending.map((entry) => entry.idempotencyKey), ["unpublished"],
    "retention must preserve unpublished work while aging out only acknowledged history");

  const deadLetterHorizonDirectory = join(root, "dead-letter-horizon");
  const deadLetterHorizonJournal = createRepositoryJournal({ directory: deadLetterHorizonDirectory, now });
  const deadLetterHorizonOutbox = createRepositoryJournalOutbox({
    journal: deadLetterHorizonJournal,
    now,
    terminalHorizonMs: 1_000,
  });
  await deadLetterHorizonOutbox.enqueue({
    repository: "veliqon/dead-letter-horizon",
    operation: "publish",
    idempotencyKey: "permanent-failure",
    payload: {},
  });
  const [deadLetterLease] = await deadLetterHorizonOutbox.claim({ workerId: "publisher" });
  await deadLetterHorizonOutbox.fail({
    leaseId: deadLetterLease.lease.leaseId,
    failure: { kind: "policy", message: "denied" },
  });
  await deadLetterHorizonOutbox.enqueue({
    repository: "veliqon/dead-letter-horizon",
    operation: "publish",
    idempotencyKey: "surviving-publication",
    payload: {},
  });
  advance(1_001);
  const deadLetterHorizonReceipt = await deadLetterHorizonOutbox.retain({ maxRecords: 100 });
  assert.equal(deadLetterHorizonReceipt.droppedTerminalItems, 1,
    "aged dead-letter history must count toward the receipted terminal horizon");
  assert.equal(deadLetterHorizonReceipt.droppedDeadLetterItems, 1,
    "dead-letter eviction must be separately visible to operators");
  assert.ok(deadLetterHorizonReceipt.removed > 0,
    "a dead-letter eviction receipt must correspond to records removed even when the journal is under budget");
  const deadLetterHorizonInspection = await deadLetterHorizonOutbox.inspect();
  assert.deepEqual(deadLetterHorizonInspection.deadLetter, [],
    "aged dead-letter history must not permanently pin the retention floor");
  assert.deepEqual(deadLetterHorizonInspection.pending.map((entry) => entry.idempotencyKey), ["surviving-publication"],
    "under-budget dead-letter eviction must preserve and replay surviving work from its checkpoint");

  const fullyTerminalDirectory = join(root, "fully-terminal-horizon");
  const fullyTerminalJournal = createRepositoryJournal({ directory: fullyTerminalDirectory, now });
  const fullyTerminalOutbox = createRepositoryJournalOutbox({ journal: fullyTerminalJournal, now, terminalHorizonMs: 1 });
  await fullyTerminalOutbox.enqueue({ repository: "veliqon/terminal", operation: "publish", idempotencyKey: "complete", payload: {} });
  const [fullyTerminalLease] = await fullyTerminalOutbox.claim({ workerId: "publisher" });
  await fullyTerminalOutbox.ack({ leaseId: fullyTerminalLease.lease.leaseId });
  advance(2);
  const fullyTerminalReceipt = await fullyTerminalOutbox.retain({ maxRecords: 1 });
  assert.equal(fullyTerminalReceipt.droppedTerminalItems, 1);
  assert.equal(fullyTerminalReceipt.retained, 0);
  assert.deepEqual(await fullyTerminalJournal.read(), [], "an all-acknowledged journal may compact cleanly to empty after its horizon");

  const floorDirectory = join(root, "retention-floor");
  const floorJournal = createRepositoryJournal({ directory: floorDirectory, now });
  const floorOutbox = createRepositoryJournalOutbox({ journal: floorJournal, now });
  await floorOutbox.enqueue({ repository: "veliqon/floor", operation: "publish", idempotencyKey: "one", payload: {} });
  await floorOutbox.enqueue({ repository: "veliqon/floor", operation: "publish", idempotencyKey: "two", payload: {} });
  const floorBefore = await floorJournal.read();
  await assert.rejects(floorOutbox.retain({ maxRecords: 1 }), (error) => error.code === "RETENTION_FLOOR_EXCEEDED");
  assert.deepEqual(await floorJournal.read(), floorBefore,
    "failed compaction must atomically leave no orphan checkpoints or partial rewrite");

  const malformedCheckpointDirectory = join(root, "malformed-checkpoint");
  const malformedCheckpointJournal = createRepositoryJournal({ directory: malformedCheckpointDirectory, now });
  await malformedCheckpointJournal.append({
    identity: "malformed-checkpoint",
    repository: "veliqon/malformed",
    payload: { repositoryOutbox: {
      version: REPOSITORY_JOURNAL_OUTBOX_VERSION,
      event: "checkpoint",
      keyDigest: "bad",
      stateDigest: "0".repeat(64),
      item: { idempotencyKey: "bad" },
    } },
  });
  const malformedCheckpointOutbox = createRepositoryJournalOutbox({ journal: malformedCheckpointJournal, now });
  await assert.rejects(malformedCheckpointOutbox.inspect(), (error) => error.code === "CORRUPT_CHECKPOINT");

  const reboundDirectory = join(root, "rebound-checkpoint");
  const reboundJournal = createRepositoryJournal({ directory: reboundDirectory, now });
  const reboundOutbox = createRepositoryJournalOutbox({ journal: reboundJournal, now });
  await reboundOutbox.enqueue({ repository: "veliqon/rebound", operation: "publish", idempotencyKey: "bound", payload: {} });
  await reboundOutbox.retain({ maxRecords: 1 });
  const reboundCheckpoint = (await reboundJournal.read())[0];
  reboundCheckpoint.payload.repositoryOutbox.keyDigest = "f".repeat(64);
  await reboundJournal.append({
    identity: "rebound-checkpoint",
    ...reboundCheckpoint.binding,
    payload: reboundCheckpoint.payload,
  });
  await assert.rejects(reboundOutbox.inspect(), (error) => error.code === "CORRUPT_CHECKPOINT");

  const malformedRetentionDirectory = join(root, "malformed-retention");
  const malformedRetentionJournal = createRepositoryJournal({ directory: malformedRetentionDirectory, now });
  await malformedRetentionJournal.append({ identity: "plain", repository: "veliqon/malformed", payload: {} });
  await malformedRetentionJournal.append({
    identity: "malformed-outbox",
    repository: "veliqon/malformed",
    payload: { repositoryOutbox: { version: REPOSITORY_JOURNAL_OUTBOX_VERSION, event: "enqueued" } },
  });
  await assert.rejects(malformedRetentionJournal.retain({ maxRecords: 1 }), (error) => error.code === "RETENTION_UNSAFE");

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

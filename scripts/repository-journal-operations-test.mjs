import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import { createRepositoryJournalOutbox } from "../src/repository-journal-outbox.mjs";
import { createRepositoryJournalOperations } from "../src/repository-journal-operations.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-journal-operations-"));
const repository = "veliqon/example";

async function addRecords(directory, count, { now = null } = {}) {
  let tick = 0;
  const journal = createRepositoryJournal({
    directory,
    ...(now ? { now: () => new Date(Date.parse(now) + tick++ * 1_000).toISOString() } : {}),
  });
  for (let index = 1; index <= count; index += 1) {
    await journal.append({ identity: `record-${index}`, repository, issueNumber: 235, payload: { index, status: "completed" } });
  }
  return journal;
}

try {
  const sourceDirectory = join(root, "source");
  const source = await addRecords(sourceDirectory, 8);
  const operations = createRepositoryJournalOperations({ directory: sourceDirectory });
  const inspection = await operations.inspect();
  assert.deepEqual({ status: inspection.status, recordCount: inspection.recordCount, repository: inspection.repository }, {
    status: "clean", recordCount: 8, repository,
  });
  assert.deepEqual(inspection.outbox, { pending: 0, leased: 0, backoff: 0, deadLetter: 0, acknowledged: 0 });

  const exportedPath = join(root, "exports", "journal.json");
  const exported = await operations.export({ output: exportedPath, repository: repository.toUpperCase() });
  assert.match(exported.checksum, /^[0-9a-f]{64}$/);
  assert.equal(exported.records.length, 8);
  const archived = await operations.archive({ output: join(root, "archive", "journal.json") });
  assert.equal(archived.destructive, false);
  assert.equal((await source.read()).length, 8, "archive must not mutate the live journal");

  const restoredDirectory = join(root, "restored");
  const restoredOperations = createRepositoryJournalOperations({ directory: restoredDirectory });
  const importPreview = await restoredOperations.import({ input: exportedPath, repository });
  assert.equal(importPreview.dryRun, true);
  assert.equal(importPreview.incoming.recordCount, 8);
  assert.equal((await createRepositoryJournal({ directory: restoredDirectory }).read()).length, 0, "import defaults to dry-run");
  const imported = await restoredOperations.import({ input: exportedPath, repository, apply: true });
  assert.equal(imported.applied, true);
  assert.deepEqual(await createRepositoryJournal({ directory: restoredDirectory }).read(), await source.read(), "cross-machine restore preserves chain and bindings");
  await assert.rejects(
    restoredOperations.import({ input: exportedPath, repository: "veliqon/other" }),
    (error) => error.code === "REPOSITORY_MISMATCH",
  );

  const originalRaw = await readFile(source.path, "utf8");
  const retentionPreview = await operations.retain({ maxRecords: 3 });
  assert.equal(retentionPreview.dryRun, true);
  assert.equal(retentionPreview.after.recordCount, 3);
  assert.equal(await readFile(source.path, "utf8"), originalRaw, "retention defaults to dry-run");
  const retained = await operations.retain({ maxRecords: 3, apply: true });
  assert.equal(retained.applied, true);
  assert.equal(retained.after.recordCount, 3);
  assert.equal((await source.read()).length, 3);
  assert.equal((await stat(retained.recoveryReceipt.path)).isFile(), true);
  assert.match(retained.recoveryReceipt.restoreCommand, /bridge journal import/);
  await operations.import({ input: retained.recoveryReceipt.path, repository, apply: true });
  assert.equal((await source.read()).length, 8, "recovery receipt restores the exact pre-retention journal");

  const interruptedDirectory = join(root, "interrupted");
  const interruptedJournal = await addRecords(interruptedDirectory, 6);
  const beforeInterruption = await readFile(interruptedJournal.path, "utf8");
  const interrupted = createRepositoryJournalOperations({
    directory: interruptedDirectory,
    hooks: { afterReplace: () => { throw new Error("simulated interruption"); } },
  });
  await assert.rejects(interrupted.retain({ maxRecords: 2, apply: true }), /simulated interruption/);
  assert.equal(await readFile(interruptedJournal.path, "utf8"), beforeInterruption, "failed apply rolls back to the original chain");

  const pendingDirectory = join(root, "pending");
  const pendingJournal = createRepositoryJournal({ directory: pendingDirectory });
  const pendingOutbox = createRepositoryJournalOutbox({ journal: pendingJournal });
  await pendingOutbox.enqueue({ repository, operation: "comment", idempotencyKey: "pending-comment", payload: { body: "pending" } });
  const pendingRetention = await createRepositoryJournalOperations({ directory: pendingDirectory }).retain({ maxRecords: 1, apply: true });
  assert.equal(pendingRetention.retention.checkpointedItems, 1);
  assert.equal((await pendingOutbox.inspect()).pending.length, 1, "pending outbox work survives retention through its reconstruction checkpoint");

  const leasedDirectory = join(root, "leased");
  const leasedJournal = createRepositoryJournal({ directory: leasedDirectory });
  const leasedOutbox = createRepositoryJournalOutbox({ journal: leasedJournal, leaseMs: 60_000 });
  await leasedOutbox.enqueue({ repository, operation: "comment", idempotencyKey: "leased-comment", payload: { body: "leased" } });
  await leasedOutbox.claim({ workerId: "active-worker" });
  const leasedInspection = await createRepositoryJournalOperations({ directory: leasedDirectory }).inspect();
  assert.equal(leasedInspection.outbox.leased, 1);
  assert.ok(leasedInspection.protectedRecords.some((record) => record.reason.endsWith("is leased")));
  await assert.rejects(
    createRepositoryJournalOperations({ directory: leasedDirectory }).retain({ maxRecords: 1, apply: true }),
    (error) => error.code === "RETENTION_PROTECTED",
    "retention must derive leased protection from persisted outbox state",
  );

  const backoffDirectory = join(root, "backoff");
  const backoffJournal = createRepositoryJournal({ directory: backoffDirectory });
  const backoffOutbox = createRepositoryJournalOutbox({ journal: backoffJournal, baseBackoffMs: 60_000 });
  await backoffOutbox.enqueue({ repository, operation: "comment", idempotencyKey: "backoff-comment", payload: { body: "backoff" } });
  const [backoffLease] = await backoffOutbox.claim({ workerId: "retry-worker" });
  await backoffOutbox.fail({ leaseId: backoffLease.lease.leaseId, failure: { kind: "network", message: "offline" } });
  const backoffInspection = await createRepositoryJournalOperations({ directory: backoffDirectory }).inspect();
  assert.equal(backoffInspection.outbox.backoff, 1);
  await assert.rejects(
    createRepositoryJournalOperations({ directory: backoffDirectory }).retain({ maxRecords: 1, apply: true }),
    (error) => error.code === "RETENTION_PROTECTED",
    "retention must derive backoff protection from persisted outbox state",
  );

  const protectedImportDirectory = join(root, "protected-import");
  const protectedImportJournal = createRepositoryJournal({ directory: protectedImportDirectory });
  const protectedImportOutbox = createRepositoryJournalOutbox({ journal: protectedImportJournal });
  await protectedImportOutbox.enqueue({ repository, operation: "comment", idempotencyKey: "import-comment", payload: { body: "import" } });
  const beforeLeasePath = join(root, "exports", "before-lease.json");
  const protectedImportOperations = createRepositoryJournalOperations({ directory: protectedImportDirectory });
  await protectedImportOperations.export({ output: beforeLeasePath, repository });
  await protectedImportOutbox.claim({ workerId: "import-worker" });
  const protectedImportPreview = await protectedImportOperations.import({ input: beforeLeasePath, repository });
  assert.ok(protectedImportPreview.protectedLost.length > 0, "dry-run names protected leased records that would be lost");
  await assert.rejects(
    protectedImportOperations.import({ input: beforeLeasePath, repository, apply: true }),
    (error) => error.code === "IMPORT_PROTECTED",
    "import refuses only when protected persisted state would be lost",
  );
  const completeLeasePath = join(root, "exports", "complete-lease.json");
  await protectedImportOperations.export({ output: completeLeasePath, repository });
  const preservingImport = await protectedImportOperations.import({ input: completeLeasePath, repository, apply: true });
  assert.equal(preservingImport.applied, true, "an import preserving every protected digest remains allowed");

  const deadDirectory = join(root, "dead-letter");
  let oldTick = 0;
  const oldNow = () => new Date(Date.UTC(2020, 0, 1, 0, 0, oldTick++)).toISOString();
  const deadJournal = createRepositoryJournal({ directory: deadDirectory, now: oldNow });
  const deadOutbox = createRepositoryJournalOutbox({ journal: deadJournal, now: oldNow });
  await deadOutbox.enqueue({ repository, operation: "comment", idempotencyKey: "dead-comment", payload: { body: "dead" } });
  const [lease] = await deadOutbox.claim({ workerId: "test" });
  await deadOutbox.fail({ leaseId: lease.lease.leaseId, failure: { kind: "authorization", message: "denied" } });
  await assert.rejects(
    createRepositoryJournalOperations({ directory: deadDirectory }).retain({ maxRecords: 1 }),
    (error) => error.code === "RETENTION_PROTECTED",
    "aged dead-letter work must remain explicit rather than disappearing during retention",
  );

  const corruptDirectory = join(root, "corrupt");
  const corruptJournal = await addRecords(corruptDirectory, 2);
  await appendFile(corruptJournal.path, '{"version":1,"sequence":3');
  const corruptRaw = await readFile(corruptJournal.path, "utf8");
  const corruptOperations = createRepositoryJournalOperations({ directory: corruptDirectory });
  const corruptArchivePath = join(root, "archive", "corrupt-journal.json");
  const corruptArchive = await corruptOperations.archive({ output: corruptArchivePath });
  assert.equal(corruptArchive.corrupt, true);
  const corruptArchiveEnvelope = JSON.parse(await readFile(corruptArchivePath, "utf8"));
  assert.equal(Buffer.from(corruptArchiveEnvelope.rawBase64, "base64").toString("utf8"), corruptRaw);
  assert.match(corruptArchive.restoreCommand, /bridge journal restore/);
  const recoveryPreview = await corruptOperations.recover();
  assert.equal(recoveryPreview.dryRun, true);
  assert.equal(recoveryPreview.corruption.code, "TORN_TAIL");
  assert.equal(await readFile(corruptJournal.path, "utf8"), corruptRaw);
  const recovered = await corruptOperations.recover({ apply: true });
  assert.equal(recovered.applied, true);
  assert.equal((await corruptJournal.inspect()).status, "clean");
  assert.equal((await corruptJournal.read()).length, 2);
  const recoveryEnvelope = JSON.parse(await readFile(recovered.recoveryReceipt.path, "utf8"));
  assert.equal(Buffer.from(recoveryEnvelope.rawBase64, "base64").toString("utf8"), corruptRaw, "corruption receipt retains every original byte");
  const restorePreview = await corruptOperations.restore({ input: recovered.recoveryReceipt.path });
  assert.equal(restorePreview.dryRun, true);
  assert.equal((await corruptJournal.inspect()).status, "clean");
  await corruptOperations.restore({ input: recovered.recoveryReceipt.path, apply: true });
  assert.equal(await readFile(corruptJournal.path, "utf8"), corruptRaw, "the receipt's exact restore command can reinstate every corrupt byte for forensic recovery");

  const rollbackDirectory = join(root, "recover-rollback");
  const rollbackJournal = await addRecords(rollbackDirectory, 1);
  await appendFile(rollbackJournal.path, "torn");
  const rollbackRaw = await readFile(rollbackJournal.path, "utf8");
  const rollbackOperations = createRepositoryJournalOperations({
    directory: rollbackDirectory,
    hooks: { afterReplace: () => { throw new Error("recovery interrupted"); } },
  });
  await assert.rejects(rollbackOperations.recover({ apply: true }), /recovery interrupted/);
  assert.equal(await readFile(rollbackJournal.path, "utf8"), rollbackRaw, "interrupted corruption recovery restores the original bytes");

  const lockDirectory = join(root, "operator-lock");
  const lockJournal = await addRecords(lockDirectory, 2);
  const lockPath = join(lockDirectory, "repository-journal.lock");
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "live" })}\n`);
  const lockOperations = createRepositoryJournalOperations({
    directory: lockDirectory,
    operatorLockTimeoutMs: 25,
    operatorLockRetryMs: 5,
  });
  await assert.rejects(
    lockOperations.retain({ maxRecords: 1, apply: true }),
    (error) => error.code === "LOCK_TIMEOUT",
    "a live owner lock is never stolen",
  );
  await writeFile(lockPath, `${JSON.stringify({ pid: 999_999_999, token: "dead" })}\n`);
  const staleAt = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleAt, staleAt);
  const reclaimed = await lockOperations.retain({ maxRecords: 1, apply: true });
  assert.equal(reclaimed.applied, true, "a stale dead-owner lock is reclaimed for operator recovery");
  assert.equal((await lockJournal.read()).length, 1);

  await writeFile(lockPath, "{\"pid\":", "utf8");
  await utimes(lockPath, staleAt, staleAt);
  await lockJournal.append({ identity: "record-3", repository, issueNumber: 235, payload: { index: 3, status: "completed" } });
  assert.equal((await lockJournal.read()).length, 2, "a stale truncated lock body is reclaimed after the fail-closed grace period");

  const concurrentDirectory = join(root, "concurrent-retention");
  const concurrentJournal = await addRecords(concurrentDirectory, 5);
  const winningOperations = createRepositoryJournalOperations({ directory: concurrentDirectory });
  let winningResult;
  const staleOperations = createRepositoryJournalOperations({
    directory: concurrentDirectory,
    hooks: {
      beforeOperatorLock: async () => {
        winningResult = await winningOperations.retain({ maxRecords: 2, apply: true });
      },
    },
  });
  await assert.rejects(
    staleOperations.retain({ maxRecords: 4, apply: true }),
    (error) => error.code === "STATE_CHANGED",
    "a concurrent pure head truncation is detected from the exact raw-file digest",
  );
  assert.equal(winningResult.applied, true);
  assert.deepEqual((await concurrentJournal.read()).map((record) => record.sequence), [4, 5], "the stale operator cannot resurrect records removed by the winning retention");

  const nonCanonicalDirectory = join(root, "non-canonical");
  const nonCanonicalJournal = await addRecords(nonCanonicalDirectory, 1);
  const [canonicalRecord] = await nonCanonicalJournal.read();
  const reorderedRecord = { digest: canonicalRecord.digest, ...Object.fromEntries(Object.entries(canonicalRecord).filter(([key]) => key !== "digest")) };
  await writeFile(nonCanonicalJournal.path, `${JSON.stringify(reorderedRecord)}\n`, "utf8");
  const nonCanonicalInspection = await nonCanonicalJournal.inspect();
  assert.equal(nonCanonicalInspection.status, "corrupt");
  assert.equal(nonCanonicalInspection.error.code, "NON_CANONICAL_RECORD", "byte-different journal records cannot validate under an identical semantic digest");

  const tampered = JSON.parse(await readFile(exportedPath, "utf8"));
  tampered.records[0].payload.index = 999;
  const tamperedPath = join(root, "tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(restoredOperations.import({ input: tamperedPath, repository }), (error) => error.code === "INTEGRITY_FAILURE");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository journal operations tests passed: dry-run safety, receipts, rollback, bounded retention, corruption recovery, and cross-machine restore.");

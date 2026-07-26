import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  const tampered = JSON.parse(await readFile(exportedPath, "utf8"));
  tampered.records[0].payload.index = 999;
  const tamperedPath = join(root, "tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(restoredOperations.import({ input: tamperedPath, repository }), (error) => error.code === "INTEGRITY_FAILURE");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository journal operations tests passed: dry-run safety, receipts, rollback, bounded retention, corruption recovery, and cross-machine restore.");

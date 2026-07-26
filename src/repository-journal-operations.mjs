import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  acquireRepositoryJournalLock,
  createRepositoryJournal,
  REPOSITORY_JOURNAL_VERSION,
  RepositoryJournalError,
} from "./repository-journal.mjs";
import { createRepositoryJournalOutbox } from "./repository-journal-outbox.mjs";

export const REPOSITORY_JOURNAL_BUNDLE_VERSION = 1;

const JOURNAL_FILE = "repository-journal.jsonl";
const LOCK_FILE = "repository-journal.lock";
const UNSAFE_STATES = new Set([
  "dirty", "unpublished", "leased", "backoff", "dead_letter", "dead-letter",
  "indeterminate", "pending", "needs_user", "needs-user",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex");
}

function normalizedRepository(value) {
  if (value === null || value === undefined || value === "") return null;
  const repository = String(value).trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new RepositoryJournalError("repository must be an owner/name identifier.", { code: "INVALID_BINDING" });
  }
  return repository;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RepositoryJournalError(`${name} must be a positive integer.`, { code: "INVALID_ARGUMENT" });
  }
  return number;
}

function serializeRecords(records) {
  return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function acquireOperatorLock(directory, options) {
  return acquireRepositoryJournalLock(resolve(directory, LOCK_FILE), options);
}

function protectionReasons(value, path = "payload", reasons = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => protectionReasons(entry, `${path}[${index}]`, reasons));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = String(entry).trim().toLowerCase();
      if (["status", "state", "phase", "outcome"].includes(key.toLowerCase()) && UNSAFE_STATES.has(normalized)) {
        reasons.push(`${path}.${key}=${normalized}`);
      }
      protectionReasons(entry, `${path}.${key}`, reasons);
    }
  }
  return reasons;
}

function summarize(inspection) {
  const records = inspection.records || [];
  const protectedRecords = records.flatMap((record) => protectionReasons(record.payload).map((reason) => ({
    sequence: record.sequence,
    identity: record.identity,
    reason,
  })));
  return {
    status: inspection.status,
    error: inspection.error,
    repository: records[0]?.binding?.repository || null,
    recordCount: records.length,
    firstSequence: records[0]?.sequence || null,
    lastSequence: records.at(-1)?.sequence || null,
    firstDigest: records[0]?.digest || null,
    lastDigest: records.at(-1)?.digest || null,
    protectedRecords,
  };
}

function outboxKeyDigest(repository, idempotencyKey) {
  return sha256({ repository: normalizedRepository(repository), idempotencyKey });
}

async function protectedRecordsFor(journal, inspection, records = inspection.records || []) {
  const protectedRecords = records.flatMap((record) => protectionReasons(record.payload).map((reason) => ({
    sequence: record.sequence,
    identity: record.identity,
    reason,
  })));
  if (inspection.status !== "clean") return protectedRecords;
  const snapshot = await createRepositoryJournalOutbox({ journal }).inspect();
  const protectedKeys = new Map();
  for (const item of [...snapshot.pending, ...snapshot.deadLetter]) {
    if (!["leased", "backoff", "dead_letter"].includes(item.status)) continue;
    protectedKeys.set(outboxKeyDigest(item.binding.repository, item.idempotencyKey), item.status);
  }
  for (const record of records) {
    const keyDigest = record.payload?.repositoryOutbox?.keyDigest;
    const status = protectedKeys.get(keyDigest);
    if (status) {
      protectedRecords.push({
        sequence: record.sequence,
        identity: record.identity,
        reason: `outbox ${keyDigest} is ${status}`,
      });
    }
  }
  return protectedRecords;
}

function bundleFor(records, { operation, sourcePath, createdAt = new Date().toISOString() } = {}) {
  const repository = records[0]?.binding?.repository || null;
  const content = {
    version: REPOSITORY_JOURNAL_BUNDLE_VERSION,
    journalVersion: REPOSITORY_JOURNAL_VERSION,
    createdAt,
    operation,
    source: basename(sourcePath),
    repository,
    firstSequence: records[0]?.sequence || null,
    lastSequence: records.at(-1)?.sequence || null,
    firstDigest: records[0]?.digest || null,
    lastDigest: records.at(-1)?.digest || null,
    records,
  };
  return { ...content, checksum: sha256(content) };
}

function verifyBundle(document, { repository = null } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new RepositoryJournalError("Journal bundle must be a JSON object.", { code: "INVALID_BUNDLE" });
  }
  const { checksum, ...content } = document;
  if (document.version !== REPOSITORY_JOURNAL_BUNDLE_VERSION || document.journalVersion !== REPOSITORY_JOURNAL_VERSION) {
    throw new RepositoryJournalError("Journal bundle uses an unsupported version.", { code: "UNSUPPORTED_VERSION" });
  }
  if (!/^[0-9a-f]{64}$/.test(checksum || "") || checksum !== sha256(content)) {
    throw new RepositoryJournalError("Journal bundle checksum verification failed.", { code: "INTEGRITY_FAILURE" });
  }
  if (!Array.isArray(document.records)) {
    throw new RepositoryJournalError("Journal bundle records must be an array.", { code: "INVALID_BUNDLE" });
  }
  const expected = normalizedRepository(repository);
  if (expected && document.repository !== expected) {
    throw new RepositoryJournalError(`Journal bundle is bound to ${document.repository || "no repository"}, not ${expected}.`, { code: "REPOSITORY_MISMATCH" });
  }
  return document;
}

async function validateRecords(records, repository = null) {
  const temporary = await mkdtemp(resolve(tmpdir(), "agent-bridge-journal-validate-"));
  try {
    await writeFile(resolve(temporary, JOURNAL_FILE), serializeRecords(records), { mode: 0o600 });
    const journal = createRepositoryJournal({ directory: temporary });
    const inspection = await journal.inspect();
    if (inspection.status !== "clean") {
      throw new RepositoryJournalError(inspection.error?.message || "Journal validation failed.", {
        code: inspection.error?.code || "INTEGRITY_FAILURE",
        line: inspection.error?.line || null,
      });
    }
    const actualRepository = inspection.records[0]?.binding.repository || null;
    const expectedRepository = normalizedRepository(repository);
    if (expectedRepository && actualRepository !== expectedRepository) {
      throw new RepositoryJournalError(`Journal is bound to ${actualRepository || "no repository"}, not ${expectedRepository}.`, { code: "REPOSITORY_MISMATCH" });
    }
    return inspection;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeRecoveryReceipt(directory, records, operation, { receiptDirectory = null } = {}) {
  const destinationRoot = resolve(receiptDirectory || resolve(directory, "recovery"));
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const path = resolve(destinationRoot, `${stamp}-${operation}-${randomUUID()}.json`);
  const bundle = bundleFor(records, { operation: `recovery-before-${operation}`, sourcePath: resolve(directory, JOURNAL_FILE) });
  await atomicWrite(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    path,
    checksum: bundle.checksum,
    repository: bundle.repository,
    recordCount: records.length,
    firstSequence: bundle.firstSequence,
    lastSequence: bundle.lastSequence,
    restoreCommand: `bridge journal import --directory ${JSON.stringify(resolve(directory))} --input ${JSON.stringify(path)} --apply`,
  };
}

async function replaceJournal(directory, records) {
  await atomicWrite(resolve(directory, JOURNAL_FILE), serializeRecords(records));
}

function rawRecoveryEnvelope(raw, inspection, createdAt = new Date().toISOString()) {
  const content = {
    version: REPOSITORY_JOURNAL_BUNDLE_VERSION,
    createdAt,
    operation: "recovery-before-corruption-repair",
    repository: inspection.records[0]?.binding.repository || null,
    rawBase64: Buffer.from(raw, "utf8").toString("base64"),
    rawSha256: sha256(raw),
    validPrefix: inspection.records,
  };
  return { ...content, checksum: sha256(content) };
}

export function createRepositoryJournalOperations({
  directory,
  receiptDirectory = null,
  hooks = {},
  operatorLockTimeoutMs = undefined,
  operatorLockRetryMs = undefined,
} = {}) {
  if (!directory) throw new RepositoryJournalError("Repository journal directory is required.", { code: "INVALID_DIRECTORY" });
  const root = resolve(directory);
  const journal = createRepositoryJournal({ directory: root });
  const lockOptions = {
    ...(operatorLockTimeoutMs === undefined ? {} : { timeoutMs: operatorLockTimeoutMs }),
    ...(operatorLockRetryMs === undefined ? {} : { retryMs: operatorLockRetryMs }),
  };

  async function inspect() {
    const inspection = await journal.inspect();
    const result = summarize(inspection);
    if (inspection.status === "clean") {
      result.protectedRecords = await protectedRecordsFor(journal, inspection);
      const outbox = await createRepositoryJournalOutbox({ journal }).inspect();
      result.outbox = {
        pending: outbox.pending.length,
        leased: outbox.pending.filter((entry) => entry.status === "leased").length,
        backoff: outbox.pending.filter((entry) => entry.status === "backoff").length,
        deadLetter: outbox.deadLetter.length,
        acknowledged: outbox.acknowledged.length,
      };
    }
    return result;
  }

  async function exportBundle({ output = null, repository = null } = {}) {
    const records = await journal.read();
    const expected = normalizedRepository(repository);
    if (expected && records[0]?.binding.repository !== expected) {
      throw new RepositoryJournalError(`Journal is bound to ${records[0]?.binding.repository || "no repository"}, not ${expected}.`, { code: "REPOSITORY_MISMATCH" });
    }
    const bundle = bundleFor(records, { operation: "export", sourcePath: journal.path });
    if (output) await atomicWrite(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`);
    return { ...bundle, output: output ? resolve(output) : null };
  }

  async function archive({ output = null } = {}) {
    const destination = resolve(output || resolve(root, "archive", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}-repository-journal.json`));
    const inspection = await journal.inspect();
    if (inspection.status !== "clean") {
      const raw = await readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
      const envelope = rawRecoveryEnvelope(raw, inspection);
      await atomicWrite(destination, `${JSON.stringify(envelope, null, 2)}\n`);
      return {
        archived: true,
        destructive: false,
        corrupt: true,
        output: destination,
        checksum: envelope.checksum,
        rawSha256: envelope.rawSha256,
        recordCount: inspection.records.length,
        restoreCommand: `bridge journal restore --directory ${JSON.stringify(root)} --input ${JSON.stringify(destination)} --apply`,
      };
    }
    const records = inspection.records;
    const bundle = bundleFor(records, { operation: "archive", sourcePath: journal.path });
    await atomicWrite(destination, `${JSON.stringify(bundle, null, 2)}\n`);
    return { archived: true, destructive: false, output: destination, checksum: bundle.checksum, recordCount: records.length };
  }

  async function importBundle({ input, repository = null, apply = false } = {}) {
    if (!input) throw new RepositoryJournalError("import requires an input bundle.", { code: "INVALID_ARGUMENT" });
    const document = verifyBundle(JSON.parse(await readFile(resolve(input), "utf8")), { repository });
    const imported = await validateRecords(document.records, repository || document.repository);
    const current = await journal.inspect();
    if (current.status !== "clean") {
      throw new RepositoryJournalError("Import refuses to replace a corrupt journal; archive it and run journal recover first.", { code: "CORRUPT_TARGET" });
    }
    const preview = {
      operation: "import",
      dryRun: !apply,
      source: resolve(input),
      repository: document.repository,
      incoming: summarize(imported),
      replaced: summarize(current),
      recoveryReceipt: null,
    };
    const incomingDigests = new Set(document.records.map((record) => record.digest));
    const lost = current.records.filter((record) => !incomingDigests.has(record.digest));
    preview.protectedLost = await protectedRecordsFor(journal, current, lost);
    if (apply && preview.protectedLost.length) {
      throw new RepositoryJournalError(
        `Import refused: ${preview.protectedLost.length} protected record state(s) would be discarded.`,
        { code: "IMPORT_PROTECTED" },
      );
    }
    if (!apply) return preview;
    const originalRaw = await readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const release = await acquireOperatorLock(root, lockOptions);
    try {
      const fresh = await journal.inspect();
      if (fresh.status !== current.status || fresh.records.at(-1)?.digest !== current.records.at(-1)?.digest) {
        throw new RepositoryJournalError("Journal changed after import preview; retry the operation.", { code: "STATE_CHANGED" });
      }
      preview.recoveryReceipt = await writeRecoveryReceipt(root, fresh.records, "import", { receiptDirectory });
      await hooks.afterRecoveryReceipt?.(preview);
      await replaceJournal(root, document.records);
      await hooks.afterReplace?.(preview);
      return { ...preview, dryRun: false, applied: true };
    } catch (error) {
      if (preview.recoveryReceipt) await atomicWrite(journal.path, originalRaw).catch(() => {});
      throw error;
    } finally {
      await release();
    }
  }

  async function retention({ maxRecords, apply = false } = {}) {
    const limit = positiveInteger(maxRecords, "maxRecords");
    const current = await journal.inspect();
    if (current.status !== "clean") throw new RepositoryJournalError(current.error.message, { code: current.error.code, line: current.error.line });
    const clone = await mkdtemp(resolve(tmpdir(), "agent-bridge-journal-retain-"));
    let receipt;
    let retainedRecords;
    let currentProtectedRecords;
    try {
      await writeFile(resolve(clone, JOURNAL_FILE), serializeRecords(current.records), { mode: 0o600 });
      const cloneJournal = createRepositoryJournal({ directory: clone });
      const cloneOutbox = createRepositoryJournalOutbox({ journal: cloneJournal });
      currentProtectedRecords = await protectedRecordsFor(cloneJournal, current);
      receipt = await cloneOutbox.retain({ maxRecords: limit });
      retainedRecords = await cloneJournal.read();
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
    const retainedDigests = new Set(retainedRecords.map((record) => record.digest));
    const removed = current.records.filter((record) => !retainedDigests.has(record.digest));
    const removedDigests = new Set(removed.map((record) => record.digest));
    const protectedRemoved = currentProtectedRecords.filter((record) => record.sequence === null
      || removed.some((removedRecord) => removedRecord.sequence === record.sequence && removedDigests.has(removedRecord.digest)));
    if ((receipt.droppedDeadLetterItems || 0) > 0) {
      protectedRemoved.push({ sequence: null, identity: null, reason: `${receipt.droppedDeadLetterItems} dead-letter outbox item(s)` });
    }
    if (protectedRemoved.length) {
      throw new RepositoryJournalError(`Retention refused: ${protectedRemoved.length} protected record state(s) would be discarded.`, { code: "RETENTION_PROTECTED" });
    }
    const preview = {
      operation: "retain",
      dryRun: !apply,
      requestedMaxRecords: limit,
      before: summarize(current),
      after: summarize({ status: "clean", records: retainedRecords, error: null }),
      retention: receipt,
      removed: removed.map((record) => ({ sequence: record.sequence, identity: record.identity, digest: record.digest })),
      recoveryReceipt: null,
    };
    if (!apply) return preview;
    const originalRaw = await readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const release = await acquireOperatorLock(root, lockOptions);
    try {
      const fresh = await journal.inspect();
      if (fresh.status !== "clean" || fresh.records.at(-1)?.digest !== current.records.at(-1)?.digest) {
        throw new RepositoryJournalError("Journal changed after retention preview; retry the operation.", { code: "STATE_CHANGED" });
      }
      preview.recoveryReceipt = await writeRecoveryReceipt(root, fresh.records, "retain", { receiptDirectory });
      await hooks.afterRecoveryReceipt?.(preview);
      await replaceJournal(root, retainedRecords);
      await hooks.afterReplace?.(preview);
      return { ...preview, dryRun: false, applied: true };
    } catch (error) {
      if (preview.recoveryReceipt) await atomicWrite(journal.path, originalRaw).catch(() => {});
      throw error;
    } finally {
      await release();
    }
  }

  async function recover({ apply = false } = {}) {
    const initialRaw = await readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const current = await journal.inspect();
    if (current.status === "clean") return { operation: "recover", dryRun: !apply, required: false, current: summarize(current) };
    const validPrefix = current.records;
    const preview = {
      operation: "recover",
      dryRun: !apply,
      required: true,
      corruption: current.error,
      recoverable: summarize({ status: "clean", records: validPrefix, error: null }),
      discardedSuffix: { startsAtLine: current.error?.line || validPrefix.length + 1 },
      recoveryReceipt: null,
    };
    if (!apply) return preview;
    const release = await acquireOperatorLock(root, lockOptions);
    let originalRaw = null;
    let replaced = false;
    try {
      const fresh = await journal.inspect();
      const freshRaw = await readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
      if (sha256(freshRaw) !== sha256(initialRaw)
        || fresh.status !== current.status
        || fresh.error?.line !== current.error?.line
        || fresh.records.at(-1)?.digest !== current.records.at(-1)?.digest) {
        throw new RepositoryJournalError("Journal changed after recovery preview; retry the operation.", { code: "STATE_CHANGED" });
      }
      const raw = freshRaw;
      originalRaw = raw;
      const receiptPath = resolve(receiptDirectory || resolve(root, "recovery"), `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-corrupt-${randomUUID()}.json`);
      const envelope = rawRecoveryEnvelope(raw, fresh);
      await atomicWrite(receiptPath, `${JSON.stringify(envelope, null, 2)}\n`);
      preview.recoveryReceipt = {
        path: receiptPath,
        checksum: envelope.checksum,
        rawSha256: envelope.rawSha256,
        recordCount: validPrefix.length,
        firstSequence: validPrefix[0]?.sequence || null,
        lastSequence: validPrefix.at(-1)?.sequence || null,
        restoreCommand: `bridge journal restore --directory ${JSON.stringify(root)} --input ${JSON.stringify(receiptPath)} --apply`,
      };
      await hooks.afterRecoveryReceipt?.(preview);
      await replaceJournal(root, validPrefix);
      replaced = true;
      await hooks.afterReplace?.(preview);
      return { ...preview, dryRun: false, applied: true };
    } catch (error) {
      if (replaced && originalRaw !== null) await atomicWrite(journal.path, originalRaw).catch(() => {});
      throw error;
    } finally {
      await release();
    }
  }

  async function restoreRaw({ input, apply = false } = {}) {
    if (!input) throw new RepositoryJournalError("restore requires an input corruption receipt.", { code: "INVALID_ARGUMENT" });
    const document = JSON.parse(await readFile(resolve(input), "utf8"));
    const { checksum, ...content } = document || {};
    if (document?.version !== REPOSITORY_JOURNAL_BUNDLE_VERSION
      || document?.operation !== "recovery-before-corruption-repair"
      || checksum !== sha256(content)
      || typeof document.rawBase64 !== "string") {
      throw new RepositoryJournalError("Corruption recovery receipt verification failed.", { code: "INTEGRITY_FAILURE" });
    }
    const raw = Buffer.from(document.rawBase64, "base64").toString("utf8");
    if (sha256(raw) !== document.rawSha256) {
      throw new RepositoryJournalError("Corruption recovery raw-byte verification failed.", { code: "INTEGRITY_FAILURE" });
    }
    const readCurrentRaw = () => readFile(journal.path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const currentRaw = await readCurrentRaw();
    const currentInspection = await journal.inspect();
    const preview = {
      operation: "restore",
      dryRun: !apply,
      source: resolve(input),
      rawSha256: document.rawSha256,
      byteLength: Buffer.byteLength(raw),
      replacesRawSha256: sha256(currentRaw),
      breakGlass: true,
      replacedStatus: currentInspection.status,
      protectedReplaced: await protectedRecordsFor(journal, currentInspection),
      recoveryReceipt: null,
    };
    if (!apply) return preview;
    const release = await acquireOperatorLock(root, lockOptions);
    let replaced = false;
    try {
      const freshRaw = await readCurrentRaw();
      if (sha256(freshRaw) !== preview.replacesRawSha256) {
        throw new RepositoryJournalError("Journal changed after raw restore preview; retry the operation.", { code: "STATE_CHANGED" });
      }
      const freshInspection = await journal.inspect();
      if (freshInspection.status === "clean") {
        preview.recoveryReceipt = await writeRecoveryReceipt(root, freshInspection.records, "restore", { receiptDirectory });
      } else {
        const receiptPath = resolve(receiptDirectory || resolve(root, "recovery"), `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-restore-${randomUUID()}.json`);
        const envelope = rawRecoveryEnvelope(freshRaw, freshInspection);
        await atomicWrite(receiptPath, `${JSON.stringify(envelope, null, 2)}\n`);
        preview.recoveryReceipt = {
          path: receiptPath,
          checksum: envelope.checksum,
          rawSha256: envelope.rawSha256,
          recordCount: freshInspection.records.length,
          firstSequence: freshInspection.records[0]?.sequence || null,
          lastSequence: freshInspection.records.at(-1)?.sequence || null,
          restoreCommand: `bridge journal restore --directory ${JSON.stringify(root)} --input ${JSON.stringify(receiptPath)} --apply`,
        };
      }
      await hooks.afterRecoveryReceipt?.(preview);
      await atomicWrite(journal.path, raw);
      replaced = true;
      await hooks.afterReplace?.(preview);
      return { ...preview, dryRun: false, applied: true };
    } catch (error) {
      if (replaced) await atomicWrite(journal.path, currentRaw).catch(() => {});
      throw error;
    } finally {
      await release();
    }
  }

  return Object.freeze({ inspect, export: exportBundle, archive, import: importBundle, retain: retention, recover, restore: restoreRaw });
}

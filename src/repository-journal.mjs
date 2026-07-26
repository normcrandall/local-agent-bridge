import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const REPOSITORY_JOURNAL_VERSION = 1;

const JOURNAL_FILE = "repository-journal.jsonl";
const LOCK_FILE = "repository-journal.lock";
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 1_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;

export class RepositoryJournalError extends Error {
  constructor(message, { code = "REPOSITORY_JOURNAL_ERROR", line = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RepositoryJournalError";
    this.code = code;
    this.line = line;
  }
}

function canonicalize(value, path = "payload", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new RepositoryJournalError(`${path} must not contain circular references.`, { code: "INVALID_PAYLOAD" });
    seen.add(value);
    const result = value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) throw new RepositoryJournalError(`${path} must not contain circular references.`, { code: "INVALID_PAYLOAD" });
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        throw new RepositoryJournalError(`${path}.${key} is not JSON data.`, { code: "INVALID_PAYLOAD" });
      }
      result[key] = canonicalize(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new RepositoryJournalError(`${path} must contain only JSON data.`, { code: "INVALID_PAYLOAD" });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function positiveInteger(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RepositoryJournalError(`${name} must be a positive integer when supplied.`, { code: "INVALID_BINDING" });
  }
  return value;
}

function normalizeBinding({ repository, issueNumber = null, pullRequestNumber = null, headSha = null } = {}) {
  const normalizedRepository = String(repository || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalizedRepository)) {
    throw new RepositoryJournalError("repository must be an owner/name identifier.", { code: "INVALID_BINDING" });
  }
  const normalizedHead = headSha === undefined || headSha === null ? null : String(headSha).toLowerCase();
  if (normalizedHead !== null && !/^[0-9a-f]{40}$/.test(normalizedHead)) {
    throw new RepositoryJournalError("headSha must be an exact 40-character Git SHA when supplied.", { code: "INVALID_BINDING" });
  }
  return {
    repository: normalizedRepository,
    issueNumber: positiveInteger(issueNumber, "issueNumber"),
    pullRequestNumber: positiveInteger(pullRequestNumber, "pullRequestNumber"),
    headSha: normalizedHead,
  };
}

function validateIdentity(identity) {
  const normalized = String(identity || "").trim();
  if (!normalized || normalized.length > 256) {
    throw new RepositoryJournalError("identity must be a non-empty string no longer than 256 characters.", { code: "INVALID_IDENTITY" });
  }
  return normalized;
}

function recordContent(record) {
  const { digest: ignored, ...content } = record;
  return content;
}

function validateRecord(record, { line, previous = null, expectedRepository = null } = {}) {
  const fail = (message, code = "CORRUPT_RECORD") => {
    throw new RepositoryJournalError(`Repository journal record at line ${line} ${message}`, { code, line });
  };
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("must be an object.");
  if (record.version !== REPOSITORY_JOURNAL_VERSION) fail(`uses unsupported version ${String(record.version)}.`, "UNSUPPORTED_VERSION");
  if (!Number.isInteger(record.sequence) || record.sequence <= 0) fail("has an invalid sequence.");
  if (!record.identity || typeof record.identity !== "string") fail("has an invalid identity.");
  let binding;
  try { binding = normalizeBinding(record.binding); } catch (error) { fail(`has an invalid binding: ${error.message}`); }
  if (stableJson(binding) !== stableJson(record.binding)) fail("has a non-canonical binding.");
  if (expectedRepository && binding.repository !== expectedRepository) fail("crosses repository boundaries.", "REPOSITORY_MISMATCH");
  if (!record.recordedAt || !Number.isFinite(Date.parse(record.recordedAt))) fail("has an invalid recordedAt timestamp.");
  if (!/^[0-9a-f]{64}$/.test(record.fingerprint || "")) fail("has an invalid fingerprint.");
  if (record.previousDigest !== null && !/^[0-9a-f]{64}$/.test(record.previousDigest || "")) fail("has an invalid previousDigest.");
  if (!/^[0-9a-f]{64}$/.test(record.digest || "")) fail("has an invalid digest.");
  let payload;
  try { payload = canonicalize(record.payload); } catch (error) { fail(`has an invalid payload: ${error.message}`); }
  if (stableJson(payload) !== stableJson(record.payload)) fail("has a non-canonical payload.");
  const expectedFingerprint = digest({ identity: record.identity, binding, payload });
  if (record.fingerprint !== expectedFingerprint) fail("has a mismatched identity fingerprint.", "INTEGRITY_FAILURE");
  if (record.digest !== digest(recordContent(record))) fail("has a mismatched content digest.", "INTEGRITY_FAILURE");
  if (previous) {
    if (record.sequence !== previous.sequence + 1) fail(`does not follow sequence ${previous.sequence}.`, "SEQUENCE_GAP");
    if (record.previousDigest !== previous.digest) fail("does not link to the preceding record.", "INTEGRITY_FAILURE");
  }
  return { ...record, binding, payload };
}

async function readRaw(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function inspectRaw(raw) {
  if (!raw) return { status: "clean", records: [], error: null };
  const lines = raw.split("\n");
  const hasTornTail = lines.at(-1) !== "";
  const tornLine = hasTornTail ? lines.length : null;
  lines.pop();
  const records = [];
  let repository = null;
  try {
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) {
        throw new RepositoryJournalError(`Repository journal contains a blank record at line ${index + 1}.`, {
          code: "CORRUPT_RECORD",
          line: index + 1,
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(lines[index]);
      } catch (cause) {
        throw new RepositoryJournalError(`Repository journal contains malformed JSON at line ${index + 1}.`, {
          code: "CORRUPT_RECORD",
          line: index + 1,
          cause,
        });
      }
      const validated = validateRecord(parsed, {
        line: index + 1,
        previous: records.at(-1) || null,
        expectedRepository: repository,
      });
      repository ||= validated.binding.repository;
      records.push(validated);
    }
  } catch (error) {
    return { status: "corrupt", records, error };
  }
  if (hasTornTail) {
    return {
      status: "torn_tail",
      records,
      error: new RepositoryJournalError(`Repository journal has an unterminated tail at line ${tornLine}.`, {
        code: "TORN_TAIL",
        line: tornLine,
      }),
    };
  }
  return { status: "clean", records, error: null };
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function ownerIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquireLock(path, { timeoutMs, retryMs }) {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
      await handle.sync();
      return async () => {
        await handle.close().catch(() => {});
        try {
          const owner = JSON.parse(await readFile(path, "utf8"));
          if (owner.token === token) await unlink(path);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const [owner, info] = await Promise.all([
          readFile(path, "utf8").then(JSON.parse),
          stat(path),
        ]);
        if (!(await ownerIsAlive(owner.pid)) && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(retryMs);
    }
  }
  throw new RepositoryJournalError(`Timed out acquiring repository journal lock: ${path}`, { code: "LOCK_TIMEOUT" });
}

function strictRecords(inspection) {
  if (inspection.status !== "clean") throw inspection.error;
  return inspection.records;
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_EXPORT_LIMIT) {
    throw new RepositoryJournalError(`limit must be an integer from 1 through ${MAX_EXPORT_LIMIT}.`, { code: "INVALID_LIMIT" });
  }
  return limit;
}

export function createRepositoryJournal({
  directory,
  now = () => new Date().toISOString(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
} = {}) {
  if (!directory) throw new RepositoryJournalError("Repository journal directory is required.", { code: "INVALID_DIRECTORY" });
  const root = resolve(directory);
  const path = resolve(root, JOURNAL_FILE);
  const lockPath = resolve(root, LOCK_FILE);

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }

  async function inspect() {
    await initialize();
    const result = inspectRaw(await readRaw(path));
    return {
      status: result.status,
      records: structuredClone(result.records),
      error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message, line: result.error.line } : null,
    };
  }

  async function read() {
    await initialize();
    return structuredClone(strictRecords(inspectRaw(await readRaw(path))));
  }

  async function append({ identity, repository, issueNumber = null, pullRequestNumber = null, headSha = null, payload }) {
    await initialize();
    const normalizedIdentity = validateIdentity(identity);
    const binding = normalizeBinding({ repository, issueNumber, pullRequestNumber, headSha });
    const normalizedPayload = canonicalize(payload);
    const fingerprint = digest({ identity: normalizedIdentity, binding, payload: normalizedPayload });
    const release = await acquireLock(lockPath, { timeoutMs: lockTimeoutMs, retryMs: lockRetryMs });
    try {
      const records = strictRecords(inspectRaw(await readRaw(path)));
      if (records.length && records[0].binding.repository !== binding.repository) {
        throw new RepositoryJournalError(
          `Journal is bound to ${records[0].binding.repository}; refusing record for ${binding.repository}.`,
          { code: "REPOSITORY_MISMATCH" },
        );
      }
      const existing = records.find((record) => record.identity === normalizedIdentity);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new RepositoryJournalError(
            `Identity ${normalizedIdentity} is already bound to different repository metadata or payload.`,
            { code: "IDENTITY_CONFLICT" },
          );
        }
        return { record: structuredClone(existing), idempotent: true };
      }
      const previous = records.at(-1) || null;
      const recordedAt = now();
      if (!Number.isFinite(Date.parse(recordedAt))) {
        throw new RepositoryJournalError("Journal clock returned an invalid timestamp.", { code: "INVALID_TIMESTAMP" });
      }
      const content = {
        version: REPOSITORY_JOURNAL_VERSION,
        sequence: (previous?.sequence || 0) + 1,
        identity: normalizedIdentity,
        binding,
        recordedAt,
        payload: normalizedPayload,
        fingerprint,
        previousDigest: previous?.digest || null,
      };
      const record = { ...content, digest: digest(content) };
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { record: structuredClone(record), idempotent: false };
    } finally {
      await release();
    }
  }

  async function exportRecords({ afterSequence = 0, limit = DEFAULT_EXPORT_LIMIT } = {}) {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new RepositoryJournalError("afterSequence must be a non-negative integer.", { code: "INVALID_CURSOR" });
    }
    const boundedLimit = normalizeLimit(limit);
    const records = await read();
    const eligible = records.filter((record) => record.sequence > afterSequence);
    const selected = eligible.slice(0, boundedLimit);
    return {
      version: REPOSITORY_JOURNAL_VERSION,
      repository: records[0]?.binding.repository || null,
      records: selected,
      hasMore: eligible.length > selected.length,
      nextSequence: selected.at(-1)?.sequence ?? afterSequence,
    };
  }

  async function retain({ maxRecords }) {
    normalizeLimit(maxRecords);
    await initialize();
    const release = await acquireLock(lockPath, { timeoutMs: lockTimeoutMs, retryMs: lockRetryMs });
    try {
      const records = strictRecords(inspectRaw(await readRaw(path)));
      if (records.length <= maxRecords) return { removed: 0, retained: records.length, firstSequence: records[0]?.sequence || null };
      const retained = records.slice(-maxRecords);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
      await rename(temporary, path);
      return { removed: records.length - retained.length, retained: retained.length, firstSequence: retained[0].sequence };
    } finally {
      await release();
    }
  }

  return Object.freeze({ path, append, read, inspect, export: exportRecords, retain });
}

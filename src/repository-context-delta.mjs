import { createHash } from "node:crypto";
import { redactSecretsAndInjectionFromText } from "./context-capsule.mjs";

/**
 * Repository context deltas are an optimization and evidence-transport format.
 * They deliberately carry no authority to read or mutate GitHub, approve a
 * review, or merge a pull request.
 */
export const REPOSITORY_CONTEXT_DELTA_VERSION = 1;
export const DEFAULT_CONTEXT_DELTA_MAX_EVENTS = 25;
export const DEFAULT_CONTEXT_DELTA_MAX_BYTES = 32 * 1024;
export const MAX_CONTEXT_DELTA_EVENTS = 250;
export const MAX_CONTEXT_DELTA_BYTES = 256 * 1024;

const PRIVATE_FIELD_NAMES = new Set([
  "reasoning", "privatereasoning", "chainofthought", "scratchpad", "internalthought", "internalthoughts",
  "transcript", "rawtranscript", "fulltranscript", "messages", "conversation", "turns", "rawoutput", "stdout", "stderr",
]);
const SECRET_FIELD_PARTS = ["authorization", "credential", "password", "passwd", "secret", "token", "apikey", "privatekey", "cookie", "sessionkey"];
const CURSOR_FIELDS = ["version", "repository", "collaborationId", "laneId", "afterSequence"];

export class RepositoryContextDeltaError extends Error {
  constructor(message, { code = "REPOSITORY_CONTEXT_DELTA_ERROR", reason = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RepositoryContextDeltaError";
    this.code = code;
    this.reason = reason;
  }
}

function stableValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  throw new RepositoryContextDeltaError("Context delta values must contain only JSON data.", { code: "INVALID_INPUT" });
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeRepository(repository) {
  const value = String(repository || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value)) {
    throw new RepositoryContextDeltaError("repository must be an owner/name identifier.", { code: "INVALID_BINDING" });
  }
  return value;
}

function normalizeIdentity(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 256) {
    throw new RepositoryContextDeltaError(`${name} must be a non-empty string no longer than 256 characters.`, { code: "INVALID_BINDING" });
  }
  return normalized;
}

function normalizeBounds({ maxEvents = DEFAULT_CONTEXT_DELTA_MAX_EVENTS, maxBytes = DEFAULT_CONTEXT_DELTA_MAX_BYTES } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents <= 0 || maxEvents > MAX_CONTEXT_DELTA_EVENTS) {
    throw new RepositoryContextDeltaError(`maxEvents must be an integer from 1 through ${MAX_CONTEXT_DELTA_EVENTS}.`, { code: "INVALID_BOUNDS" });
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CONTEXT_DELTA_BYTES) {
    throw new RepositoryContextDeltaError(`maxBytes must be an integer from 1 through ${MAX_CONTEXT_DELTA_BYTES}.`, { code: "INVALID_BOUNDS" });
  }
  return { maxEvents, maxBytes };
}

function normalizedFieldName(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretField(key) {
  const normalized = normalizedFieldName(key);
  return SECRET_FIELD_PARTS.some((part) => normalized === part || normalized.endsWith(part));
}

function cursorContent({ repository, collaborationId, laneId, afterSequence }) {
  return {
    version: REPOSITORY_CONTEXT_DELTA_VERSION,
    repository: normalizeRepository(repository),
    collaborationId: normalizeIdentity(collaborationId, "collaborationId"),
    laneId: normalizeIdentity(laneId, "laneId"),
    afterSequence,
  };
}

export function createRepositoryContextCursor({ repository, collaborationId, laneId, afterSequence = 0 }) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RepositoryContextDeltaError("afterSequence must be a non-negative safe integer.", { code: "INVALID_CURSOR" });
  }
  const content = cursorContent({ repository, collaborationId, laneId, afterSequence });
  return Object.freeze({ ...content, checksum: digest(content) });
}

function resync(reason, details = {}) {
  return {
    required: true,
    reason,
    ...details,
  };
}

export function inspectRepositoryContextCursor(cursor, binding) {
  let expected;
  try {
    expected = cursorContent({ ...binding, afterSequence: 0 });
  } catch (error) {
    throw error;
  }
  if (cursor === null || cursor === undefined) {
    return { valid: true, afterSequence: 0, cursor: createRepositoryContextCursor(expected), resync: null };
  }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("corrupt_cursor") };
  }
  if (Object.keys(cursor).sort().join(",") !== [...CURSOR_FIELDS, "checksum"].sort().join(",")) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("corrupt_cursor") };
  }
  if (cursor.version !== REPOSITORY_CONTEXT_DELTA_VERSION) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("unsupported_cursor_version", { cursorVersion: cursor.version }) };
  }
  if (!Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0 || !/^[0-9a-f]{64}$/.test(cursor.checksum || "")) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("corrupt_cursor") };
  }
  const content = Object.fromEntries(CURSOR_FIELDS.map((key) => [key, cursor[key]]));
  let normalized;
  try {
    normalized = cursorContent(content);
  } catch {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("corrupt_cursor") };
  }
  if (cursor.checksum !== digest(normalized)) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("corrupt_cursor") };
  }
  if (normalized.repository !== expected.repository) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("foreign_repository", { expectedRepository: expected.repository }) };
  }
  if (normalized.collaborationId !== expected.collaborationId || normalized.laneId !== expected.laneId) {
    return { valid: false, afterSequence: null, cursor: null, resync: resync("foreign_lane", {
      expectedCollaborationId: expected.collaborationId,
      expectedLaneId: expected.laneId,
    }) };
  }
  return { valid: true, afterSequence: normalized.afterSequence, cursor: Object.freeze({ ...cursor }), resync: null };
}

function sanitize(value, redactions, path = "payload", seen = new Set()) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") {
    const clean = redactSecretsAndInjectionFromText(value);
    if (clean !== value) redactions.push({ path, reason: "secret" });
    return clean;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new RepositoryContextDeltaError("Journal payload contains a circular value.", { code: "INVALID_RECORD" });
    seen.add(value);
    const result = value.map((entry, index) => sanitize(entry, redactions, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new RepositoryContextDeltaError("Journal payload contains a circular value.", { code: "INVALID_RECORD" });
    seen.add(value);
    const recordType = normalizedFieldName(value.type || value.kind || "");
    if (["reasoning", "thinking", "privatereasoning", "chainofthought"].includes(recordType)) {
      seen.delete(value);
      redactions.push({ path, reason: "private_reasoning_or_transcript" });
      return { type: String(value.type || value.kind), redacted: "<REDACTED_PRIVATE_REASONING>" };
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (PRIVATE_FIELD_NAMES.has(normalizedFieldName(key))) {
        redactions.push({ path: `${path}.${key}`, reason: "private_reasoning_or_transcript" });
        continue;
      }
      if (isSecretField(key)) {
        redactions.push({ path: `${path}.${key}`, reason: "credential" });
        continue;
      }
      result[key] = sanitize(value[key], redactions, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new RepositoryContextDeltaError("Journal payload contains non-JSON data.", { code: "INVALID_RECORD" });
}

export function redactRepositoryContextRecord(record) {
  const redactions = [];
  const payload = sanitize(record.payload, redactions);
  const compact = {
    sequence: record.sequence,
    identity: record.identity,
    recordedAt: record.recordedAt,
    binding: record.binding,
    payload,
  };
  if (redactions.length) compact.redactions = redactions;
  return stableValue(compact);
}

function validateSequence(records, expectedFirst = null) {
  let previous = null;
  for (const record of records) {
    if (!record || !Number.isSafeInteger(record.sequence) || record.sequence <= 0) return false;
    if (previous === null && expectedFirst !== null && record.sequence !== expectedFirst) return false;
    if (previous !== null && record.sequence !== previous + 1) return false;
    previous = record.sequence;
  }
  return true;
}

export async function readRepositoryContextDelta({
  journal,
  repository,
  collaborationId,
  laneId,
  cursor = null,
  maxEvents,
  maxBytes,
} = {}) {
  if (!journal || typeof journal.export !== "function" || typeof journal.read !== "function") {
    throw new RepositoryContextDeltaError("A repository journal with export() and read() is required.", { code: "INVALID_JOURNAL" });
  }
  const binding = { repository, collaborationId, laneId };
  const bounds = normalizeBounds({ maxEvents, maxBytes });
  const inspected = inspectRepositoryContextCursor(cursor, binding);
  if (!inspected.valid) return deltaEnvelope({ binding, cursor, bounds, resyncRequired: inspected.resync });

  let page;
  try {
    page = await journal.export({ afterSequence: inspected.afterSequence, limit: MAX_CONTEXT_DELTA_EVENTS });
  } catch (cause) {
    return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("journal_unverifiable", { journalCode: cause?.code || null }) });
  }
  if (page.repository && normalizeRepository(page.repository) !== normalizeRepository(repository)) {
    return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("foreign_repository", { journalRepository: page.repository }) });
  }
  if (page.cursorGap) {
    return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("out_of_retention", page.cursorGap) });
  }
  if (!Array.isArray(page.records) || !validateSequence(page.records, inspected.afterSequence + 1)) {
    return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("journal_sequence_invalid") });
  }
  let latestSequence = page.records.at(-1)?.sequence ?? inspected.afterSequence;
  if (!page.records.length && inspected.afterSequence > 0) {
    try {
      const retained = await journal.read();
      if (!Array.isArray(retained) || !validateSequence(retained)) {
        return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("journal_sequence_invalid") });
      }
      latestSequence = retained.at(-1)?.sequence ?? 0;
    } catch (cause) {
      return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("journal_unverifiable", { journalCode: cause?.code || null }) });
    }
  }
  if (inspected.afterSequence > latestSequence && !page.hasMore) {
    return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("stale_cursor", { latestSequence }) });
  }

  const records = [];
  let bytes = 0;
  for (const record of page.records) {
    if (record.sequence <= inspected.afterSequence) continue;
    let compact;
    try {
      compact = redactRepositoryContextRecord(record);
    } catch (cause) {
      return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("record_unverifiable", { sequence: record.sequence, recordCode: cause?.code || null }) });
    }
    const recordBytes = byteLength(compact);
    if (!records.length && recordBytes > bounds.maxBytes) {
      return deltaEnvelope({ binding, cursor: inspected.cursor, bounds, resyncRequired: resync("record_exceeds_bounds", { sequence: record.sequence, recordBytes }) });
    }
    if (records.length >= bounds.maxEvents || bytes + recordBytes > bounds.maxBytes) break;
    records.push(compact);
    bytes += recordBytes;
  }
  const afterSequence = records.at(-1)?.sequence ?? inspected.afterSequence;
  const nextCursor = createRepositoryContextCursor({ ...binding, afterSequence });
  return deltaEnvelope({
    binding,
    cursor: nextCursor,
    bounds,
    records,
    bytes,
    hasMore: Boolean(page.hasMore || page.records.some((record) => record.sequence > afterSequence)),
  });
}

function deltaEnvelope({ binding, cursor, bounds, records = [], bytes = 0, hasMore = false, resyncRequired = null }) {
  return {
    version: REPOSITORY_CONTEXT_DELTA_VERSION,
    kind: "repository_context_delta",
    authority: "none",
    binding: {
      repository: normalizeRepository(binding.repository),
      collaborationId: normalizeIdentity(binding.collaborationId, "collaborationId"),
      laneId: normalizeIdentity(binding.laneId, "laneId"),
    },
    cursor: cursor || null,
    records,
    eventCount: records.length,
    byteCount: bytes,
    bounds,
    hasMore,
    resyncRequired,
  };
}

export function createRepositoryContextDeltaKernel({ journal, repository, collaborationId, laneId, maxEvents, maxBytes } = {}) {
  const binding = { repository, collaborationId, laneId };
  normalizeRepository(repository);
  normalizeIdentity(collaborationId, "collaborationId");
  normalizeIdentity(laneId, "laneId");
  normalizeBounds({ maxEvents, maxBytes });
  return Object.freeze({
    initialCursor: () => createRepositoryContextCursor({ ...binding, afterSequence: 0 }),
    read: ({ cursor = null, maxEvents: requestedEvents = maxEvents, maxBytes: requestedBytes = maxBytes } = {}) => readRepositoryContextDelta({
      journal,
      ...binding,
      cursor,
      maxEvents: requestedEvents,
      maxBytes: requestedBytes,
    }),
  });
}

import { createHash, randomUUID } from "node:crypto";

export const REPOSITORY_JOURNAL_OUTBOX_VERSION = 1;

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CLAIM_LIMIT = 100;
const SECRET_FIELD = /(authorization|credential|password|passwd|secret|token|apikey|privatekey)/i;

export class RepositoryJournalOutboxError extends Error {
  constructor(message, { code = "REPOSITORY_JOURNAL_OUTBOX_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RepositoryJournalOutboxError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new RepositoryJournalOutboxError(message, { code });
}

function requiredString(value, name, maxLength = 256) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) fail(`${name} must be a non-empty string no longer than ${maxLength} characters.`, "INVALID_ENTRY");
  return normalized;
}

function positiveInteger(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer when supplied.`, "INVALID_ENTRY");
  return value;
}

function exactHead(value, name = "headSha") {
  if (value === null || value === undefined) return null;
  const normalized = String(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) fail(`${name} must be an exact 40-character Git SHA when supplied.`, "INVALID_ENTRY");
  return normalized;
}

function canonicalize(value, path = "payload", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(`${path} must not contain circular references.`, "INVALID_PAYLOAD");
    seen.add(value);
    const result = value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) fail(`${path} must not contain circular references.`, "INVALID_PAYLOAD");
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (SECRET_FIELD.test(key.replaceAll(/[^a-z0-9]/gi, ""))) fail(`${path}.${key} looks like a secret-bearing field and is not permitted.`, "SECRET_FIELD");
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        fail(`${path}.${key} is not JSON data.`, "INVALID_PAYLOAD");
      }
      result[key] = canonicalize(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  fail(`${path} must contain only JSON data.`, "INVALID_PAYLOAD");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isoNow(now) {
  const value = now();
  if (!Number.isFinite(Date.parse(value))) fail("Outbox clock returned an invalid timestamp.", "INVALID_TIMESTAMP");
  return value;
}

function millis(value, name, { minimum = 1 } = {}) {
  if (!Number.isInteger(value) || value < minimum) fail(`${name} must be an integer of at least ${minimum}.`, "INVALID_CONFIGURATION");
  return value;
}

function eventIdentity(keyDigest, event, ordinal = 0) {
  return `repository-outbox:${keyDigest}:${event}:${ordinal}`;
}

function outboxEvent(record) {
  const event = record?.payload?.repositoryOutbox;
  if (event === undefined || event === null) return null;
  if (event.version !== REPOSITORY_JOURNAL_OUTBOX_VERSION) {
    fail(`Repository outbox event uses unsupported version ${String(event.version)}.`, "UNSUPPORTED_VERSION");
  }
  return event;
}

function classifyFailure(failure = {}) {
  const kind = String(failure.kind || "").trim().toLowerCase();
  const statusCode = Number.isInteger(failure.statusCode) ? failure.statusCode : null;
  const terminalKinds = new Set(["authentication", "authorization", "policy", "invalid_request"]);
  const retryKinds = new Set(["network", "timeout", "connection", "rate_limit", "server"]);
  if (terminalKinds.has(kind)) return { terminal: true, classification: kind };
  if (statusCode === 401) return { terminal: true, classification: "authentication" };
  if (statusCode === 403) return { terminal: true, classification: "authorization" };
  if (statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return { terminal: true, classification: "invalid_request" };
  }
  if (statusCode === 429 || kind === "rate_limit") return { terminal: false, classification: "rate_limit" };
  if ((statusCode !== null && statusCode >= 500 && statusCode <= 599) || retryKinds.has(kind)) {
    return { terminal: false, classification: kind || "server" };
  }
  return { terminal: true, classification: kind || "invalid_request" };
}

function reconstruct(records, nowMs) {
  const items = new Map();
  for (const record of records) {
    const event = outboxEvent(record);
    if (!event) continue;
    if (event.event === "enqueued") {
      if (!items.has(event.keyDigest)) {
        items.set(event.keyDigest, {
          keyDigest: event.keyDigest,
          idempotencyKey: event.idempotencyKey,
          operation: event.operation,
          binding: record.binding,
          payload: event.payload,
          payloadDigest: event.payloadDigest,
          enqueuedAt: event.at,
          enqueueSequence: record.sequence,
          claimCount: 0,
          lease: null,
          acknowledgedAt: null,
          failure: null,
          retryAt: null,
          terminal: false,
        });
      }
      continue;
    }
    const item = items.get(event.keyDigest);
    if (!item) {
      fail("Repository outbox history is missing the enqueue record required to reconstruct an item.", "OUTBOX_HISTORY_GAP");
    }
    if (event.event === "claimed") {
      item.claimCount = Math.max(item.claimCount, event.claimOrdinal);
      item.lease = {
        claimOrdinal: event.claimOrdinal,
        leaseId: event.leaseId,
        workerId: event.workerId,
        claimedAt: event.at,
        expiresAt: event.expiresAt,
      };
      item.failure = null;
      item.retryAt = null;
    } else if (event.event === "acknowledged" && item.lease?.leaseId === event.leaseId) {
      item.acknowledgedAt = event.at;
      item.lease = null;
    } else if (event.event === "failed" && item.lease?.leaseId === event.leaseId) {
      item.failure = {
        classification: event.classification,
        message: event.message,
        statusCode: event.statusCode,
        failedAt: event.at,
      };
      item.retryAt = event.retryAt;
      item.terminal = event.terminal;
      item.lease = null;
    }
  }
  for (const item of items.values()) {
    if (item.lease && Date.parse(item.lease.expiresAt) <= nowMs) item.lease = null;
  }
  return items;
}

function publicItem(item, nowMs, maxAttempts) {
  const exhausted = !item.acknowledgedAt && !item.lease && item.claimCount >= maxAttempts;
  const terminal = item.terminal || exhausted;
  const due = !item.acknowledgedAt && !terminal && !item.lease && (!item.retryAt || Date.parse(item.retryAt) <= nowMs);
  return structuredClone({
    version: REPOSITORY_JOURNAL_OUTBOX_VERSION,
    idempotencyKey: item.idempotencyKey,
    operation: item.operation,
    binding: item.binding,
    payload: item.payload,
    enqueuedAt: item.enqueuedAt,
    claimCount: item.claimCount,
    lease: item.lease,
    acknowledgedAt: item.acknowledgedAt,
    retryAt: item.retryAt,
    failure: item.failure,
    status: item.acknowledgedAt ? "acknowledged" : terminal ? "dead_letter" : item.lease ? "leased" : due ? "pending" : "backoff",
  });
}

export function createRepositoryJournalOutbox({
  journal,
  now = () => new Date().toISOString(),
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
} = {}) {
  if (!journal || typeof journal.append !== "function" || typeof journal.read !== "function") {
    fail("A repository journal with append() and read() is required.", "INVALID_JOURNAL");
  }
  millis(leaseMs, "leaseMs");
  millis(maxAttempts, "maxAttempts");
  millis(baseBackoffMs, "baseBackoffMs");
  millis(maxBackoffMs, "maxBackoffMs");
  millis(maxPayloadBytes, "maxPayloadBytes");
  if (baseBackoffMs > maxBackoffMs) fail("baseBackoffMs must not exceed maxBackoffMs.", "INVALID_CONFIGURATION");

  async function state() {
    const nowAt = isoNow(now);
    return { nowAt, nowMs: Date.parse(nowAt), items: reconstruct(await journal.read(), Date.parse(nowAt)) };
  }

  async function enqueue({ repository, operation, idempotencyKey, issueNumber = null, pullRequestNumber = null, headSha = null, payload }) {
    const normalizedOperation = requiredString(operation, "operation", 128);
    const normalizedKey = requiredString(idempotencyKey, "idempotencyKey", 256);
    const normalizedPayload = canonicalize(payload);
    const serialized = stableJson(normalizedPayload);
    if (Buffer.byteLength(serialized, "utf8") > maxPayloadBytes) fail(`payload exceeds the ${maxPayloadBytes}-byte limit.`, "PAYLOAD_TOO_LARGE");
    const binding = {
      repository: requiredString(repository, "repository", 256).toLowerCase(),
      issueNumber: positiveInteger(issueNumber, "issueNumber"),
      pullRequestNumber: positiveInteger(pullRequestNumber, "pullRequestNumber"),
      headSha: exactHead(headSha),
    };
    const keyDigest = hash({ repository: binding.repository, idempotencyKey: normalizedKey });
    const event = {
      version: REPOSITORY_JOURNAL_OUTBOX_VERSION,
      event: "enqueued",
      keyDigest,
      idempotencyKey: normalizedKey,
      operation: normalizedOperation,
      payload: normalizedPayload,
      payloadDigest: hash(normalizedPayload),
      at: isoNow(now),
    };
    try {
      const result = await journal.append({
        identity: eventIdentity(keyDigest, "enqueue"),
        ...binding,
        payload: { repositoryOutbox: event },
      });
      const records = await journal.read();
      return { entry: publicItem(reconstruct(records, Date.parse(event.at)).get(keyDigest), Date.parse(event.at), maxAttempts), idempotent: result.idempotent };
    } catch (error) {
      if (error?.code === "IDENTITY_CONFLICT") {
        const records = await journal.read();
        const existingRecord = records.find((record) => record.identity === eventIdentity(keyDigest, "enqueue"));
        const existing = outboxEvent(existingRecord);
        const equivalent = existing?.event === "enqueued"
          && existing.operation === normalizedOperation
          && existing.idempotencyKey === normalizedKey
          && existing.payloadDigest === event.payloadDigest
          && stableJson(existing.payload) === stableJson(normalizedPayload)
          && stableJson(existingRecord.binding) === stableJson(binding);
        if (equivalent) {
          return {
            entry: publicItem(reconstruct(records, Date.parse(event.at)).get(keyDigest), Date.parse(event.at), maxAttempts),
            idempotent: true,
          };
        }
        throw new RepositoryJournalOutboxError(`Idempotency key ${normalizedKey} is already bound to a different operation, binding, or payload.`, {
          code: "IDEMPOTENCY_CONFLICT",
          cause: error,
        });
      }
      throw error;
    }
  }

  async function claim({ workerId, limit = 1, leaseDurationMs = leaseMs } = {}) {
    const normalizedWorker = requiredString(workerId, "workerId", 256);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_CLAIM_LIMIT) fail(`limit must be from 1 through ${MAX_CLAIM_LIMIT}.`, "INVALID_LIMIT");
    millis(leaseDurationMs, "leaseDurationMs");
    const claimed = [];
    while (claimed.length < limit) {
      const snapshot = await state();
      const candidates = [...snapshot.items.values()]
        .filter((item) => publicItem(item, snapshot.nowMs, maxAttempts).status === "pending")
        .sort((left, right) => (left.retryAt || left.enqueuedAt).localeCompare(right.retryAt || right.enqueuedAt)
          || left.enqueueSequence - right.enqueueSequence
          || left.idempotencyKey.localeCompare(right.idempotencyKey));
      const candidate = candidates.find((item) => !claimed.some((entry) => entry.idempotencyKey === item.idempotencyKey));
      if (!candidate) break;
      const claimOrdinal = candidate.claimCount + 1;
      const leaseId = randomUUID();
      const at = snapshot.nowAt;
      const expiresAt = new Date(snapshot.nowMs + leaseDurationMs).toISOString();
      const event = { version: REPOSITORY_JOURNAL_OUTBOX_VERSION, event: "claimed", keyDigest: candidate.keyDigest, claimOrdinal, leaseId, workerId: normalizedWorker, at, expiresAt };
      try {
        const result = await journal.append({
          identity: eventIdentity(candidate.keyDigest, "claim", claimOrdinal),
          ...candidate.binding,
          payload: { repositoryOutbox: event },
        });
        if (result.idempotent || result.record.payload.repositoryOutbox.leaseId !== leaseId) continue;
        claimed.push(publicItem({ ...candidate, claimCount: claimOrdinal, lease: { claimOrdinal, leaseId, workerId: normalizedWorker, claimedAt: at, expiresAt } }, snapshot.nowMs, maxAttempts));
      } catch (error) {
        if (error?.code !== "IDENTITY_CONFLICT") throw error;
      }
    }
    return claimed;
  }

  async function requireLease(leaseId) {
    const normalizedLease = requiredString(leaseId, "leaseId", 128);
    const snapshot = await state();
    const item = [...snapshot.items.values()].find((entry) => entry.lease?.leaseId === normalizedLease);
    if (!item) fail("The lease is absent, expired, or already completed.", "STALE_LEASE");
    return { ...snapshot, item, leaseId: normalizedLease };
  }

  async function acknowledge({ leaseId, headSha = null } = {}) {
    const snapshot = await requireLease(leaseId);
    const boundHead = snapshot.item.binding.headSha;
    const acknowledgedHead = exactHead(headSha, "headSha");
    if (boundHead && acknowledgedHead !== boundHead) fail("Acknowledgement headSha must exactly match the entry binding.", "HEAD_MISMATCH");
    if (!boundHead && acknowledgedHead) fail("An unbound entry cannot be acknowledged against a head SHA.", "HEAD_MISMATCH");
    const event = { version: REPOSITORY_JOURNAL_OUTBOX_VERSION, event: "acknowledged", keyDigest: snapshot.item.keyDigest, leaseId: snapshot.leaseId, headSha: acknowledgedHead, at: snapshot.nowAt };
    const result = await journal.append({
      identity: eventIdentity(snapshot.item.keyDigest, "ack", snapshot.item.claimCount),
      ...snapshot.item.binding,
      payload: { repositoryOutbox: event },
    });
    return { acknowledged: true, idempotent: result.idempotent, entry: publicItem({ ...snapshot.item, acknowledgedAt: event.at, lease: null }, snapshot.nowMs, maxAttempts) };
  }

  async function recordFailure({ leaseId, failure = {} } = {}) {
    const snapshot = await requireLease(leaseId);
    const classified = classifyFailure(failure);
    const retryAfterMs = failure.retryAfterMs === null || failure.retryAfterMs === undefined ? 0 : millis(failure.retryAfterMs, "retryAfterMs", { minimum: 0 });
    const exponential = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, snapshot.item.claimCount - 1)));
    const delayMs = Math.min(maxBackoffMs, Math.max(exponential, retryAfterMs));
    const terminal = classified.terminal || snapshot.item.claimCount >= maxAttempts;
    const retryAt = terminal ? null : new Date(snapshot.nowMs + delayMs).toISOString();
    const message = String(failure.message || classified.classification).slice(0, 1_024);
    const event = {
      version: REPOSITORY_JOURNAL_OUTBOX_VERSION,
      event: "failed",
      keyDigest: snapshot.item.keyDigest,
      leaseId: snapshot.leaseId,
      classification: classified.classification,
      statusCode: Number.isInteger(failure.statusCode) ? failure.statusCode : null,
      message,
      terminal,
      retryAt,
      at: snapshot.nowAt,
    };
    const result = await journal.append({
      identity: eventIdentity(snapshot.item.keyDigest, "fail", snapshot.item.claimCount),
      ...snapshot.item.binding,
      payload: { repositoryOutbox: event },
    });
    const next = { ...snapshot.item, lease: null, terminal, retryAt, failure: { classification: event.classification, message, statusCode: event.statusCode, failedAt: event.at } };
    return { terminal, retryAt, idempotent: result.idempotent, entry: publicItem(next, snapshot.nowMs, maxAttempts) };
  }

  async function inspect() {
    const snapshot = await state();
    const entries = [...snapshot.items.values()].map((item) => publicItem(item, snapshot.nowMs, maxAttempts));
    const ordering = (left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.idempotencyKey.localeCompare(right.idempotencyKey);
    return {
      version: REPOSITORY_JOURNAL_OUTBOX_VERSION,
      pending: entries.filter((entry) => ["pending", "backoff", "leased"].includes(entry.status)).sort(ordering),
      deadLetter: entries.filter((entry) => entry.status === "dead_letter").sort(ordering),
      acknowledged: entries.filter((entry) => entry.status === "acknowledged").sort(ordering),
    };
  }

  return Object.freeze({ enqueue, claim, acknowledge, ack: acknowledge, fail: recordFailure, inspect });
}

import { createHash } from "node:crypto";

export const REPOSITORY_SNAPSHOT_CACHE_VERSION = 1;

const CACHE_EVENT = "repository_snapshot_cache";
const KINDS = new Set(["issue", "pull_request", "review_threads", "diff", "repository_map"]);
const TRUST_CLASSES = new Set(["github-live", "github-webhook", "local-derived", "imported"]);
const FORBIDDEN_KEY = /(authorization|credential|password|passwd|secret|token|api.?key|private.?key|prompt|reasoning|chain.?of.?thought|transcript)/i;
const SECRET_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[opsu]|github_pat)_[A-Za-z0-9_]{20,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_FRESHNESS_MS = 5 * 60_000;
const DEFAULT_MAX_FRESHNESS_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 2_000;

export class RepositorySnapshotCacheError extends Error {
  constructor(message, { code = "REPOSITORY_SNAPSHOT_CACHE_ERROR", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RepositorySnapshotCacheError";
    this.code = code;
  }
}

function fail(message, code = "INVALID_CACHE_ENTRY") {
  throw new RepositorySnapshotCacheError(message, { code });
}

function stableValue(value, path = "data", seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) fail(`${path} contains secret-like material.`, "SECRET_VALUE");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(`${path} contains a circular reference.`);
    seen.add(value);
    const result = value.map((entry, index) => stableValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) fail(`${path} contains a circular reference.`);
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_KEY.test(key.replaceAll(/[^a-z0-9]/gi, ""))) {
        fail(`${path}.${key} is not permitted in the redacted cache.`, "FORBIDDEN_FIELD");
      }
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        fail(`${path}.${key} is not JSON data.`);
      }
      result[key] = stableValue(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  fail(`${path} must contain only JSON data.`);
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedRepository(repository) {
  const value = String(repository || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value)) fail("repository must be an owner/name identifier.", "INVALID_KEY");
  return value;
}

function normalizedKind(kind) {
  const value = String(kind || "").trim().toLowerCase().replaceAll("-", "_");
  if (!KINDS.has(value)) fail(`kind must be one of: ${[...KINDS].join(", ")}.`, "INVALID_KEY");
  return value;
}

function normalizedSubject(subject) {
  const value = String(subject || "").trim();
  if (!value || value.length > 512) fail("subject must be a non-empty stable identity no longer than 512 characters.", "INVALID_KEY");
  if (SECRET_VALUE.test(value)) fail("subject contains secret-like material.", "SECRET_VALUE");
  return value;
}

function normalizedHead(headSha) {
  if (headSha === undefined || headSha === null) return null;
  const value = String(headSha).toLowerCase();
  if (!SHA.test(value)) fail("headSha must be an exact 40-character Git SHA.", "INVALID_KEY");
  return value;
}

function normalizeKey({ repository, kind, subject, headSha = null }) {
  return {
    repository: normalizedRepository(repository),
    kind: normalizedKind(kind),
    subject: normalizedSubject(subject),
    headSha: normalizedHead(headSha),
  };
}

function keyString(key) {
  return stableJson(key);
}

function subjectKey(key) {
  return stableJson({ repository: key.repository, kind: key.kind, subject: key.subject });
}

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}.`, "INVALID_LIMIT");
  }
  return value;
}

function timestamp(value, name) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) fail(`${name} must be an RFC 3339 timestamp.`, "INVALID_PROVENANCE");
  return { value: new Date(millis).toISOString(), millis };
}

function optionalBoundedString(value, name) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 512) fail(`${name} must be non-empty and no longer than 512 characters.`, "INVALID_PROVENANCE");
  if (SECRET_VALUE.test(normalized)) fail(`${name} contains secret-like material.`, "SECRET_VALUE");
  return normalized;
}

function cacheEvent(record) {
  const payload = record?.payload;
  return payload?.namespace === CACHE_EVENT ? payload : null;
}

function validateStoredEvent(event) {
  if (!event || event.version !== REPOSITORY_SNAPSHOT_CACHE_VERSION || !["put", "invalidate"].includes(event.operation)) {
    fail("Repository journal contains a malformed snapshot-cache event.", "CORRUPT_CACHE_RECORD");
  }
  stableValue(event, "cacheEvent");
  const key = normalizeKey(event.key);
  if (stableJson(key) !== stableJson(event.key)) fail("Snapshot-cache event contains a non-canonical key.", "CORRUPT_CACHE_RECORD");
  integer(event.sourceRevision, "sourceRevision");
  if (event.operation === "put") {
    const data = stableValue(event.data);
    if (stableJson(data) !== stableJson(event.data) || digest(data) !== event.dataDigest) {
      fail("Snapshot-cache entry digest does not match its redacted data.", "CORRUPT_CACHE_RECORD");
    }
    timestamp(event.fetchedAt, "fetchedAt");
    integer(event.freshnessMs, "freshnessMs", { minimum: 1 });
    if (!TRUST_CLASSES.has(event.trustClass)) fail("Snapshot-cache entry has an invalid trustClass.", "CORRUPT_CACHE_RECORD");
  }
  return { ...event, key };
}

function nonAuthoritative(result) {
  return {
    ...result,
    authoritative: false,
    usableForAuthorization: false,
    prohibitedUses: Object.freeze(["claim", "formal_review", "merge", "rules", "permissions"]),
  };
}

export function createRepositorySnapshotCache({
  journal,
  now = () => new Date().toISOString(),
  defaultFreshnessMs = DEFAULT_FRESHNESS_MS,
  maxFreshnessMs = DEFAULT_MAX_FRESHNESS_MS,
  maxEntryAgeMs = DEFAULT_MAX_ENTRY_AGE_MS,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (!journal || typeof journal.append !== "function" || typeof journal.inspect !== "function") {
    fail("journal must be a repository journal instance.", "INVALID_JOURNAL");
  }
  integer(defaultFreshnessMs, "defaultFreshnessMs", { minimum: 1 });
  integer(maxFreshnessMs, "maxFreshnessMs", { minimum: defaultFreshnessMs });
  integer(maxEntryAgeMs, "maxEntryAgeMs", { minimum: maxFreshnessMs });
  integer(maxEntryBytes, "maxEntryBytes", { minimum: 1 });
  integer(maxEntries, "maxEntries", { minimum: 1 });

  function clock() {
    return timestamp(now(), "cache clock");
  }

  async function load() {
    const inspection = await journal.inspect();
    if (inspection.status !== "clean") {
      return { corrupt: inspection.error || { code: "CORRUPT_JOURNAL", message: "Repository journal is not clean." }, events: [] };
    }
    const events = [];
    try {
      for (const record of inspection.records) {
        const event = cacheEvent(record);
        if (event) events.push({ record, event: validateStoredEvent(event) });
      }
    } catch (error) {
      return { corrupt: { code: error.code || "CORRUPT_CACHE_RECORD", message: error.message }, events };
    }
    return { corrupt: null, events };
  }

  function materialize(events) {
    const entries = new Map();
    const exactInvalidations = new Map();
    const subjectInvalidations = new Map();
    for (const { record, event } of events) {
      const exact = keyString(event.key);
      const subject = subjectKey(event.key);
      if (event.operation === "invalidate") {
        const map = event.key.headSha === null ? subjectInvalidations : exactInvalidations;
        map.set(event.key.headSha === null ? subject : exact, Math.max(map.get(event.key.headSha === null ? subject : exact) ?? -1, event.sourceRevision));
        for (const [entryKey, entry] of entries) {
          if ((event.key.headSha === null ? subjectKey(entry.key) === subject : entryKey === exact) && entry.event.sourceRevision <= event.sourceRevision) {
            entries.delete(entryKey);
          }
        }
        continue;
      }
      const invalidatedThrough = Math.max(exactInvalidations.get(exact) ?? -1, subjectInvalidations.get(subject) ?? -1);
      if (event.sourceRevision <= invalidatedThrough) continue;
      const existing = entries.get(exact);
      if (!existing || event.sourceRevision > existing.event.sourceRevision) entries.set(exact, { record, event });
    }
    return { entries, exactInvalidations, subjectInvalidations };
  }

  async function put({
    repository,
    kind,
    subject,
    headSha = null,
    sourceRevision,
    sourceEtag = null,
    sourceUpdatedAt = null,
    fetchedAt = null,
    freshnessMs = defaultFreshnessMs,
    trustClass = "github-live",
    data,
  }) {
    const key = normalizeKey({ repository, kind, subject, headSha });
    integer(sourceRevision, "sourceRevision");
    integer(freshnessMs, "freshnessMs", { minimum: 1, maximum: maxFreshnessMs });
    if (!TRUST_CLASSES.has(trustClass)) fail(`trustClass must be one of: ${[...TRUST_CLASSES].join(", ")}.`, "INVALID_PROVENANCE");
    const normalizedData = stableValue(data);
    const encodedData = stableJson(normalizedData);
    if (Buffer.byteLength(encodedData, "utf8") > maxEntryBytes) fail(`Cache entry exceeds ${maxEntryBytes} bytes.`, "ENTRY_TOO_LARGE");
    const updated = sourceUpdatedAt === null || sourceUpdatedAt === undefined ? null : timestamp(sourceUpdatedAt, "sourceUpdatedAt").value;
    const loaded = await load();
    if (loaded.corrupt) fail(`Cannot write through corrupt cache evidence: ${loaded.corrupt.message}`, "CORRUPT_CACHE_RECORD");
    const state = materialize(loaded.events);
    const exact = keyString(key);
    const subjectId = subjectKey(key);
    const invalidatedThrough = Math.max(state.exactInvalidations.get(exact) ?? -1, state.subjectInvalidations.get(subjectId) ?? -1);
    if (sourceRevision <= invalidatedThrough) fail("Write is at or behind the durable invalidation barrier.", "OUT_OF_ORDER");
    const current = state.entries.get(exact)?.event;
    const fetched = timestamp(fetchedAt || (current?.sourceRevision === sourceRevision ? current.fetchedAt : clock().value), "fetchedAt").value;
    const event = {
      namespace: CACHE_EVENT,
      version: REPOSITORY_SNAPSHOT_CACHE_VERSION,
      operation: "put",
      key,
      sourceRevision,
      sourceEtag: optionalBoundedString(sourceEtag, "sourceEtag"),
      sourceUpdatedAt: updated,
      fetchedAt: fetched,
      freshnessMs,
      trustClass,
      data: normalizedData,
      dataDigest: digest(normalizedData),
    };
    if (current && sourceRevision < current.sourceRevision) fail("Write would roll the cache back to an older source revision.", "OUT_OF_ORDER");
    if (current && sourceRevision === current.sourceRevision && stableJson(current) !== stableJson(event)) {
      fail("The same source revision is already bound to different evidence.", "REVISION_CONFLICT");
    }
    const currentTime = clock().millis;
    const activeEntryCount = [...state.entries.values()]
      .filter(({ event: entry }) => currentTime - Date.parse(entry.fetchedAt) <= maxEntryAgeMs)
      .length;
    if (!current && activeEntryCount >= maxEntries) fail(`Cache contains the maximum of ${maxEntries} active entries.`, "CACHE_FULL");
    const eventDigest = digest(event);
    const result = await journal.append({
      identity: `snapshot-cache:put:${digest(key)}:${sourceRevision}`,
      repository: key.repository,
      headSha: key.headSha,
      payload: event,
    });
    return nonAuthoritative({ idempotent: result.idempotent, key, sourceRevision, dataDigest: event.dataDigest, eventDigest });
  }

  async function get({ repository, kind, subject, headSha = null, offline = false } = {}) {
    const key = normalizeKey({ repository, kind, subject, headSha });
    const loaded = await load();
    if (loaded.corrupt) return nonAuthoritative({ status: "corrupt", key, reason: loaded.corrupt.code, error: loaded.corrupt.message, entry: null });
    const state = materialize(loaded.events);
    const exact = keyString(key);
    const entry = state.entries.get(exact)?.event;
    const invalidatedThrough = Math.max(state.exactInvalidations.get(exact) ?? -1, state.subjectInvalidations.get(subjectKey(key)) ?? -1);
    if (!entry) {
      return nonAuthoritative({
        status: invalidatedThrough >= 0 ? "invalidated" : "missing",
        key,
        reason: invalidatedThrough >= 0 ? "explicit_invalidation" : "not_cached",
        invalidatedThroughRevision: invalidatedThrough >= 0 ? invalidatedThrough : null,
        entry: null,
      });
    }
    const ageMs = Math.max(0, clock().millis - Date.parse(entry.fetchedAt));
    if (ageMs > maxEntryAgeMs) return nonAuthoritative({ status: "missing", key, reason: "age_limit", ageMs, entry: null });
    const fresh = ageMs <= entry.freshnessMs;
    const status = offline || !fresh ? "stale" : "fresh";
    return nonAuthoritative({
      status,
      key,
      reason: offline ? "offline_unverified" : fresh ? "within_freshness_lifetime" : "freshness_expired",
      ageMs,
      entry: structuredClone(entry),
    });
  }

  async function invalidate({ repository, kind, subject, headSha = null, throughRevision = null } = {}) {
    const key = normalizeKey({ repository, kind, subject, headSha });
    const loaded = await load();
    if (loaded.corrupt) fail(`Cannot invalidate corrupt cache evidence: ${loaded.corrupt.message}`, "CORRUPT_CACHE_RECORD");
    const state = materialize(loaded.events);
    const matching = [...state.entries.values()]
      .map(({ event }) => event)
      .filter((event) => event.key.repository === key.repository && event.key.kind === key.kind && event.key.subject === key.subject && (key.headSha === null || event.key.headSha === key.headSha));
    const observed = matching.reduce((maximum, event) => Math.max(maximum, event.sourceRevision), -1);
    const existingBarrier = key.headSha === null
      ? state.subjectInvalidations.get(subjectKey(key)) ?? -1
      : state.exactInvalidations.get(keyString(key)) ?? -1;
    const barrier = throughRevision === null ? Math.max(0, observed, existingBarrier) : integer(throughRevision, "throughRevision");
    if (barrier < Math.max(observed, existingBarrier)) fail("Invalidation cannot be older than currently cached evidence.", "OUT_OF_ORDER");
    const event = {
      namespace: CACHE_EVENT,
      version: REPOSITORY_SNAPSHOT_CACHE_VERSION,
      operation: "invalidate",
      key,
      sourceRevision: barrier,
    };
    const result = await journal.append({
      identity: `snapshot-cache:invalidate:${digest(key)}:${barrier}`,
      repository: key.repository,
      headSha: key.headSha,
      payload: event,
    });
    return nonAuthoritative({ idempotent: result.idempotent, key, invalidatedThroughRevision: barrier });
  }

  async function inspect({ repository = null } = {}) {
    const loaded = await load();
    if (loaded.corrupt) return nonAuthoritative({ status: "corrupt", reason: loaded.corrupt.code, error: loaded.corrupt.message, entries: [] });
    const state = materialize(loaded.events);
    const expected = repository === null ? null : normalizedRepository(repository);
    const entries = [];
    for (const { event } of state.entries.values()) {
      if (expected && event.key.repository !== expected) continue;
      const read = await get({ ...event.key });
      if (read.status !== "missing") entries.push(read);
    }
    return nonAuthoritative({ status: "clean", entries });
  }

  return Object.freeze({ put, get, invalidate, inspect });
}

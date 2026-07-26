import { createHash } from "node:crypto";

export const MISSION_CONTROL_EVENT_PROTOCOL_VERSION = 1;

export const MISSION_CONTROL_EVENT_TYPES = Object.freeze([
  "snapshot",
  "repository.updated",
  "repository.removed",
  "portfolio.updated",
  "portfolio.removed",
  "lane.updated",
  "lane.removed",
  "provider.updated",
  "provider.removed",
  "narrative.updated",
  "output.appended",
  "attention.updated",
  "github.updated",
  "quota.updated",
  "lifecycle.updated",
  "resync.required",
]);

const EVENT_TYPES = new Set(MISSION_CONTROL_EVENT_TYPES);
const IDENTITY_FIELDS = Object.freeze(["repository", "portfolioId", "laneId", "providerId"]);
const EVENT_IDENTITY_FIELDS = Object.freeze({
  snapshot: [],
  "repository.updated": ["repository"],
  "repository.removed": ["repository"],
  "portfolio.updated": ["repository", "portfolioId"],
  "portfolio.removed": ["repository", "portfolioId"],
  "lane.updated": ["repository", "laneId"],
  "lane.removed": ["repository", "laneId"],
  "provider.updated": ["repository", "laneId", "providerId"],
  "provider.removed": ["repository", "laneId", "providerId"],
  "narrative.updated": ["repository", "laneId"],
  "output.appended": ["repository", "laneId"],
  "attention.updated": ["repository", "laneId"],
  "github.updated": ["repository", "laneId"],
  "quota.updated": ["providerId"],
  "lifecycle.updated": ["repository", "laneId"],
  "resync.required": [],
});
const RESYNC_REASON_MAX_LENGTH = 512;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requiredIdentifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${name} must be a non-empty identifier without control-line characters.`);
  }
  return value;
}

function optionalIdentifier(value, name) {
  if (value === undefined || value === null) return null;
  return requiredIdentifier(value, name);
}

function clone(value) {
  return structuredClone(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") throw new Error("occurredAt must be an RFC 3339 timestamp with an explicit offset.");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts) throw new Error("occurredAt must be an RFC 3339 timestamp with an explicit offset.");
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = parts[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    throw new Error("occurredAt must be an RFC 3339 timestamp with an explicit offset.");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("occurredAt must be an RFC 3339 timestamp with an explicit offset.");
  return timestamp.toISOString();
}

function normalizeResyncPayload(payload) {
  const normalized = clone(payload);
  if (normalized.reason === undefined || normalized.reason === null) return normalized;
  if (typeof normalized.reason !== "string") throw new Error("resync.required payload.reason must be a string.");
  const reason = normalized.reason.trim().replace(/\s+/gu, " ");
  if (!reason) throw new Error("resync.required payload.reason must not be empty.");
  if (reason.length > RESYNC_REASON_MAX_LENGTH) {
    throw new Error(`resync.required payload.reason must not exceed ${RESYNC_REASON_MAX_LENGTH} characters.`);
  }
  normalized.reason = reason;
  return normalized;
}

function validateSnapshotCollection(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`snapshot payload.${name} must be an array.`);
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error(`snapshot payload.${name} entries must be objects.`);
    return clone(entry);
  });
}

export function validateMissionControlSnapshotPayload(value) {
  if (!isRecord(value)) throw new Error("snapshot payload must be an object.");
  const repositories = validateSnapshotCollection(value.repositories, "repositories");
  const portfolios = validateSnapshotCollection(value.portfolios, "portfolios");
  const lanes = validateSnapshotCollection(value.lanes, "lanes");
  const providers = validateSnapshotCollection(value.providers, "providers");
  const quotas = validateSnapshotCollection(value.quotas, "quotas");

  const repositoryIds = new Set();
  for (const repository of repositories) {
    const id = requiredIdentifier(repository.id, "snapshot repository.id");
    if (repositoryIds.has(id)) throw new Error(`snapshot contains duplicate repository ${id}.`);
    repositoryIds.add(id);
  }

  const portfolioIds = new Set();
  for (const portfolio of portfolios) {
    const repository = requiredIdentifier(portfolio.repository, "snapshot portfolio.repository");
    const id = requiredIdentifier(portfolio.id, "snapshot portfolio.id");
    if (!repositoryIds.has(repository)) {
      throw new Error(`snapshot portfolio ${id} references unknown repository ${repository}.`);
    }
    const key = `${repository}\0${id}`;
    if (portfolioIds.has(key)) throw new Error(`snapshot contains duplicate portfolio ${id} in ${repository}.`);
    portfolioIds.add(key);
  }

  const laneIds = new Set();
  for (const lane of lanes) {
    const repository = requiredIdentifier(lane.repository, "snapshot lane.repository");
    const id = requiredIdentifier(lane.id, "snapshot lane.id");
    if (!repositoryIds.has(repository)) {
      throw new Error(`snapshot lane ${id} references unknown repository ${repository}.`);
    }
    const key = `${repository}\0${id}`;
    if (laneIds.has(key)) throw new Error(`snapshot contains duplicate lane ${id} in ${repository}.`);
    laneIds.add(key);
  }

  const providerIds = new Set();
  for (const provider of providers) {
    const repository = requiredIdentifier(provider.repository, "snapshot provider.repository");
    const laneId = requiredIdentifier(provider.laneId, "snapshot provider.laneId");
    const id = requiredIdentifier(provider.id, "snapshot provider.id");
    if (!laneIds.has(`${repository}\0${laneId}`)) {
      throw new Error(`snapshot provider ${id} references unknown lane ${laneId} in ${repository}.`);
    }
    const key = `${repository}\0${laneId}\0${id}`;
    if (providerIds.has(key)) throw new Error(`snapshot contains duplicate provider ${id} for lane ${laneId}.`);
    providerIds.add(key);
  }

  const quotaIds = new Set();
  for (const quota of quotas) {
    const id = requiredIdentifier(quota.providerId, "snapshot quota.providerId");
    if (quotaIds.has(id)) throw new Error(`snapshot contains duplicate quota ${id}.`);
    quotaIds.add(id);
  }

  return { repositories, portfolios, lanes, providers, quotas };
}

export function validateMissionControlEventEnvelope(value) {
  if (!isRecord(value)) throw new Error("Mission Control event envelope must be an object.");
  if (value.version !== MISSION_CONTROL_EVENT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported Mission Control event protocol version: ${String(value.version)}.`);
  }
  const streamId = requiredIdentifier(value.streamId, "streamId");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error("sequence must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(value.cursor) || value.cursor !== value.sequence) {
    throw new Error("cursor must be a safe integer equal to sequence.");
  }
  if (!EVENT_TYPES.has(value.type)) throw new Error(`Unsupported Mission Control event type: ${String(value.type)}.`);
  const occurredAt = canonicalTimestamp(value.occurredAt);
  if (!isRecord(value.payload)) throw new Error("event payload must be an object.");

  const identities = {
    repository: optionalIdentifier(value.repository, "repository"),
    portfolioId: optionalIdentifier(value.portfolioId, "portfolioId"),
    laneId: optionalIdentifier(value.laneId, "laneId"),
    providerId: optionalIdentifier(value.providerId, "providerId"),
  };
  const allowedIdentities = new Set(EVENT_IDENTITY_FIELDS[value.type]);
  for (const field of IDENTITY_FIELDS) {
    if (identities[field] && !allowedIdentities.has(field)) {
      if (value.type === "quota.updated") {
        throw new Error("quota.updated is machine-global and cannot carry repository, lane, or portfolio identity.");
      }
      throw new Error(`${value.type} cannot carry ${field} identity.`);
    }
    if (!identities[field] && allowedIdentities.has(field)) {
      throw new Error(`${value.type} requires ${field} identity.`);
    }
  }

  if (value.type === "snapshot") {
    return Object.freeze({
      version: value.version,
      streamId,
      sequence: value.sequence,
      cursor: value.cursor,
      type: value.type,
      occurredAt,
      payload: validateMissionControlSnapshotPayload(value.payload),
    });
  }

  return Object.freeze({
    version: value.version,
    streamId,
    sequence: value.sequence,
    cursor: value.cursor,
    type: value.type,
    occurredAt,
    ...Object.fromEntries(IDENTITY_FIELDS
      .filter((field) => identities[field])
      .map((field) => [field, identities[field]])),
    payload: value.type === "resync.required" ? normalizeResyncPayload(value.payload) : clone(value.payload),
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function missionControlEventDigest(envelope) {
  const normalized = validateMissionControlEventEnvelope(envelope);
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

export function missionControlLaneKey(repository, laneId) {
  return `${requiredIdentifier(repository, "repository")}\0${requiredIdentifier(laneId, "laneId")}`;
}

export function missionControlPortfolioKey(repository, portfolioId) {
  return `${requiredIdentifier(repository, "repository")}\0${requiredIdentifier(portfolioId, "portfolioId")}`;
}

export function missionControlProviderKey(repository, laneId, providerId) {
  return `${missionControlLaneKey(repository, laneId)}\0${requiredIdentifier(providerId, "providerId")}`;
}

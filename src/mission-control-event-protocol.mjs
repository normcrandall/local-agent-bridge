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
const LANE_EVENT_TYPES = new Set([
  "lane.updated",
  "lane.removed",
  "provider.updated",
  "provider.removed",
  "narrative.updated",
  "output.appended",
  "attention.updated",
  "github.updated",
  "lifecycle.updated",
]);
const PORTFOLIO_EVENT_TYPES = new Set(["portfolio.updated", "portfolio.removed"]);
const PROVIDER_EVENT_TYPES = new Set(["provider.updated", "provider.removed", "quota.updated"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredIdentifier(value, name) {
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
  if (typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))) {
    throw new Error("occurredAt must be an ISO-compatible timestamp.");
  }
  if (!isRecord(value.payload)) throw new Error("event payload must be an object.");

  const repository = optionalIdentifier(value.repository, "repository");
  const laneId = optionalIdentifier(value.laneId, "laneId");
  const portfolioId = optionalIdentifier(value.portfolioId, "portfolioId");
  const providerId = optionalIdentifier(value.providerId, "providerId");

  if (value.type === "snapshot") {
    if (repository || laneId || portfolioId || providerId) {
      throw new Error("snapshot envelopes cannot carry entity identity fields.");
    }
    return Object.freeze({
      version: value.version,
      streamId,
      sequence: value.sequence,
      cursor: value.cursor,
      type: value.type,
      occurredAt: value.occurredAt,
      payload: validateMissionControlSnapshotPayload(value.payload),
    });
  }

  if (value.type !== "resync.required" && !repository) {
    throw new Error(`${value.type} requires repository identity.`);
  }
  if (LANE_EVENT_TYPES.has(value.type) && !laneId) throw new Error(`${value.type} requires laneId.`);
  if (PORTFOLIO_EVENT_TYPES.has(value.type) && !portfolioId) throw new Error(`${value.type} requires portfolioId.`);
  if (PROVIDER_EVENT_TYPES.has(value.type) && !providerId) throw new Error(`${value.type} requires providerId.`);
  if ((value.type === "repository.updated" || value.type === "repository.removed") && (laneId || portfolioId || providerId)) {
    throw new Error(`${value.type} cannot carry lane, portfolio, or provider identity.`);
  }
  if (value.type === "resync.required" && (repository || laneId || portfolioId || providerId)) {
    throw new Error("resync.required cannot carry entity identity fields.");
  }

  return Object.freeze({
    version: value.version,
    streamId,
    sequence: value.sequence,
    cursor: value.cursor,
    type: value.type,
    occurredAt: value.occurredAt,
    ...(repository ? { repository } : {}),
    ...(laneId ? { laneId } : {}),
    ...(portfolioId ? { portfolioId } : {}),
    ...(providerId ? { providerId } : {}),
    payload: clone(value.payload),
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

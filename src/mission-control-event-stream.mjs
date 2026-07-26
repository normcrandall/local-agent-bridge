import { randomUUID } from "node:crypto";
import {
  MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  validateMissionControlEventEnvelope,
  validateMissionControlSnapshotPayload,
} from "./mission-control-event-protocol.mjs";

export const MISSION_CONTROL_SUBSCRIPTION_MAX_BATCH = 100;
export const MISSION_CONTROL_SUBSCRIPTION_MAX_WAIT_MS = 5_000;
export const MISSION_CONTROL_EVENT_RETENTION = 512;
export const MISSION_CONTROL_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const DERIVED_TIME_FIELDS = new Set([
  "activeSeconds",
  "ageSeconds",
  "deadSeconds",
  "elapsedSeconds",
  "heartbeatAgeSeconds",
  "summaryAgeSeconds",
]);

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !DERIVED_TIME_FIELDS.has(key))
      .map(([key, entry]) => [key, stableClone(entry)]));
  }
  return value;
}

function projectSnapshot(snapshot) {
  const lanes = Array.isArray(snapshot?.lanes) ? snapshot.lanes : [];
  const repositories = (Array.isArray(snapshot?.repositories) ? snapshot.repositories : [])
    .map(({ repository, ...entry }) => ({ ...entry, id: repository }))
    .filter((entry) => entry.id);
  const repositoryIds = new Set(repositories.map((entry) => entry.id));
  const normalizedLanes = lanes
    .filter((lane) => lane?.id && lane?.repository && repositoryIds.has(lane.repository))
    .map((lane) => stableClone(lane));

  const portfolios = new Map();
  const providers = new Map();
  for (const lane of normalizedLanes) {
    const portfolioId = lane.portfolio?.portfolioId;
    if (portfolioId) {
      const key = `${lane.repository}\0${portfolioId}`;
      const previous = portfolios.get(key) || {};
      portfolios.set(key, {
        ...previous,
        ...stableClone(lane.portfolio),
        id: portfolioId,
        repository: lane.repository,
      });
    }
    const providerId = lane.activeAgent || lane.writer;
    if (providerId) {
      providers.set(`${lane.repository}\0${lane.id}\0${providerId}`, {
        id: providerId,
        repository: lane.repository,
        laneId: lane.id,
        status: lane.lifecyclePhase || lane.status || "unknown",
        updatedAt: lane.updatedAt || null,
      });
    }
  }

  const projected = validateMissionControlSnapshotPayload({
    repositories,
    portfolios: [...portfolios.values()],
    lanes: normalizedLanes,
    providers: [...providers.values()],
    quotas: [],
  });
  if (Buffer.byteLength(JSON.stringify(projected)) > MISSION_CONTROL_SNAPSHOT_MAX_BYTES) {
    throw new Error("Mission Control snapshot exceeded the 16 MiB transport limit.");
  }
  return projected;
}

function sorted(entries, keyFor) {
  return [...entries].sort((left, right) => keyFor(left).localeCompare(keyFor(right)));
}

function indexed(entries, keyFor) {
  return new Map(entries.map((entry) => [keyFor(entry), entry]));
}

function changed(previous, next) {
  return canonical(previous) !== canonical(next);
}

export function missionControlEventProjection(snapshot) {
  return projectSnapshot(snapshot);
}

export class MissionControlEventStream {
  #events = [];
  #initialized = false;
  #loadSnapshot;
  #refresh = Promise.resolve();
  #retention;
  #sequence = 0;
  #snapshot = null;
  #streamId;
  #waiters = new Set();

  constructor({ loadSnapshot, retention = MISSION_CONTROL_EVENT_RETENTION, streamId = `mission-control-${randomUUID()}` } = {}) {
    if (typeof loadSnapshot !== "function") throw new Error("Mission Control event stream requires a snapshot loader.");
    if (!Number.isSafeInteger(retention) || retention < 1 || retention > 10_000) {
      throw new Error("Mission Control event retention must be an integer between 1 and 10000.");
    }
    this.#loadSnapshot = loadSnapshot;
    this.#retention = retention;
    this.#streamId = streamId;
  }

  get cursor() { return this.#sequence; }

  get streamId() { return this.#streamId; }

  #envelope(type, payload, identity = {}) {
    this.#sequence += 1;
    return validateMissionControlEventEnvelope({
      version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
      streamId: this.#streamId,
      sequence: this.#sequence,
      cursor: this.#sequence,
      type,
      occurredAt: new Date().toISOString(),
      ...identity,
      payload,
    });
  }

  #snapshotEnvelope() {
    return validateMissionControlEventEnvelope({
      version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
      streamId: this.#streamId,
      sequence: this.#sequence,
      cursor: this.#sequence,
      type: "snapshot",
      occurredAt: new Date().toISOString(),
      payload: structuredClone(this.#snapshot),
    });
  }

  #append(event) {
    this.#events.push(event);
    if (this.#events.length > this.#retention) this.#events.splice(0, this.#events.length - this.#retention);
  }

  #notify() {
    for (const notify of this.#waiters) notify();
    this.#waiters.clear();
  }

  async refresh() {
    const operation = this.#refresh.then(async () => {
      const next = projectSnapshot(await this.#loadSnapshot());
      if (!this.#initialized) {
        this.#snapshot = next;
        this.#initialized = true;
        return;
      }
      const startingSequence = this.#sequence;
      const definitions = [
        ["repositories", (entry) => entry.id, "repository.updated", "repository.removed", (entry) => ({ repository: entry.id })],
        ["portfolios", (entry) => `${entry.repository}\0${entry.id}`, "portfolio.updated", "portfolio.removed", (entry) => ({ repository: entry.repository, portfolioId: entry.id })],
        ["lanes", (entry) => `${entry.repository}\0${entry.id}`, "lane.updated", "lane.removed", (entry) => ({ repository: entry.repository, laneId: entry.id })],
        ["providers", (entry) => `${entry.repository}\0${entry.laneId}\0${entry.id}`, "provider.updated", "provider.removed", (entry) => ({ repository: entry.repository, laneId: entry.laneId, providerId: entry.id })],
        ["quotas", (entry) => entry.providerId, "quota.updated", null, (entry) => ({ providerId: entry.providerId })],
      ];
      for (const [name, keyFor, updateType, removeType, identityFor] of definitions) {
        const before = indexed(this.#snapshot[name], keyFor);
        const after = indexed(next[name], keyFor);
        for (const entry of sorted(after.values(), keyFor)) {
          const key = keyFor(entry);
          if (!before.has(key) || changed(before.get(key), entry)) {
            this.#append(this.#envelope(updateType, entry, identityFor(entry)));
          }
        }
      }
      for (const [name, keyFor, _updateType, removeType, identityFor] of [...definitions].reverse()) {
        if (!removeType) continue;
        const before = indexed(this.#snapshot[name], keyFor);
        const after = indexed(next[name], keyFor);
        for (const entry of sorted(before.values(), keyFor)) {
          if (!after.has(keyFor(entry))) this.#append(this.#envelope(removeType, {}, identityFor(entry)));
        }
      }
      this.#snapshot = next;
      if (this.#sequence !== startingSequence) this.#notify();
    });
    this.#refresh = operation.catch(() => {});
    await operation;
  }

  async snapshot() {
    await this.refresh();
    return this.#snapshotEnvelope();
  }

  #resync(reason) {
    return {
      streamId: this.#streamId,
      cursor: this.#sequence,
      events: [],
      resyncRequired: true,
      reason,
      resyncEvent: validateMissionControlEventEnvelope({
        version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
        streamId: this.#streamId,
        sequence: this.#sequence,
        cursor: this.#sequence,
        type: "resync.required",
        occurredAt: new Date().toISOString(),
        payload: { reason },
      }),
    };
  }

  #read(streamId, cursor, maxEvents) {
    if (typeof streamId !== "string" || !streamId) throw new Error("Mission Control subscription requires a streamId.");
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Mission Control subscription cursor must be a non-negative safe integer.");
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MISSION_CONTROL_SUBSCRIPTION_MAX_BATCH) {
      throw new Error(`Mission Control subscription batch must be between 1 and ${MISSION_CONTROL_SUBSCRIPTION_MAX_BATCH}.`);
    }
    if (streamId !== this.#streamId) return this.#resync("stream_changed");
    if (cursor > this.#sequence) throw new Error("Mission Control subscription cursor is ahead of the stream.");
    const earliest = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (cursor < earliest - 1) return this.#resync("retention_window_exceeded");
    const events = this.#events.filter((event) => event.sequence > cursor).slice(0, maxEvents);
    return {
      streamId: this.#streamId,
      cursor: events.at(-1)?.cursor ?? cursor,
      events: structuredClone(events),
      resyncRequired: false,
      hasMore: events.length > 0 && events.at(-1).sequence < this.#sequence,
    };
  }

  async read({ streamId, cursor, maxEvents = 50, waitMs = 0, signal } = {}) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MISSION_CONTROL_SUBSCRIPTION_MAX_WAIT_MS) {
      throw new Error(`Mission Control subscription wait must be between 0 and ${MISSION_CONTROL_SUBSCRIPTION_MAX_WAIT_MS}ms.`);
    }
    await this.refresh();
    let result = this.#read(streamId, cursor, maxEvents);
    if (result.resyncRequired || result.events.length || waitMs === 0 || signal?.aborted) return result;
    await new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolvePromise();
      };
      const timer = setTimeout(finish, waitMs);
      this.#waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
    result = this.#read(streamId, cursor, maxEvents);
    return result;
  }
}

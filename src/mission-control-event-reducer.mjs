import {
  MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  missionControlEventDigest,
  missionControlLaneKey,
  missionControlPortfolioKey,
  missionControlProviderKey,
  validateMissionControlEventEnvelope,
} from "./mission-control-event-protocol.mjs";

export const MISSION_CONTROL_EVENT_DIGEST_RETENTION = 256;

function clone(value) {
  return structuredClone(value);
}

function indexed(entries, keyFor) {
  return Object.fromEntries(entries.map((entry) => [keyFor(entry), clone(entry)]));
}

function readySync() {
  return { status: "ready", reason: null, expectedSequence: null, receivedSequence: null };
}

function requireResync(state, reason, event, expectedSequence = state.cursor + 1) {
  return {
    ...state,
    sync: {
      status: "resync_required",
      reason,
      expectedSequence,
      receivedSequence: event?.sequence ?? null,
    },
  };
}

function retainedEventDigests(digests, cursor) {
  const firstRetainedSequence = Math.max(0, cursor - MISSION_CONTROL_EVENT_DIGEST_RETENTION + 1);
  return Object.fromEntries(Object.entries(digests || {}).filter(([sequence]) => {
    const numericSequence = Number(sequence);
    return numericSequence >= firstRetainedSequence && numericSequence <= cursor;
  }));
}

function stateFromSnapshot(event, previousState = null) {
  const { repositories, portfolios, lanes, providers, capacities, quotas } = event.payload;
  const preserveReplayEvidence = previousState?.streamId === event.streamId;
  return {
    version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
    streamId: event.streamId,
    cursor: event.cursor,
    snapshotAt: event.occurredAt,
    updatedAt: event.occurredAt,
    sync: readySync(),
    repositories: indexed(repositories, (entry) => entry.id),
    portfolios: indexed(portfolios, (entry) => missionControlPortfolioKey(entry.repository, entry.id)),
    lanes: indexed(lanes, (entry) => missionControlLaneKey(entry.repository, entry.id)),
    providers: indexed(providers, (entry) => missionControlProviderKey(entry.repository, entry.laneId, entry.id)),
    capacities: indexed(capacities, (entry) => entry.providerId),
    quotas: indexed(quotas, (entry) => entry.providerId),
    appliedEventDigests: preserveReplayEvidence
      ? retainedEventDigests(previousState.appliedEventDigests, event.cursor)
      : {},
  };
}

function withoutKeys(record, predicate) {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => !predicate(key, value)));
}

function mergeEntity(previous, payload, identity) {
  return { ...(previous || {}), ...clone(payload), ...identity };
}

function applyDelta(state, event) {
  let repositories = state.repositories;
  let portfolios = state.portfolios;
  let lanes = state.lanes;
  let providers = state.providers;
  let capacities = state.capacities;
  let quotas = state.quotas;
  const laneKey = event.laneId ? missionControlLaneKey(event.repository, event.laneId) : null;
  const portfolioKey = event.portfolioId ? missionControlPortfolioKey(event.repository, event.portfolioId) : null;
  const providerKey = event.laneId && event.providerId
    ? missionControlProviderKey(event.repository, event.laneId, event.providerId)
    : null;

  switch (event.type) {
    case "repository.updated":
      repositories = {
        ...repositories,
        [event.repository]: mergeEntity(repositories[event.repository], event.payload, { id: event.repository }),
      };
      break;
    case "repository.removed":
      repositories = withoutKeys(repositories, (key) => key === event.repository);
      portfolios = withoutKeys(portfolios, (_key, value) => value.repository === event.repository);
      lanes = withoutKeys(lanes, (_key, value) => value.repository === event.repository);
      providers = withoutKeys(providers, (_key, value) => value.repository === event.repository);
      break;
    case "portfolio.updated":
      portfolios = {
        ...portfolios,
        [portfolioKey]: mergeEntity(portfolios[portfolioKey], event.payload, {
          id: event.portfolioId,
          repository: event.repository,
        }),
      };
      break;
    case "portfolio.removed":
      portfolios = withoutKeys(portfolios, (key) => key === portfolioKey);
      break;
    case "lane.updated":
      lanes = {
        ...lanes,
        [laneKey]: mergeEntity(lanes[laneKey], event.payload, { id: event.laneId, repository: event.repository }),
      };
      break;
    case "lane.removed":
      lanes = withoutKeys(lanes, (key) => key === laneKey);
      providers = withoutKeys(providers, (_key, value) => value.repository === event.repository && value.laneId === event.laneId);
      break;
    case "provider.updated":
      providers = {
        ...providers,
        [providerKey]: mergeEntity(providers[providerKey], event.payload, {
          id: event.providerId,
          laneId: event.laneId,
          repository: event.repository,
        }),
      };
      break;
    case "provider.removed":
      providers = withoutKeys(providers, (key) => key === providerKey);
      break;
    case "capacity.updated":
      capacities = {
        ...capacities,
        [event.providerId]: mergeEntity(capacities[event.providerId], event.payload, { providerId: event.providerId }),
      };
      break;
    case "capacity.removed":
      capacities = withoutKeys(capacities, (key) => key === event.providerId);
      break;
    case "narrative.updated":
    case "attention.updated":
    case "github.updated":
    case "lifecycle.updated": {
      const field = event.type.split(".")[0];
      lanes = {
        ...lanes,
        [laneKey]: mergeEntity(lanes[laneKey], { [field]: clone(event.payload) }, {
          id: event.laneId,
          repository: event.repository,
        }),
      };
      break;
    }
    case "output.appended": {
      const previous = lanes[laneKey];
      lanes = {
        ...lanes,
        [laneKey]: mergeEntity(previous, {
          output: [...(Array.isArray(previous?.output) ? previous.output : []), clone(event.payload)],
        }, { id: event.laneId, repository: event.repository }),
      };
      break;
    }
    case "quota.updated":
      quotas = {
        ...quotas,
        [event.providerId]: mergeEntity(quotas[event.providerId], event.payload, { providerId: event.providerId }),
      };
      break;
    default:
      throw new Error(`Reducer cannot apply event type ${event.type}.`);
  }

  return { ...state, repositories, portfolios, lanes, providers, capacities, quotas };
}

function deltaIdentityFailure(state, event) {
  if (["repository.updated", "repository.removed", "quota.updated"].includes(event.type)) return null;
  if (event.repository && !state.repositories[event.repository]) return "unknown_repository";
  if (event.laneId
    && event.type !== "lane.updated"
    && event.type !== "lane.removed"
    && !state.lanes[missionControlLaneKey(event.repository, event.laneId)]) {
    return "unknown_lane";
  }
  return null;
}

export function createMissionControlEventState(snapshotEnvelope) {
  const snapshot = validateMissionControlEventEnvelope(snapshotEnvelope);
  if (snapshot.type !== "snapshot") throw new Error("Initial Mission Control state requires a snapshot envelope.");
  return stateFromSnapshot(snapshot);
}

export function reduceMissionControlEvent(currentState, envelope) {
  const event = validateMissionControlEventEnvelope(envelope);
  if (event.type === "snapshot") {
    if (currentState
      && currentState.streamId === event.streamId
      && event.sequence < currentState.cursor) {
      return requireResync(currentState, "stale_snapshot", event, currentState.cursor);
    }
    return stateFromSnapshot(event, currentState);
  }
  if (!currentState) {
    return requireResync({
      version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
      streamId: null,
      cursor: -1,
      snapshotAt: null,
      updatedAt: null,
      sync: readySync(),
      repositories: {}, portfolios: {}, lanes: {}, providers: {}, capacities: {}, quotas: {}, appliedEventDigests: {},
    }, "snapshot_required", event, null);
  }
  const state = currentState;
  if (state.version !== MISSION_CONTROL_EVENT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported reducer state version: ${String(state.version)}.`);
  }
  if (state.sync?.status === "resync_required") return state;
  if (event.streamId !== state.streamId) return requireResync(state, "stream_changed", event);

  const digest = missionControlEventDigest(event);
  const knownDigest = state.appliedEventDigests?.[event.sequence];
  if (event.sequence <= state.cursor) {
    if (knownDigest === digest) return state;
    return requireResync(state, knownDigest ? "sequence_conflict" : "stale_event", event);
  }
  if (event.sequence !== state.cursor + 1) {
    return requireResync(state, "sequence_gap", event);
  }
  if (event.type === "resync.required") return requireResync(state, event.payload.reason || "server_requested", event);

  const identityFailure = deltaIdentityFailure(state, event);
  if (identityFailure) return requireResync(state, identityFailure, event);

  const reduced = applyDelta(state, event);
  return {
    ...reduced,
    cursor: event.cursor,
    updatedAt: event.occurredAt,
    sync: readySync(),
    appliedEventDigests: retainedEventDigests({
      ...state.appliedEventDigests,
      [event.sequence]: digest,
    }, event.sequence),
  };
}

export function reduceMissionControlEvents(snapshotEnvelope, deltas = []) {
  if (!Array.isArray(deltas)) throw new Error("Mission Control deltas must be an array.");
  return deltas.reduce(reduceMissionControlEvent, createMissionControlEventState(snapshotEnvelope));
}

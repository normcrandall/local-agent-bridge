#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  MISSION_CONTROL_EVENT_TYPES,
  missionControlEventDigest,
  missionControlLaneKey,
  validateMissionControlEventEnvelope,
} from "../src/mission-control-event-protocol.mjs";
import {
  MISSION_CONTROL_EVENT_DIGEST_RETENTION,
  createMissionControlEventState,
  reduceMissionControlEvent,
  reduceMissionControlEvents,
} from "../src/mission-control-event-reducer.mjs";

const at = (second) => new Date(Date.parse("2026-07-26T12:00:00.000Z") + (second * 1_000)).toISOString();
const envelope = (sequence, type, payload, identity = {}) => ({
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId: "mission-control-boot-a",
  sequence,
  cursor: sequence,
  type,
  occurredAt: at(sequence),
  ...identity,
  payload,
});

const snapshot = envelope(10, "snapshot", {
  repositories: [{ id: "norm/example", active: 1 }],
  portfolios: [{ id: "helm-1", repository: "norm/example", status: "active" }],
  lanes: [{ id: "bridge-1", repository: "norm/example", status: "running", output: [] }],
  providers: [{ id: "claude", repository: "norm/example", laneId: "bridge-1", model: "opus" }],
  capacities: [{ providerId: "claude", work: { limit: 5, inUse: 1, queued: 0 }, review: { limit: 10, inUse: 0, queued: 0 } }],
  quotas: [{ providerId: "claude", weeklyRemaining: 50 }],
});

assert.ok(MISSION_CONTROL_EVENT_TYPES.includes("snapshot"));
assert.equal(validateMissionControlEventEnvelope(snapshot).cursor, 10);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION + 1 }), /Unsupported.*version/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, version: 1 }), /Unsupported.*version/i,
  "a version-1 snapshot must fail closed after capacity events expand the wire contract");
const { capacities: _omittedCapacities, ...snapshotWithoutCapacitiesPayload } = snapshot.payload;
assert.deepEqual(validateMissionControlEventEnvelope({
  ...snapshot,
  payload: snapshotWithoutCapacitiesPayload,
}).payload.capacities, [], "a version-2 snapshot from a capacity-unaware producer remains readable");
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, cursor: 9 }), /cursor.*sequence/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "not-a-date" }), /occurredAt/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "2026-02-30T12:00:00Z" }), /occurredAt/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "2026-02-30 12:00:00" }), /occurredAt/i,
  "space-separated timestamps must not bypass calendar validation");
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "2026-07-26T12:00:10" }), /occurredAt/i,
  "offset-less timestamps would produce host-timezone-dependent digests");
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "2026-07-26T12:00:10.1234Z" }), /occurredAt/i,
  "sub-millisecond precision must not be silently truncated into a digest collision");
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, occurredAt: "2026-07-26T24:00:10Z" }), /occurredAt/i);
const alternateTimestamp = { ...snapshot, occurredAt: "2026-07-26T08:00:10-04:00" };
assert.equal(validateMissionControlEventEnvelope(alternateTimestamp).occurredAt, snapshot.occurredAt);
assert.equal(missionControlEventDigest(alternateTimestamp), missionControlEventDigest(snapshot),
  "equivalent timestamp spellings must produce the same canonical digest");
assert.throws(() => validateMissionControlEventEnvelope(envelope(11, "lane.updated", {}, {
  repository: "norm/example",
})), /laneId/i);
assert.throws(() => validateMissionControlEventEnvelope(envelope(11, "repository.updated", {}, {
  repository: "norm/example",
  laneId: "bridge-1",
})), /cannot carry laneId/i);
assert.throws(() => validateMissionControlEventEnvelope(envelope(11, "portfolio.updated", {}, {
  repository: "norm/example",
  portfolioId: "helm-1",
  providerId: "claude",
})), /cannot carry providerId/i);
assert.throws(() => validateMissionControlEventEnvelope(envelope(11, "lane.updated", {}, {
  repository: "norm/example",
  laneId: "bridge-1",
  portfolioId: "helm-1",
})), /cannot carry portfolioId/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, payload: {
  ...snapshot.payload,
  lanes: [...snapshot.payload.lanes, snapshot.payload.lanes[0]],
} }), /duplicate lane/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, payload: {
  ...snapshot.payload,
  providers: [{ id: "codex", repository: "norm/example", laneId: "missing" }],
} }), /unknown lane/i);
assert.equal(missionControlEventDigest(snapshot), missionControlEventDigest(structuredClone(snapshot)));

const initial = createMissionControlEventState(snapshot);
const laneKey = missionControlLaneKey("norm/example", "bridge-1");
assert.equal(initial.cursor, 10);
assert.equal(initial.lanes[laneKey].status, "running");
assert.equal(initial.capacities.claude.review.limit, 10);
assert.throws(() => reduceMissionControlEvent(initial, envelope(11, "repository.updated", {}, {
  repository: "norm/example",
  laneId: "bridge-1",
})), /cannot carry laneId/i,
"foreign lane identity must fail envelope validation instead of entering reducer resync logic");

const laneUpdate = envelope(11, "lane.updated", { status: "reviewing", prNumber: 42 }, {
  repository: "norm/example",
  laneId: "bridge-1",
});
const narrativeUpdate = envelope(12, "narrative.updated", { summary: "Checking exact-head review." }, {
  repository: "norm/example",
  laneId: "bridge-1",
});
const output = envelope(13, "output.appended", { text: "Review approved.", source: "provider" }, {
  repository: "norm/example",
  laneId: "bridge-1",
});
const quota = envelope(14, "quota.updated", { weeklyRemaining: 49 }, {
  providerId: "claude",
});
const current = reduceMissionControlEvents(snapshot, [laneUpdate, narrativeUpdate, output, quota]);
assert.equal(current.cursor, 14);
assert.equal(current.lanes[laneKey].status, "reviewing");
assert.equal(current.lanes[laneKey].narrative.summary, "Checking exact-head review.");
assert.deepEqual(current.lanes[laneKey].output, [{ text: "Review approved.", source: "provider" }]);
assert.equal(current.quotas.claude.weeklyRemaining, 49);
assert.equal("repository" in validateMissionControlEventEnvelope(quota), false);
assert.throws(() => validateMissionControlEventEnvelope({ ...quota, repository: "norm/example" }), /machine-global/i);
const capacityUpdate = envelope(11, "capacity.updated", {
  work: { limit: 5, inUse: 2, queued: 1 },
  review: { limit: 10, inUse: 3, queued: 4 },
}, { providerId: "claude" });
const capacityState = reduceMissionControlEvent(initial, capacityUpdate);
assert.equal(capacityState.capacities.claude.work.inUse, 2);
assert.equal(capacityState.capacities.claude.review.queued, 4);
assert.throws(() => validateMissionControlEventEnvelope({ ...capacityUpdate, repository: "norm/example" }), /machine-global/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...capacityUpdate, version: 1 }), /Unsupported.*version/i,
  "a capacity delta cannot masquerade as the pre-capacity protocol");

const snapshotAfterDeltas = envelope(15, "snapshot", {
  repositories: Object.values(current.repositories),
  portfolios: Object.values(current.portfolios),
  lanes: Object.values(current.lanes),
  providers: Object.values(current.providers),
  capacities: Object.values(current.capacities),
  quotas: Object.values(current.quotas),
});
const replacedAtSameStream = reduceMissionControlEvent(current, snapshotAfterDeltas);
const crossSnapshotDuplicate = reduceMissionControlEvent(replacedAtSameStream, quota);
assert.deepEqual(crossSnapshotDuplicate, replacedAtSameStream,
  "a retained duplicate delivered after a same-stream snapshot must remain idempotent");

const duplicate = reduceMissionControlEvent(current, quota);
assert.deepEqual(duplicate, current, "an exact duplicate delivery must be idempotent");
const conflict = reduceMissionControlEvent(current, { ...quota, payload: { weeklyRemaining: 1 } });
assert.equal(conflict.sync.status, "resync_required");
assert.equal(conflict.sync.reason, "sequence_conflict");
assert.equal(conflict.quotas.claude.weeklyRemaining, 49, "a conflict must not mutate materialized state");

const gap = reduceMissionControlEvent(current, envelope(16, "lane.updated", { status: "merged" }, {
  repository: "norm/example",
  laneId: "bridge-1",
}));
assert.equal(gap.sync.status, "resync_required");
assert.equal(gap.sync.reason, "sequence_gap");
assert.equal(gap.sync.expectedSequence, 15);
assert.equal(gap.cursor, 14);

const stale = reduceMissionControlEvent(current, envelope(9, "lane.updated", { status: "stale" }, {
  repository: "norm/example",
  laneId: "bridge-1",
}));
assert.equal(stale.sync.reason, "stale_event");
assert.equal(stale.lanes[laneKey].status, "reviewing");

const streamChange = reduceMissionControlEvent(current, {
  ...envelope(15, "lane.updated", { status: "merged" }, { repository: "norm/example", laneId: "bridge-1" }),
  streamId: "mission-control-boot-b",
});
assert.equal(streamChange.sync.reason, "stream_changed");

const staleSnapshot = reduceMissionControlEvent(current, snapshot);
assert.equal(staleSnapshot.sync.reason, "stale_snapshot");
assert.equal(staleSnapshot.cursor, 14);

const beforeSnapshot = reduceMissionControlEvent(null, laneUpdate);
assert.equal(beforeSnapshot.sync.reason, "snapshot_required");

const unknownLane = reduceMissionControlEvent(initial, envelope(11, "narrative.updated", { summary: "impossible" }, {
  repository: "norm/example",
  laneId: "bridge-missing",
}));
assert.equal(unknownLane.sync.reason, "unknown_lane");

const replacement = {
  ...envelope(20, "snapshot", {
    repositories: [{ id: "norm/reconnected", active: 0 }],
    portfolios: [], lanes: [], providers: [], quotas: [],
  }),
  streamId: "mission-control-boot-b",
  occurredAt: at(20),
};
const resynchronized = reduceMissionControlEvent(gap, replacement);
assert.equal(resynchronized.sync.status, "ready");
assert.equal(resynchronized.streamId, "mission-control-boot-b");
assert.equal(resynchronized.cursor, 20);
assert.deepEqual(Object.keys(resynchronized.repositories), ["norm/reconnected"]);
assert.deepEqual(resynchronized.lanes, {});

const requested = reduceMissionControlEvent(current, envelope(15, "resync.required", { reason: "retention_window_exceeded" }));
assert.equal(requested.sync.status, "resync_required");
assert.equal(requested.sync.reason, "retention_window_exceeded");
assert.equal(validateMissionControlEventEnvelope(envelope(15, "resync.required", {
  reason: "  retention_window_exceeded\r\n  safely ",
})).payload.reason, "retention_window_exceeded safely");
assert.throws(() => validateMissionControlEventEnvelope(envelope(15, "resync.required", {
  reason: "x".repeat(513),
})), /must not exceed 512/i);
assert.throws(() => validateMissionControlEventEnvelope(envelope(15, "resync.required", {
  reason: "   ",
})), /must not be empty/i);
const ignoredWhileUnsynchronized = reduceMissionControlEvent(requested, envelope(16, "repository.updated", { active: 9 }, {
  repository: "norm/example",
}));
assert.deepEqual(ignoredWhileUnsynchronized, requested, "only a snapshot may recover a resync-required state");

const highFrequencyEvents = Array.from({ length: MISSION_CONTROL_EVENT_DIGEST_RETENTION + 5 }, (_, index) =>
  envelope(11 + index, "repository.updated", { tick: index }, { repository: "norm/example" }));
const bounded = highFrequencyEvents.reduce(reduceMissionControlEvent, initial);
assert.equal(Object.keys(bounded.appliedEventDigests).length, MISSION_CONTROL_EVENT_DIGEST_RETENTION,
  "duplicate evidence must stay within the configured replay window");
const firstRetained = highFrequencyEvents.at(-MISSION_CONTROL_EVENT_DIGEST_RETENTION);
assert.strictEqual(reduceMissionControlEvent(bounded, firstRetained), bounded,
  "a duplicate at the retained boundary must remain an identity no-op");
const expired = highFrequencyEvents.at(-(MISSION_CONTROL_EVENT_DIGEST_RETENTION + 1));
assert.equal(reduceMissionControlEvent(bounded, expired).sync.reason, "stale_event",
  "an unprovable duplicate outside retention must fail closed into resync");

const sharedLaneUpdates = [
  envelope(11, "attention.updated", { required: true, reason: "approval" }, {
    repository: "norm/example", laneId: "bridge-1",
  }),
  envelope(12, "github.updated", { prNumber: 42, headSha: "abc123" }, {
    repository: "norm/example", laneId: "bridge-1",
  }),
  envelope(13, "lifecycle.updated", { phase: "reviewing" }, {
    repository: "norm/example", laneId: "bridge-1",
  }),
];
const sharedLaneState = sharedLaneUpdates.reduce(reduceMissionControlEvent, initial);
assert.deepEqual(sharedLaneState.lanes[laneKey].attention, { required: true, reason: "approval" });
assert.deepEqual(sharedLaneState.lanes[laneKey].github, { prNumber: 42, headSha: "abc123" });
assert.deepEqual(sharedLaneState.lanes[laneKey].lifecycle, { phase: "reviewing" });

const removalSnapshot = envelope(30, "snapshot", {
  repositories: [{ id: "norm/example" }],
  portfolios: [{ id: "helm-1", repository: "norm/example" }],
  lanes: [
    { id: "bridge-1", repository: "norm/example" },
    { id: "bridge-2", repository: "norm/example" },
  ],
  providers: [
    { id: "claude", repository: "norm/example", laneId: "bridge-1" },
    { id: "codex", repository: "norm/example", laneId: "bridge-2" },
  ],
  capacities: [{ providerId: "claude", work: { limit: 5, inUse: 0, queued: 0 }, review: { limit: 10, inUse: 1, queued: 0 } }],
  quotas: [{ providerId: "claude", weeklyRemaining: 48 }],
});
const afterLaneRemoval = reduceMissionControlEvent(createMissionControlEventState(removalSnapshot),
  envelope(31, "lane.removed", {}, { repository: "norm/example", laneId: "bridge-1" }));
assert.equal(afterLaneRemoval.lanes[missionControlLaneKey("norm/example", "bridge-1")], undefined);
assert.equal(Object.values(afterLaneRemoval.providers).some((provider) => provider.laneId === "bridge-1"), false);
assert.equal(Object.values(afterLaneRemoval.providers).some((provider) => provider.laneId === "bridge-2"), true);
const afterRepositoryRemoval = reduceMissionControlEvent(afterLaneRemoval,
  envelope(32, "repository.removed", {}, { repository: "norm/example" }));
assert.deepEqual(afterRepositoryRemoval.repositories, {});
assert.deepEqual(afterRepositoryRemoval.portfolios, {});
assert.deepEqual(afterRepositoryRemoval.lanes, {});
assert.deepEqual(afterRepositoryRemoval.providers, {});
assert.equal(afterRepositoryRemoval.capacities.claude.review.inUse, 1,
  "repository removal must not erase machine-global provider capacity");
assert.equal(afterRepositoryRemoval.quotas.claude.weeklyRemaining, 48,
  "repository removal must not erase machine-global quota state");

console.log("Mission Control event protocol tests passed.");

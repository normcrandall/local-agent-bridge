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
  createMissionControlEventState,
  reduceMissionControlEvent,
  reduceMissionControlEvents,
} from "../src/mission-control-event-reducer.mjs";

const at = (second) => `2026-07-26T12:00:${String(second).padStart(2, "0")}.000Z`;
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
  quotas: [{ providerId: "claude", weeklyRemaining: 50 }],
});

assert.ok(MISSION_CONTROL_EVENT_TYPES.includes("snapshot"));
assert.equal(validateMissionControlEventEnvelope(snapshot).cursor, 10);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, version: 2 }), /Unsupported.*version/i);
assert.throws(() => validateMissionControlEventEnvelope({ ...snapshot, cursor: 9 }), /cursor.*sequence/i);
assert.throws(() => validateMissionControlEventEnvelope(envelope(11, "lane.updated", {}, {
  repository: "norm/example",
})), /laneId/i);
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
  repository: "norm/example",
  providerId: "claude",
});
const current = reduceMissionControlEvents(snapshot, [laneUpdate, narrativeUpdate, output, quota]);
assert.equal(current.cursor, 14);
assert.equal(current.lanes[laneKey].status, "reviewing");
assert.equal(current.lanes[laneKey].narrative.summary, "Checking exact-head review.");
assert.deepEqual(current.lanes[laneKey].output, [{ text: "Review approved.", source: "provider" }]);
assert.equal(current.quotas.claude.weeklyRemaining, 49);

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
const ignoredWhileUnsynchronized = reduceMissionControlEvent(requested, envelope(16, "repository.updated", { active: 9 }, {
  repository: "norm/example",
}));
assert.deepEqual(ignoredWhileUnsynchronized, requested, "only a snapshot may recover a resync-required state");

console.log("Mission Control event protocol tests passed.");

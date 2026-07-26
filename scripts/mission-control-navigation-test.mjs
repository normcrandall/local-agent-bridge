#!/usr/bin/env node

import assert from "node:assert/strict";
import { createMissionControlEventState } from "../src/mission-control-event-reducer.mjs";
import {
  MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  missionControlLaneKey,
} from "../src/mission-control-event-protocol.mjs";
import {
  MISSION_CONTROL_VIEW_TABS,
  projectMissionControlViewModel,
} from "../src/mission-control-view-model.mjs";
import {
  MISSION_CONTROL_NAVIGATION_PANES,
  MISSION_CONTROL_NAVIGATION_VIEWS,
  createMissionControlNavigationState,
  markMissionControlCompletionSeen,
  missionControlCompletionIsUnseen,
  moveMissionControlLane,
  reconcileMissionControlNavigation,
  restoreMissionControlNavigation,
  serializeMissionControlNavigation,
  updateMissionControlNavigation,
} from "../src/mission-control-navigation.mjs";

const at = (second) => new Date(Date.parse("2026-07-26T18:00:00.000Z") + second * 1_000).toISOString();
const snapshot = {
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId: "navigation-test",
  sequence: 1,
  cursor: 1,
  type: "snapshot",
  occurredAt: at(1),
  payload: {
    repositories: [{ id: "veliqon/alpha" }, { id: "veliqon/beta" }],
    portfolios: [
      { id: "helm-a", repository: "veliqon/alpha" },
      { id: "helm-b", repository: "veliqon/beta" },
    ],
    providers: [],
    quotas: [],
    lanes: [
      { id: "alpha-a", repository: "veliqon/alpha", status: "running", createdAt: at(2), portfolio: { portfolioId: "helm-a" } },
      { id: "alpha-b", repository: "veliqon/alpha", status: "working", createdAt: at(3), portfolio: { portfolioId: "helm-a" } },
      { id: "beta-a", repository: "veliqon/beta", status: "running", createdAt: at(4), portfolio: { portfolioId: "helm-b" } },
      { id: "decision", repository: "veliqon/alpha", status: "needs_user", createdAt: at(5), attention: { required: true }, portfolio: { portfolioId: "helm-a" } },
      { id: "review", repository: "veliqon/alpha", status: "reviewing", createdAt: at(6), mode: "review", portfolio: { portfolioId: "helm-a" } },
      { id: "merge", repository: "veliqon/alpha", status: "integrating", createdAt: at(7), mergeTrain: { queued: true }, portfolio: { portfolioId: "helm-a" } },
      { id: "done", repository: "veliqon/alpha", status: "merged", completedAt: at(8), github: { headSha: "abc" }, portfolio: { portfolioId: "helm-a" } },
      { id: "orphan", repository: "veliqon/alpha", status: "blocked", createdAt: at(9) },
    ],
  },
};

const projected = projectMissionControlViewModel(createMissionControlEventState(snapshot));
const lane = (id) => Object.values(projected.collections).flat().find((entry) => entry.id === id);
const alphaA = lane("alpha-a");
const alphaB = lane("alpha-b");
const betaA = lane("beta-a");
const needsUser = lane("decision");
const completed = lane("done");

assert.deepEqual(MISSION_CONTROL_NAVIGATION_VIEWS, ["active", "needsYou", "queue", "reviews", "mergeTrain", "history", "portfolios"]);
assert.deepEqual(MISSION_CONTROL_NAVIGATION_PANES, ["repositories", "work", "details"]);
assert.deepEqual(projected.tabs, MISSION_CONTROL_VIEW_TABS);
assert.equal(alphaB.key, missionControlLaneKey("veliqon/alpha", "alpha-b"), "navigation consumes the producer's canonical NUL-separated lane key");
assert.deepEqual(projected.portfolios.map(({ repository, id }) => ({ repository, id })), [
  { repository: "veliqon/alpha", id: "helm-a" },
  { repository: "veliqon/beta", id: "helm-b" },
], "the projection forwards declared portfolios to navigation");

let navigation = createMissionControlNavigationState({ repository: "veliqon/alpha", lane: alphaB.key });
let result = reconcileMissionControlNavigation(navigation, projected);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b", "review", "merge"]);
assert.equal(result.state.lane, alphaB.key);

// A heartbeat-driven source reorder must not reorder rows or move selection.
const heartbeatReordered = {
  ...projected,
  collections: { ...projected.collections, active: [alphaB, projected.collections.active[3], alphaA, projected.collections.active[2]] },
};
result = reconcileMissionControlNavigation(result.state, heartbeatReordered);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b", "review", "merge"]);
assert.equal(result.state.lane, alphaB.key);

// Removing the selected final row chooses its nearest surviving predecessor.
let finalSelection = reconcileMissionControlNavigation(
  createMissionControlNavigationState({ repository: "veliqon/alpha", lane: lane("merge").key }),
  projected,
);
finalSelection = reconcileMissionControlNavigation(finalSelection.state, {
  ...projected,
  collections: { ...projected.collections, active: projected.collections.active.filter((entry) => entry.id !== "merge") },
});
assert.equal(finalSelection.state.lane, lane("review").key);

// Removing a selected middle row chooses the row that occupies its old index.
let middle = reconcileMissionControlNavigation(
  createMissionControlNavigationState({ repository: "veliqon/alpha", lane: alphaB.key }),
  projected,
);
middle = reconcileMissionControlNavigation(middle.state, {
  ...projected,
  collections: { ...projected.collections, active: projected.collections.active.filter((entry) => entry.id !== "alpha-b") },
});
assert.equal(middle.state.lane, lane("review").key);

navigation = updateMissionControlNavigation(result.state, { repository: "veliqon/beta" });
result = reconcileMissionControlNavigation(navigation, projected);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["beta-a"]);
assert.equal(result.state.lane, betaA.key);

navigation = updateMissionControlNavigation(result.state, { repository: "veliqon/alpha", portfolio: "helm-a", view: "portfolios" });
result = reconcileMissionControlNavigation(navigation, projected);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b", "review", "merge", "decision", "done"]);
assert.ok(!result.lanes.some((entry) => entry.id === "orphan"), "a lane id never masquerades as a portfolio id");
assert.deepEqual(result.portfolios, ["helm-a"], "only declared or explicitly lane-bound portfolio ids enter the picker");
assert.equal(result.state.portfolio, "helm-a");
assert.equal(moveMissionControlLane(result.state, projected, 1).lane, alphaB.key);

for (const [view, expected] of [["reviews", "review"], ["mergeTrain", "merge"]]) {
  const viewResult = reconcileMissionControlNavigation(createMissionControlNavigationState({ view, repository: "veliqon/alpha" }), projected);
  assert.deepEqual(viewResult.lanes.map((entry) => entry.id), [expected]);
}

// Completion visibility is terminal-only local bookkeeping and never aliases attention.
assert.ok(alphaA.completionToken, "the projection deliberately emits a stable token for non-terminal lanes");
assert.equal(missionControlCompletionIsUnseen(result.state, alphaA), false);
assert.throws(() => markMissionControlCompletionSeen(result.state, alphaA), /terminal/i);
assert.equal(missionControlCompletionIsUnseen(result.state, completed), true);
const seen = markMissionControlCompletionSeen(result.state, completed);
assert.equal(missionControlCompletionIsUnseen(seen, completed), false);
assert.equal(missionControlCompletionIsUnseen(seen, needsUser), false);

// Every identifier accepted by the wire contract remains navigable, including tabs and 512-char components.
const longRepository = `r${"x".repeat(511)}`;
const longLaneId = `l${"y".repeat(511)}`;
const unusualLane = { id: "tab\tidentifier", repository: "veliqon/alpha", key: missionControlLaneKey("veliqon/alpha", "tab\tidentifier") };
const longLane = { id: longLaneId, repository: longRepository, key: missionControlLaneKey(longRepository, longLaneId) };
const identityModel = {
  repositories: [{ id: "veliqon/alpha" }, { id: longRepository }],
  portfolios: [],
  collections: { active: [unusualLane, longLane], needsYou: [], queue: [], reviews: [], mergeTrain: [], history: [] },
};
assert.deepEqual(reconcileMissionControlNavigation(createMissionControlNavigationState({ repository: "veliqon/alpha" }), identityModel).lanes.map((entry) => entry.id), ["tab\tidentifier"]);
assert.equal(reconcileMissionControlNavigation(createMissionControlNavigationState({ repository: longRepository, lane: longLane.key }), identityModel).state.lane, longLane.key);

const now = Date.parse("2026-07-26T18:00:00.000Z");
const serialized = serializeMissionControlNavigation({
  ...seen,
  pane: "details",
  providerOutput: "secret output must not be persisted",
  token: "github-token-must-not-be-persisted",
}, { now });
assert.doesNotMatch(serialized, /secret|github-token/u);
assert.deepEqual(restoreMissionControlNavigation(serialized, { now: now + 1_000 }), createMissionControlNavigationState({
  ...seen,
  pane: "details",
}));
assert.deepEqual(restoreMissionControlNavigation("not json", { now }), createMissionControlNavigationState());
assert.deepEqual(restoreMissionControlNavigation(serialized, { now: now + 31 * 24 * 60 * 60 * 1_000 }), createMissionControlNavigationState());
assert.deepEqual(restoreMissionControlNavigation(JSON.stringify({ version: 999, savedAt: new Date(now).toISOString() }), { now }), createMissionControlNavigationState());

const safeKey = missionControlLaneKey("safe-repo", "safe-lane");
const hostile = JSON.stringify({
  version: 1,
  savedAt: new Date(now).toISOString(),
  view: "not-real",
  pane: "not-real",
  repository: "ok",
  lane: missionControlLaneKey("repo", "x".repeat(512)),
  seenCompletions: { [safeKey]: "safe-token", [missionControlLaneKey("repo", "z".repeat(512))]: "also-safe" },
});
assert.deepEqual(restoreMissionControlNavigation(hostile, { now }), createMissionControlNavigationState({
  repository: "ok",
  lane: missionControlLaneKey("repo", "x".repeat(512)),
  seenCompletions: { [safeKey]: "safe-token", [missionControlLaneKey("repo", "z".repeat(512))]: "also-safe" },
}));

// Oversized optional history is shed instead of making persistence unusable.
const oversized = createMissionControlNavigationState({
  laneOrderByScope: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    JSON.stringify(["active", `repo-${index}`, null]),
    Array.from({ length: 20 }, (_, laneIndex) => missionControlLaneKey(`repo-${index}`, `${"x".repeat(500)}-${laneIndex}`)),
  ])),
});
const compacted = serializeMissionControlNavigation(oversized, { now });
assert.ok(Buffer.byteLength(compacted, "utf8") <= 64 * 1_024);
assert.doesNotThrow(() => restoreMissionControlNavigation(compacted, { now }));

console.log("Mission Control navigation tests passed.");

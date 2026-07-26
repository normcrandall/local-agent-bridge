#!/usr/bin/env node

import assert from "node:assert/strict";
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

const lane = (id, repository, status, portfolio = null, extra = {}) => ({
  id,
  key: `${repository}:${id}`,
  repository,
  status,
  ...(portfolio ? { portfolio: { portfolioId: portfolio } } : {}),
  ...extra,
});
const alphaA = lane("alpha-a", "veliqon/alpha", "running", "helm-a");
const alphaB = lane("alpha-b", "veliqon/alpha", "working", "helm-a");
const betaA = lane("beta-a", "veliqon/beta", "running", "helm-b");
const needsUser = lane("decision", "veliqon/alpha", "needs_user", "helm-a");
const completed = lane("done", "veliqon/alpha", "merged", "helm-a", { completionToken: "merge:abc" });

const model = {
  repositories: [{ id: "veliqon/alpha" }, { id: "veliqon/beta" }],
  portfolios: [
    { id: "helm-a", repository: "veliqon/alpha" },
    { id: "helm-b", repository: "veliqon/beta" },
  ],
  collections: {
    active: [alphaA, alphaB, betaA],
    needsYou: [needsUser],
    queue: [],
    reviews: [],
    mergeTrain: [],
    history: [completed],
  },
};

assert.deepEqual(MISSION_CONTROL_NAVIGATION_VIEWS, ["active", "needsYou", "queue", "reviews", "mergeTrain", "history", "portfolios"]);
assert.deepEqual(MISSION_CONTROL_NAVIGATION_PANES, ["repositories", "work", "details"]);

let navigation = createMissionControlNavigationState({ repository: "veliqon/alpha", lane: alphaB.key });
let result = reconcileMissionControlNavigation(navigation, model);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b"]);
assert.equal(result.state.lane, alphaB.key);

// A heartbeat-driven source reorder must not reorder rows or move selection.
const heartbeatReordered = { ...model, collections: { ...model.collections, active: [alphaB, betaA, alphaA] } };
result = reconcileMissionControlNavigation(result.state, heartbeatReordered);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b"]);
assert.equal(result.state.lane, alphaB.key);

// Removing the selected final row chooses its nearest surviving predecessor.
const alphaBArchived = {
  ...model,
  collections: { ...model.collections, active: [alphaA, betaA], history: [completed, { ...alphaB, status: "completed" }] },
};
result = reconcileMissionControlNavigation(result.state, alphaBArchived);
assert.equal(result.state.lane, alphaA.key);

// Removing a selected middle row chooses the row that occupies its old index.
const alphaC = lane("alpha-c", "veliqon/alpha", "running", "helm-a");
let middle = reconcileMissionControlNavigation(
  createMissionControlNavigationState({ repository: "veliqon/alpha", lane: alphaB.key }),
  { ...model, collections: { ...model.collections, active: [alphaA, alphaB, alphaC, betaA] } },
);
middle = reconcileMissionControlNavigation(middle.state, {
  ...model,
  collections: { ...model.collections, active: [alphaA, alphaC, betaA] },
});
assert.equal(middle.state.lane, alphaC.key);

navigation = updateMissionControlNavigation(result.state, { repository: "veliqon/beta" });
result = reconcileMissionControlNavigation(navigation, model);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["beta-a"]);
assert.equal(result.state.lane, betaA.key);

navigation = updateMissionControlNavigation(result.state, { repository: "veliqon/alpha", portfolio: "helm-a", view: "portfolios" });
result = reconcileMissionControlNavigation(navigation, model);
assert.deepEqual(result.lanes.map((entry) => entry.id), ["alpha-a", "alpha-b", "decision", "done"]);
assert.equal(result.state.portfolio, "helm-a");
assert.equal(moveMissionControlLane(result.state, model, 1).lane, alphaB.key);

// Completion visibility is local bookkeeping and never aliases user attention.
assert.equal(missionControlCompletionIsUnseen(result.state, completed), true);
const seen = markMissionControlCompletionSeen(result.state, completed);
assert.equal(missionControlCompletionIsUnseen(seen, completed), false);
assert.equal(missionControlCompletionIsUnseen(seen, needsUser), false);

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

const hostile = JSON.stringify({
  version: 1,
  savedAt: new Date(now).toISOString(),
  view: "not-real",
  pane: "not-real",
  repository: "ok",
  lane: "x".repeat(300),
  seenCompletions: { "safe-lane": "safe-token", ["z".repeat(300)]: "not-safe" },
});
assert.deepEqual(restoreMissionControlNavigation(hostile, { now }), createMissionControlNavigationState({
  repository: "ok",
  seenCompletions: { "safe-lane": "safe-token" },
}));

console.log("Mission Control navigation tests passed.");

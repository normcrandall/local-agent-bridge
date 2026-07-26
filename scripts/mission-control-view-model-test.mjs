#!/usr/bin/env node

import assert from "node:assert/strict";
import { createMissionControlEventState, reduceMissionControlEvent } from "../src/mission-control-event-reducer.mjs";
import { MISSION_CONTROL_EVENT_PROTOCOL_VERSION } from "../src/mission-control-event-protocol.mjs";
import {
  MISSION_CONTROL_VIEW_TABS,
  acknowledgeMissionControlDone,
  projectMissionControlViewModel,
} from "../src/mission-control-view-model.mjs";

const at = (second) => new Date(Date.parse("2026-07-26T12:00:00.000Z") + second * 1_000).toISOString();
const snapshot = {
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId: "view-test",
  sequence: 1,
  cursor: 1,
  type: "snapshot",
  occurredAt: at(1),
  payload: {
    repositories: [{ id: "veliqon/alpha" }, { id: "veliqon/beta" }],
    portfolios: [],
    providers: [],
    quotas: [],
    lanes: [
      { id: "writer-a", repository: "veliqon/alpha", status: "running", createdAt: at(3), updatedAt: at(3) },
      { id: "writer-b", repository: "veliqon/alpha", status: "working", createdAt: at(2), updatedAt: at(2) },
      { id: "needs-user", repository: "veliqon/alpha", status: "needs_user", attention: { required: true }, createdAt: at(4) },
      { id: "queued", repository: "veliqon/beta", status: "blocked", createdAt: at(5) },
      { id: "review", repository: "veliqon/alpha", status: "reviewing", mode: "review", createdAt: at(6) },
      { id: "merge", repository: "veliqon/beta", status: "integrating", createdAt: at(7) },
      { id: "done", repository: "veliqon/alpha", status: "merged", updatedAt: at(8), github: { headSha: "abc" } },
      { id: "stopped", repository: "veliqon/beta", status: "failed", updatedAt: at(9) },
    ],
  },
};

let eventState = createMissionControlEventState(snapshot);
let view = projectMissionControlViewModel(eventState, {
  selectedRepository: "veliqon/alpha",
  selectedTab: "active",
  selectedLane: "veliqon/alpha\0writer-a",
});

assert.deepEqual(view.tabs, MISSION_CONTROL_VIEW_TABS);
assert.deepEqual(view.collections.active.map((lane) => lane.id), ["writer-b", "writer-a", "review", "merge"]);
assert.deepEqual(view.collections.needsYou.map((lane) => lane.id), ["needs-user"]);
assert.deepEqual(view.collections.queue.map((lane) => lane.id), ["queued"]);
assert.deepEqual(view.collections.reviews.map((lane) => lane.id), ["review"]);
assert.deepEqual(view.collections.mergeTrain.map((lane) => lane.id), ["merge"]);
assert.deepEqual(view.collections.history.map((lane) => lane.id), ["done", "stopped"]);
assert.deepEqual(view.repositories, [
  { id: "veliqon/alpha", active: 3, needsYou: 1, waiting: 0, stopped: 0, doneUnseen: 1 },
  { id: "veliqon/beta", active: 1, needsYou: 0, waiting: 1, stopped: 1, doneUnseen: 1 },
]);
assert.deepEqual(view.selection, {
  repository: "veliqon/alpha",
  tab: "active",
  lane: "veliqon/alpha\0writer-a",
});

eventState = reduceMissionControlEvent(eventState, {
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId: "view-test",
  sequence: 2,
  cursor: 2,
  type: "narrative.updated",
  occurredAt: at(20),
  repository: "veliqon/alpha",
  laneId: "writer-b",
  payload: { summary: "A newer heartbeat narrative must not jump the row." },
});
view = projectMissionControlViewModel(eventState, view.clientState);
assert.deepEqual(view.collections.active.map((lane) => lane.id), ["writer-b", "writer-a", "review", "merge"]);
assert.equal(view.selection.lane, "veliqon/alpha\0writer-a");

const done = view.collections.history.find((lane) => lane.id === "done");
assert.throws(() => acknowledgeMissionControlDone(view.clientState, view.collections.active[0]), /terminal/i);
const acknowledged = acknowledgeMissionControlDone(view.clientState, done);
const afterAcknowledgement = projectMissionControlViewModel(eventState, acknowledged);
assert.equal(afterAcknowledgement.collections.history.find((lane) => lane.id === "done").doneUnseen, false);
assert.equal(afterAcknowledgement.repositories.find((repository) => repository.id === "veliqon/alpha").doneUnseen, 0);
assert.equal(eventState.lanes["veliqon/alpha\0done"].acknowledged, undefined,
  "done acknowledgement must remain client-local");

const missingFocus = projectMissionControlViewModel(eventState, {
  ...afterAcknowledgement.clientState,
  selectedRepository: "veliqon/missing",
  selectedTab: "not-a-tab",
  selectedLane: "missing",
});
assert.deepEqual(missingFocus.selection, {
  repository: "veliqon/alpha",
  tab: "active",
  lane: "veliqon/alpha\0writer-b",
});

const betaQueue = projectMissionControlViewModel(eventState, {
  ...missingFocus.clientState,
  selectedRepository: "veliqon/beta",
  selectedTab: "queue",
  selectedLane: "veliqon/beta\0queued",
});
assert.equal(betaQueue.selection.lane, "veliqon/beta\0queued");
assert.equal(betaQueue.collections.queue[0].status, "blocked");

console.log("Mission Control view-model tests passed.");

#!/usr/bin/env node

import assert from "node:assert/strict";
import { createMissionControlSubscriptionClient } from "../src/mission-control-client.mjs";
import { MISSION_CONTROL_EVENT_PROTOCOL_VERSION } from "../src/mission-control-event-protocol.mjs";

const streamId = "mission-control-client-test";
const occurredAt = (sequence) => new Date(Date.parse("2026-07-26T19:00:00.000Z") + sequence * 1_000).toISOString();
const repository = { id: "norm/example" };
const lane = (status, updatedAt = occurredAt(0)) => ({
  id: "bridge-00000000-0000-4000-8000-000000000227",
  repository: repository.id,
  status,
  lifecyclePhase: status,
  createdAt: occurredAt(0),
  updatedAt,
});
const snapshot = (sequence, status) => ({
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId,
  sequence,
  cursor: sequence,
  type: "snapshot",
  occurredAt: occurredAt(sequence),
  payload: { repositories: [repository], portfolios: [], lanes: [lane(status, occurredAt(sequence))], providers: [], quotas: [] },
});
const laneEvent = (sequence, status) => ({
  version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
  streamId,
  sequence,
  cursor: sequence,
  type: "lane.updated",
  occurredAt: occurredAt(sequence),
  repository: repository.id,
  laneId: lane(status).id,
  payload: lane(status, occurredAt(sequence)),
});

let snapshotReads = 0;
let snapshotHead = snapshot(0, "queued");
const reads = [];
const scripted = [];
const redraws = [];
const client = createMissionControlSubscriptionClient({
  runtimeRoot: "/runtime",
  workspaceRoot: "/workspace",
  stateRoot: "/state",
  waitMs: 0,
  snapshotReader: async () => { snapshotReads += 1; return snapshotHead; },
  eventReader: async (request) => {
    reads.push({ streamId: request.streamId, cursor: request.cursor, maxEvents: request.maxEvents });
    const next = scripted.shift();
    if (next instanceof Error) throw next;
    return next || { streamId, cursor: request.cursor, events: [], resyncRequired: false, hasMore: false };
  },
  onUpdate: ({ reason, eventCount, checkpoint, viewModel }) => {
    redraws.push({ reason, eventCount, checkpoint, status: viewModel.collections.active[0]?.status || viewModel.collections.queue[0]?.status });
  },
});

await client.pollOnce();
assert.equal(snapshotReads, 1);
assert.deepEqual(redraws, [{ reason: "bootstrap", eventCount: 0, checkpoint: { streamId, cursor: 0 }, status: "queued" }]);

scripted.push({ streamId, cursor: 2, events: [laneEvent(1, "running"), laneEvent(2, "working")], resyncRequired: false, hasMore: false });
await client.pollOnce();
assert.equal(redraws.length, 2, "a multi-event batch must produce one redraw");
assert.deepEqual(redraws.at(-1), { reason: "events", eventCount: 2, checkpoint: { streamId, cursor: 2 }, status: "working" });
assert.deepEqual(reads[0], { streamId, cursor: 0, maxEvents: 100 });

scripted.push(new Error("supervisor restarted"));
await assert.rejects(client.pollOnce(), /supervisor restarted/);
assert.deepEqual(client.snapshot.checkpoint, { streamId, cursor: 2 }, "a failed transport read must not consume the durable cursor");
scripted.push({ streamId, cursor: 3, events: [laneEvent(3, "reviewing")], resyncRequired: false, hasMore: false });
await client.pollOnce();
assert.equal(reads.at(-1).cursor, 2, "reconnect must resume from the last applied cursor");

snapshotHead = snapshot(5, "recovering");
scripted.push({ streamId, cursor: 5, events: [laneEvent(5, "failed")], resyncRequired: false, hasMore: false });
await client.pollOnce();
assert.equal(snapshotReads, 2, "a reducer-detected cursor gap must perform one bounded snapshot resync");
assert.equal(client.snapshot.resyncCount, 1);
assert.equal(redraws.at(-1).reason, "resync:sequence_gap");
assert.deepEqual(client.snapshot.checkpoint, { streamId, cursor: 5 });

snapshotHead = snapshot(7, "running");
scripted.push({ streamId, cursor: 5, events: [], resyncRequired: true, reason: "retention_window_exceeded" });
await client.pollOnce();
assert.equal(snapshotReads, 3, "a server-declared retention gap must resync exactly once");
assert.equal(client.snapshot.resyncCount, 2);
assert.equal(redraws.at(-1).reason, "resync:retention_window_exceeded");

const beforeIdle = redraws.length;
scripted.push({ streamId, cursor: 7, events: [], resyncRequired: false, hasMore: false });
await client.pollOnce();
assert.equal(redraws.length, beforeIdle, "an empty long-poll response must not redraw");

const hundred = Array.from({ length: 100 }, (_, index) => laneEvent(8 + index, index % 2 ? "working" : "running"));
scripted.push({ streamId, cursor: 107, events: hundred, resyncRequired: false, hasMore: false });
await client.pollOnce();
assert.equal(redraws.length, beforeIdle + 1, "the maximum event batch must still redraw only once");
assert.equal(redraws.at(-1).eventCount, 100);
assert.equal(client.snapshot.redrawCount, redraws.length);

client.stop();
assert.equal((await client.pollOnce()).status, "stopped");

let consecutiveResyncReads = 0;
const resyncAbort = new AbortController();
const resyncClient = createMissionControlSubscriptionClient({
  runtimeRoot: "/runtime",
  workspaceRoot: "/workspace",
  stateRoot: "/state",
  waitMs: 0,
  reconnectDelayMs: 1,
  snapshotReader: async () => snapshot(7, "running"),
  eventReader: async () => {
    consecutiveResyncReads += 1;
    if (consecutiveResyncReads === 3) resyncAbort.abort();
    return { streamId, cursor: 7, events: [], resyncRequired: true, reason: "retention_window_exceeded" };
  },
});
await resyncClient.run({ signal: resyncAbort.signal });
assert.equal(consecutiveResyncReads, 3, "repeated resync requests remain recoverable");
assert.ok(resyncClient.snapshot.resyncCount >= 2);
assert.ok(resyncClient.snapshot.consecutiveResyncs >= 2, "consecutive resyncs are tracked and back off instead of busy-looping");

let paginatedRecoveryReads = 0;
const paginatedRecoveryAbort = new AbortController();
const paginatedRecoveryClient = createMissionControlSubscriptionClient({
  runtimeRoot: "/runtime",
  workspaceRoot: "/workspace",
  stateRoot: "/state",
  waitMs: 0,
  reconnectDelayMs: 0,
  snapshotReader: async () => snapshot(0, "running"),
  eventReader: async () => {
    paginatedRecoveryReads += 1;
    if (paginatedRecoveryReads === 1) {
      return { streamId, cursor: 0, events: [], resyncRequired: true, reason: "retention_window_exceeded" };
    }
    if (paginatedRecoveryReads === 2) {
      return { streamId, cursor: 1, events: [laneEvent(1, "working")], resyncRequired: false, hasMore: true };
    }
    paginatedRecoveryAbort.abort();
    return { streamId, cursor: 1, events: [], resyncRequired: true, reason: "retention_window_exceeded" };
  },
});
await paginatedRecoveryClient.run({ signal: paginatedRecoveryAbort.signal });
assert.equal(paginatedRecoveryReads, 3);
assert.equal(
  paginatedRecoveryClient.snapshot.consecutiveResyncs,
  1,
  "a healthy paginated batch resets the resync backoff before a later gap",
);

console.log("Mission Control live-client tests passed: ordered batching, reconnect cursor reuse, bounded gap resync/backoff, and redraw coalescing are verified.");

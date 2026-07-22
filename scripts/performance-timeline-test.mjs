import assert from "node:assert/strict";
import {
  createPerformanceTimeline,
  finishPerformanceSpan,
  markPerformanceMilestone,
  startPerformanceSpan,
  summarizePerformance,
} from "../src/performance-timeline.mjs";
import { createVerificationTimingTracker } from "../src/verification-timing.mjs";

let timeline = createPerformanceTimeline("2026-07-22T12:00:00.000Z");
timeline = startPerformanceSpan(timeline, "queueing", { at: "2026-07-22T12:00:00.000Z", category: "active" });
timeline = finishPerformanceSpan(timeline, "queueing", { at: "2026-07-22T12:00:01.000Z" });
timeline = startPerformanceSpan(timeline, "provider_startup", { at: "2026-07-22T12:00:01.000Z", category: "active" });
timeline = finishPerformanceSpan(timeline, "provider_startup", { at: "2026-07-22T12:00:01.200Z" });
timeline = startPerformanceSpan(timeline, "first_progress", { at: "2026-07-22T12:00:01.200Z", category: "active" });
timeline = finishPerformanceSpan(timeline, "first_progress", { at: "2026-07-22T12:00:01.700Z" });
timeline = startPerformanceSpan(timeline, "provider_turn", { at: "2026-07-22T12:00:00.500Z", category: "active" });
timeline = finishPerformanceSpan(timeline, "provider_turn", { at: "2026-07-22T12:00:02.000Z" });
timeline = markPerformanceMilestone(timeline, "provider_completed", { at: "2026-07-22T12:01:00.000Z" });
timeline = markPerformanceMilestone(timeline, "coordinator_wake_enqueued", { at: "2026-07-22T12:01:02.000Z" });
timeline = markPerformanceMilestone(timeline, "coordinator_wake_delivered", { at: "2026-07-22T12:01:05.000Z" });
timeline = markPerformanceMilestone(timeline, "coordinator_wake_acknowledged", { at: "2026-07-22T12:01:15.000Z" });
timeline = markPerformanceMilestone(timeline, "review_started", { at: "2026-07-22T12:01:20.000Z" });
timeline = markPerformanceMilestone(timeline, "formal_review_published", { at: "2026-07-22T12:02:00.000Z" });
timeline = markPerformanceMilestone(timeline, "review_completed", { at: "2026-07-22T12:02:10.000Z" });
timeline = markPerformanceMilestone(timeline, "merge_validation_started", { at: "2026-07-22T12:02:20.000Z" });
timeline = markPerformanceMilestone(timeline, "merge_validation_completed", { at: "2026-07-22T12:02:50.000Z" });
timeline = markPerformanceMilestone(timeline, "merge_authorized", { at: "2026-07-22T12:02:55.000Z" });
timeline = markPerformanceMilestone(timeline, "merge_completed", { at: "2026-07-22T12:03:00.000Z" });

const summary = summarizePerformance(timeline);
assert.equal(summary.byName.queueing.totalMs, 1000);
assert.equal(summary.byName.provider_startup.totalMs, 200);
assert.equal(summary.byName.first_progress.totalMs, 500);
assert.equal(summary.byName.completion_to_wake.totalMs, 2000);
assert.equal(summary.byName.wake_delivery.totalMs, 3000);
assert.equal(summary.byName.wake_acknowledgement.totalMs, 10000);
assert.equal(summary.byName.wake_to_review.totalMs, 5000);
assert.equal(summary.byName.formal_review_to_portfolio_review.totalMs, 10000);
assert.equal(summary.byName.merge_coordinator_wait.totalMs, 10000);
assert.equal(summary.byName.merge_ci_validation.totalMs, 30000);
assert.equal(summary.byName.merge_policy_wait.totalMs, 5000);
assert.equal(summary.byName.github_merge_execution.totalMs, 5000);
assert.equal(summary.deadTimeMs, 80_000);
assert.equal(summary.attributedDeadTimeMs, 80_000);
assert.equal(summary.activeTimeMs, 2_000, "wall-clock active time must merge overlapping spans");
assert.equal(summary.attributedActiveTimeMs, 3_200, "per-span attribution remains available for breakdowns");

let noDelivery = createPerformanceTimeline("2026-07-22T13:00:00.000Z");
noDelivery = markPerformanceMilestone(noDelivery, "provider_completed", { at: "2026-07-22T13:00:01.000Z" });
noDelivery = markPerformanceMilestone(noDelivery, "handoff_completed", { at: "2026-07-22T13:00:02.000Z" });
noDelivery = markPerformanceMilestone(noDelivery, "handoff_acknowledged", { at: "2026-07-22T13:00:17.000Z" });
const noDeliverySummary = summarizePerformance(noDelivery);
assert.equal(noDeliverySummary.byName.handoff_to_chair_acknowledgement.totalMs, 15_000,
  "a handoff without a delivery adapter must still measure chair acknowledgement delay");

let undeliveredWake = createPerformanceTimeline("2026-07-22T14:00:00.000Z");
undeliveredWake = markPerformanceMilestone(undeliveredWake, "provider_completed", { at: "2026-07-22T14:00:01.000Z" });
undeliveredWake = markPerformanceMilestone(undeliveredWake, "coordinator_wake_enqueued", { at: "2026-07-22T14:00:03.000Z" });
undeliveredWake = markPerformanceMilestone(undeliveredWake, "coordinator_wake_acknowledged", { at: "2026-07-22T14:00:13.000Z" });
const undeliveredWakeSummary = summarizePerformance(undeliveredWake);
assert.equal(undeliveredWakeSummary.byName.wake_acknowledgement.totalMs, 10_000,
  "an undelivered native-chair wake must measure enqueue-to-acknowledgement");

let overlappingDeadTime = createPerformanceTimeline("2026-07-22T15:00:00.000Z");
overlappingDeadTime = markPerformanceMilestone(overlappingDeadTime, "provider_completed", { at: "2026-07-22T15:00:01.000Z" });
overlappingDeadTime = markPerformanceMilestone(overlappingDeadTime, "handoff_completed", { at: "2026-07-22T15:00:02.000Z" });
overlappingDeadTime = markPerformanceMilestone(overlappingDeadTime, "coordinator_wake_enqueued", { at: "2026-07-22T15:00:03.000Z" });
overlappingDeadTime = markPerformanceMilestone(overlappingDeadTime, "coordinator_wake_acknowledged", { at: "2026-07-22T15:00:13.000Z" });
overlappingDeadTime = markPerformanceMilestone(overlappingDeadTime, "handoff_acknowledged", { at: "2026-07-22T15:00:17.000Z" });
const overlappingSummary = summarizePerformance(overlappingDeadTime);
assert.equal(overlappingSummary.deadTimeMs, 16_000, "wall-clock dead time must not double-count overlapping acknowledgement spans");
assert.equal(overlappingSummary.attributedDeadTimeMs, 27_000, "per-span dead-time attribution remains available for diagnosis");

const verificationEvents = [];
const tracker = createVerificationTimingTracker({
  onStart: async (event) => verificationEvents.push({ action: "start", ...event }),
  onFinish: async (event) => verificationEvents.push({ action: "finish", ...event }),
});
await tracker.observe({ command: "npm run test:evidence", at: "2026-07-22T12:03:00.000Z" });
await tracker.observe({ command: "npm run test:performance", at: "2026-07-22T12:03:01.000Z" });
assert.deepEqual(tracker.activeCommands(), ["npm run test:evidence", "npm run test:performance"]);
await tracker.observe({ command: "npm run test:performance", finished: true, at: "2026-07-22T12:03:03.000Z" });
await tracker.observe({ command: "npm run test:evidence", finished: true, at: "2026-07-22T12:03:05.000Z" });
assert.deepEqual(verificationEvents.map((event) => [event.action, event.command]), [
  ["start", "npm run test:evidence"],
  ["start", "npm run test:performance"],
  ["finish", "npm run test:performance"],
  ["finish", "npm run test:evidence"],
], "concurrent gates must retain independent spans even when they finish out of order");
assert.equal(await tracker.finishAll({ at: "2026-07-22T12:03:06.000Z" }), 0);

console.log("Performance timeline tests passed.");

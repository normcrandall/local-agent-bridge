import assert from "node:assert/strict";
import { inspectTurnSilence } from "../src/codex-turn-watchdog.mjs";

const startedAt = "2026-07-15T09:26:26.486Z";
const silent = inspectTurnSilence([
  { timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
], { now: Date.parse(startedAt) + 61_000, thresholdMs: 60_000 });
assert.equal(silent.status, "silent");
assert.equal(silent.phase, "pre-first-output");

const active = inspectTurnSilence([
  { timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: "2026-07-15T09:26:30.000Z", type: "response_item", payload: { type: "message", role: "assistant" } },
], { now: Date.parse(startedAt) + 61_000, thresholdMs: 60_000 });
assert.equal(active.status, "responsive");

const completed = inspectTurnSilence([
  { timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: "2026-07-15T09:26:35.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
], { now: Date.parse(startedAt) + 61_000, thresholdMs: 60_000 });
assert.equal(completed.status, "completed");

console.log("Codex native-turn silence watchdog tests passed.");

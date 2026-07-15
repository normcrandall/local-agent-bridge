import assert from "node:assert/strict";
import { completionAfterHandoff, acknowledgeCompletion } from "../src/handoff-protocol.mjs";

const handoff = {
  outcome: "completed",
  summary: "Implemented and verified the change.",
  artifacts: ["src/example.mjs"],
  verification: ["npm test: passed"],
  remaining: [],
  nextAction: "chair_verify",
};
const pending = completionAfterHandoff(null, { handoff, agent: "claude", turn: 3, at: "2026-07-15T00:00:00.000Z" });
assert.equal(pending.sequence, 1);
assert.equal(pending.phase, "awaiting_chair_verification");
assert.equal(pending.acknowledged, false);
assert.equal(pending.lastHandoff.agent, "claude");

const verified = acknowledgeCompletion(pending, {
  sequence: 1,
  accepted: true,
  summary: "Verified independently.",
  verification: ["npm test: passed independently"],
  remaining: [],
  at: "2026-07-15T00:01:00.000Z",
});
assert.equal(verified.phase, "verified_complete");
assert.equal(verified.acknowledged, true);
assert.throws(() => acknowledgeCompletion(pending, {
  sequence: 2, accepted: true, summary: "Wrong sequence", verification: [], remaining: [],
}), /sequence/i);

console.log("Structured handoff completion tests passed.");

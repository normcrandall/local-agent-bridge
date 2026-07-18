// Issue #55 fixture: command-aware live narrative — the active verification command
// and the explicit capacity-wait reason appear in the narrative.
import assert from "node:assert/strict";
import {
  activeVerificationCommand,
  capacityWaitNarrative,
  verificationNarrative,
} from "../src/collaboration-narrative.mjs";

// Capacity-wait narrative carries an explicit reason and structured capacity.
const singleWait = capacityWaitNarrative({ agent: "codex", role: "work", limit: 1, inUse: 1, position: 2 });
assert.match(singleWait.summary, /Waiting for codex work capacity/);
assert.match(singleWait.summary, /1\/1 codex work slot in use/);
assert.match(singleWait.reason, /all 1 codex work capacity slot .*occupied; queued at position 2/);
assert.deepEqual(singleWait.capacity, { role: "work", limit: 1, inUse: 1, position: 2 });

const reviewWait = capacityWaitNarrative({ agent: "claude", role: "review", limit: 2, inUse: 2, position: 1 });
assert.match(reviewWait.summary, /2\/2 claude review slots in use/);
assert.match(reviewWait.reason, /next to acquire/);

// Active verification command detection: longest allowlisted match wins; null otherwise.
const commands = ["npm test", "npm run test:collaboration"];
assert.equal(activeVerificationCommand("Running npm run test:collaboration now", commands), "npm run test:collaboration");
assert.equal(activeVerificationCommand("Running npm test now", commands), "npm test");
assert.equal(activeVerificationCommand("Reading files", commands), null);
assert.equal(activeVerificationCommand(null, commands), null);
assert.equal(activeVerificationCommand("anything", []), null);

// Verification narrative folds the active command into the summary, or passes through.
const named = verificationNarrative({ agent: "claude", providerSummary: "50% done", command: "npm run smoke" });
assert.equal(named.verificationCommand, "npm run smoke");
assert.match(named.summary, /claude is running verification command `npm run smoke`: 50% done/);

const passthrough = verificationNarrative({ agent: "claude", providerSummary: "Reading files", command: null });
assert.equal(passthrough.verificationCommand, null);
assert.equal(passthrough.summary, "Reading files");

console.log("Issue #55 command-aware narrative tests passed.");

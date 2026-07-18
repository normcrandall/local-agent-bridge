import assert from "node:assert/strict";
import { createAgentPool } from "../src/agent-pool.mjs";
import { classifyCoordinatorWake } from "../src/coordinator-wake.mjs";

// Fail-closed autonomous delivery: an autonomous council/portfolio/take-the-helm
// pool may only mutate GitHub through a bound githubBuilder. Without one it must
// refuse the deliver profile and any smuggled raw-delivery workCommand, never
// falling back to raw push, gh pull-request mutation, gh api, PAT, or ambient
// git credentials.
const root = "/tmp/issue-40-autonomy";
const boundBuilder = {
  repository: "owner/repo",
  expectedLogin: "builder[bot]",
  headSha: "a".repeat(40),
  allowedOperations: ["ensure_pull_request"],
};

assert.throws(
  () => createAgentPool({ root, workProfile: "deliver", autonomous: true }),
  /Autonomous delivery requires a bound githubBuilder/,
);

for (const command of [
  "git push -u origin feature",
  "gh pr create --fill",
  "gh pr merge 4 --squash",
  "echo prep && gh pr ready 4",
  "gh api repos/owner/repo/merges",
]) {
  assert.throws(
    () => createAgentPool({ root, workProfile: "implement", workCommands: [command], autonomous: true }),
    /raw delivery command is not permitted/,
    `autonomous pool must reject smuggled raw delivery: ${command}`,
  );
}

// Autonomous delivery WITH a bound builder is permitted (canonical path).
assert.doesNotThrow(() => createAgentPool({ root, workProfile: "deliver", githubBuilder: boundBuilder, autonomous: true }));
// A benign autonomous implement lane (no raw delivery command) is permitted.
assert.doesNotThrow(() => createAgentPool({ root, workProfile: "implement", workCommands: ["npm test"], autonomous: true }));
// The explicitly user-selected, non-autonomous legacy deliver lane is preserved.
assert.doesNotThrow(() => createAgentPool({ root, workProfile: "deliver" }));

// Lifecycle: coordinator wakes distinguish succeeded / rejected / indeterminate
// / reconciled remote verification from the structural delivery outcome recorded
// in completion, rather than ignoring delivery results.
const chair = { provider: "claude" };
const wakeFor = (status, completion) => classifyCoordinatorWake({ chair, status, completion });

const indeterminateHandoff = wakeFor("running", { acknowledged: false, nextAction: "chair_verify", delivery: { outcome: "indeterminate" } });
assert.equal(indeterminateHandoff.deliveryOutcome, "indeterminate");
assert.equal(indeterminateHandoff.actionable, true);
assert.equal(indeterminateHandoff.nextAction, "writer_fix");

const reconciledComplete = wakeFor("agreed", { acknowledged: true, delivery: { outcome: "reconciled" } });
assert.equal(reconciledComplete.kind, "phase_complete");
assert.equal(reconciledComplete.deliveryOutcome, "reconciled");
assert.equal(reconciledComplete.nextAction, "chair_verify");

const rejectedComplete = wakeFor("agreed", { acknowledged: true, delivery: { outcome: "rejected" } });
assert.equal(rejectedComplete.deliveryOutcome, "rejected");
assert.equal(rejectedComplete.nextAction, "inspect");

const succeededComplete = wakeFor("agreed", { acknowledged: true, delivery: { outcome: "succeeded" } });
assert.equal(succeededComplete.deliveryOutcome, "succeeded");
assert.equal(succeededComplete.nextAction, "chair_verify");

// No recorded delivery leaves the classification unchanged (no delivery field).
const noDelivery = wakeFor("agreed", { acknowledged: true });
assert.equal(noDelivery.deliveryOutcome, undefined);
assert.equal(noDelivery.nextAction, "chair_verify");

console.log("Issue #40 fail-closed autonomous-delivery and lifecycle wake tests passed.");

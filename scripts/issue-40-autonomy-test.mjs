import assert from "node:assert/strict";
import { createAgentPool, autonomousWorkProfile } from "../src/agent-pool.mjs";
import { claudeToolRequest, codexToolRequest } from "../src/tool-requests.mjs";
import { classifyCoordinatorWake, enqueueCoordinatorWake } from "../src/coordinator-wake.mjs";
import { createCollaboration, updateCollaboration } from "../src/collaboration-store.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// A raw-delivery workCommand is rejected in EVERY autonomous mode, including
// when a bound builder is present.
assert.throws(
  () => createAgentPool({ root, workProfile: "implement", githubBuilder: boundBuilder, workCommands: ["git push origin feature"], autonomous: true }),
  /raw delivery command is not permitted/,
);

// Autonomous delivery WITH a bound builder is permitted (canonical path), and is
// downgraded to an implement-equivalent shell/network profile.
assert.doesNotThrow(() => createAgentPool({ root, workProfile: "deliver", githubBuilder: boundBuilder, autonomous: true }));

// The downgrade helper: autonomous + bound builder → implement-equivalent; a
// non-autonomous caller keeps its explicitly selected deliver profile.
assert.equal(autonomousWorkProfile({ autonomous: true, githubBuilder: boundBuilder, mode: "work", workProfile: "deliver" }), "implement");
assert.equal(autonomousWorkProfile({ autonomous: false, githubBuilder: boundBuilder, mode: "work", workProfile: "deliver" }), "deliver");

// Inspect the ACTUAL generated Claude request: with the builder bound and the
// autonomous downgrade applied, the profile is implement (no git push / gh pr
// grants) while the bound builder is present.
const effectiveProfile = autonomousWorkProfile({ autonomous: true, githubBuilder: boundBuilder, mode: "work", workProfile: "deliver" });
const claudeRequest = claudeToolRequest({ prompt: "deliver via builder", mode: "work", workProfile: effectiveProfile, githubBuilder: boundBuilder });
assert.equal(claudeRequest.arguments.workProfile, "implement");
assert.notEqual(claudeRequest.arguments.workProfile, "deliver");
assert.ok(claudeRequest.arguments.githubBuilder, "the bound builder must remain present");

// Inspect the ACTUAL generated Codex request: implement-equivalent network is
// disabled and the bound builder tools are present, with no raw-delivery prose.
const codexBridge = "/tmp/github-builder-bridge.mjs";
const codexRequest = codexToolRequest({
  prompt: "deliver via builder", cwd: "/workspace", mode: "work",
  workProfile: effectiveProfile, githubBuilder: boundBuilder, githubBuilderBridgePath: codexBridge,
});
assert.equal(codexRequest.arguments.config["sandbox_workspace_write.network_access"], false);
assert.ok(codexRequest.arguments.config["mcp_servers.github_builder.enabled"]);
assert.match(codexRequest.arguments.prompt, /github_builder tools/);
assert.doesNotMatch(codexRequest.arguments.prompt, /push and pull-request creation/);
// Contrast: an un-downgraded deliver profile would have re-enabled Codex network
// (the exact leak the downgrade closes).
const leakyCodex = codexToolRequest({
  prompt: "x", cwd: "/workspace", mode: "work",
  workProfile: "deliver", githubBuilder: boundBuilder, githubBuilderBridgePath: codexBridge,
});
assert.equal(leakyCodex.arguments.config["sandbox_workspace_write.network_access"], true);
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

// classifyCoordinatorWake for each delivery outcome, direct.
for (const [outcome, expectedNext] of [["succeeded", "chair_verify"], ["reconciled", "chair_verify"], ["rejected", "inspect"], ["indeterminate", "inspect"]]) {
  const wake = classifyCoordinatorWake({ chair, status: "agreed", completion: { acknowledged: true, sequence: 1, delivery: { outcome } } });
  assert.equal(wake.deliveryOutcome, outcome, `${outcome}: surfaced`);
  assert.equal(wake.nextAction, expectedNext, `${outcome}: nextAction`);
}

// enqueue/dedup: a wake is enqueued once for a stable delivery state, deduped on
// repeat, and re-enqueued when the delivery outcome changes.
const wakeRoot = await mkdtemp(join(tmpdir(), "issue-40-wake-"));
const created = await createCollaboration(wakeRoot, {
  chair: { provider: "claude" },
  workspace: wakeRoot,
  status: "agreed",
  runSequence: 1,
  runtime: { turnCount: 1 },
  completion: { acknowledged: true, sequence: 1, delivery: { outcome: "succeeded" } },
});
const enq1 = await enqueueCoordinatorWake(wakeRoot, created.id);
assert.equal(enq1.coordinatorWake.deliveryOutcome, "succeeded");
assert.equal(enq1.coordinatorWake.sequence, 1);
const firstKey = enq1.coordinatorWake.key;
const enq2 = await enqueueCoordinatorWake(wakeRoot, created.id);
assert.equal(enq2.coordinatorWake.sequence, 1, "unchanged delivery state must dedup");
assert.equal(enq2.coordinatorWake.key, firstKey);
await updateCollaboration(wakeRoot, created.id, (current) => ({
  ...current,
  completion: { ...current.completion, delivery: { outcome: "indeterminate" } },
}));
const enq3 = await enqueueCoordinatorWake(wakeRoot, created.id);
assert.equal(enq3.coordinatorWake.deliveryOutcome, "indeterminate");
assert.equal(enq3.coordinatorWake.sequence, 2, "a delivery-state change must re-enqueue");
assert.notEqual(enq3.coordinatorWake.key, firstKey);

console.log("Issue #40 fail-closed autonomous-delivery, lifecycle wake, and enqueue/dedup tests passed.");

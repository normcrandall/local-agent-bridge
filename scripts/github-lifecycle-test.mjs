import assert from "node:assert/strict";
import {
  createInMemoryGitHubLifecycleAdapter,
  createProductionGitHubLifecycleAdapter,
  handleLifecycleWebhook,
  normalizeLifecyclePolicy,
  portfolioStatusForSemanticState,
  reconcileGitHubLifecycle,
  SEMANTIC_LIFECYCLE_STATES,
  semanticStateForPhase,
  transitionSemanticLifecycle,
} from "../src/github-lifecycle.mjs";

assert.deepEqual(SEMANTIC_LIFECYCLE_STATES, [
  "triaging",
  "queued",
  "implementing",
  "reviewing",
  "blocked",
  "needs_user",
  "merged",
  "cancelled",
  "obsolete",
  "stale",
]);
assert.equal(portfolioStatusForSemanticState("queued"), "ready");
assert.equal(portfolioStatusForSemanticState("cancelled"), "obsolete");
assert.equal(portfolioStatusForSemanticState("stale"), "indeterminate");
assert.equal(semanticStateForPhase("completed"), "reviewing");
assert.equal(semanticStateForPhase("stale"), "stale");

const policy = normalizeLifecyclePolicy({
  labels: {
    queued: "workflow:backlog",
    implementing: "workflow:active",
    reviewing: "workflow:review",
  },
  project: {
    number: 7,
    field: "Workflow",
    options: {
      queued: "Backlog",
      implementing: "Doing",
      reviewing: "Review",
    },
  },
});
const memory = createInMemoryGitHubLifecycleAdapter();
let result = await transitionSemanticLifecycle({
  adapter: memory,
  issueNumber: 151,
  policy,
  state: "queued",
  collaborationId: "bridge-test",
  writer: "codex",
  transitionId: "transition-1",
});
assert.equal(result.applied, true);
assert.deepEqual([...memory.labels], ["workflow:backlog"]);
assert.deepEqual(memory.projectUpdates, [{
  projectNumber: 7,
  projectTitle: null,
  fieldName: "Workflow",
  optionName: "Backlog",
}]);
assert.equal(result.record.assignments[0].writer, "codex");

const duplicate = await transitionSemanticLifecycle({
  adapter: memory,
  issueNumber: 151,
  policy,
  record: result.record,
  history: result.history,
  state: "queued",
  collaborationId: "bridge-test",
  writer: "codex",
  transitionId: "transition-1",
});
assert.equal(duplicate.duplicate, true);
assert.equal(memory.projectUpdates.length, 1);

result = await transitionSemanticLifecycle({
  adapter: memory,
  issueNumber: 151,
  policy,
  record: result.record,
  history: result.history,
  state: "implementing",
  collaborationId: "bridge-test",
  writer: "claude",
  writerReason: "provider_failover",
  transitionId: "transition-2",
});
assert.deepEqual([...memory.labels], ["workflow:active"]);
assert.deepEqual(result.record.assignments.map(({ writer, reason }) => ({ writer, reason })), [
  { writer: "codex", reason: "assigned" },
  { writer: "claude", reason: "provider_failover" },
]);
assert.equal(result.record.activeWriter, "claude");

const unavailableProject = createInMemoryGitHubLifecycleAdapter({ projectAvailable: false });
const fallback = await transitionSemanticLifecycle({
  adapter: unavailableProject,
  issueNumber: 151,
  policy,
  state: "reviewing",
  transitionId: "fallback",
});
assert.equal(fallback.transition.project.reason, "unavailable");
assert.deepEqual([...unavailableProject.labels], ["workflow:review"]);

const transientAdapter = createInMemoryGitHubLifecycleAdapter();
transientAdapter.setProjectState = async () => {
  const error = new Error("service unavailable");
  error.status = 500;
  throw error;
};
await assert.rejects(
  transitionSemanticLifecycle({
    adapter: transientAdapter,
    issueNumber: 151,
    policy,
    state: "reviewing",
    transitionId: "transient",
  }),
  /service unavailable/,
);

const webhook = await handleLifecycleWebhook({
  adapter: memory,
  issueNumber: 151,
  policy,
  record: result.record,
  history: result.history,
  collaborationId: "bridge-test",
  writer: "claude",
  deliveryId: "delivery-123",
  observedState: "reviewing",
});
const replayedWebhook = await handleLifecycleWebhook({
  adapter: memory,
  issueNumber: 151,
  policy,
  record: webhook.record,
  history: webhook.history,
  collaborationId: "bridge-test",
  writer: "claude",
  deliveryId: "delivery-123",
  observedState: "reviewing",
});
assert.equal(replayedWebhook.duplicate, true);
assert.deepEqual(webhook.record.deliveryIds, ["delivery-123"]);

memory.issue.state = "closed";
memory.issue.state_reason = "not_planned";
const reconciled = await reconcileGitHubLifecycle({
  adapter: memory,
  issueNumber: 151,
  policy,
  record: webhook.record,
  history: webhook.history,
  collaborationId: "bridge-test",
  writer: "claude",
});
assert.equal(reconciled.outcome, "obsolete");
assert.equal(reconciled.record.state, "obsolete");

const mergedIssue = createInMemoryGitHubLifecycleAdapter({
  issue: { state: "closed", pull_request: { merged_at: "2026-07-25T00:00:00.000Z" } },
});
const merged = await reconcileGitHubLifecycle({
  adapter: mergedIssue,
  issueNumber: 151,
  policy,
  collaborationId: "bridge-merged",
});
assert.equal(merged.outcome, "merged");
assert.equal(merged.record.state, "merged");

const calls = [];
const production = createProductionGitHubLifecycleAdapter({
  getIssue: async (number) => ({ number }),
  addIssueLabel: async (...args) => calls.push(["add", ...args]),
  removeIssueLabel: async (...args) => calls.push(["remove", ...args]),
  updateIssueProjectSingleSelect: async (...args) => calls.push(["project", ...args]),
});
assert.deepEqual(await production.getIssue(151), { number: 151 });
await production.addLabel(151, "workflow:active");
await production.removeLabel(151, "workflow:backlog");
await production.setProjectState(151, { fieldName: "Workflow", optionName: "Doing" });
assert.deepEqual(calls, [
  ["add", 151, "workflow:active"],
  ["remove", 151, "workflow:backlog"],
  ["project", 151, { fieldName: "Workflow", optionName: "Doing" }],
]);

console.log("github lifecycle tests passed");

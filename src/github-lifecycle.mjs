import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SEMANTIC_LIFECYCLE_STATES = Object.freeze([
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

const SEMANTIC_STATE_SET = new Set(SEMANTIC_LIFECYCLE_STATES);
const PROJECT_FALLBACK_STATUSES = new Set([403, 404, 422]);

export const DEFAULT_LIFECYCLE_LABELS = Object.freeze(Object.fromEntries(
  SEMANTIC_LIFECYCLE_STATES.map((state) => [state, `agent:${state.replaceAll("_", "-")}`]),
));

export const SEMANTIC_TO_PORTFOLIO_STATUS = Object.freeze({
  triaging: "planning",
  queued: "ready",
  implementing: "implementing",
  reviewing: "reviewing",
  blocked: "blocked",
  needs_user: "needs_user",
  merged: "merged",
  cancelled: "obsolete",
  obsolete: "obsolete",
  stale: "indeterminate",
});

const PHASE_TO_SEMANTIC = Object.freeze({
  triaging: "triaging",
  claiming: "queued",
  preflight: "queued",
  waiting_capacity: "queued",
  queued: "queued",
  running: "implementing",
  working: "implementing",
  provider_progress: "implementing",
  turn: "implementing",
  verifying: "reviewing",
  verification: "reviewing",
  reviewing: "reviewing",
  review: "reviewing",
  completed: "reviewing",
  blocked: "blocked",
  failed: "blocked",
  needs_user: "needs_user",
  merged: "merged",
  cancelled: "cancelled",
  obsolete: "obsolete",
  stale: "stale",
  rolled_back: "obsolete",
  taken_over: "obsolete",
  recovered: "queued",
});

function assertSemanticState(state) {
  if (!SEMANTIC_STATE_SET.has(state)) {
    throw new Error(`Unknown semantic lifecycle state: ${state}.`);
  }
}

function stableTransitionId({ collaborationId, state, writer, deliveryId }) {
  if (deliveryId) return `delivery:${deliveryId}`;
  const value = `${collaborationId || "unbound"}:${state}:${writer || "unassigned"}`;
  return `lifecycle:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function semanticStateForPhase(phase) {
  return PHASE_TO_SEMANTIC[String(phase || "").toLowerCase()] || "implementing";
}

export function portfolioStatusForSemanticState(state) {
  assertSemanticState(state);
  return SEMANTIC_TO_PORTFOLIO_STATUS[state];
}

export function normalizeLifecyclePolicy(policy = {}) {
  const labels = { ...DEFAULT_LIFECYCLE_LABELS, ...(policy.labels || {}) };
  for (const state of SEMANTIC_LIFECYCLE_STATES) {
    if (labels[state] !== null && (typeof labels[state] !== "string" || !labels[state].trim())) {
      throw new Error(`Lifecycle label mapping for ${state} must be a non-empty string or null.`);
    }
  }
  const project = policy.project
    ? {
      number: Number.isInteger(policy.project.number) ? policy.project.number : null,
      title: policy.project.title || null,
      field: policy.project.field,
      options: { ...(policy.project.options || {}) },
    }
    : null;
  if (project && (!project.field || typeof project.field !== "string")) {
    throw new Error("Lifecycle Project policy requires a field name.");
  }
  return { labels, project };
}

export function loadRepositoryLifecyclePolicy(workspace) {
  const path = resolve(workspace, ".agent-bridge/lifecycle-policy.json");
  try {
    return normalizeLifecyclePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeLifecyclePolicy();
    throw new Error(`Invalid repository lifecycle policy ${path}: ${error.message}`);
  }
}

export function recordLifecycleAssignment(record = {}, { writer, at = new Date().toISOString(), reason = "assigned" } = {}) {
  if (!writer) return { ...record, assignments: [...(record.assignments || [])] };
  const assignments = [...(record.assignments || [])];
  if (assignments.at(-1)?.writer !== writer) assignments.push({ writer, at, reason });
  return { ...record, activeWriter: writer, assignments };
}

export function createSemanticLifecycleRecord({
  state = "queued",
  collaborationId = null,
  writer = null,
  at = new Date().toISOString(),
} = {}) {
  assertSemanticState(state);
  const transition = {
    id: stableTransitionId({ collaborationId, state, writer }),
    state,
    at,
    collaborationId,
    writer,
    project: { applied: false, reason: "pending_issue_sync" },
  };
  return recordLifecycleAssignment({
    state,
    updatedAt: at,
    transitions: [transition],
    deliveryIds: [],
  }, { writer, at, reason: "claimed" });
}

export function createProductionGitHubLifecycleAdapter(client) {
  return {
    async getIssue(issueNumber) {
      const issue = await client.getIssue(issueNumber);
      if (String(issue?.state || "").toLowerCase() !== "closed"
        || issue.merged_at
        || issue.pull_request?.merged_at
        || typeof client.getIssueTimeline !== "function") {
        return issue;
      }
      const timeline = await client.getIssueTimeline(issueNumber);
      const merged = timeline.find((event) => (
        event?.event === "merged"
        || event?.source?.issue?.merged_at
        || event?.source?.issue?.pull_request?.merged_at
      ));
      return merged
        ? { ...issue, merged_at: merged.created_at || merged.source?.issue?.merged_at || merged.source?.issue?.pull_request?.merged_at }
        : issue;
    },
    addLabel: (issueNumber, label) => client.addIssueLabel(issueNumber, label),
    removeLabel: (issueNumber, label) => client.removeIssueLabel(issueNumber, label),
    setProjectState: (issueNumber, mapping) => client.updateIssueProjectSingleSelect(issueNumber, mapping),
  };
}

export function createInMemoryGitHubLifecycleAdapter({
  issue = { state: "open", labels: [] },
  projectAvailable = true,
} = {}) {
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
  const projectUpdates = [];
  return {
    issue: { ...issue },
    labels,
    projectUpdates,
    async getIssue() {
      return { ...this.issue, labels: [...labels].map((name) => ({ name })) };
    },
    async addLabel(_issueNumber, label) {
      labels.add(label);
    },
    async removeLabel(_issueNumber, label) {
      labels.delete(label);
    },
    async setProjectState(_issueNumber, mapping) {
      if (!projectAvailable) {
        const error = new Error("Project fields are unavailable.");
        error.status = 403;
        throw error;
      }
      projectUpdates.push(structuredClone(mapping));
      return { applied: true };
    },
  };
}

export async function transitionSemanticLifecycle({
  adapter,
  issueNumber,
  policy = normalizeLifecyclePolicy(),
  record = {},
  history = [],
  state,
  collaborationId = null,
  writer = null,
  writerReason = "assigned",
  transitionId = null,
  deliveryId = null,
  at = new Date().toISOString(),
}) {
  assertSemanticState(state);
  const normalizedPolicy = normalizeLifecyclePolicy(policy);
  const id = transitionId || stableTransitionId({ collaborationId, state, writer, deliveryId });
  const priorTransitions = [...(record.transitions || [])];
  const priorDeliveries = [...(record.deliveryIds || [])];
  if (priorTransitions.some((entry) => entry.id === id) || (deliveryId && priorDeliveries.includes(deliveryId))) {
    return { record, history, applied: false, duplicate: true };
  }

  const targetLabel = normalizedPolicy.labels[state];
  if (targetLabel) await adapter.addLabel(issueNumber, targetLabel);
  for (const [otherState, label] of Object.entries(normalizedPolicy.labels)) {
    if (!label || otherState === state) continue;
    try {
      await adapter.removeLabel(issueNumber, label);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  let project = { applied: false, reason: normalizedPolicy.project ? "unmapped_state" : "not_configured" };
  const option = normalizedPolicy.project?.options?.[state];
  if (normalizedPolicy.project && option) {
    try {
      await adapter.setProjectState(issueNumber, {
        projectNumber: normalizedPolicy.project.number,
        projectTitle: normalizedPolicy.project.title,
        fieldName: normalizedPolicy.project.field,
        optionName: option,
      });
      project = { applied: true };
    } catch (error) {
      if (!PROJECT_FALLBACK_STATUSES.has(error.status)) throw error;
      project = { applied: false, reason: "unavailable", status: error.status };
    }
  }

  const transition = { id, state, at, collaborationId, writer, project, ...(deliveryId ? { deliveryId } : {}) };
  let nextRecord = {
    ...record,
    state,
    updatedAt: at,
    transitions: [...priorTransitions, transition],
    deliveryIds: deliveryId ? [...priorDeliveries, deliveryId] : priorDeliveries,
  };
  nextRecord = recordLifecycleAssignment(nextRecord, { writer, at, reason: writerReason });
  const nextHistory = [
    { event: "lifecycle_transition", collaboration: collaborationId, writer, phase: state, semanticState: state, transitionId: id, at },
    ...history,
  ].slice(0, 10);
  return { record: nextRecord, history: nextHistory, applied: true, duplicate: false, transition };
}

export function semanticOutcomeFromIssue(issue) {
  if (!issue || String(issue.state || "").toLowerCase() !== "closed") return null;
  if (issue.merged_at || issue.pull_request?.merged_at) return "merged";
  return issue.state_reason === "not_planned" ? "obsolete" : "cancelled";
}

export async function reconcileGitHubLifecycle(options) {
  const issue = await options.adapter.getIssue(options.issueNumber);
  const outcome = semanticOutcomeFromIssue(issue);
  if (!outcome) return { outcome: null, issue, record: options.record || {}, history: options.history || [], applied: false };
  const result = await transitionSemanticLifecycle({
    ...options,
    state: outcome,
    transitionId: `github-outcome:${options.issueNumber}:${outcome}`,
  });
  return { ...result, outcome, issue };
}

export async function handleLifecycleWebhook({
  deliveryId,
  observedState,
  ...options
}) {
  if (!deliveryId || typeof deliveryId !== "string") throw new Error("Webhook lifecycle delivery requires a delivery ID.");
  assertSemanticState(observedState);
  return transitionSemanticLifecycle({
    ...options,
    state: observedState,
    deliveryId,
    transitionId: `delivery:${deliveryId}`,
  });
}

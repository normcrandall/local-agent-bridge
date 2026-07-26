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
const LABEL_FALLBACK_STATUSES = new Set([403, 404]);

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

function stableTransitionId({ collaborationId, state, writer, deliveryId, sequence = 1 }) {
  if (deliveryId) return `delivery:${deliveryId}`;
  const value = `${collaborationId || "unbound"}:${state}:${writer || "unassigned"}:${sequence}`;
  return `lifecycle:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function semanticStateForPhase(phase) {
  return PHASE_TO_SEMANTIC[String(phase || "").toLowerCase()] || null;
}

export function compactGitHubLifecycleSummary({ phase, writer = null, summary = null, terminal = false } = {}) {
  const state = String(phase || "unknown").trim().toLowerCase().slice(0, 64);
  if (terminal && summary) return String(summary).trim().replaceAll(/\s+/g, " ").slice(0, 500);
  return writer
    ? `${writer} collaboration checkpoint: ${state}.`
    : `Collaboration checkpoint: ${state}.`;
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
  policy = normalizeLifecyclePolicy(),
  at = new Date().toISOString(),
} = {}) {
  assertSemanticState(state);
  const normalizedPolicy = normalizeLifecyclePolicy(policy);
  const transition = {
    id: stableTransitionId({ collaborationId, state, writer, sequence: 1 }),
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
    transitionSequence: 1,
    deliveryIds: [],
    labelPolicy: normalizedPolicy.labels,
  }, { writer, at, reason: "claimed" });
}

export function createProductionGitHubLifecycleAdapter(client, {
  snapshotCache = null,
  repository = null,
  headSha = null,
} = {}) {
  async function cachedRead({ kind, subject, exactHead = null, load }) {
    if (!snapshotCache || !repository) {
      return { value: await load(), cache: "disabled", authoritative: false, usableForAuthorization: false };
    }
    return snapshotCache.getOrLoad({
      repository,
      kind,
      subject,
      headSha: exactHead,
      trustClass: "github-live",
      load: async () => {
        const data = await load();
        return {
          data,
          sourceUpdatedAt: data?.updated_at || data?.updatedAt || null,
        };
      },
    });
  }

  return {
    // Snapshot methods are intentionally separate from the live lifecycle
    // authority method below. A caller can use them for context or display,
    // but state transitions must continue through getIssue().
    getIssueSnapshot: (issueNumber) => cachedRead({
      kind: "issue",
      subject: `issue:${issueNumber}`,
      exactHead: headSha,
      load: () => client.getIssue(issueNumber),
    }),
    getPullRequestSnapshot: typeof client.getPullRequest === "function"
      ? (pullRequestNumber, exactHead = headSha) => cachedRead({
        kind: "pull_request",
        subject: `pr:${pullRequestNumber}:detail`,
        exactHead,
        load: () => client.getPullRequest(pullRequestNumber),
      })
      : undefined,
    getReviewThreadsSnapshot: typeof client.reviewThreads === "function"
      ? (pullRequestNumber, exactHead = headSha) => cachedRead({
        kind: "review_threads",
        subject: `pr:${pullRequestNumber}:threads`,
        exactHead,
        load: () => client.reviewThreads(pullRequestNumber),
      })
      : undefined,
    async getIssue(issueNumber) {
      // Lifecycle reconciliation may close work or release capacity. It is an
      // authority decision and therefore always re-reads GitHub live.
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
  const priorTransitions = [...(record.transitions || [])];
  const priorDeliveries = [...(record.deliveryIds || [])];
  const transitionSequence = Math.max(record.transitionSequence || 0, priorTransitions.length) + 1;
  const id = transitionId || stableTransitionId({ collaborationId, state, writer, deliveryId, sequence: transitionSequence });
  if (priorTransitions.some((entry) => entry.id === id) || (deliveryId && priorDeliveries.includes(deliveryId))) {
    return { record, history, applied: false, duplicate: true };
  }

  const targetLabel = normalizedPolicy.labels[state];
  const labelReceipt = { applied: true, reason: null, degradations: [] };
  if (targetLabel) {
    try {
      await adapter.addLabel(issueNumber, targetLabel);
    } catch (error) {
      if (!LABEL_FALLBACK_STATUSES.has(error.status)) throw error;
      labelReceipt.applied = false;
      labelReceipt.reason = "permission_unavailable";
      labelReceipt.degradations.push({ operation: "add", label: targetLabel, status: error.status });
    }
  }
  if (labelReceipt.applied) {
    const lifecycleLabels = new Set([
      ...Object.values(DEFAULT_LIFECYCLE_LABELS),
      ...Object.values(record.labelPolicy || {}),
      ...Object.values(normalizedPolicy.labels),
    ].filter(Boolean));
    for (const label of lifecycleLabels) {
      if (label === targetLabel) continue;
      try {
        await adapter.removeLabel(issueNumber, label);
      } catch (error) {
        if (!LABEL_FALLBACK_STATUSES.has(error.status)) throw error;
        labelReceipt.applied = false;
        labelReceipt.reason = "partially_applied";
        labelReceipt.degradations.push({ operation: "remove", label, status: error.status });
      }
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
      project = {
        applied: false,
        reason: error.code === "project_mapping_not_found" ? "misconfigured" : "unavailable",
        status: error.status,
        ...(error.code ? { code: error.code } : {}),
      };
    }
  }

  const transition = { id, state, at, collaborationId, writer, labels: labelReceipt, project, ...(deliveryId ? { deliveryId } : {}) };
  let nextRecord = {
    ...record,
    state,
    updatedAt: at,
    transitions: [...priorTransitions, transition],
    transitionSequence,
    deliveryIds: deliveryId ? [...priorDeliveries, deliveryId] : priorDeliveries,
    labelPolicy: normalizedPolicy.labels,
  };
  nextRecord = recordLifecycleAssignment(nextRecord, { writer, at, reason: writerReason });
  const lifecycleHistoryEntry = {
    event: "lifecycle_transition",
    collaboration: collaborationId,
    writer,
    phase: state,
    semanticState: state,
    transitionId: id,
    at,
  };
  const nextHistory = writerReason === "provider_failover" && history[0]?.event === "writer_failover"
    ? [history[0], lifecycleHistoryEntry, ...history.slice(1)].slice(0, 10)
    : [lifecycleHistoryEntry, ...history].slice(0, 10);
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

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";
import { mergePullRequestWithBuilder } from "./native-github-builder.mjs";
import {
  appendEvent,
  archiveCollaboration,
  collaborationDirectory,
  collaborationView,
  createCollaboration,
  listCollaborations,
  pruneTerminalCollaborations,
  readCollaboration,
  releaseOwnedCollaborationLocks,
  updateCollaboration,
  waitForCollaborationChange,
} from "./collaboration-store.mjs";
import { reapProcessTree } from "./process-reaper.mjs";
import { DEFAULT_AGENTS, KNOWN_AGENTS, validateAgents, WRITER_AGENTS } from "./talk-protocol.mjs";
import { createWorktree, isSafeWorkerPid, preflight, selectRoles } from "./operations.mjs";
import { adoptExistingWriterCheckout, cleanupWriterCheckout, isLinkedGitCheckout, prepareWriterCheckout, recoverWriterCheckout } from "./writer-checkout.mjs";
import { createDecisionReceipt, DECISION_CATEGORIES } from "./decision-policy.mjs";
import { resolveNativeChair } from "./native-chair.mjs";
import { clearTerminalRuntime, legacyWorkerCommandMatches, reconciliationAction, workerCancellationMatches, workerCommandMatches } from "./collaboration-cleanup.mjs";
import { acknowledgeCompletion } from "./handoff-protocol.mjs";
import { readContextCapsule } from "./context-capsule.mjs";
import { createEvidenceStore } from "./evidence-store.mjs";
import { assertRepositoryEvidenceHead, captureRepositoryEvidence, formatRepositoryEvidence, readRepositoryHead } from "./repository-evidence.mjs";
import { formatReusableVerification, resolveVerificationPlan } from "./verification-receipts.mjs";
import {
  createPerformanceTimeline,
  markPerformanceMilestone,
  startPerformanceSpan,
  summarizePerformance,
} from "./performance-timeline.mjs";
import { replayIncident, formatReplayHuman } from "./incident-replay.mjs";
import { analyzePortfolio, buildExecutionWaves, normalizePortfolioItems } from "./portfolio-scheduler.mjs";
import { createPortfolio, listPortfolios, readPortfolio, updatePortfolio } from "./portfolio-store.mjs";
import {
  loadProviderConcurrency,
  normalizeProviderConcurrency,
  releaseProviderCapacityForCollaboration,
} from "./provider-concurrency.mjs";
import {
  acknowledgeCoordinatorWake,
  enqueueCoordinatorWake,
} from "./coordinator-wake.mjs";
import {
  beginMergeValidation,
  createArbitrationDossier,
  createMergeTrain,
  enqueueMergeCandidate,
  mergeAuthorization,
  recoverMergeValidation,
  recordMergeResult,
  recordMergeValidation,
  refreshMergeTarget,
} from "./merge-train.mjs";
import {
  plannedIssueClaimWorktree,
  resolveClaimedWorktreeHead,
  resolveIssueClaimRevisions,
} from "./collaboration-start-preflight.mjs";
import { hydrateClaimedIssueTask } from "./claimed-issue-context.mjs";
import { startSupervisedWorker } from "./worker-supervisor-client.mjs";

const RUNTIME_ROOT = realpathSync(process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const PORTFOLIO_ROOT = resolve(process.env.BRIDGE_PORTFOLIO_DIR || collaborationDirectory(WORKSPACE_ROOT), "portfolios");
const EVIDENCE_ROOT = resolve(collaborationDirectory(WORKSPACE_ROOT), "evidence");
const TERMINAL_STATUSES = new Set(["agreed", "needs_user", "turn_limit", "failed", "cancelled", "budget"]);
const STATUS_VALUES = ["queued", "running", "recovering", "cancelling", "indeterminate", ...TERMINAL_STATUSES];

function blockNestedCollaboration() {
  if (process.env.BRIDGE_DELEGATED_SESSION === "1") {
    throw new Error("Nested collaboration mutation blocked; the active broker owns participant routing.");
  }
}

function assertAutonomousDeliveryBinding({ mode, workProfile, githubBuilder }) {
  if (mode === "work" && workProfile === "deliver" && !githubBuilder) {
    throw new Error("Autonomous delivery requires a bound githubBuilder; raw push, gh pull-request mutation, PAT, or ambient git credentials are not permitted in autonomous council/portfolio flows.");
  }
}

function projectDirectory(requested) {
  const candidate = resolve(WORKSPACE_ROOT, requested || ".");
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`Working directory does not exist: ${candidate}`);
  }
  const actual = realpathSync(candidate);
  const fromRoot = relative(WORKSPACE_ROOT, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Working directory must stay within ${WORKSPACE_ROOT}`);
  }
  return actual;
}

async function startWorker(id) {
  return startSupervisedWorker({
    collaborationId: id,
    runtimeRoot: RUNTIME_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
  });
}

function summary(view) {
  const lastTurn = view.turns?.at(-1);
  const lines = [
    `Collaboration: ${view.id}`,
    `Status: ${view.status}`,
    `Agents: ${view.agents.join(", ")}`,
    `Turns: ${view.runtime?.turnCount || 0}`,
    `Updated: ${view.updatedAt}`,
  ];
  const available = view.runtime?.availableAgents;
  const active = view.runtime?.activeCall;
  const unavailable = view.runtime?.unavailableAgents || {};
  if (available?.length) lines.push(`Available: ${available.join(", ")}`);
  for (const [agent, reason] of Object.entries(unavailable)) {
    lines.push(`Skipped: ${agent} — ${reason}`);
  }
  if (active) {
    const elapsedSeconds = active.startedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(active.startedAt)) / 1000))
      : null;
    lines.push([
      `Active: ${active.agent} — ${active.status || "running"}`,
      `Phase: ${active.phase || "working"}`,
      `Summary: ${active.summary || "No provider-authored summary yet."}`,
      `Narrative updated: ${active.summaryAt || "no provider narrative yet"}`,
      `Narrative source: ${active.summarySource || "unknown"}`,
      active.livenessMessage ? `Liveness: ${active.livenessMessage}` : null,
      `Heartbeat: ${active.heartbeatAt || "unknown"}`,
      elapsedSeconds === null ? null : `Elapsed: ${elapsedSeconds}s`,
    ].filter(Boolean).join("\n"));
  }
  if (view.githubReview) {
    lines.push(
      `PR review: ${view.githubReview.repository}#${view.githubReview.prNumber}@${view.githubReview.headSha.slice(0, 12)} as ${view.githubReview.expectedLogin || "the active provider reviewer App"}`,
    );
  }
  if (view.reviewPublication?.status && view.reviewPublication.status !== "available") {
    lines.push(`Review publication: ${view.reviewPublication.status}`);
    if (view.reviewPublication.publishableAgents?.length) {
      lines.push(`Publishable reviewers: ${view.reviewPublication.publishableAgents.join(", ")}`);
    }
    if (view.reviewPublication.publishedAgents?.length) {
      lines.push(`Completed publications: ${view.reviewPublication.publishedAgents.join(", ")}`);
    }
    for (const [agent, reason] of Object.entries(view.reviewPublication.localOnlyAgents || {})) {
      lines.push(`Local-only reviewer: ${agent} — ${reason}`);
    }
    for (const [agent, reason] of Object.entries(view.reviewPublication.unavailableAgents || {})) {
      lines.push(`Reviewer failed after preflight: ${agent} — ${reason}`);
    }
    if (view.reviewPublication.humanApprovalRequired) {
      lines.push("Merge gate: exact-head approval from a configured trusted human is required.");
    }
  }
  if (view.rotation) lines.push(`Rotation: task ${view.rotation.taskNumber}; writer ${view.rotation.writer}; reviewers ${view.rotation.reviewers.join(", ")}`);
  if (view.chair) lines.push(`Chair: ${view.chair.provider} (${view.chair.source || "native-chair"}); same-provider delegation ${view.chair.allowSameProviderDelegation ? "allowed" : "suppressed"}.`);
  if (view.worktree) lines.push(`Worktree: ${view.worktree.path} (${view.worktree.branch} from ${view.worktree.base})`);
  if (view.ciTracking) {
    const checks = view.ci?.checks || [];
    lines.push(`CI: PR #${view.ciTracking.prNumber}; ${view.ci?.ok ? `${checks.length} checks refreshed` : view.ci?.error || "awaiting refresh"}`);
  }
  if (view.budget && Object.keys(view.budget).length) {
    lines.push(`Budget: ${JSON.stringify(view.budget)}${view.budgetExceeded ? " — reached" : ""}`);
  }
  if (view.usage && Object.keys(view.usage).length) lines.push(`Usage: ${JSON.stringify(view.usage)}`);
  if (view.decisions?.length) {
    const decision = view.decisions.at(-1);
    lines.push(decision.action === "resolved"
      ? `Decision: ${decision.decision} (${Math.round(decision.confidence * 100)}% confidence; owner ${decision.owner}; rollback: ${decision.rollbackPath})`
      : `Decision needs user: ${decision.reason}`);
  }
  if (view.permissionProfile === "yolo") lines.push("Permissions: YOLO — provider approvals and sandbox protections are bypassed for the writer.");
  if (view.completion?.lastHandoff) {
    const completion = view.completion;
    lines.push([
      `Handoff ${completion.sequence}: ${completion.lastHandoff.agent} — ${completion.lastHandoff.outcome}`,
      `Completion phase: ${completion.phase}`,
      `Completion acknowledged: ${completion.acknowledged ? "yes" : "no"}`,
      `Next action: ${completion.nextAction}`,
      `Handoff summary: ${completion.lastHandoff.summary}`,
    ].join("\n"));
  }
  if (view.coordinatorWake) {
    const wake = view.coordinatorWake;
    lines.push([
      `Coordinator wake ${wake.sequence}: ${wake.kind} — ${wake.status}`,
      `Wake target: ${wake.provider}`,
      `Wake next action: ${wake.nextAction}`,
      `Wake summary: ${wake.summary}`,
    ].join("\n"));
  }
  if (lastTurn) {
    const excerpt = lastTurn.message.length > 4_000
      ? `${lastTurn.message.slice(0, 4_000)}\n[turn excerpt truncated]`
      : lastTurn.message;
    lines.push(`Latest turn (${lastTurn.agent}, ${lastTurn.status}):\n${excerpt}`);
  }
  if (view.error) lines.push(`Error: ${view.error}`);
  if (["queued", "running", "recovering", "cancelling"].includes(view.status)) {
    lines.push("Call get_collaboration with this ID to check progress.");
  } else if (view.status === "indeterminate") {
    lines.push("Provider execution state is unknown. Writer ownership is preserved; inspect the workspace/provider before cancelling or starting replacement work.");
  } else if (view.status === "needs_user") {
    lines.push("Call continue_collaboration with the user's answer.");
  } else {
    lines.push("This ID is portable: another configured app can inspect or continue it.");
  }
  return lines.join("\n\n");
}

function toolResponse(view) {
  if (!view?.id || !Array.isArray(view.agents)) {
    return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], structuredContent: view };
  }
  return {
    content: [{ type: "text", text: summary(view) }],
    structuredContent: view,
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function reconcileInterruptedCleanup() {
  const summaries = await listCollaborations(WORKSPACE_ROOT, { limit: 10_000 });
  for (const summaryState of summaries) {
    const state = await readCollaboration(WORKSPACE_ROOT, summaryState.id);
    if (TERMINAL_STATUSES.has(state.status) && (state.runtime?.activeCall || state.workerPid || state.workerOwner)) {
      await updateCollaboration(WORKSPACE_ROOT, state.id, (current) => clearTerminalRuntime(current));
      await appendEvent(WORKSPACE_ROOT, state.id, { type: "cleanup_reconciled", at: new Date().toISOString(), action: "clear-terminal-metadata" });
      continue;
    }
    if (!["queued", "running", "recovering", "cancelling"].includes(state.status)) continue;
    const ageMs = Date.now() - Date.parse(state.updatedAt || state.createdAt);
    if (!state.workerPid && ageMs < 30_000) continue;
    const alive = processAlive(state.workerPid);
    if (alive && !state.workerOwner && legacyWorkerCommandMatches(state)) continue;
    const ownershipMatches = workerCommandMatches(state);
    const action = reconciliationAction(state, { processAlive: alive, commandMatches: ownershipMatches });
    if (action === "mark-indeterminate" || action === "retain-indeterminate-owner-mismatch") {
      await updateCollaboration(WORKSPACE_ROOT, state.id, (current) => ({
        ...current, status: "indeterminate",
        error: !alive ? "Worker exited without a terminal receipt (exit reason unknown)." : "Worker PID exists but ownership command did not match; no process was terminated.",
        runtime: {
          ...(current.runtime || {}),
          activeCall: current.runtime?.activeCall ? { ...current.runtime.activeCall, status: "indeterminate", phase: "unknown" } : null,
        },
      }));
      await appendEvent(WORKSPACE_ROOT, state.id, { type: "cleanup_reconciled", at: new Date().toISOString(), action });
    }
  }
  try {
    const { reconcileClaimsAndPortfolios } = await import("./github-issue-claims.mjs");
    await reconcileClaimsAndPortfolios(WORKSPACE_ROOT);
  } catch (error) {
    console.error(`GitHub issue claim reconciliation failed: ${error.message}`);
  }
}

function compactStatusView(view) {
  const {
    task: _task,
    taskBase: _taskBase,
    models: _models,
    modelFallbacks: _modelFallbacks,
    providerConcurrency: _providerConcurrency,
    requestedVerificationCommands: _requestedVerificationCommands,
    verificationCommands: _verificationCommands,
    workCommands: _workCommands,
    preflight: _preflight,
    capabilities: _capabilities,
    performance: _performance,
    verificationReceipts: _verificationReceipts,
    evidence: _evidence,
    ...status
  } = view;
  const repository = view.evidence?.repository;
  return {
    ...status,
    ...(view.evidence ? {
      evidence: {
        repository: repository ? {
          repository: repository.repository,
          headSha: repository.headSha,
          baseSha: repository.baseSha || null,
          clean: repository.clean,
          fileCount: repository.fileCount,
          changedFileCount: repository.changedFiles?.length || 0,
          repositoryMapComplete: repository.repositoryMapComplete !== false,
          diffComplete: repository.diffComplete !== false,
          environmentFingerprintComplete: repository.environmentFingerprintComplete !== false,
        } : null,
        cacheMetrics: view.evidence.cacheMetrics || repository?.cacheMetrics || null,
        avoidedCommands: view.evidence.avoidedCommands || 0,
        estimatedAvoidedMs: view.evidence.estimatedAvoidedMs || 0,
      },
    } : {}),
    verificationReceiptCount: view.verificationReceipts?.length || 0,
  };
}

function refreshPortfolioState(state) {
  const schedule = analyzePortfolio({ items: state.items, maxParallel: state.maxParallel });
  const finished = state.items.every((item) => ["merged", "completed", "obsolete"].includes(item.status));
  const hasActive = state.items.some((item) => ["claimed", "planning", "implementing", "verifying", "reviewing", "repairing", "ready_to_merge", "integrating", "arbitrating"].includes(item.status));
  return {
    ...state,
    status: finished ? "complete" : hasActive ? "running" : schedule.selected.length ? "ready" : "blocked",
    schedule,
  };
}

function updatePortfolioItemState(state, itemId, patch) {
  let found = false;
  const items = state.items.map((item) => {
    if (item.id !== String(itemId)) return item;
    found = true;
    return { ...item, ...patch, id: item.id };
  });
  if (!found) throw new Error(`Portfolio item ${itemId} does not exist.`);
  return refreshPortfolioState({ ...state, items });
}

async function releaseLinkedIssueClaim(item, outcome) {
  if (!item?.collaborationId) return { released: false, reason: "no_collaboration" };
  const collaboration = await readCollaboration(WORKSPACE_ROOT, item.collaborationId);
  if (!collaboration.issueClaim) return { released: false, reason: "no_issue_claim" };
  const { getBuilderClientForWorkspace, releaseClaimLease } = await import("./github-issue-claims.mjs");
  const claimClient = await getBuilderClientForWorkspace(
    collaboration.workspace || WORKSPACE_ROOT,
    collaboration.issueClaim.issueNumber,
  );
  if (!claimClient) {
    throw new Error(`No builder App client is configured for claimed issue #${collaboration.issueClaim.issueNumber}.`);
  }
  await releaseClaimLease({
    client: claimClient,
    issueNumber: collaboration.issueClaim.issueNumber,
    collaborationId: item.collaborationId,
    outcome,
  });
  return { released: true, issueNumber: collaboration.issueClaim.issueNumber };
}

async function markLinkedCollaborationPerformance(item, name, metadata = {}) {
  if (!item?.collaborationId) return null;
  const at = new Date().toISOString();
  return updateCollaboration(WORKSPACE_ROOT, item.collaborationId, (current) => {
    const performance = markPerformanceMilestone(
      current.performance || createPerformanceTimeline(current.createdAt || at),
      name,
      { at, metadata: { portfolioItemId: item.id, ...metadata } },
    );
    return { ...current, performance, performanceSummary: summarizePerformance(performance) };
  }).catch(() => null);
}

function portfolioLaneOutcome(item, collaboration, expectedHeadSha) {
  const headAdvanced = Boolean(expectedHeadSha && item.headSha && item.headSha !== expectedHeadSha);
  if (headAdvanced) {
    return {
      outcome: "success_signal",
      nextAction: "process_head_advance",
      reason: `Portfolio lane head advanced from ${expectedHeadSha} to ${item.headSha}.`,
    };
  }
  if (collaboration.status === "indeterminate") {
    return {
      outcome: "lane_indeterminate",
      nextAction: "inspect_before_reassign",
      reason: collaboration.error || "Provider ownership is indeterminate.",
    };
  }
  if (collaboration.status === "recovering") {
    return {
      outcome: "recovering",
      nextAction: "wait_for_provider_recovery",
      reason: collaboration.runtime?.activeCall?.summary || "The broker is waiting to retry the eligible provider roster.",
    };
  }
  if (collaboration.status === "failed") {
    const exhausted = /No requested model is currently available/i.test(collaboration.error || "");
    return {
      outcome: "lane_stopped",
      nextAction: exhausted ? "reassign_writer" : "inspect_failure",
      reason: collaboration.error || "The lane collaboration failed.",
    };
  }
  if (collaboration.status === "needs_user") {
    return {
      outcome: "lane_stopped",
      nextAction: "needs_user",
      reason: collaboration.error || collaboration.coordinatorWake?.summary || "The lane requires user input.",
    };
  }
  if (["cancelled", "budget"].includes(collaboration.status)) {
    return {
      outcome: "lane_stopped",
      nextAction: collaboration.status === "budget" ? "inspect_budget" : "requeue_or_cancel",
      reason: collaboration.error || `The lane collaboration entered ${collaboration.status}.`,
    };
  }
  if (["agreed", "turn_limit"].includes(collaboration.status)) {
    return {
      outcome: "handoff_ready",
      nextAction: collaboration.coordinatorWake?.nextAction || (collaboration.status === "agreed" ? "chair_verify" : "continue"),
      reason: collaboration.coordinatorWake?.summary || `The lane collaboration entered ${collaboration.status}.`,
    };
  }
  return {
    outcome: "active",
    nextAction: "continue_waiting",
    reason: collaboration.runtime?.activeCall?.summary || `The lane collaboration is ${collaboration.status}.`,
  };
}

async function markStoppedPortfolioLane(portfolioId_, itemId, collaboration, classification) {
  if (!["lane_stopped", "lane_indeterminate"].includes(classification.outcome)) {
    return readPortfolio(PORTFOLIO_ROOT, portfolioId_);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readPortfolio(PORTFOLIO_ROOT, portfolioId_);
    const item = current.items.find((candidate) => candidate.id === String(itemId));
    if (!item) throw new Error(`Portfolio item ${itemId} does not exist.`);
    const status = classification.outcome === "lane_indeterminate"
      ? "indeterminate"
      : collaboration.status === "needs_user"
        ? "needs_user"
        : "failed";
    if (item.status === status && item.summary === classification.reason) return current;
    try {
      return await updatePortfolio(PORTFOLIO_ROOT, portfolioId_, current.revision, (state) => (
        updatePortfolioItemState(state, itemId, {
          status,
          summary: classification.reason,
          collaborationStatus: collaboration.status,
        })
      ));
    } catch (error) {
      if (!/Portfolio revision changed/i.test(error.message) || attempt === 1) throw error;
    }
  }
  throw new Error(`Unable to reconcile portfolio lane ${itemId}.`);
}

const collaborationId = z.string().regex(/^bridge-[0-9a-f-]{36}$/).describe(
  "Portable collaboration ID returned by start_collaboration.",
);
const modelsSchema = z.object({
  claude: z.string().min(1).optional(),
  codex: z.string().min(1).optional(),
  antigravity: z.string().min(1).optional(),
  ollama: z.string().min(1).optional(),
  docker: z.string().min(1).optional(),
}).optional().describe(
  "Optional exact model overrides. Omit a provider to use that provider's configured model.",
);
const modelFallbacksSchema = z.object({
  claude: z.array(z.string().trim().min(1)).max(5).optional(),
  codex: z.array(z.string().trim().min(1)).max(5).optional(),
  antigravity: z.array(z.string().trim().min(1)).max(5).optional(),
  ollama: z.array(z.string().trim().min(1)).max(5).optional(),
  docker: z.array(z.string().trim().min(1)).max(5).optional(),
}).strict().optional().describe(
  "Ordered provider models to try after an overload response. Claude uses its native fallback flag; Codex and Antigravity retry through the bridge. A later provider-recovery attempt starts again from the preferred configured model. Omit to use the machine-local config; pass a provider's [] to disable it for this collaboration.",
);
const allowClaudeFableSchema = z.boolean().default(false).describe(
  "Explicit Fable authorization for this phase. Set true only when the user's current request asks for Fable by name; saved settings and earlier phases do not count.",
);
const providerConcurrencyRoleSchema = z.object({
  work: z.number().int().min(1).max(20).optional(),
  review: z.number().int().min(1).max(20).optional(),
}).strict();
const providerConcurrencySchema = z.object({
  claude: providerConcurrencyRoleSchema.optional(),
  codex: providerConcurrencyRoleSchema.optional(),
  antigravity: providerConcurrencyRoleSchema.optional(),
  ollama: providerConcurrencyRoleSchema.optional(),
  docker: providerConcurrencyRoleSchema.optional(),
}).strict().optional().describe(
  "Optional lower per-provider live-call limits. The machine-local provider-concurrency policy is a hard ceiling; defaults are work 5 and review 10.",
);
const verificationCommandsSchema = z.array(
  z.string().trim().min(1).max(500).refine((command) => !/[\r\n]/.test(command), "Commands must be single-line."),
).max(20).optional().describe(
  "Exact shell gates delegated reviewers should run when their provider sandbox permits them.",
);
const workCommandsSchema = z.array(
  z.string().trim().min(1).max(500).refine((command) => !/[\r\n]/.test(command), "Commands must be single-line."),
).max(50).optional().describe(
  "Exact shell commands the Claude writer may run in work mode. Include authorized branch, test, commit, and push commands; all unlisted shell commands are denied.",
);
const workProfileSchema = z.enum(["exact", "implement", "deliver"]).default("exact").describe(
  "Claude writer permission profile: implement covers common local development through commit; deliver additionally covers push and bounded gh pr lifecycle commands.",
);
const permissionProfileSchema = z.enum(["standard", "yolo"]).default("standard").describe(
  "Explicit provider permission policy. yolo bypasses provider approvals and sandboxes for the designated work-mode writer; it is never inferred.",
);
const handoffPathSchema = z.string().trim().min(1).optional().describe(
  "Project-relative file the delegated Claude or Codex reviewer may create or edit as its handoff. No other review-mode writes are allowed.",
);
const githubReviewSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.number().int().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN).optional().describe("Legacy single reviewer identity. Omit to select the active provider's configured reviewer App."),
  expectedLogins: z.object({
    claude: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    codex: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    antigravity: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    ollama: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    docker: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
  }).strict().optional(),
}).strict().optional().describe(
  "Explicitly authorize reviewers to write their handoff and submit one formal review to this exact PR head. The active provider's configured reviewer App is selected by default. Requires handoffPath.",
);
const githubBuilderSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.number().int().min(1).optional(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  headRef: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  allowedOperations: z.array(z.enum(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge", "create_branch", "push_branch", "replace_branch"])).min(1).max(9)
    .default(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready"]),
}).strict().superRefine((value, ctx) => {
  if (value.allowedOperations.includes("create_branch") && !value.baseSha) {
    ctx.addIssue({ code: "custom", path: ["baseSha"], message: "create_branch requires an exact baseSha authorization" });
  }
  if (value.allowedOperations.includes("create_branch") && !value.baseRef) {
    ctx.addIssue({ code: "custom", path: ["baseRef"], message: "create_branch requires an exact baseRef authorization" });
  }
}).optional().describe(
  "Authorize only target-bound builder GitHub operations for one repository and head SHA. Available only to the work-mode writer.",
);
const issueClaimSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  issueNumber: z.number().int().min(1),
  expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  portfolioId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  writer: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  allowedOperations: z.array(z.string()).optional(),
}).strict().optional().describe(
  "Durable issue claim lease configuration.",
);
const budgetSchema = z.object({
  maxCostUsd: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxMinutes: z.number().positive().optional(),
}).strict().optional().describe("Optional collaboration budget. The broker stops after the current turn when a known limit is reached.");
const providerRecoverySchema = z.object({
  enabled: z.boolean().default(true),
  maxAttempts: z.number().int().min(0).max(20).default(3),
  backoffSeconds: z.array(z.number().int().min(1).max(3600)).min(1).max(20).default([15, 60, 180]),
}).strict().optional().describe(
  "Retry the full eligible-provider roster after every requested provider is confirmed unavailable. Recovery remains visible and preserves the workspace; indeterminate ownership is never retried.",
);
const ciTrackingSchema = z.object({
  prNumber: z.number().int().positive(),
}).strict().optional().describe("Refresh GitHub PR checks after each completed turn.");
const worktreeSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  base: z.string().min(1).default("HEAD"),
  root: z.string().optional(),
}).strict().optional().describe("Create and pin an isolated collaboration workspace. Work mode receives a self-contained writer checkout; review mode receives a linked read-only worktree.");
const decisionPolicySchema = z.object({
  additionalEscalations: z.array(z.enum(DECISION_CATEGORIES)).max(6).default([]),
  maxDialogueTurns: z.number().int().min(1).max(12).default(4),
}).strict().optional().describe("Optional policy that can tighten, but never weaken, the human escalation boundary.");
const chairSchema = z.object({
  provider: z.enum(KNOWN_AGENTS),
  sessionId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  allowSameProviderDelegation: z.boolean().default(false),
}).strict().optional().describe("Declare the active host as a native participant. Its provider is not delegated again unless explicitly allowed.");
const portfolioId = z.string().regex(/^helm-[0-9a-f-]{36}$/).describe("Durable portfolio ID returned by create_portfolio.");
const portfolioStatusSchema = z.enum([
  "ready", "blocked", "claimed", "planning", "implementing", "verifying", "reviewing", "repairing",
  "ready_to_merge", "integrating", "arbitrating", "needs_user", "indeterminate", "failed", "merged", "completed", "obsolete",
]);
const portfolioItemSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500).optional(),
  task: z.string().min(1).max(50_000).optional(),
  priority: z.number().finite().default(0),
  status: portfolioStatusSchema.default("ready"),
  blockedBy: z.array(z.string().min(1).max(200)).max(200).default([]),
  conflictsWith: z.array(z.string().min(1).max(200)).max(200).default([]),
  paths: z.array(z.string().min(1).max(1_000)).max(500).default([]),
  resources: z.array(z.string().min(1).max(500)).max(200).default([]),
  verificationCommands: verificationCommandsSchema.default([]),
  issueNumber: z.number().int().min(1).optional(),
}).strict();
const arbitrationDossierSchema = z.object({
  itemId: z.string().min(1),
  classification: z.enum(["mechanical", "structural", "semantic", "requirement"]),
  files: z.array(z.string()).default([]),
  currentIntent: z.string().min(1),
  incomingIntent: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
}).passthrough();

const server = new McpServer(
  { name: "desktop-agent-collaboration", version: "0.2.0" },
  {
    instructions:
      "Use start_collaboration for an asynchronous durable job with one provider or a bounded roundtable with multiple providers. It returns immediately with a portable collaborationId. Unavailable providers are skipped and the run continues with any remaining participant. Autonomous work lanes should include an ordered eligible-provider roster and an explicit preferred writer so a confirmed unavailable writer fails over in the same worktree. Pass verificationCommands and handoffPath for independently verified reviews. Choose workProfile implement for local ownership through commit or deliver when the writer also owns push and PR delivery; use workCommands only for unusual additions. When repository policy requires reviewer-authored PR feedback, pass githubReview so the delegated Claude or Codex reviewer receives target-bound handoff and formal-review tools. Native coordinators must use merge_pull_request for an exact-head merge authorized by machine-local policy; never request Bash permission for gh pr merge. Use wait_for_portfolio_lane to race expected success signals against collaboration failure, cancellation, indeterminate ownership, recovery, and handoff completion; never park on a PR-head or CI-only waiter. Use modelFallbacks.claude, modelFallbacks.codex, or modelFallbacks.antigravity for ordered overload-only downgrade chains. Fable is denied by default; set allowClaudeFable only when the user's current request explicitly asks for Fable by name. Use get_collaboration to poll or inspect it, continue_collaboration for another phase, and cancel_collaboration to stop. The broker owns routing; never ask a peer to call another peer.",
  },
);

server.registerTool(
  "merge_pull_request",
  {
    title: "Merge an authorized pull request",
    description:
      "Use the configured builder GitHub App to merge one exact PR head after independently checking the review gate and GitHub rules. The repository must be allowlisted by machine-local autonomous merge policy.",
    inputSchema: {
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      prNumber: z.number().int().min(1),
      headSha: z.string().regex(/^[0-9a-f]{40}$/i),
      method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    },
  },
  async (input) => {
    blockNestedCollaboration();
    return toolResponse(await mergePullRequestWithBuilder(input));
  },
);

server.registerTool(
  "start_collaboration",
  {
    title: "Start agent collaboration",
    description:
      "Start a detached durable provider job or bounded multi-provider collaboration. Returns immediately; call get_collaboration with the returned ID for progress.",
    inputSchema: {
      task: z.string().min(1).describe("Shared objective, constraints, and expected deliverable."),
      agents: z.array(z.enum(KNOWN_AGENTS)).min(1).max(KNOWN_AGENTS.length).default(DEFAULT_AGENTS),
      startAgent: z.enum(KNOWN_AGENTS).optional().describe("Defaults to the first item in agents."),
      workspace: z.string().optional().describe("Project-relative directory; defaults to the bridge project."),
      mode: z.enum(["review", "work"]).default("review"),
      writer: z.enum(WRITER_AGENTS).optional().describe(
        "The only agent allowed to edit in work mode. Defaults to startAgent and must be selected in agents.",
      ),
      browser: z.boolean().default(false).describe("Enable isolated browser access where supported."),
      maxTurns: z.number().int().min(1).max(20).default(6),
      turnTimeoutSeconds: z.number().int().min(30).max(7200).default(600).describe("Per-model inactivity limit. Progress resets it; ordered fallback chains have a hard total bound of this limit multiplied by the number of permitted model attempts."),
      models: modelsSchema,
      modelFallbacks: modelFallbacksSchema,
      allowClaudeFable: allowClaudeFableSchema,
      providerConcurrency: providerConcurrencySchema,
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema,
      permissionProfile: permissionProfileSchema,
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      githubBuilder: githubBuilderSchema,
      issueClaim: issueClaimSchema,
      taskNumber: z.number().int().nonnegative().optional().describe("When supplied, rotate the writer deterministically across the selected agents unless writer is explicit."),
      rotationOffset: z.number().int().default(0),
      worktree: worktreeSchema,
      budget: budgetSchema,
      providerRecovery: providerRecoverySchema,
      ciTracking: ciTrackingSchema,
      decisionPolicy: decisionPolicySchema,
      chair: chairSchema,
    },
  },
  async (input) => {
    blockNestedCollaboration();
    const participantRotation = input.taskNumber === undefined ? null : selectRoles({
      taskNumber: input.taskNumber, agents: input.agents, offset: input.rotationOffset,
    });
    const requestedWriter = input.mode === "work" ? (input.writer || participantRotation?.writer || input.startAgent || input.agents[0]) : null;
    if (requestedWriter && !WRITER_AGENTS.includes(requestedWriter)) {
      throw new Error(`Provider ${requestedWriter} is review-only and cannot be selected as writer.`);
    }
    const native = resolveNativeChair({
      chair: input.chair || null, agents: input.agents, startAgent: input.startAgent,
      writer: requestedWriter, mode: input.mode,
    });
    const delegatedAgents = native.agents;
    const effectiveMode = native.chairOwnsWork ? "review" : input.mode;
    const effectivePermissionProfile = effectiveMode === "review" ? "standard" : (input.permissionProfile || "standard");
    const rotated = participantRotation;
    const startAgent = delegatedAgents.includes(rotated?.writer) ? rotated.writer : native.startAgent;
    validateAgents(delegatedAgents, startAgent);
    const writer = effectiveMode === "work" ? (native.writer || startAgent) : null;
    assertAutonomousDeliveryBinding({
      mode: effectiveMode,
      workProfile: input.workProfile || "exact",
      githubBuilder: input.githubBuilder || null,
    });
    if (input.githubReview && !input.handoffPath) throw new Error("githubReview requires handoffPath.");
    if (input.githubBuilder && effectiveMode !== "work") throw new Error("githubBuilder cannot be delegated when the native chair owns the work; the host must perform its own bound delivery phase.");
    if (input.githubReview && effectiveMode === "work" && delegatedAgents.every((agent) => agent === writer)) {
      throw new Error("githubReview requires at least one reviewer distinct from the work-mode writer.");
    }
    if (input.permissionProfile === "yolo" && input.mode !== "work") {
      throw new Error("permissionProfile yolo is available only in work mode.");
    }
    if (writer && !delegatedAgents.includes(writer)) throw new Error("writer must be included in delegated agents.");
    const requestedWorkspace = projectDirectory(input.workspace);
    const collaborationId = `bridge-${randomUUID()}`;
    let leaseAcquired = false;
    let claimClient = null;
    let claimHeadSha = null;
    let claimBaseSha = null;
    let resolvedIssueClaim = input.issueClaim ? { ...input.issueClaim } : null;
    let resolvedTask = input.task;
    let issueContext = null;
    let repositoryEvidence = null;
    let verificationPlan = { reusable: [], pendingCommands: input.verificationCommands || [], avoidedCommands: 0, estimatedAvoidedMs: 0 };
    const evidenceStore = createEvidenceStore({ directory: EVIDENCE_ROOT });

    if (input.issueClaim) {
      const { acquireClaimLease } = await import("./github-issue-claims.mjs");
      const { createInstallationToken } = await import("./github-app-auth.mjs");
      const { createBoundBuilderClient } = await import("./github-builder-client.mjs");
      const repository = input.issueClaim.repository;
      const expectedLogin = input.issueClaim.expectedLogin;
      const credential = await createInstallationToken({ role: "builder", repository });
      const revisions = resolveIssueClaimRevisions({
        workspace: requestedWorkspace,
        headSha: input.issueClaim.headSha,
        baseRef: input.worktree?.base || input.issueClaim.baseSha || input.issueClaim.headSha || "HEAD",
      });
      const headSha = revisions.headSha;
      claimHeadSha = headSha;
      claimBaseSha = revisions.baseSha;

      claimClient = createBoundBuilderClient({
        apiUrl: input.issueClaim.apiUrl || process.env.GITHUB_BUILDER_API_URL || "https://api.github.com",
        token: credential.token,
        verifiedLogin: credential.verifiedLogin,
        repository,
        expectedLogin,
        headSha,
        issueNumber: input.issueClaim.issueNumber,
        allowedOperations: ["get_issue", "add_issue_label", "remove_issue_label", "get_issue_comments", "post_issue_comment", "update_issue_comment", "delete_issue_comment", "list_tag_locks", "acquire_tag_lock", "release_tag_lock"],
        workspace: requestedWorkspace,
        fetchImpl: fetch,
      });

      const hydrated = await hydrateClaimedIssueTask({
        client: claimClient,
        repository,
        issueNumber: input.issueClaim.issueNumber,
        task: input.task,
        evidenceStore,
        evidenceScope: { repository, headSha },
      });
      resolvedTask = hydrated.task;
      issueContext = hydrated.metadata;

      let portfolioId = input.issueClaim.portfolioId || null;
      let itemId = input.issueClaim.itemId || null;
      if (!portfolioId || !itemId) {
        try {
          const portfolios = await listPortfolios(PORTFOLIO_ROOT);
          for (const p of portfolios) {
            const item = p.items.find(i => i.issueNumber === input.issueClaim.issueNumber || i.id === String(input.issueClaim.issueNumber));
            if (item) {
              portfolioId = p.id;
              itemId = item.id;
              break;
            }
          }
        } catch {}
      }

      const plannedWorktreePath = plannedIssueClaimWorktree({
        workspace: requestedWorkspace,
        worktree: input.worktree,
        mode: effectiveMode,
      });

      await acquireClaimLease({
        client: claimClient,
        issueNumber: input.issueClaim.issueNumber,
        portfolioId,
        itemId,
        writer: writer || input.writer || startAgent,
        collaborationId,
        branch: input.worktree?.branch || input.issueClaim.branch || null,
        worktree: plannedWorktreePath || input.issueClaim.worktree || null,
        baseSha: claimBaseSha,
        headSha: claimHeadSha,
        workspaceRoot: WORKSPACE_ROOT,
      });
      leaseAcquired = true;
    }

    try {
      let readiness = null;
      if (!input.worktree) {
        readiness = preflight({ workspace: requestedWorkspace, agents: delegatedAgents, mode: effectiveMode, workProfile: input.workProfile || "exact", permissionProfile: effectivePermissionProfile });
        if (!readiness.checks.find((check) => check.name === "workspace")?.ok
          || !readiness.checks.find((check) => check.name === "git-repository")?.ok) {
          throw new Error("Collaboration preflight failed: workspace must exist and be a Git repository.");
        }
      }
      const worktree = input.worktree
        ? effectiveMode === "work"
          ? prepareWriterCheckout({
            workspace: requestedWorkspace,
            taskId: input.worktree.taskId,
            branch: input.worktree.branch,
            base: input.worktree.base,
            checkoutRoot: input.worktree.root,
          })
          : createWorktree({
            workspace: requestedWorkspace,
            taskId: input.worktree.taskId,
            branch: input.worktree.branch,
            base: input.worktree.base,
            worktreeRoot: input.worktree.root,
          })
        : effectiveMode === "work"
          ? adoptExistingWriterCheckout({ workspace: requestedWorkspace })
          : null;
      const workspace = worktree?.path || requestedWorkspace;
      if (input.chair?.workspace && projectDirectory(input.chair.workspace) !== realpathSync(workspace)) {
        throw new Error("Native chair workspace must match the collaboration workspace.");
      }
      readiness ||= preflight({ workspace, agents: delegatedAgents, mode: effectiveMode, workProfile: input.workProfile || "exact", permissionProfile: effectivePermissionProfile });
      if (!readiness.checks.find((check) => check.name === "workspace")?.ok
        || !readiness.checks.find((check) => check.name === "git-repository")?.ok) {
        throw new Error("Collaboration preflight failed: workspace must exist and be a Git repository.");
      }
      const existing = await listCollaborations(WORKSPACE_ROOT, { status: "indeterminate", limit: 100 });
      const ownershipConflict = existing.find((candidate) => candidate.workspace === workspace);
      if (ownershipConflict) {
        throw new Error(`Workspace ownership is preserved by indeterminate collaboration ${ownershipConflict.id}; inspect and cancel it before starting replacement work.`);
      }
      if (input.issueClaim) {
        const actualHead = resolveClaimedWorktreeHead(workspace);
        resolvedIssueClaim = {
          ...input.issueClaim,
          writer: writer || input.writer || startAgent,
          branch: worktree?.branch || input.issueClaim.branch || null,
          worktree: workspace,
          baseSha: claimBaseSha,
          headSha: actualHead,
        };
        const { refreshClaimLease } = await import("./github-issue-claims.mjs");
        await refreshClaimLease({
          client: claimClient,
          issueNumber: input.issueClaim.issueNumber,
          collaborationId,
          phase: "preflight",
          summary: "Worktree created and collaboration preflight passed.",
          headSha: resolvedIssueClaim.headSha,
          branch: resolvedIssueClaim.branch,
          worktree: resolvedIssueClaim.worktree,
        });
      }
      repositoryEvidence = await captureRepositoryEvidence({
        workspace,
        store: evidenceStore,
        repository: input.issueClaim?.repository || input.githubReview?.repository || input.githubBuilder?.repository,
        headSha: input.githubReview?.headSha || input.githubBuilder?.headSha || undefined,
        baseSha: input.githubBuilder?.baseSha || resolvedIssueClaim?.baseSha || null,
        allowMissingHead: !input.issueClaim && !input.githubReview && !input.githubBuilder && !input.worktree,
      });
      const taskBase = resolvedTask;
      resolvedTask = [taskBase, formatRepositoryEvidence(repositoryEvidence)].filter(Boolean).join("\n\n");
      verificationPlan = await resolveVerificationPlan({
        store: evidenceStore,
        repositoryEvidence,
        commands: input.verificationCommands || [],
      });
      if (verificationPlan.reusable.length) {
        resolvedTask = `${resolvedTask}\n\n${formatReusableVerification(verificationPlan.reusable)}`;
      }
      const state = await createCollaboration(WORKSPACE_ROOT, {
        id: collaborationId,
        task: resolvedTask,
        taskBase,
        workspace,
        agents: delegatedAgents,
        participants: input.chair ? [input.chair.provider, ...delegatedAgents.filter((agent) => agent !== input.chair.provider)] : delegatedAgents,
        chair: native.chair,
        startAgent,
        mode: effectiveMode,
        requestedMode: input.mode,
        chairOwnsWork: native.chairOwnsWork,
        writer,
        browser: input.browser,
        models: input.models || {},
        modelFallbacks: input.modelFallbacks || {},
        allowClaudeFable: input.allowClaudeFable === true,
        providerConcurrency: await loadProviderConcurrency({ overrides: input.providerConcurrency || {} }),
        requestedVerificationCommands: input.verificationCommands || [],
        verificationCommands: verificationPlan.pendingCommands,
        verificationReceipts: verificationPlan.reusable,
        workCommands: input.workCommands || [],
        workProfile: input.workProfile || "exact",
        permissionProfile: effectivePermissionProfile,
        requestedPermissionProfile: input.permissionProfile || "standard",
        handoffPath: input.handoffPath || null,
        githubReview: input.githubReview || null,
        githubBuilder: input.githubBuilder || null,
        issueClaim: resolvedIssueClaim,
        issueContext,
        evidence: {
          repository: repositoryEvidence,
          cacheMetrics: evidenceStore.metrics(),
          avoidedCommands: verificationPlan.avoidedCommands,
          estimatedAvoidedMs: verificationPlan.estimatedAvoidedMs,
        },
        rotation: rotated ? { taskNumber: input.taskNumber, offset: input.rotationOffset, ...rotated } : null,
        worktree,
        preflight: readiness,
        capabilities: readiness.capabilities,
        budget: input.budget || {},
        providerRecovery: input.providerRecovery || { enabled: true, maxAttempts: 3, backoffSeconds: [15, 60, 180] },
        providerRecoveryState: { attempts: 0, status: "idle" },
        usage: {},
        ciTracking: input.ciTracking || null,
        ci: null,
        decisionPolicy: input.decisionPolicy || { additionalEscalations: [], maxDialogueTurns: 4 },
        decisionPolicyEnabled: Boolean(input.decisionPolicy),
        decisions: [],
        handoffs: [],
        completion: null,
        performance: startPerformanceSpan(
          createPerformanceTimeline(new Date().toISOString()),
          "queueing",
          { key: "queueing:1", category: "active", metadata: { runSequence: 1 } },
        ),
        runSequence: 1,
        coordinatorWake: null,
        nativeChairTurns: [],
        turnTimeoutSeconds: input.turnTimeoutSeconds,
        run: { maxTurns: input.decisionPolicy ? Math.min(input.maxTurns, input.decisionPolicy.maxDialogueTurns) : input.maxTurns },
        runtime: {
          sessions: Object.fromEntries(delegatedAgents.map((agent) => [agent, null])),
          nextAgent: startAgent,
          previousMessage: null,
          previousAgent: null,
          agreementStreak: 0,
          turnCount: 0,
          availableAgents: delegatedAgents,
          unavailableAgents: {},
          writer,
        },
      });
      await startWorker(state.id);
      return toolResponse(await collaborationView(WORKSPACE_ROOT, state.id, 1));
    } catch (startError) {
      if (leaseAcquired && claimClient && input.issueClaim) {
        try {
          const { releaseClaimLease } = await import("./github-issue-claims.mjs");
          await releaseClaimLease({
            client: claimClient,
            issueNumber: input.issueClaim.issueNumber,
            collaborationId,
            outcome: "rolled_back",
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [startError, rollbackError],
            `Collaboration start failed and its issue-claim rollback also failed: ${startError.message}; ${rollbackError.message}`,
          );
        }
      }
      throw startError;
    }
  },
);

server.registerTool(
  "get_collaboration",
  {
    title: "Get agent collaboration",
    description:
      "Poll compact status by default. Request detail full and explicit turns only when task/history content is needed. To long-poll, pass the last updatedAt value with waitSeconds.",
    inputSchema: {
      collaborationId,
      detail: z.enum(["status", "full"]).default("status"),
      includeTurns: z.number().int().min(0).max(50).default(0),
      afterTurn: z.number().int().min(0).default(0).describe("Return only completed turns with a higher turn number."),
      afterUpdatedAt: z.string().optional(),
      waitSeconds: z.number().int().min(0).max(30).default(0),
    },
  },
  async ({ collaborationId: id, detail, includeTurns, afterTurn, afterUpdatedAt, waitSeconds }) => {
    if (waitSeconds > 0) {
      await waitForCollaborationChange(WORKSPACE_ROOT, id, afterUpdatedAt, waitSeconds * 1000);
    }
    const view = await collaborationView(WORKSPACE_ROOT, id, includeTurns, afterTurn);
    return toolResponse(detail === "full" ? view : compactStatusView(view));
  },
);

server.registerTool(
  "recover_writer_checkout",
  {
    title: "Recover a stranded writer checkout",
    description: "After explicit inspection, migrate one stopped linked-worktree writer into private Git custody. The exact current workspace and HEAD are required; active or indeterminate execution is never relocated.",
    inputSchema: {
      collaborationId,
      expectedWorkspace: z.string().min(1),
      expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
    },
  },
  async ({ collaborationId: id, expectedWorkspace, expectedHeadSha }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (current.mode !== "work" || !current.worktree) {
      throw new Error("Writer checkout recovery requires a work-mode collaboration with a recorded worktree.");
    }
    if (!["failed", "needs_user", "turn_limit"].includes(current.status)) {
      throw new Error(`Writer checkout recovery requires a stopped inspectable collaboration; current status is ${current.status}.`);
    }
    if (current.status === "indeterminate" || current.runtime?.activeCall
      || (isSafeWorkerPid(current.workerPid) && processAlive(current.workerPid))) {
      throw new Error("Writer checkout recovery refuses active or indeterminate execution ownership.");
    }
    const actualWorkspace = realpathSync(current.workspace);
    if (realpathSync(expectedWorkspace) !== actualWorkspace) {
      throw new Error("Writer checkout recovery workspace changed after inspection.");
    }
    const observedHead = resolveClaimedWorktreeHead(actualWorkspace);
    if (observedHead !== expectedHeadSha) {
      throw new Error(`Writer checkout recovery HEAD changed after inspection: expected ${expectedHeadSha}, observed ${observedHead}.`);
    }
    if (current.worktree.strategy === "self-contained" || !isLinkedGitCheckout(actualWorkspace)) {
      throw new Error("Writer checkout recovery source is already self-contained.");
    }
    const operationId = `writer-recovery-${randomUUID()}`;
    const recoveredAt = new Date().toISOString();
    const previousStatus = current.status;
    const reserved = await updateCollaboration(WORKSPACE_ROOT, id, (latest) => {
      if (!["failed", "needs_user", "turn_limit"].includes(latest.status)
        || latest.workspaceOperation || latest.runtime?.activeCall
        || (isSafeWorkerPid(latest.workerPid) && processAlive(latest.workerPid))) {
        throw new Error("Writer checkout recovery lost stopped execution ownership before reservation.");
      }
      if (realpathSync(latest.workspace) !== actualWorkspace
        || resolveClaimedWorktreeHead(actualWorkspace) !== expectedHeadSha) {
        throw new Error("Writer checkout recovery workspace or HEAD changed before reservation.");
      }
      return {
        ...latest,
        status: "indeterminate",
        workspaceOperation: {
          id: operationId,
          type: "recover_writer_checkout",
          status: "reserved",
          workspace: actualWorkspace,
          expectedHeadSha,
          previousStatus,
          reservedAt: recoveredAt,
        },
      };
    });
    let recovered;
    let state;
    try {
      recovered = recoverWriterCheckout({
        workspace: actualWorkspace,
        taskId: `${basename(reserved.worktree.path || actualWorkspace)}-${id}`,
        branch: reserved.worktree.branch || reserved.issueClaim?.branch || null,
        base: reserved.issueClaim?.baseSha || reserved.worktree.base || expectedHeadSha,
      });
      state = await updateCollaboration(WORKSPACE_ROOT, id, (latest) => {
        if (latest.status !== "indeterminate" || latest.workspaceOperation?.id !== operationId
          || realpathSync(latest.workspace) !== actualWorkspace) {
          throw new Error("Writer checkout recovery lost its reserved workspace operation before commit.");
        }
        return {
          ...latest,
          status: previousStatus,
          workspace: recovered.path,
          worktree: recovered,
          workspaceOperation: null,
          issueClaim: latest.issueClaim
            ? { ...latest.issueClaim, branch: recovered.branch, worktree: recovered.path, headSha: recovered.base }
            : latest.issueClaim,
          workspaceRecovery: {
            recoveredAt,
            from: actualWorkspace,
            to: recovered.path,
            inspectedHeadSha: expectedHeadSha,
            recordedBaseSha: recovered.recovery.recordedBaseSha,
            sourceHeadSha: recovered.recovery.sourceHeadSha,
            strategy: "self-contained",
          },
        };
      });
    } catch (error) {
      if (recovered?.path && existsSync(recovered.path)) {
        cleanupWriterCheckout({ workspace: recovered.path, expectedPath: recovered.path, discardChanges: true });
      }
      await updateCollaboration(WORKSPACE_ROOT, id, (latest) => latest.workspaceOperation?.id === operationId
        ? {
          ...latest,
          status: previousStatus,
          workspaceOperation: null,
          workspaceOperationFailure: { operationId, failedAt: new Date().toISOString(), error: error.message },
        }
        : latest);
      throw error;
    }

    let claimRefresh = null;
    if (state.issueClaim) {
      try {
        const { getBuilderClientForWorkspace, refreshClaimLease } = await import("./github-issue-claims.mjs");
        const client = await getBuilderClientForWorkspace(state.workspace, state.issueClaim.issueNumber);
        if (!client) throw new Error(`No builder App client is configured for claimed issue #${state.issueClaim.issueNumber}.`);
        await refreshClaimLease({
          client,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          phase: "recovered",
          summary: "Coordinator inspected and migrated the stranded writer into private Git custody.",
          headSha: recovered.base,
          branch: recovered.branch,
          worktree: recovered.path,
        });
        claimRefresh = { ok: true };
      } catch (error) {
        claimRefresh = { ok: false, error: error.message };
      }
    }
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "writer_checkout_recovered",
      at: recoveredAt,
      from: actualWorkspace,
      to: recovered.path,
      branch: recovered.branch,
      baseSha: recovered.base,
      trackedPatch: recovered.recovery.trackedPatch,
      untrackedPathCount: recovered.recovery.untrackedPaths.length,
      claimRefresh,
    });
    return toolResponse({
      ...await collaborationView(WORKSPACE_ROOT, id, 0),
      recoveryReceipt: state.workspaceRecovery,
      claimRefresh,
      nextAction: "continue_collaboration",
    });
  },
);

server.registerTool(
  "cleanup_writer_checkout",
  {
    title: "Clean up a private writer checkout",
    description: "Remove one stopped self-contained writer checkout after exact workspace and HEAD inspection. Dirty changes are preserved unless discardChanges is explicitly true.",
    inputSchema: {
      collaborationId,
      expectedWorkspace: z.string().min(1),
      expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
      discardChanges: z.boolean().default(false),
    },
  },
  async ({ collaborationId: id, expectedWorkspace, expectedHeadSha, discardChanges }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (current.mode !== "work" || current.worktree?.strategy !== "self-contained") {
      throw new Error("Writer checkout cleanup requires a work-mode collaboration with private Git custody.");
    }
    if (current.worktree?.managed === false) {
      throw new Error("Writer checkout cleanup is available only for a bridge-managed private checkout; adopted user repositories are never removed.");
    }
    if (!["completed", "failed", "cancelled", "needs_user", "turn_limit"].includes(current.status)) {
      throw new Error(`Writer checkout cleanup requires a stopped inspectable collaboration; current status is ${current.status}.`);
    }
    if (current.status === "indeterminate" || current.runtime?.activeCall
      || (isSafeWorkerPid(current.workerPid) && processAlive(current.workerPid))) {
      throw new Error("Writer checkout cleanup refuses active or indeterminate execution ownership.");
    }
    const actualWorkspace = realpathSync(current.workspace);
    if (realpathSync(expectedWorkspace) !== actualWorkspace) {
      throw new Error("Writer checkout cleanup workspace changed after inspection.");
    }
    const cleanupDescriptor = current.worktree.cleanup;
    if (cleanupDescriptor?.strategy !== "remove-directory"
      || realpathSync(cleanupDescriptor.path) !== actualWorkspace) {
      throw new Error("Writer checkout cleanup descriptor does not match the recorded workspace.");
    }
    const observedHead = resolveClaimedWorktreeHead(actualWorkspace);
    if (observedHead !== expectedHeadSha) {
      throw new Error(`Writer checkout cleanup HEAD changed after inspection: expected ${expectedHeadSha}, observed ${observedHead}.`);
    }
    const operationId = `writer-cleanup-${randomUUID()}`;
    const previousStatus = current.status;
    const reservedAt = new Date().toISOString();
    await updateCollaboration(WORKSPACE_ROOT, id, (latest) => {
      if (!["completed", "failed", "cancelled", "needs_user", "turn_limit"].includes(latest.status)
        || latest.workspaceOperation || latest.runtime?.activeCall
        || (isSafeWorkerPid(latest.workerPid) && processAlive(latest.workerPid))) {
        throw new Error("Writer checkout cleanup lost stopped execution ownership before reservation.");
      }
      if (realpathSync(latest.workspace) !== actualWorkspace
        || resolveClaimedWorktreeHead(actualWorkspace) !== expectedHeadSha) {
        throw new Error("Writer checkout cleanup workspace or HEAD changed before reservation.");
      }
      return {
        ...latest,
        status: "indeterminate",
        workspaceOperation: {
          id: operationId,
          type: "cleanup_writer_checkout",
          status: "reserved",
          workspace: actualWorkspace,
          expectedHeadSha,
          discardChanges,
          previousStatus,
          reservedAt,
        },
      };
    });
    let receipt;
    let state;
    try {
      receipt = cleanupWriterCheckout({
        workspace: actualWorkspace,
        expectedPath: expectedWorkspace,
        discardChanges,
      });
      state = await updateCollaboration(WORKSPACE_ROOT, id, (latest) => {
        if (latest.status !== "indeterminate" || latest.workspaceOperation?.id !== operationId) {
          throw new Error("Writer checkout cleanup lost its reserved workspace operation before commit.");
        }
        return {
          ...latest,
          status: previousStatus,
          worktree: { ...latest.worktree, cleanup: null, cleanedAt: receipt.cleanedAt },
          workspaceOperation: null,
          workspaceCleanup: receipt,
        };
      });
    } catch (error) {
      await updateCollaboration(WORKSPACE_ROOT, id, (latest) => latest.workspaceOperation?.id === operationId
        ? {
          ...latest,
          status: existsSync(actualWorkspace) ? previousStatus : "indeterminate",
          workspaceOperation: existsSync(actualWorkspace) ? null : {
            ...latest.workspaceOperation,
            status: "reconciliation_required",
            failedAt: new Date().toISOString(),
            error: error.message,
          },
          workspaceOperationFailure: { operationId, failedAt: new Date().toISOString(), error: error.message },
        }
        : latest);
      throw error;
    }
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "writer_checkout_cleaned",
      at: receipt.cleanedAt,
      path: receipt.path,
      discardedChanges: receipt.discardedChanges,
    });
    return toolResponse({
      collaborationId: state.id,
      status: state.status,
      cleanupReceipt: receipt,
    });
  },
);

server.registerTool(
  "plan_portfolio",
  {
    title: "Plan parallel issue portfolio",
    description: "Compute the safe ready frontier and dry-run execution waves from explicit dependencies, conflicts, path scopes, and shared resources without starting work.",
    inputSchema: {
      items: z.array(portfolioItemSchema).min(1).max(500),
      maxParallel: z.number().int().min(1).max(20).default(2),
    },
  },
  async ({ items, maxParallel }) => toolResponse({
    schedule: analyzePortfolio({ items, maxParallel }),
    waves: buildExecutionWaves({ items, maxParallel }),
  }),
);

server.registerTool(
  "create_portfolio",
  {
    title: "Create durable parallel issue portfolio",
    description: "Create a revisioned portfolio ledger and exact-SHA merge train. Selected lanes must still be started through start_collaboration in isolated worktrees.",
    inputSchema: {
      objective: z.string().min(1).max(50_000),
      workspace: z.string().optional(),
      items: z.array(portfolioItemSchema).min(1).max(500),
      maxParallel: z.number().int().min(1).max(20).default(2),
      targetBranch: z.string().min(1).max(500).default("main"),
      targetSha: z.string().regex(/^[0-9a-f]{40}$/i),
    },
  },
  async ({ objective, workspace: requestedWorkspace, items, maxParallel, targetBranch, targetSha }) => {
    blockNestedCollaboration();
    const workspace = projectDirectory(requestedWorkspace);
    const normalized = normalizePortfolioItems(items);
    const initial = refreshPortfolioState({
      objective,
      workspace,
      maxParallel,
      items: normalized,
      mergeTrain: createMergeTrain({ targetBranch, targetSha }),
    });
    return toolResponse(await createPortfolio(PORTFOLIO_ROOT, initial));
  },
);

server.registerTool(
  "get_portfolio",
  {
    title: "Get parallel issue portfolio",
    description: "Read the current durable portfolio, ready frontier, active lanes, and merge train.",
    inputSchema: { portfolioId },
  },
  async ({ portfolioId: id }) => toolResponse(await readPortfolio(PORTFOLIO_ROOT, id)),
);

server.registerTool(
  "wait_for_portfolio_lane",
  {
    title: "Wait for a portfolio lane outcome",
    description:
      "Race a lane's expected head advance against its linked collaboration becoming terminal or indeterminate. Terminal failures are reconciled into the portfolio immediately so a success-only waiter cannot silently park.",
    inputSchema: {
      portfolioId,
      itemId: z.string().min(1).max(200),
      expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
      afterUpdatedAt: z.string().optional(),
      waitSeconds: z.number().int().min(0).max(30).default(0),
    },
  },
  async ({ portfolioId: id, itemId, expectedHeadSha, afterUpdatedAt, waitSeconds }) => {
    let portfolio = await readPortfolio(PORTFOLIO_ROOT, id);
    let item = portfolio.items.find((candidate) => candidate.id === String(itemId));
    if (!item) throw new Error(`Portfolio item ${itemId} does not exist.`);
    if (!item.collaborationId) throw new Error(`Portfolio item ${itemId} has no linked collaborationId.`);
    if (waitSeconds > 0) {
      await waitForCollaborationChange(WORKSPACE_ROOT, item.collaborationId, afterUpdatedAt, waitSeconds * 1000);
    }
    const collaboration = await collaborationView(WORKSPACE_ROOT, item.collaborationId, 0);
    const classification = portfolioLaneOutcome(item, collaboration, expectedHeadSha);
    portfolio = await markStoppedPortfolioLane(id, itemId, collaboration, classification);
    item = portfolio.items.find((candidate) => candidate.id === String(itemId));
    const unavailable = Object.keys(collaboration.runtime?.unavailableAgents || {});
    return toolResponse({
      portfolioId: id,
      item,
      collaboration: compactStatusView(collaboration),
      ...classification,
      candidateProviders: KNOWN_AGENTS.filter((agent) => agent !== item.writer && !unavailable.includes(agent)),
    });
  },
);

server.registerTool(
  "list_portfolios",
  {
    title: "List parallel issue portfolios",
    description: "List recent durable portfolio ledgers.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  },
  async ({ limit }) => toolResponse({ portfolios: (await listPortfolios(PORTFOLIO_ROOT)).slice(0, limit) }),
);

server.registerTool(
  "update_portfolio_item",
  {
    title: "Update portfolio lane",
    description: "Record one lane lifecycle receipt using optimistic revision control, then recompute the safe frontier.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      status: portfolioStatusSchema,
      writer: z.enum(WRITER_AGENTS).optional(),
      collaborationId: collaborationId.optional(),
      worktree: z.string().max(5_000).optional(),
      branch: z.string().max(1_000).optional(),
      prNumber: z.number().int().min(1).optional(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
      summary: z.string().max(20_000).optional(),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, status, ...details }) => {
    blockNestedCollaboration();
    const patch = Object.fromEntries(Object.entries({ status, ...details }).filter(([, value]) => value !== undefined));
    const result = await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => updatePortfolioItemState(current, itemId, patch));

    const updatedItem = result.items.find((item) => item.id === String(itemId));
    if (status === "reviewing") await markLinkedCollaborationPerformance(updatedItem, "review_started");
    if (status === "ready_to_merge") await markLinkedCollaborationPerformance(updatedItem, "review_completed");

    if (status === "obsolete") {
      await releaseLinkedIssueClaim(updatedItem, "obsolete");
    }

    return toolResponse(result);
  },
);

server.registerTool(
  "enqueue_portfolio_merge",
  {
    title: "Enqueue exact-SHA portfolio merge",
    description: "Add or refresh one verified PR in the bridge-owned merge train. This does not merge it.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      prNumber: z.number().int().min(1),
      headSha: z.string().regex(/^[0-9a-f]{40}$/i),
      priority: z.number().finite().default(0),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, prNumber, headSha, priority }) => {
    blockNestedCollaboration();
    const result = await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => updatePortfolioItemState({
      ...current,
      mergeTrain: enqueueMergeCandidate(current.mergeTrain, { itemId, prNumber, headSha, priority }),
    }, itemId, { status: "ready_to_merge", prNumber, headSha }));
    await markLinkedCollaborationPerformance(result.items.find((item) => item.id === String(itemId)), "review_completed", { prNumber, headSha });
    return toolResponse(result);
  },
);

server.registerTool(
  "begin_portfolio_merge_validation",
  {
    title: "Begin serialized portfolio merge validation",
    description: "Acquire the one active integration slot after checking the observed target and PR head SHAs.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      observedTargetSha: z.string().regex(/^[0-9a-f]{40}$/i),
      observedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, observedTargetSha, observedHeadSha }) => {
    blockNestedCollaboration();
    const result = await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => updatePortfolioItemState({
      ...current,
      mergeTrain: beginMergeValidation(current.mergeTrain, { itemId, observedTargetSha, observedHeadSha }),
    }, itemId, { status: "integrating" }));
    await markLinkedCollaborationPerformance(
      result.items.find((item) => item.id === String(itemId)),
      "merge_validation_started",
      { observedTargetSha, observedHeadSha },
    );
    return toolResponse(result);
  },
);

server.registerTool(
  "record_portfolio_merge_validation",
  {
    title: "Record portfolio merge validation",
    description: "Record combined integration gates or a conflict dossier and release the integration slot.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      outcome: z.enum(["passed", "failed", "conflict"]),
      checks: z.array(z.string().min(1).max(2_000)).max(100).default([]),
      dossier: arbitrationDossierSchema.optional(),
      error: z.string().max(20_000).optional(),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, outcome, checks, dossier, error }) => {
    blockNestedCollaboration();
    const result = await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => {
      const normalizedDossier = dossier ? createArbitrationDossier(dossier) : null;
      const mergeTrain = recordMergeValidation(current.mergeTrain, { itemId, outcome, checks, dossier: normalizedDossier, error });
      const status = outcome === "passed" ? "ready_to_merge" : outcome === "conflict" ? "arbitrating" : "repairing";
      return updatePortfolioItemState({ ...current, mergeTrain }, itemId, { status, summary: error || undefined });
    });
    await markLinkedCollaborationPerformance(
      result.items.find((item) => item.id === String(itemId)),
      "merge_validation_completed",
      { outcome, checks: checks.length },
    );
    return toolResponse(result);
  },
);

server.registerTool(
  "authorize_portfolio_merge",
  {
    title: "Authorize exact validated portfolio merge",
    description: "Return an exact-SHA merge authorization only when combined validation is current. Actual merge still requires the separately bound GitHub builder permission.",
    inputSchema: {
      portfolioId,
      itemId: z.string().min(1).max(200),
      observedTargetSha: z.string().regex(/^[0-9a-f]{40}$/i),
      observedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
    },
  },
  async ({ portfolioId: id, itemId, observedTargetSha, observedHeadSha }) => {
    const current = await readPortfolio(PORTFOLIO_ROOT, id);
    const authorization = mergeAuthorization(current.mergeTrain, { itemId, observedTargetSha, observedHeadSha });
    await markLinkedCollaborationPerformance(current.items.find((item) => item.id === String(itemId)), "merge_authorized", { observedTargetSha, observedHeadSha });
    return toolResponse({ portfolioId: id, revision: current.revision, authorization });
  },
);

server.registerTool(
  "recover_portfolio_merge_validation",
  {
    title: "Recover interrupted portfolio merge validation",
    description: "Explicitly release an interrupted integration slot after inspection, preserving a durable reason and either requeueing the candidate or returning it for repair.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      reason: z.string().min(1).max(20_000),
      disposition: z.enum(["requeue", "repair"]).default("requeue"),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, reason, disposition }) => {
    blockNestedCollaboration();
    return toolResponse(await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => updatePortfolioItemState({
      ...current,
      mergeTrain: recoverMergeValidation(current.mergeTrain, { itemId, reason, disposition }),
    }, itemId, {
      status: disposition === "requeue" ? "ready_to_merge" : "repairing",
      summary: `Merge validation recovered: ${reason}`,
    })));
  },
);

server.registerTool(
  "refresh_portfolio_target",
  {
    title: "Refresh portfolio merge target",
    description: "Record an externally advanced target SHA and invalidate every stale combined validation. Active validation must be recovered first.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      observedTargetSha: z.string().regex(/^[0-9a-f]{40}$/i),
      reason: z.string().min(1).max(20_000),
    },
  },
  async ({ portfolioId: id, expectedRevision, observedTargetSha, reason }) => {
    blockNestedCollaboration();
    return toolResponse(await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => refreshPortfolioState({
      ...current,
      mergeTrain: refreshMergeTarget(current.mergeTrain, { observedTargetSha, reason }),
    })));
  },
);

server.registerTool(
  "record_portfolio_merge",
  {
    title: "Record completed portfolio merge",
    description: "Record GitHub's successful exact-head merge, invalidate remaining combined validations, and release newly unblocked work.",
    inputSchema: {
      portfolioId,
      expectedRevision: z.number().int().min(1),
      itemId: z.string().min(1).max(200),
      expectedTargetSha: z.string().regex(/^[0-9a-f]{40}$/i),
      expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i),
      mergedSha: z.string().regex(/^[0-9a-f]{40}$/i),
    },
  },
  async ({ portfolioId: id, expectedRevision, itemId, expectedTargetSha, expectedHeadSha, mergedSha }) => {
    blockNestedCollaboration();
    const updatedState = await updatePortfolio(PORTFOLIO_ROOT, id, expectedRevision, (current) => updatePortfolioItemState({
      ...current,
      mergeTrain: recordMergeResult(current.mergeTrain, { itemId, expectedTargetSha, expectedHeadSha, mergedSha }),
    }, itemId, { status: "merged", summary: `Merged as ${mergedSha}` }));

    const mergedItem = updatedState.items.find((item) => item.id === String(itemId));
    await markLinkedCollaborationPerformance(mergedItem, "merge_completed", { mergedSha });
    await releaseLinkedIssueClaim(mergedItem, "merged");
    return toolResponse(updatedState);
  },
);

server.registerTool(
  "record_verification_receipt",
  {
    title: "Record exact-head verification receipt",
    description: "Persist a chair- or CI-attested verification result so later reviewers can reuse it only at the same clean head and environment fingerprint.",
    inputSchema: {
      collaborationId,
      command: z.string().trim().min(1).max(500),
      exitCode: z.number().int(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime(),
      source: z.enum(["chair", "github_ci"]),
      attestation: z.enum(["authoritative", "observed", "claimed"]).default("claimed"),
      outputDigest: z.string().regex(/^[0-9a-f]{64}$/i),
      outputSummary: z.string().max(4_000).optional(),
    },
  },
  async ({ collaborationId: id, command, exitCode, startedAt, completedAt, source, attestation, outputDigest, outputSummary }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    const repositoryEvidence = current.evidence?.repository;
    if (!repositoryEvidence?.repository || !repositoryEvidence?.headSha || !repositoryEvidence?.environmentFingerprint) {
      throw new Error(`Collaboration ${id} has no exact-head repository evidence.`);
    }
    const authorizedCommands = new Set([
      ...(current.requestedVerificationCommands || []),
      ...(current.verificationCommands || []),
    ]);
    if (!authorizedCommands.has(command)) {
      throw new Error(`Verification command was not declared for collaboration ${id}: ${command}`);
    }
    const store = createEvidenceStore({ directory: EVIDENCE_ROOT });
    const currentEvidence = await captureRepositoryEvidence({
      workspace: current.workspace,
      store,
      repository: repositoryEvidence.repository,
      headSha: repositoryEvidence.headSha,
      baseSha: repositoryEvidence.baseSha || null,
    });
    if (!currentEvidence.clean) {
      throw new Error("Verification receipts can be recorded only for a clean workspace.");
    }
    if (currentEvidence.environmentFingerprint !== repositoryEvidence.environmentFingerprint) {
      throw new Error("Verification environment changed after evidence capture; refresh the collaboration before recording this receipt.");
    }
    const recorded = await store.recordVerificationReceipt({
      repository: repositoryEvidence.repository,
      headSha: repositoryEvidence.headSha,
      command,
      cwd: ".",
      environmentFingerprint: repositoryEvidence.environmentFingerprint,
      exitCode,
      startedAt,
      completedAt,
      source,
      attestation,
      outputDigest,
      outputSummary: outputSummary || null,
    });
    const receipt = recorded.value;
    await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous,
      verificationReceipts: [
        ...(previous.verificationReceipts || []).filter((existing) => existing.command !== command),
        receipt,
      ],
      evidence: {
        ...(previous.evidence || {}),
        cacheMetrics: store.metrics(),
      },
    }));
    await appendEvent(WORKSPACE_ROOT, id, { type: "verification_receipt_recorded", at: new Date().toISOString(), receipt });
    return toolResponse({ collaborationId: id, receipt, digest: recorded.digest });
  },
);

server.registerTool(
  "acknowledge_handoff",
  {
    title: "Acknowledge delegated completion handoff",
    description: "Record the chair's independent verification of the latest structured HANDOFF receipt.",
    inputSchema: {
      collaborationId,
      sequence: z.number().int().min(1),
      accepted: z.boolean(),
      summary: z.string().min(1).max(20_000),
      verification: z.array(z.string().min(1).max(2_000)).max(50).default([]),
      remaining: z.array(z.string().min(1).max(2_000)).max(50).default([]),
    },
  },
  async ({ collaborationId: id, sequence, accepted, summary: acknowledgementSummary, verification, remaining }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; acknowledge the HANDOFF after the delegated phase stops.`);
    }
    const recordedAt = new Date().toISOString();
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => {
      const basePerformance = previous.performance || createPerformanceTimeline(previous.createdAt || recordedAt);
      const wakeOwnsAcknowledgement = previous.coordinatorWake?.sourceHandoffSequence === sequence;
      const performance = wakeOwnsAcknowledgement
        ? basePerformance
        : markPerformanceMilestone(
          basePerformance,
          "handoff_acknowledged",
          { at: recordedAt, metadata: { sequence, accepted } },
        );
      return {
        ...previous,
        completion: acknowledgeCompletion(previous.completion, {
          sequence,
          accepted,
          summary: acknowledgementSummary,
          verification,
          remaining,
          at: recordedAt,
        }),
        performance,
        performanceSummary: summarizePerformance(performance),
      };
    });
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "handoff_acknowledged",
      at: recordedAt,
      completion: state.completion,
    });
    return toolResponse({ collaborationId: id, status: state.status, completion: state.completion });
  },
);

server.registerTool(
  "get_context_capsule",
  {
    title: "Get collaboration context capsule",
    description: "Retrieve all or selected allowed sections of the context capsule for a collaboration without reading the full transcript.",
    inputSchema: {
      collaborationId,
      sections: z.array(z.enum([
        "facts", "decisions", "artifacts", "constraints", "unresolvedQuestions", "sourceReferences"
      ])).optional().describe("Allowed sections to retrieve. If omitted, all sections are returned."),
    },
  },
  async ({ collaborationId: id, sections }) => {
    blockNestedCollaboration();
    const capsule = await readContextCapsule(WORKSPACE_ROOT, id, sections);
    if (!capsule) {
      throw new Error(`No context capsule found for collaboration ${id}.`);
    }
    return toolResponse(capsule);
  },
);

server.registerTool(
  "acknowledge_coordinator_wake",
  {
    title: "Acknowledge coordinator wake",
    description: "Record that the native coordinator received and processed the current durable wake event.",
    inputSchema: {
      collaborationId,
      sequence: z.number().int().min(1),
      provider: z.enum(KNOWN_AGENTS),
      summary: z.string().min(1).max(20_000),
      action: z.enum(["processed", "continued", "needs_user", "completed"]).default("processed"),
    },
  },
  async ({ collaborationId: id, sequence, provider, summary: wakeSummary, action }) => {
    blockNestedCollaboration();
    const state = await acknowledgeCoordinatorWake(WORKSPACE_ROOT, id, sequence, {
      provider,
      summary: wakeSummary,
      action,
    });
    return toolResponse({
      collaborationId: id,
      status: state.status,
      coordinatorWake: state.coordinatorWake,
    });
  },
);

server.registerTool(
  "record_native_chair_turn",
  {
    title: "Record native chair turn",
    description: "Attach a durable receipt for work completed by the current host session without launching another CLI instance of that provider.",
    inputSchema: {
      collaborationId,
      summary: z.string().min(1).max(20_000),
      artifacts: z.array(z.string().min(1).max(2_000)).max(50).default([]),
      verification: z.array(z.string().min(1).max(2_000)).max(50).default([]),
    },
  },
  async ({ collaborationId: id, summary: chairSummary, artifacts, verification }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (!current.chair) throw new Error(`Collaboration ${id} has no declared native chair.`);
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; record the native chair receipt after the delegated phase stops.`);
    }
    if (current.completion?.acknowledged === false) {
      throw new Error(`Collaboration ${id} has unacknowledged HANDOFF sequence ${current.completion.sequence}; call acknowledge_handoff before continuing.`);
    }
    if (current.coordinatorWake?.actionable && current.coordinatorWake.status !== "acknowledged") {
      throw new Error(`Collaboration ${id} has unacknowledged coordinator wake ${current.coordinatorWake.sequence}; call acknowledge_coordinator_wake before continuing.`);
    }
    const receipt = {
      source: "native-chair", provider: current.chair.provider, sessionId: current.chair.sessionId || null,
      workspace: current.workspace, summary: chairSummary, artifacts, verification, recordedAt: new Date().toISOString(),
    };
    await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous, nativeChairTurns: [...(previous.nativeChairTurns || []), receipt],
    }));
    await appendEvent(WORKSPACE_ROOT, id, { type: "native_chair_turn", at: receipt.recordedAt, receipt });
    return toolResponse({ collaborationId: id, receipt, status: current.status });
  },
);

server.registerTool(
  "continue_collaboration",
  {
    title: "Continue agent collaboration",
    description:
      "Resume the same provider sessions with a user answer or a new phase. Returns immediately and retains the portable ID.",
    inputSchema: {
      collaborationId,
      message: z.string().min(1).describe("User answer, correction, or next-phase instruction."),
      additionalTurns: z.number().int().min(1).max(20).default(6),
      models: modelsSchema,
      modelFallbacks: modelFallbacksSchema,
      allowClaudeFable: allowClaudeFableSchema.optional(),
      providerConcurrency: providerConcurrencySchema,
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema.optional(),
      permissionProfile: permissionProfileSchema.optional(),
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      githubBuilder: githubBuilderSchema,
      issueClaim: issueClaimSchema,
      budget: budgetSchema,
      providerRecovery: providerRecoverySchema,
      ciTracking: ciTrackingSchema,
      turnTimeoutSeconds: z.number().int().min(30).max(7200).optional(),
      decisionPolicy: decisionPolicySchema,
    },
  },
  async ({
    collaborationId: id,
    message,
    additionalTurns,
    models,
    modelFallbacks,
    allowClaudeFable,
    providerConcurrency,
    verificationCommands,
    workCommands,
    workProfile,
    permissionProfile,
    handoffPath,
    githubReview,
    githubBuilder,
    issueClaim,
    budget,
    providerRecovery,
    ciTracking,
    turnTimeoutSeconds,
    decisionPolicy,
  }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; wait for it to stop before continuing.`);
    }
    if (current.workspaceOperation) {
      throw new Error(`Collaboration ${id} has a reserved ${current.workspaceOperation.type} operation; inspect or reconcile it before continuing.`);
    }
    if (current.completion?.acknowledged === false) {
      throw new Error(`Collaboration ${id} has unacknowledged HANDOFF sequence ${current.completion.sequence}; call acknowledge_handoff before continuing.`);
    }
    if (current.coordinatorWake?.actionable && current.coordinatorWake.status !== "acknowledged") {
      throw new Error(`Collaboration ${id} has unacknowledged coordinator wake ${current.coordinatorWake.sequence}; call acknowledge_coordinator_wake before continuing.`);
    }
    if (current.coordinatorWake && !current.coordinatorWake.actionable && current.coordinatorWake.status !== "acknowledged") {
      await acknowledgeCoordinatorWake(WORKSPACE_ROOT, id, current.coordinatorWake.sequence, {
        provider: current.coordinatorWake.provider,
        summary: "Coordinator supplied the user answer or inspection result and continued the collaboration.",
        action: "continued",
      });
    }
    if (githubReview && !(handoffPath || current.handoffPath)) {
      throw new Error("githubReview requires handoffPath.");
    }
    if (githubBuilder && current.mode !== "work") throw new Error("githubBuilder is available only in work mode.");
    assertAutonomousDeliveryBinding({
      mode: current.mode,
      workProfile: workProfile || current.workProfile || "exact",
      githubBuilder: githubBuilder || current.githubBuilder || null,
    });
    if ((permissionProfile || current.permissionProfile) === "yolo" && current.mode !== "work") {
      throw new Error("permissionProfile yolo is available only in work mode.");
    }
    const resolvedProviderConcurrency = providerConcurrency
      ? await loadProviderConcurrency({
        overrides: normalizeProviderConcurrency(
          providerConcurrency,
          current.providerConcurrency || await loadProviderConcurrency(),
        ),
      })
      : current.providerConcurrency || await loadProviderConcurrency();
    let resolvedContinuationIssueClaim = current.issueClaim || null;
    if (issueClaim) {
      if (!current.issueClaim) {
        throw new Error("A GitHub issue claim cannot be added during continuation; acquire it atomically with start_collaboration.");
      }
      if (issueClaim.repository !== current.issueClaim.repository
        || issueClaim.issueNumber !== current.issueClaim.issueNumber
        || issueClaim.expectedLogin !== current.issueClaim.expectedLogin) {
        throw new Error("Continuation cannot change the repository, issue number, or builder identity of an existing claim.");
      }
      resolvedContinuationIssueClaim = { ...current.issueClaim, ...issueClaim };
      const { getBuilderClientForWorkspace, refreshClaimLease } = await import("./github-issue-claims.mjs");
      const claimClient = await getBuilderClientForWorkspace(current.workspace, current.issueClaim.issueNumber);
      if (!claimClient) throw new Error(`No builder App client is configured for claimed issue #${current.issueClaim.issueNumber}.`);
      await refreshClaimLease({
        client: claimClient,
        issueNumber: current.issueClaim.issueNumber,
        collaborationId: id,
        phase: "working",
        summary: "Collaboration continuation queued.",
        headSha: resolvedContinuationIssueClaim.headSha,
        branch: resolvedContinuationIssueClaim.branch,
        worktree: resolvedContinuationIssueClaim.worktree || current.workspace,
      });
    }
    const requestedContinuationCommands = verificationCommands
      || current.requestedVerificationCommands
      || current.verificationCommands
      || [];
    const continuationStore = createEvidenceStore({ directory: EVIDENCE_ROOT });
    const activeGithubReview = githubReview || current.githubReview || null;
    const activeGithubBuilder = githubBuilder || current.githubBuilder || null;
    const continuationEvidence = await captureRepositoryEvidence({
      workspace: current.workspace,
      store: continuationStore,
      repository: resolvedContinuationIssueClaim?.repository || activeGithubReview?.repository || activeGithubBuilder?.repository,
      headSha: activeGithubReview?.headSha || activeGithubBuilder?.headSha || undefined,
      baseSha: activeGithubBuilder?.baseSha || resolvedContinuationIssueClaim?.baseSha || null,
      allowMissingHead: !current.evidence?.repository?.headSha
        && !resolvedContinuationIssueClaim
        && !activeGithubReview
        && !activeGithubBuilder
        && !current.worktree?.base,
    });
    const continuationVerificationPlan = await resolveVerificationPlan({
      store: continuationStore,
      repositoryEvidence: continuationEvidence,
      commands: requestedContinuationCommands,
    });
    const continuationMessage = [
      message,
      formatRepositoryEvidence(continuationEvidence),
      formatReusableVerification(continuationVerificationPlan.reusable),
    ].filter(Boolean).join("\n\n");
    const state = await updateCollaboration(WORKSPACE_ROOT, id, async (previous) => {
      if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(previous.status)
        || previous.workspaceOperation || previous.runtime?.activeCall
        || (isSafeWorkerPid(previous.workerPid) && processAlive(previous.workerPid))) {
        throw new Error(`Collaboration ${id} execution ownership changed before continuation could be reserved.`);
      }
      const nextRunSequence = (previous.runSequence || 1) + 1;
      const queuedAt = new Date().toISOString();
      const performance = startPerformanceSpan(
        previous.performance || createPerformanceTimeline(previous.createdAt || queuedAt),
        "queueing",
        { key: `queueing:${nextRunSequence}`, at: queuedAt, metadata: { runSequence: nextRunSequence } },
      );
      const refreshedTask = [
        previous.taskBase || previous.task,
        formatRepositoryEvidence(continuationEvidence),
        formatReusableVerification(continuationVerificationPlan.reusable),
      ].filter(Boolean).join("\n\n");
      if (continuationEvidence?.headSha) {
        assertRepositoryEvidenceHead({
          expectedHeadSha: continuationEvidence.headSha,
          observedHeadSha: await readRepositoryHead(previous.workspace),
        });
      }
      return {
        ...previous,
        task: refreshedTask,
        taskBase: previous.taskBase || previous.task,
        status: "queued",
        cancelRequested: false,
        error: null,
        cleanup: null,
        models: models ? { ...previous.models, ...models } : previous.models,
        modelFallbacks: modelFallbacks
          ? { ...(previous.modelFallbacks || {}), ...modelFallbacks }
          : previous.modelFallbacks || {},
        allowClaudeFable: allowClaudeFable === true,
        providerConcurrency: resolvedProviderConcurrency,
        requestedVerificationCommands: requestedContinuationCommands,
        verificationCommands: continuationVerificationPlan.pendingCommands,
        verificationReceipts: continuationVerificationPlan.reusable,
        workCommands: workCommands || previous.workCommands || [],
        workProfile: workProfile || previous.workProfile || "exact",
        permissionProfile: permissionProfile || previous.permissionProfile || "standard",
        handoffPath: handoffPath || previous.handoffPath || null,
        githubReview: githubReview || previous.githubReview || null,
        githubBuilder: githubBuilder || previous.githubBuilder || null,
        issueClaim: resolvedContinuationIssueClaim,
        budget: budget || previous.budget || {},
        providerRecovery: providerRecovery || previous.providerRecovery || { enabled: true, maxAttempts: 3, backoffSeconds: [15, 60, 180] },
        providerRecoveryState: { attempts: 0, status: "idle" },
        ciTracking: ciTracking || previous.ciTracking || null,
        evidence: {
          repository: continuationEvidence,
          cacheMetrics: continuationStore.metrics(),
          avoidedCommands: continuationVerificationPlan.avoidedCommands,
          estimatedAvoidedMs: continuationVerificationPlan.estimatedAvoidedMs,
        },
        turnTimeoutSeconds: turnTimeoutSeconds || previous.turnTimeoutSeconds || 600,
        decisionPolicy: decisionPolicy || previous.decisionPolicy || { additionalEscalations: [], maxDialogueTurns: 4 },
        decisionPolicyEnabled: decisionPolicy ? true : previous.decisionPolicyEnabled || false,
        budgetExceeded: false,
        decisionEscalation: null,
        performance,
        performanceSummary: summarizePerformance(performance),
        runSequence: nextRunSequence,
        coordinatorWake: previous.coordinatorWake?.status === "acknowledged"
          ? previous.coordinatorWake
          : null,
        run: { maxTurns: (decisionPolicy || previous.decisionPolicyEnabled)
          ? Math.min(additionalTurns, (decisionPolicy || previous.decisionPolicy).maxDialogueTurns)
          : additionalTurns },
        runtime: {
          ...previous.runtime,
          previousMessage: continuationMessage,
          previousAgent: null,
          agreementStreak: 0,
          availableAgents: previous.agents,
          unavailableAgents: {},
        },
        completion: previous.completion
          ? { ...previous.completion, phase: "continuing", nextAction: "provider_work" }
          : null,
      };
    });
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "user_continued",
      at: new Date().toISOString(),
      message,
      evidence: state.evidence,
    });
    await startWorker(id);
    return toolResponse(await collaborationView(WORKSPACE_ROOT, state.id, 1));
  },
);

server.registerTool(
  "record_decision",
  {
    title: "Record bounded collaboration decision",
    description: "Record a reversible technical decision receipt or escalate a protected human decision without expanding authority.",
    inputSchema: {
      collaborationId,
      question: z.string().min(1).max(10_000),
      category: z.enum(DECISION_CATEGORIES),
      alternatives: z.array(z.string().min(1).max(5_000)).max(20).default([]),
      decision: z.string().min(1).max(10_000).optional(),
      confidence: z.number().min(0).max(1).optional(),
      dissent: z.array(z.string().min(1).max(5_000)).max(20).default([]),
      rollbackPath: z.string().min(1).max(10_000).optional(),
      owner: z.string().min(1).max(200),
    },
  },
  async ({ collaborationId: id, ...input }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (["queued", "running", "recovering", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; record the decision only after the bounded dialogue stops.`);
    }
    const receipt = createDecisionReceipt({
      ...input,
      additionalEscalations: current.decisionPolicy?.additionalEscalations || [],
    });
    const recordedAt = new Date().toISOString();
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous,
      status: receipt.action === "needs_user" ? "needs_user" : previous.status,
      decisions: [...(previous.decisions || []), { ...receipt, recordedAt }],
      runtime: receipt.action === "needs_user"
        ? { ...previous.runtime, activeCall: null, previousMessage: receipt.reason }
        : previous.runtime,
    }));
    await appendEvent(WORKSPACE_ROOT, id, { type: "decision_recorded", at: recordedAt, receipt });
    if (receipt.action === "needs_user") await enqueueCoordinatorWake(WORKSPACE_ROOT, id);
    return toolResponse({ collaborationId: id, receipt, status: state.status });
  },
);

server.registerTool(
  "cancel_collaboration",
  {
    title: "Cancel agent collaboration",
    description: "Cancel the collaboration and terminate its detached worker process group, including the active provider adapter.",
    inputSchema: { collaborationId },
  },
  async ({ collaborationId: id }) => {
    const before = await readCollaboration(WORKSPACE_ROOT, id);
    if (before.workspaceOperation) {
      throw new Error(`Refusing to cancel: ${before.workspaceOperation.type} owns the collaboration workspace; reconcile that operation first.`);
    }
    const workerIsLive = isSafeWorkerPid(before.workerPid) && processAlive(before.workerPid);
    if (workerIsLive && !workerCancellationMatches(before)) {
      throw new Error("Refusing to cancel: the live PID does not match this collaboration's owned worker metadata. Inspect with bridge recover; no process was terminated.");
    }
    await updateCollaboration(WORKSPACE_ROOT, id, (previous) => {
      if (previous.workspaceOperation) {
        throw new Error(`Refusing to cancel: ${previous.workspaceOperation.type} reserved the collaboration workspace after inspection.`);
      }
      return {
        ...previous,
        status: "cancelling",
        cancelRequested: true,
      };
    });
    let reaped = null;
    if (workerIsLive) {
      // Issue #55: reap the whole worker tree (process group + ps-discovered
      // descendants such as shell -> npm -> node), bounded grace, then SIGKILL.
      try {
        reaped = await reapProcessTree(before.workerPid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => clearTerminalRuntime({
      ...previous,
      cancelRequested: true,
    }, { status: "cancelled" }));

    // Issue #55: deterministically release the reaped worker's own worker/workspace
    // locks. Ownership guards are preserved: locks held by a different live process are
    // never removed.
    const releasedLocks = await releaseOwnedCollaborationLocks(WORKSPACE_ROOT, {
      id,
      workspace: before.workspace,
      ownerPid: before.workerPid,
    });

    let claimReleaseError = null;
    if (before.issueClaim) {
      try {
        await releaseLinkedIssueClaim({ collaborationId: id }, "cancelled");
      } catch (error) {
        claimReleaseError = error;
      }
    }

    const releasedProviderCapacity = await releaseProviderCapacityForCollaboration(WORKSPACE_ROOT, id);
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "cancelled",
      at: new Date().toISOString(),
      terminatedWorkerPid: before.workerPid || null,
      reaped: reaped ? {
        descendants: reaped.descendants.length,
        signalled: reaped.signalled.length,
        killed: reaped.killed.length,
        escalated: reaped.escalated,
      } : null,
      releasedLocks: releasedLocks.released.length,
      releasedProviderCapacity,
      claimRelease: claimReleaseError ? { ok: false, error: claimReleaseError.message } : { ok: true },
    });
    if (claimReleaseError) {
      throw new Error(`Collaboration ${id} was cancelled, but its GitHub issue claim remains held: ${claimReleaseError.message}`, { cause: claimReleaseError });
    }
    return toolResponse({ ...state, turns: [] });
  },
);

server.registerTool(
  "release_issue_claim",
  {
    title: "Recover an inspected issue claim",
    description: "Release one target-bound issue claim after explicit inspection. Orphaned refs require their exact generation.",
    inputSchema: {
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      issueNumber: z.number().int().min(1),
      expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
      collaborationId: z.string().min(1),
      generation: z.number().int().min(1).optional(),
      outcome: z.enum(["merged", "cancelled", "obsolete", "rolled_back", "taken_over", "recovered"]).default("recovered"),
    },
  },
  async ({ repository, issueNumber, expectedLogin, collaborationId, generation, outcome }) => {
    blockNestedCollaboration();
    const { getBuilderClientForWorkspace, recoverIssueClaim, releaseClaimLease } = await import("./github-issue-claims.mjs");
    const claimClient = await getBuilderClientForWorkspace(WORKSPACE_ROOT, issueNumber);
    if (!claimClient) throw new Error(`No builder App client is configured for claimed issue #${issueNumber}.`);
    const normalizeLogin = (login) => String(login || "").toLowerCase().replace(/\[bot\]$/, "");
    if (claimClient.repository !== repository || normalizeLogin(claimClient.expectedLogin) !== normalizeLogin(expectedLogin)) {
      throw new Error("Inspected recovery target does not match the bound repository and builder App identity.");
    }
    const recovery = outcome === "recovered"
      ? await recoverIssueClaim({ client: claimClient, issueNumber, collaborationId, generation, workspaceRoot: WORKSPACE_ROOT })
      : (await releaseClaimLease({ client: claimClient, issueNumber, collaborationId, outcome }), { recovered: true, generation, canonical: true });
    const recoveryReceipt = `Inspected recovery receipt: issue #${issueNumber}, collaboration ${collaborationId}, generation ${recovery.generation || generation || "canonical"}, outcome ${outcome}.`;
    await claimClient.postIssueComment(issueNumber, recoveryReceipt);
    return toolResponse({ ok: true, ...recovery, outcome });
  }
);

server.registerTool(
  "archive_collaboration",
  {
    title: "Archive collaboration",
    description: "Move one terminal collaboration state and JSONL history into the local archive. Running and indeterminate work is retained.",
    inputSchema: { collaborationId },
  },
  async ({ collaborationId: id }) => toolResponse(await archiveCollaboration(WORKSPACE_ROOT, id)),
);

server.registerTool(
  "prune_collaborations",
  {
    title: "Prune old collaborations",
    description: "Archive terminal collaborations older than the retention period; never touches active or indeterminate work.",
    inputSchema: { olderThanDays: z.number().int().min(1).max(3650).default(30) },
  },
  async ({ olderThanDays }) => {
    const archived = await pruneTerminalCollaborations(WORKSPACE_ROOT, { olderThanDays });
    return toolResponse({ archived, count: archived.length });
  },
);

server.registerTool(
  "list_collaborations",
  {
    title: "List agent collaborations",
    description: "List recent portable collaboration IDs and their current status.",
    inputSchema: {
      status: z.enum(STATUS_VALUES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ status, limit }) => {
    const collaborations = await listCollaborations(WORKSPACE_ROOT, { status, limit });
    return {
      content: [{
        type: "text",
        text: collaborations.length
          ? collaborations.map((item) => `${item.id}  ${item.status}  ${item.task}`).join("\n")
          : "No collaborations found.",
      }],
      structuredContent: { collaborations },
    };
  },
);

server.registerTool(
  "replay_incident",
  {
    title: "Replay collaboration incident",
    description: "Reconstruct a chronological timeline, observed facts, inferred contributing factors, and remediation steps from active or archived collaboration records.",
    inputSchema: { collaborationId },
  },
  async ({ collaborationId: id }) => {
    const report = await replayIncident(WORKSPACE_ROOT, id);
    return {
      content: [{
        type: "text",
        text: formatReplayHuman(report),
      }],
      structuredContent: report,
    };
  }
);

await reconcileInterruptedCleanup();
await server.connect(new StdioServerTransport());

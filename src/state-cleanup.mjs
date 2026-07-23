import { resolve } from "node:path";
import {
  archiveCollaboration,
  listCollaborations,
  readCollaboration,
} from "./collaboration-store.mjs";
import { LIVE_COLLABORATION_STATUSES } from "./collaboration-cleanup.mjs";
import { archivePortfolio, listPortfolios } from "./portfolio-store.mjs";
import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";
import { auditHostActivityArtifacts, pruneHostActivityArtifacts } from "./host-activity-store.mjs";

const SAFE_COLLABORATION_ARCHIVE_STATUSES = new Set([
  "agreed", "completed", "cancelled", "closed", "superseded", "failed", "turn_limit", "budget",
]);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function pendingWake(state) {
  return state.coordinatorWake && ["pending", "delivered"].includes(state.coordinatorWake.status);
}

function pendingHandoff(state) {
  return state.completion && state.completion.acknowledged !== true
    && !["complete", "completed", "none"].includes(state.completion.nextAction);
}

function collaborationProtectionReasons(state) {
  const reasons = [];
  if (LIVE_COLLABORATION_STATUSES.has(state.status)) reasons.push(`status:${state.status}`);
  if (state.status === "indeterminate") reasons.push("indeterminate_ownership");
  if (state.status === "needs_user") reasons.push("needs_user");
  if (alive(state.workerPid)) reasons.push("live_worker");
  if (state.runtime?.activeCall) reasons.push("active_provider_call");
  if (pendingWake(state)) reasons.push("pending_coordinator_wake");
  if (pendingHandoff(state)) reasons.push("unacknowledged_handoff");
  if (state.workspaceOperation) reasons.push("workspace_operation");
  return reasons;
}

function collaborationSummary(state, reasons = []) {
  return {
    id: state.id,
    status: state.status,
    updatedAt: state.updatedAt,
    workspace: state.workspace || null,
    issueClaim: state.issueClaim ? {
      repository: state.issueClaim.repository || null,
      issueNumber: state.issueClaim.issueNumber || null,
    } : null,
    pullRequest: state.githubReview?.prNumber || state.githubBuilder?.prNumber || state.ciTracking?.prNumber || null,
    worktree: state.worktree?.path || state.writerCheckout?.path || null,
    reasons,
  };
}

function portfolioSummary(state, reasons = []) {
  return {
    id: state.id,
    status: state.status,
    updatedAt: state.updatedAt,
    workspace: state.workspace || null,
    objective: state.objective || null,
    itemCount: Array.isArray(state.items) ? state.items.length : 0,
    revision: state.revision ?? null,
    reasons,
  };
}

export async function auditBridgeCleanup({
  workspaceRoot,
  stateRoot,
  olderThanDays = 7,
  now = Date.now(),
} = {}) {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) throw new Error("olderThanDays must be a positive integer.");
  const cutoff = now - olderThanDays * 86_400_000;
  const listed = await listCollaborations(workspaceRoot, { limit: 10_000 });
  const collaborations = await Promise.all(listed.map((entry) => readCollaboration(workspaceRoot, entry.id)));
  const collaborationArchiveCandidates = [];
  const staleCollaborations = [];
  const protectedCollaborations = [];

  for (const state of collaborations) {
    const isOld = dateMs(state.updatedAt) > 0 && dateMs(state.updatedAt) <= cutoff;
    const reasons = collaborationProtectionReasons(state);
    if (!isOld || reasons.length) {
      if (reasons.length) protectedCollaborations.push(collaborationSummary(state, reasons));
      continue;
    }
    if (SAFE_COLLABORATION_ARCHIVE_STATUSES.has(state.status)) {
      collaborationArchiveCandidates.push(collaborationSummary(state));
    } else {
      staleCollaborations.push(collaborationSummary(state, [`status:${state.status || "unknown"}`]));
    }
  }

  const portfolioRoot = process.env.BRIDGE_PORTFOLIO_DIR || resolve(stateRoot, "portfolios");
  const portfolios = await listPortfolios(portfolioRoot);
  const portfolioArchiveCandidates = [];
  const stalePortfolios = [];
  for (const state of portfolios) {
    const isOld = dateMs(state.updatedAt) > 0 && dateMs(state.updatedAt) <= cutoff;
    if (!isOld) continue;
    const items = Array.isArray(state.items) ? state.items : [];
    const terminal = state.status === "complete"
      && items.every((item) => PORTFOLIO_STATUS_GROUPS.terminal.includes(item.status));
    if (terminal && Number.isInteger(state.revision)) portfolioArchiveCandidates.push(portfolioSummary(state));
    else {
      const reasons = [];
      if (!terminal) reasons.push(`status:${state.status || "unknown"}`);
      if (!Number.isInteger(state.revision)) reasons.push("missing_revision");
      stalePortfolios.push(portfolioSummary(state, reasons));
    }
  }

  const hostActivityAudit = await auditHostActivityArtifacts(stateRoot, {
    now,
    olderThanMs: olderThanDays * 86_400_000,
  });

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    olderThanDays,
    stateRoot: resolve(stateRoot),
    collaborationArchiveCandidates,
    portfolioArchiveCandidates,
    staleCollaborations,
    stalePortfolios,
    protectedCollaborations,
    hostActivityCleanupCandidates: hostActivityAudit.candidates,
    protectedHostActivityArtifacts: hostActivityAudit.preserved,
    counts: {
      collaborations: collaborations.length,
      portfolios: portfolios.length,
      collaborationArchiveCandidates: collaborationArchiveCandidates.length,
      portfolioArchiveCandidates: portfolioArchiveCandidates.length,
      staleCollaborations: staleCollaborations.length,
      stalePortfolios: stalePortfolios.length,
      protectedCollaborations: protectedCollaborations.length,
      hostActivityCleanupCandidates: hostActivityAudit.candidates.length,
      protectedHostActivityArtifacts: hostActivityAudit.preserved.length,
    },
  };
}

export async function applyBridgeCleanup(options = {}) {
  const audit = await auditBridgeCleanup(options);
  const archivedCollaborations = [];
  const archivedPortfolios = [];
  const failedCollaborations = [];
  const failedPortfolios = [];
  for (const candidate of audit.collaborationArchiveCandidates) {
    try {
      archivedCollaborations.push(await archiveCollaboration(options.workspaceRoot, candidate.id, { expectedUpdatedAt: candidate.updatedAt }));
    } catch (error) {
      failedCollaborations.push({ id: candidate.id, error: error.message });
    }
  }
  const portfolioRoot = process.env.BRIDGE_PORTFOLIO_DIR || resolve(options.stateRoot, "portfolios");
  for (const candidate of audit.portfolioArchiveCandidates) {
    try {
      archivedPortfolios.push(await archivePortfolio(portfolioRoot, candidate.id, { expectedRevision: candidate.revision }));
    } catch (error) {
      failedPortfolios.push({ id: candidate.id, error: error.message });
    }
  }
  const hostActivityCleanup = await pruneHostActivityArtifacts(options.stateRoot, {
    now: options.now ?? Date.parse(audit.generatedAt),
    olderThanMs: audit.olderThanDays * 86_400_000,
    names: audit.hostActivityCleanupCandidates.map((candidate) => candidate.name),
  });
  return {
    ...audit,
    applied: true,
    archivedCollaborations,
    archivedPortfolios,
    failedCollaborations,
    failedPortfolios,
    removedHostActivityArtifacts: hostActivityCleanup.removed,
    failedHostActivityArtifacts: hostActivityCleanup.failed,
  };
}

export function formatCleanupReport(report, { applied = report.applied === true, limit = 20 } = {}) {
  const lines = [
    `Bridge cleanup ${applied ? "result" : "audit (dry-run)"}`,
    `Cutoff: ${report.cutoff} (${report.olderThanDays} day retention)`,
    `Archive-ready: ${report.counts.collaborationArchiveCandidates} collaborations, ${report.counts.portfolioArchiveCandidates} portfolios; ${report.counts.hostActivityCleanupCandidates || 0} expired host receipts`,
    `Preserved: ${report.counts.protectedCollaborations} protected collaborations, ${report.counts.staleCollaborations} unresolved collaborations, ${report.counts.stalePortfolios} nonterminal portfolios`,
  ];
  if (applied) {
    lines.push(`Archived: ${report.archivedCollaborations.length} collaborations, ${report.archivedPortfolios.length} portfolios; removed ${report.removedHostActivityArtifacts?.length || 0} expired host receipts`);
    if (report.failedCollaborations?.length || report.failedPortfolios?.length || report.failedHostActivityArtifacts?.length) {
      lines.push(`Skipped after recheck: ${report.failedCollaborations?.length || 0} collaborations, ${report.failedPortfolios?.length || 0} portfolios, ${report.failedHostActivityArtifacts?.length || 0} host receipts`);
    }
  } else if (report.counts.collaborationArchiveCandidates || report.counts.portfolioArchiveCandidates || report.counts.hostActivityCleanupCandidates) {
    lines.push("Run again with --apply to archive only the archive-ready records.");
  }
  const candidates = [
    ...report.collaborationArchiveCandidates.map((entry) => `${entry.id} ${entry.status}`),
    ...report.portfolioArchiveCandidates.map((entry) => `${entry.id} ${entry.status} (${entry.itemCount} items)`),
    ...report.hostActivityCleanupCandidates.map((entry) => `host-activity/${entry.name} ${entry.type}`),
  ];
  if (candidates.length) {
    lines.push("Candidates:");
    lines.push(...candidates.slice(0, limit).map((entry) => `  ${entry}`));
    if (candidates.length > limit) lines.push(`  … ${candidates.length - limit} more; use --json for the complete audit`);
  }
  lines.push("Stale unresolved records are never auto-cancelled, and cleanup never deletes worktrees, branches, claims, or GitHub history.");
  return lines.join("\n");
}

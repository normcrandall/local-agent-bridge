#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
import { createAgentPool } from "../src/agent-pool.mjs";
import { deliverySummaryForHandoff, summarizeDeliveryOutcomes } from "../src/builder-operation-store.mjs";
import {
  acquireWorkerLock,
  acquireWorkspaceLock,
  appendEvent,
  collaborationDirectory,
  readCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";
import { runConversation, WRITER_AGENTS } from "../src/talk-protocol.mjs";
import { isTransportLivenessSummary, refreshCi, usageDecision } from "../src/operations.mjs";
import { clearTerminalRuntime } from "../src/collaboration-cleanup.mjs";
import { createDecisionReceipt } from "../src/decision-policy.mjs";
import { completionAfterHandoff } from "../src/handoff-protocol.mjs";
import {
  assertReviewWorkspaceHead,
  orderReviewProbes,
  recordReviewPublicationResult,
} from "../src/review-publication.mjs";
import { acquireProviderCapacity, assertNoProviderPoolReentry, loadProviderConcurrency } from "../src/provider-concurrency.mjs";
import { activeVerificationCommand, capacityWaitNarrative, deliveryRepairSummary, verificationNarrative } from "../src/collaboration-narrative.mjs";
import { enqueueCoordinatorWake } from "../src/coordinator-wake.mjs";
import { createIssueClaimClient } from "../src/github-issue-claims.mjs";
import { recordLifecycleAssignment } from "../src/github-lifecycle.mjs";
import { createInstallationToken } from "../src/github-app-auth.mjs";
import { providerPermissionDecisionForRequest } from "../src/verification-allowlist.mjs";
import {
  createPerformanceTimeline,
  finishPerformanceSpan,
  markPerformanceMilestone,
  startPerformanceSpan,
  summarizePerformance,
} from "../src/performance-timeline.mjs";
import { createVerificationTimingTracker } from "../src/verification-timing.mjs";
import { assertRepositoryEvidenceHead, captureRepositoryEvidence } from "../src/repository-evidence.mjs";
import {
  createRepositoryRuntimeJournal,
  shouldCheckpointWorkerFailure,
} from "../src/repository-runtime-journal.mjs";
import { publishRepositoryLifecycleCheckpoint, repositoryJournalPublicationState } from "../src/repository-lifecycle-publication.mjs";
import { createEvidenceStore } from "../src/evidence-store.mjs";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import {
  createRepositoryContextDeltaKernel,
  readRepositoryContextBaseline,
} from "../src/repository-context-delta.mjs";
import {
  composeRepositoryContextTurnPrompt,
  redactSecretsAndInjectionFromText,
} from "../src/context-capsule.mjs";
import { createRepositorySnapshotCache, repositorySnapshotCacheDirectory } from "../src/repository-snapshot-cache.mjs";
import { CLAIMED_ISSUE_CONTEXT_MARKER, assertClaimedIssueContextIntegrity } from "../src/claimed-issue-context.mjs";
import { assertObservedVerificationEvidence, persistObservedVerificationResults } from "../src/verification-receipts.mjs";
import {
  classifyProviderFailure,
  providerExhaustionError,
  providerFailureRecord,
  providerFailuresSummary,
  shouldRecoverProviderExhaustion,
} from "../src/provider-failover.mjs";

const runtimeRoot = realpathSync(
  process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);
const workspaceRoot = realpathSync(
  process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || runtimeRoot,
);
const id = process.argv[2];
if (!id) throw new Error("A collaboration ID is required.");
const EVIDENCE_ROOT = resolve(collaborationDirectory(workspaceRoot), "evidence");

let releaseWorker = null;
let releaseWorkspace = null;
let pool = null;
let state = null;
let claimClient = null;
let claimJournal = null;
let workerHeadSha = null;
let repositoryContextKernel = null;
let repositoryContextBinding = null;

async function checkpointClaim({ phase, summary, writer, previousWriter = null, kind = "refresh", terminal = false } = {}) {
  if (!claimClient || !claimJournal || !state?.issueClaim) return { queued: false, publication: [] };
  const metadata = claimWorkspaceMetadata(state);
  workerHeadSha = metadata.headSha;
  const queued = await claimJournal.enqueue({
    kind,
    collaborationId: id,
    phase,
    summary,
    writer: writer || state.writer || null,
    previousWriter,
    headSha: metadata.headSha,
    branch: metadata.branch,
    terminal,
  });
  const publication = await claimJournal.publishPending({
    workerId: `${id}:${process.pid}`,
    async publish(checkpoint, entry) {
      const currentMetadata = claimWorkspaceMetadata(state);
      const { refreshClaimLease, releaseClaimLease } = await import("../src/github-issue-claims.mjs");
      return publishRepositoryLifecycleCheckpoint({
        checkpoint,
        entry,
        currentMetadata,
        client: claimClient,
        workspaceRoot,
        refreshClaimLease,
        releaseClaimLease,
      });
    },
  });
  const inspection = await claimJournal.inspect();
  const publicationState = repositoryJournalPublicationState(inspection);
  await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    repositoryJournal: {
      version: 1,
      lastCheckpointAt: new Date().toISOString(),
      lastCheckpointPhase: phase,
      ...publicationState,
      acknowledgedPublications: inspection.acknowledged.length,
    },
  }));
  const terminalFailure = publication.find((result) => result.status === "dead_letter");
  if (terminalFailure) {
    const error = new Error(`Repository lifecycle publication was rejected: ${terminalFailure.error}`);
    error.code = "REPOSITORY_LIFECYCLE_PUBLICATION_REJECTED";
    throw error;
  }
  if (terminal && publicationState.deadLetterPublications === 0) {
    await claimJournal.retain({ maxRecords: 500 });
  }
  return { queued: !queued.idempotent, publication };
}

async function recordTiming(event) {
  const at = event.at || new Date().toISOString();
  try {
    return await updateCollaboration(workspaceRoot, id, (current) => {
      let performance = current.performance || createPerformanceTimeline(current.createdAt || at);
      if (event.action === "start") {
        performance = startPerformanceSpan(performance, event.name, {
          at, key: event.key, category: event.category || "active", metadata: event.metadata || {},
        });
      } else if (event.action === "finish") {
        performance = finishPerformanceSpan(performance, event.name, {
          at, key: event.key, metadata: event.metadata || {},
        });
      } else if (event.action === "milestone") {
        performance = markPerformanceMilestone(performance, event.name, { at, metadata: event.metadata || {} });
      }
      return { ...current, performance, performanceSummary: summarizePerformance(performance) };
    });
  } catch {
    return null;
  }
}

function gitValue(workspace, args, label) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to resolve ${label} in ${workspace}.`);
  return result.stdout.trim();
}

function claimWorkspaceMetadata(state) {
  return {
    headSha: gitValue(state.workspace, ["rev-parse", "HEAD"], "claim HEAD"),
    branch: gitValue(state.workspace, ["branch", "--show-current"], "claim branch") || state.issueClaim?.branch || null,
    worktree: state.workspace,
  };
}

async function scheduleProviderRecovery(error) {
  const current = await readCollaboration(workspaceRoot, id);
  const unavailableAgents = current.runtime?.unavailableAgents || {};
  if (!shouldRecoverProviderExhaustion(error, unavailableAgents)) {
    return false;
  }
  const policy = current.providerRecovery || { enabled: true, maxAttempts: 3, backoffSeconds: [15, 60, 180] };
  const attempts = current.providerRecoveryState?.attempts || 0;
  if (!policy.enabled || attempts >= policy.maxAttempts) {
    await updateCollaboration(workspaceRoot, id, (state) => ({
      ...state,
      providerRecoveryState: {
        ...(state.providerRecoveryState || {}),
        attempts,
        status: "exhausted",
        exhaustedAt: new Date().toISOString(),
        lastError: error.message,
      },
      providerFailoverState: {
        ...(state.providerFailoverState || {}),
        status: "exhausted",
      },
    }));
    return false;
  }
  const delaySeconds = policy.backoffSeconds[Math.min(attempts, policy.backoffSeconds.length - 1)];
  const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  await updateCollaboration(workspaceRoot, id, (state) => ({
    ...state,
    status: "recovering",
    error: error.message,
    workerPid: null,
    workerOwner: null,
    providerRecoveryState: {
      attempts: attempts + 1,
      status: "waiting",
      lastError: error.message,
      scheduledAt: new Date().toISOString(),
      nextRetryAt,
    },
    providerFailoverState: {
      ...(state.providerFailoverState || {}),
      status: "recovering",
    },
    runtime: {
      ...state.runtime,
      activeCall: {
        agent: null,
        mode: state.mode,
        status: "recovering",
        phase: "provider_recovery",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        summary: `All eligible providers are unavailable. Recovery attempt ${attempts + 1}/${policy.maxAttempts} is scheduled for ${nextRetryAt}.`,
        summaryAt: new Date().toISOString(),
        summarySource: "broker",
      },
    },
  }));
  await appendEvent(workspaceRoot, id, {
    type: "provider_recovery_scheduled",
    at: new Date().toISOString(),
    attempt: attempts + 1,
    maxAttempts: policy.maxAttempts,
    delaySeconds,
    nextRetryAt,
    error: error.message,
  });
  const supervisor = spawn(process.execPath, [
    resolve(runtimeRoot, "scripts/collaboration-recovery.mjs"),
    id,
    String(delaySeconds),
  ], {
    cwd: runtimeRoot,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot, BRIDGE_WORKSPACE_ROOT: workspaceRoot },
    detached: true,
    stdio: "ignore",
  });
  supervisor.unref();
  return true;
}

try {
  releaseWorker = await acquireWorkerLock(workspaceRoot, id);
  state = await readCollaboration(workspaceRoot, id);
  const storedClaimedTask = state.taskBase || state.task;
  if (state.issueContext || state.issueTarget || state.issueClaim
    || String(storedClaimedTask || "").includes(CLAIMED_ISSUE_CONTEXT_MARKER)) {
    // Supervisors and delayed recovery can launch this executable without
    // passing through continue_collaboration. Revalidate the stored immutable
    // issue snapshot here, before credentials, claim refresh, or provider
    // dispatch, so every worker entry path fails closed on corruption.
    assertClaimedIssueContextIntegrity({
      task: storedClaimedTask,
      metadata: state.issueContext,
    });
  }
  if (state.cancelRequested) {
    await updateCollaboration(workspaceRoot, id, (current) => ({ ...current, status: "cancelled", workerPid: null }));
    process.exit(0);
  }

  if (state.issueClaim) {
    const repository = state.issueClaim.repository;
    const expectedLogin = state.issueClaim.expectedLogin;
    const credential = await createInstallationToken({ role: "builder", repository });

    workerHeadSha = claimWorkspaceMetadata(state).headSha;

    claimClient = createIssueClaimClient({
      apiUrl: state.issueClaim.apiUrl || "https://api.github.com",
      credential,
      repository,
      expectedLogin,
      headSha: workerHeadSha,
      issueNumber: state.issueClaim.issueNumber,
      workspace: state.workspace,
      fetchImpl: fetch,
    });
    claimJournal = createRepositoryRuntimeJournal({
      workspace: state.workspace,
      repository,
      issueNumber: state.issueClaim.issueNumber,
      pullRequestNumber: state.githubBuilder?.prNumber || state.githubReview?.prNumber || null,
      collaborationId: id,
    });
    repositoryContextBinding = {
      repository,
      collaborationId: id,
      laneId: `issue-${state.issueClaim.issueNumber}`,
    };
    repositoryContextKernel = createRepositoryContextDeltaKernel({
      journal: claimJournal.journal,
      ...repositoryContextBinding,
      maxEvents: state.repositoryContext?.maxEvents,
      maxBytes: state.repositoryContext?.maxBytes,
    });
    // A newly minted, repository-bound credential is the only automatic
    // authority-restoration signal. Redrive is persistently bounded by the
    // outbox claim count, so a revoked App cannot loop on every checkpoint.
    await claimJournal.redriveAuthorityFailures({ authorityRestored: true });
  }

  state = await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    status: "running",
    workerPid: process.pid,
    workerOwner: {
      ...(current.workerOwner || {}),
      id, pid: process.pid, token: process.env.BRIDGE_WORKER_TOKEN || null,
      supervisorId: process.env.BRIDGE_SUPERVISOR_ID || null,
      startedAt: new Date().toISOString(), command: "collaboration-worker.mjs",
    },
    error: null,
    runStartedAt: current.runStartedAt || new Date().toISOString(),
  }));
  await recordTiming({ action: "finish", name: "queueing", key: `queueing:${state.runSequence || 1}`, at: new Date().toISOString(), metadata: { runSequence: state.runSequence || 1 } });
  await appendEvent(workspaceRoot, id, { type: "run_started", at: new Date().toISOString(), pid: process.pid });

  if (claimClient) {
    const metadata = claimWorkspaceMetadata(state);
    workerHeadSha = metadata.headSha;
    await checkpointClaim({
      phase: "running",
      summary: "Starting provider work.",
      writer: state.writer,
    });
  }

  if (state.mode === "work") releaseWorkspace = await acquireWorkspaceLock(workspaceRoot, state.workspace);

  if (state.githubReview) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: state.workspace, encoding: "utf8" });
    if (head.status !== 0) throw new Error(`Unable to verify review workspace head: ${(head.stderr || head.stdout || "git failed").trim()}`);
    assertReviewWorkspaceHead({
      expectedHeadSha: state.githubReview.headSha,
      observedHeadSha: head.stdout.trim(),
    });
  }

  if (state.evidence?.repository?.headSha) {
    const evidenceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: state.workspace, encoding: "utf8" });
    if (evidenceHead.status !== 0) throw new Error(`Unable to verify repository evidence head: ${(evidenceHead.stderr || evidenceHead.stdout || "git failed").trim()}`);
    assertRepositoryEvidenceHead({
      expectedHeadSha: state.evidence.repository.headSha,
      observedHeadSha: evidenceHead.stdout.trim(),
    });
  }

  pool = createAgentPool({
    root: runtimeRoot,
    workspace: state.workspace,
    models: state.models,
    modelFallbacks: state.modelFallbacks || {},
    allowClaudeFable: state.allowClaudeFable === true,
    verificationCommands: state.verificationCommands || [],
    reusableVerificationCommands: (state.verificationReceipts || []).map((receipt) => receipt.command).filter(Boolean),
    workCommands: state.workCommands || [],
    workProfile: state.workProfile || "exact",
    permissionProfile: state.permissionProfile || "standard",
    handoffPath: state.handoffPath || null,
    githubReview: state.githubReview || null,
    githubBuilder: state.githubBuilder || null,
    turnTimeoutSeconds: state.turnTimeoutSeconds || 600,
    requestTimeoutMs: (state.turnTimeoutSeconds || 600) * 1000 + 5_000,
    // The collaboration worker is the autonomous council/portfolio/take-the-helm
    // execution path: delivery must be fail-closed to a bound githubBuilder.
    autonomous: true,
    writableRoots: state.mode === "work" && state.worktree?.strategy === "self-contained"
      ? [state.worktree.gitMetadataRoot]
      : [],
    onTiming: recordTiming,
  });
  await recordTiming({ action: "start", name: "provider_preflight", key: `provider_preflight:${state.runSequence || 1}`, metadata: { agents: state.agents } });
  const probes = await Promise.all(state.agents.map((agent) => pool.probe(agent)));
  await recordTiming({ action: "finish", name: "provider_preflight", key: `provider_preflight:${state.runSequence || 1}`, metadata: { available: probes.filter((probe) => probe.available).map((probe) => probe.agent) } });
  const reviewOrder = orderReviewProbes({
    probes,
    requestedStartAgent: state.startAgent,
    githubReview: state.mode === "review" ? state.githubReview : null,
  });
  const availableAgents = reviewOrder.agents;
  const unavailableAgents = Object.fromEntries(
    probes.filter((probe) => !probe.available).map((probe) => [probe.agent, probe.reason]),
  );
  for (const probe of probes.filter((candidate) => !candidate.available)) {
    const failure = providerFailureRecord(probe.agent, probe.reason);
    await appendEvent(workspaceRoot, id, {
      type: "agent_unavailable",
      at: new Date().toISOString(),
      agent: probe.agent,
      reason: probe.reason,
      failureClass: failure.failureClass,
      phase: "preflight",
    });
  }
  for (const probe of probes.filter((candidate) => candidate.available && candidate.reviewPublication?.available === false)) {
    await appendEvent(workspaceRoot, id, {
      type: "review_publication_unavailable",
      at: new Date().toISOString(),
      agent: probe.agent,
      reason: probe.reviewPublication.reason,
      fallback: "local_handoff_and_trusted_human_approval",
    });
  }
  const startAgent = reviewOrder.startAgent;
  const requestedAgents = state.requestedAgents?.length ? state.requestedAgents : state.agents;
  const requestedAvailableAgents = requestedAgents.filter((agent) => availableAgents.includes(agent));
  const previousWriter = state.writer;
  const writer = state.mode === "work" && availableAgents.length
    ? (availableAgents.includes(state.writer)
      ? state.writer
      : availableAgents.find((agent) => WRITER_AGENTS.includes(agent)) || null)
    : null;
  const conversationAgents = state.mode === "work" && state.issueClaim && state.providerFailover?.enabled !== false
    ? [...new Set([...requestedAvailableAgents, ...(writer ? [writer] : [])])]
    : availableAgents;
  const standbyAgents = state.mode === "work"
    ? availableAgents.filter((agent) => !conversationAgents.includes(agent) && WRITER_AGENTS.includes(agent))
    : [];
  const preflightFailover = state.mode === "work" && previousWriter && writer && previousWriter !== writer
    ? {
      from: previousWriter,
      to: writer,
      failureClass: classifyProviderFailure(unavailableAgents[previousWriter]),
      reason: unavailableAgents[previousWriter] || "Provider failed preflight.",
      phase: "preflight",
      at: new Date().toISOString(),
    }
    : null;
  const conversationStartAgent = state.mode === "work" && !conversationAgents.includes(state.startAgent)
    ? writer
    : (conversationAgents.includes(startAgent) ? startAgent : conversationAgents[0]);
  state = await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    writer,
    issueClaim: current.issueClaim ? { ...current.issueClaim, writer: writer || current.issueClaim.writer } : current.issueClaim,
    semanticLifecycle: recordLifecycleAssignment(current.semanticLifecycle || {}, {
      writer,
      at: preflightFailover?.at,
      reason: preflightFailover ? "provider_failover" : "assigned",
    }),
    providerFailoverState: preflightFailover
      ? {
        status: "transferred",
        transitions: [...(current.providerFailoverState?.transitions || []), preflightFailover].slice(-20),
        lastTransition: preflightFailover,
      }
      : !availableAgents.length || (state.mode === "work" && !writer)
        ? { ...(current.providerFailoverState || {}), status: "exhausted" }
        : current.providerFailoverState,
    reviewPublication: reviewOrder.publication,
    runtime: {
      ...current.runtime,
      nextAgent: conversationAgents.includes(current.runtime?.nextAgent)
        ? current.runtime.nextAgent
        : conversationStartAgent,
      availableAgents: conversationAgents,
      standbyAgents,
      unavailableAgents,
      writer,
    },
  }));
  if (preflightFailover) {
    await appendEvent(workspaceRoot, id, { type: "provider_failover", ...preflightFailover });
    if (claimClient) {
      await checkpointClaim({
        phase: "running",
        writer,
        previousWriter,
        summary: `${previousWriter} failed preflight; writer transferred to ${writer}.`,
      });
    }
  }
  if (!availableAgents.length) {
    throw providerExhaustionError(providerFailuresSummary(unavailableAgents));
  }
  if (state.mode === "work" && !writer) {
    throw providerExhaustionError(providerFailuresSummary(unavailableAgents, {
      prefix: "No write-capable provider is currently available",
    }));
  }
  const outcome = await runConversation({
    task: state.task,
    maxTurns: state.run.maxTurns,
    agents: conversationAgents,
    standbyAgents,
    startAgent: conversationStartAgent,
    mode: state.mode,
    browser: state.browser,
    writer,
    initialState: state.runtime,
    workspace: workspaceRoot,
    collaborationId: id,
    preparePrompt: repositoryContextKernel
      ? async ({ fullPrompt, compactPrompt, firstExposure, cursor }) => {
        const baseline = await readRepositoryContextBaseline({
          journal: claimJournal.journal,
          ...repositoryContextBinding,
        });
        const delta = firstExposure || !cursor
          ? null
          : await repositoryContextKernel.read({ cursor });
        return composeRepositoryContextTurnPrompt({
          fullPrompt,
          compactPrompt,
          firstExposure,
          binding: repositoryContextBinding,
          priorCursor: cursor,
          baseline,
          delta,
          maxBytes: state.repositoryContext?.maxPromptBytes,
        });
      }
      : null,
    onPromptPrepared: async ({ agent, turn, prepared, state: runtimeState }) => {
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          repositoryContextCursors: runtimeState.repositoryContextCursors,
          contextResyncReceipts: runtimeState.contextResyncReceipts,
          promptMetrics: runtimeState.promptMetrics,
        },
      }));
      await appendEvent(workspaceRoot, id, {
        type: "repository_context_prompt_prepared",
        at: new Date().toISOString(),
        agent,
        turn,
        promptKind: prepared.kind,
        promptBytes: prepared.promptBytes,
        avoidedBytes: prepared.avoidedBytes,
        eventCount: prepared.eventCount,
        cursorAfterSequence: prepared.cursor?.afterSequence ?? null,
        resyncReason: prepared.receipt?.reason || null,
        truncated: prepared.truncated === true,
      });
    },
    send: async (call) => {
      const startedAt = new Date().toISOString();
      const capacityRole = call.mode === "work" ? "work" : "review";
      const capacityLimits = state.providerConcurrency || await loadProviderConcurrency();
      let lastCapacityWaitSignature = null;
      let capacityQueued = false;
      const capacityTimingKey = `capacity_queue:${call.agent}:${startedAt}`;
      let capacityLease;
      try {
        // Issue #55: before acquiring capacity, reject a verification command that would
        // re-enter this same live provider-capacity pool — it would deadlock on the slot
        // this call is about to hold. Fail fast; register no waiter.
        assertNoProviderPoolReentry({
          provider: call.agent,
          role: capacityRole,
          collaborationId: id,
          limit: capacityLimits?.[call.agent]?.[capacityRole],
          verificationCommands: state.verificationCommands || [],
        });
        capacityLease = await acquireProviderCapacity(workspaceRoot, {
          provider: call.agent,
          role: capacityRole,
          collaborationId: id,
          limits: capacityLimits,
          onWait: async ({ limit, inUse, position }) => {
            const now = new Date().toISOString();
            if (!capacityQueued) {
              capacityQueued = true;
              await recordTiming({ action: "start", name: "capacity_queue", key: capacityTimingKey, at: now, metadata: { agent: call.agent, role: capacityRole } });
            }
            // Issue #55: put the explicit capacity-wait reason into the live narrative.
            const wait = capacityWaitNarrative({ agent: call.agent, role: capacityRole, limit, inUse, position });
            await updateCollaboration(workspaceRoot, id, (current) => ({
              ...current,
              runtime: {
                ...current.runtime,
                activeCall: {
                  agent: call.agent,
                  mode: call.mode,
                  status: "queued",
                  phase: "waiting_capacity",
                  startedAt,
                  heartbeatAt: now,
                  summary: wait.summary,
                  summaryAt: now,
                  summarySource: "broker",
                  waitReason: wait.reason,
                  capacity: wait.capacity,
                },
              },
            }));
            const signature = `${limit}:${inUse}:${position}`;
            if (signature !== lastCapacityWaitSignature) {
              lastCapacityWaitSignature = signature;
              await appendEvent(workspaceRoot, id, {
                type: "provider_capacity_wait",
                at: now,
                agent: call.agent,
                role: capacityRole,
                limit,
                inUse,
                position,
                reason: wait.reason,
              });
            }
          },
        });
        if (capacityQueued) {
          await recordTiming({ action: "finish", name: "capacity_queue", key: capacityTimingKey, metadata: { agent: call.agent, role: capacityRole } });
        }
      } catch (error) {
        await updateCollaboration(workspaceRoot, id, (current) => ({
          ...current,
          runtime: { ...current.runtime, activeCall: null },
        })).catch(() => {});
        // Issue #55: a self-deadlock is a distinct, typed terminal signal — no waiter
        // was registered, so surface it explicitly rather than as a generic failure.
        await appendEvent(workspaceRoot, id, {
          type: error?.selfDeadlock ? "provider_self_deadlock" : "provider_capacity_failed",
          at: new Date().toISOString(),
          agent: call.agent,
          role: capacityRole,
          code: error?.code || null,
          error: error.message,
        }).catch(() => {});
        throw error;
      }
      let lastSummary = `Waiting for ${call.agent}'s first progress update.`;
      let summaryAt = null;
      let summarySource = "broker";
      let livenessMessage = null;
      let progressEventCount = 0;
      let observedOutputBytes = 0;
      let lastOutputAt = null;
      let lastProgressAt = null;
      const permissionDecision = providerPermissionDecisionForRequest({
        provider: call.agent,
        mode: call.mode,
        verificationCommands: state.verificationCommands || [],
        permissionProfile: state.permissionProfile || "standard",
      });
      const activePermissionProfile = permissionDecision.permissionProfile;
      const permissionReason = permissionDecision.permissionReason;
      const writeActiveCall = async (patch = {}) => {
        await updateCollaboration(workspaceRoot, id, (current) => ({
          ...current,
          runtime: {
            ...current.runtime,
            activeCall: {
              agent: call.agent,
              mode: call.mode,
              status: "running",
              phase: "working",
              startedAt,
              heartbeatAt: new Date().toISOString(),
              summary: lastSummary,
              summaryAt,
              summarySource,
              livenessMessage,
              activity: {
                progressEventCount,
                outputBytes: observedOutputBytes,
                lastOutputAt,
                lastProgressAt,
              },
              permissionProfile: activePermissionProfile,
              permissionReason,
              capacity: {
                role: capacityRole,
                limit: capacityLease.limit,
                slot: capacityLease.slot,
              },
              ...patch,
            },
          },
        }));
      };
      let heartbeat = null;
      const providerTimingKey = `provider_turn:${call.agent}:${startedAt}`;
      const firstProgressTimingKey = `first_progress:${call.agent}:${startedAt}`;
      let firstProgressObserved = false;
      const verificationTiming = createVerificationTimingTracker({
        onStart: ({ command, key, at, metadata }) => recordTiming({
          action: "start",
          name: "tests",
          key: `${key}:${call.agent}:${startedAt}`,
          at,
          metadata: { agent: call.agent, command, ...metadata },
        }),
        onFinish: ({ command, key, at, metadata }) => recordTiming({
          action: "finish",
          name: "tests",
          key: `${key}:${call.agent}:${startedAt}`,
          at,
          metadata: { agent: call.agent, command, ...metadata },
        }),
      });
      try {
        await recordTiming({ action: "start", name: "provider_turn", key: providerTimingKey, at: startedAt, metadata: { agent: call.agent, mode: call.mode } });
        await recordTiming({ action: "start", name: "first_progress", key: firstProgressTimingKey, at: startedAt, metadata: { agent: call.agent } });
        await writeActiveCall();
        await appendEvent(workspaceRoot, id, {
          type: "agent_started",
          at: startedAt,
          agent: call.agent,
          mode: call.mode,
          permissionProfile: activePermissionProfile,
          permissionReason,
          summary: lastSummary,
          capacity: {
            role: capacityRole,
            limit: capacityLease.limit,
            slot: capacityLease.slot,
          },
        });
        heartbeat = setInterval(() => {
          writeActiveCall().catch(() => {});
        }, 5_000);
        heartbeat.unref?.();
        let activeCommand = null;
        const response = await pool.send(call, async (progress) => {
          const incoming = progress.summary?.trim().slice(0, 500);
          if (incoming) {
            progressEventCount += 1;
            observedOutputBytes += Buffer.byteLength(incoming, "utf8");
            lastProgressAt = progress.at || new Date().toISOString();
          }
          if (incoming && isTransportLivenessSummary(incoming)) livenessMessage = incoming;
          else if (incoming) {
            lastOutputAt = progress.at || new Date().toISOString();
            if (!firstProgressObserved) {
              firstProgressObserved = true;
              await recordTiming({ action: "finish", name: "first_progress", key: firstProgressTimingKey, at: progress.at, metadata: { agent: call.agent } });
            }
            // Issue #55: name the active verification command in the live narrative.
            activeCommand = activeVerificationCommand(incoming, state.verificationCommands || []);
            const commandFinished = activeCommand && /\b(?:finished|completed)\b/i.test(incoming);
            await verificationTiming.observe({
              command: activeCommand,
              finished: commandFinished,
              at: progress.at,
              metadata: commandFinished ? { completionInferred: call.agent !== "claude" } : {},
            });
            const narrative = verificationNarrative({
              agent: call.agent,
              providerSummary: incoming,
              command: activeCommand,
            });
            lastSummary = narrative.summary;
            summaryAt = progress.at || new Date().toISOString();
            summarySource = "provider_or_adapter";
          }
          await writeActiveCall({
            phase: "provider_progress",
            progress: progress.progress,
            total: progress.total,
            summary: lastSummary,
            summaryAt,
            summarySource,
            livenessMessage,
            verificationCommand: activeCommand,
            activity: {
              progressEventCount,
              outputBytes: observedOutputBytes,
              lastOutputAt,
              lastProgressAt,
            },
          });
          if (incoming) {
            await appendEvent(workspaceRoot, id, {
              type: "agent_progress",
              at: progress.at,
              agent: call.agent,
              summary: lastSummary,
              livenessMessage,
              progress: progress.progress,
              total: progress.total,
            });
          }
        });
        if (heartbeat) clearInterval(heartbeat);
        const completedAt = new Date().toISOString();
        if (!firstProgressObserved) {
          await recordTiming({ action: "finish", name: "first_progress", key: firstProgressTimingKey, at: completedAt, metadata: { agent: call.agent, noProgress: true } });
        }
        await verificationTiming.finishAll({ at: completedAt, metadata: { completionInferred: true } });
        const measured = response.metadata?.timing;
        for (const [name, durationMs] of [["inference", measured?.inferenceMs], ["tools", measured?.toolMs]]) {
          if (!Number.isFinite(durationMs) || durationMs < 0) continue;
          const key = `${name}:${call.agent}:${startedAt}`;
          const measuredStart = new Date(Math.max(Date.parse(startedAt), Date.parse(completedAt) - durationMs)).toISOString();
          await recordTiming({ action: "start", name, key, at: measuredStart, metadata: { agent: call.agent, measured: true } });
          await recordTiming({ action: "finish", name, key, at: completedAt, metadata: { agent: call.agent, calls: name === "tools" ? measured.toolCalls : measured.apiCalls } });
        }
        await recordTiming({ action: "finish", name: "provider_turn", key: providerTimingKey, at: completedAt, metadata: { agent: call.agent, timing: response.metadata?.timing || null } });
        await recordTiming({ action: "milestone", name: "provider_completed", at: completedAt, metadata: { agent: call.agent } });
        const verificationResults = response.metadata?.verificationResults || [];
        if (verificationResults.length && call.mode === "review") {
          try {
            const current = await readCollaboration(workspaceRoot, id);
            const previousEvidence = current.evidence?.repository;
            const store = createEvidenceStore({ directory: EVIDENCE_ROOT });
            const snapshotCache = createRepositorySnapshotCache({
              journal: createRepositoryJournal({ directory: repositorySnapshotCacheDirectory(current.workspace) }),
            });
            const repositoryEvidence = await captureRepositoryEvidence({
              workspace: current.workspace,
              store,
              snapshotCache,
              repository: previousEvidence?.repository,
              headSha: previousEvidence?.headSha,
              baseSha: previousEvidence?.baseSha || null,
            });
            assertObservedVerificationEvidence({ expected: previousEvidence, observed: repositoryEvidence });
            const persisted = await persistObservedVerificationResults({
              store,
              repositoryEvidence,
              results: verificationResults,
              authorizedCommands: current.requestedVerificationCommands || current.verificationCommands || [],
              provider: call.agent,
            });
            if (persisted.recorded.length) {
              await updateCollaboration(workspaceRoot, id, (previous) => ({
                ...previous,
                verificationReceipts: [
                  ...(previous.verificationReceipts || []).filter((receipt) => !persisted.recorded.some((candidate) => candidate.command === receipt.command)),
                  ...persisted.recorded,
                ],
                evidence: {
                  ...(previous.evidence || {}),
                  repository: repositoryEvidence,
                  cacheMetrics: {
                    ...store.metrics(),
                    snapshots: snapshotCache.metrics(),
                  },
                },
              }));
              for (const receipt of persisted.recorded) {
                await appendEvent(workspaceRoot, id, {
                  type: "verification_receipt_recorded",
                  at: new Date().toISOString(),
                  receipt,
                });
              }
            }
            for (const skipped of persisted.skipped) {
              await appendEvent(workspaceRoot, id, {
                type: "verification_receipt_skipped",
                at: new Date().toISOString(),
                agent: call.agent,
                ...skipped,
              });
            }
          } catch (error) {
            await appendEvent(workspaceRoot, id, {
              type: "verification_receipt_skipped",
              at: new Date().toISOString(),
              agent: call.agent,
              reason: error.code === "VERIFICATION_HEAD_CHANGED"
                ? "head_changed_during_verification"
                : error.code === "VERIFICATION_ENVIRONMENT_CHANGED"
                  ? "environment_changed_during_verification"
                  : error.code === "MISSING_EXPECTED_EVIDENCE"
                    ? "missing_baseline_evidence"
                    : "evidence_capture_failed",
              error: error.message,
            }).catch(() => {});
          }
        } else if (verificationResults.length) {
          await appendEvent(workspaceRoot, id, {
            type: "verification_receipt_skipped",
            at: new Date().toISOString(),
            agent: call.agent,
            reason: "mutable_work_mode",
          });
        }
        // Delivery repair is a distinct, visible lifecycle event: the provider
        // kept custody and its commit, and only the builder envelope was
        // corrected inside the same conversation.
        if (response.metadata?.deliveryRepair?.attempted) {
          const repair = response.metadata.deliveryRepair;
          await recordTiming({
            action: "milestone",
            name: "delivery_repair",
            at: completedAt,
            metadata: { agent: call.agent, attempts: repair.attempts.length, outcome: repair.outcome },
          });
          await appendEvent(workspaceRoot, id, {
            type: "delivery_repair",
            at: completedAt,
            agent: call.agent,
            outcome: repair.outcome,
            repaired: repair.repaired === true,
            attempts: repair.attempts,
            summary: deliveryRepairSummary(call.agent, repair),
          });
        }
        if (response.metadata?.reviewPublication?.published) {
          await recordTiming({
            action: "milestone",
            name: "formal_review_published",
            at: completedAt,
            metadata: { agent: call.agent, authorizing: response.metadata.reviewPublication.authorizing !== false },
          });
        }
        await updateCollaboration(workspaceRoot, id, (current) => ({
          ...current,
          runtime: { ...current.runtime, activeCall: null },
        }));
        await appendEvent(workspaceRoot, id, {
          type: "agent_completed",
          at: new Date().toISOString(),
          agent: call.agent,
        });
        await capacityLease.release();
        return response;
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        const failedAt = new Date().toISOString();
        await verificationTiming.finishAll({ at: failedAt, metadata: { failed: true } }).catch(() => {});
        await recordTiming({ action: "finish", name: "first_progress", key: firstProgressTimingKey, at: failedAt, metadata: { agent: call.agent, failed: true } }).catch(() => {});
        await recordTiming({ action: "finish", name: "provider_turn", key: providerTimingKey, at: failedAt, metadata: { agent: call.agent, failed: true } }).catch(() => {});
        if (error?.deliveryRepair?.attempted) {
          await appendEvent(workspaceRoot, id, {
            type: "delivery_repair",
            at: failedAt,
            agent: call.agent,
            outcome: error.deliveryRepair.outcome,
            repaired: false,
            attempts: error.deliveryRepair.attempts,
            summary: deliveryRepairSummary(call.agent, error.deliveryRepair),
          }).catch(() => {});
        }
        if (error?.indeterminate) {
          lastSummary = `Caller lost contact with ${call.agent}; execution state is unknown and ownership is preserved.`;
          await writeActiveCall({ status: "indeterminate", phase: "unknown", summary: lastSummary });
          await appendEvent(workspaceRoot, id, {
            type: "agent_indeterminate",
            at: new Date().toISOString(),
            agent: call.agent,
            summary: lastSummary,
            error: error.message,
          });
        } else {
          await updateCollaboration(workspaceRoot, id, (current) => ({
            ...current,
            runtime: { ...current.runtime, activeCall: null },
          }));
          await capacityLease.release();
        }
        throw error;
      }
    },
    shouldStop: async () => {
      const current = await readCollaboration(workspaceRoot, id);
      if (current.cancelRequested) return "cancelled";
      if (current.decisionEscalation) return "needs_user";
      if (current.budgetExceeded) return "budget";
      if (current.budget?.maxMinutes && current.runStartedAt
        && Date.now() - Date.parse(current.runStartedAt) >= current.budget.maxMinutes * 60_000) return "budget";
      return false;
    },
    onTurn: async (turn) => {
      const recordedAt = new Date().toISOString();
      await appendEvent(workspaceRoot, id, { type: "turn", at: recordedAt, ...turn });
      if (claimJournal) {
        const metadata = claimWorkspaceMetadata(state);
        const safeText = (value) => redactSecretsAndInjectionFromText(String(value || "")).slice(0, 2_000);
        const collaborationContext = {
          collaborationId: id,
          agent: turn.agent,
          turn: turn.number,
          status: turn.status,
          summary: safeText(turn.handoff?.summary || `${turn.agent} completed turn ${turn.number} with status ${turn.status}.`),
          artifacts: (turn.handoff?.artifacts || []).slice(0, 50).map(safeText),
          verification: (turn.handoff?.verification || []).slice(0, 50).map(safeText),
        };
        const contextDigest = createHash("sha256").update(JSON.stringify(collaborationContext)).digest("hex").slice(0, 16);
        await claimJournal.journal.append({
          identity: `collaboration-context:${id}:turn:${turn.number}:${contextDigest}`,
          repository: state.issueClaim.repository,
          issueNumber: state.issueClaim.issueNumber,
          pullRequestNumber: state.githubBuilder?.prNumber || state.githubReview?.prNumber || null,
          headSha: metadata.headSha,
          payload: {
            collaborationContext,
          },
        });
      }
      await updateCollaboration(workspaceRoot, id, (current) => {
        const previousUsage = current.usage?.[turn.agent] || { costUsd: 0, tokens: 0, turns: 0 };
        const observed = turn.metadata?.usage || {};
        const usage = {
          ...current.usage,
          [turn.agent]: {
            costUsd: previousUsage.costUsd + (observed.costUsd || 0),
            tokens: previousUsage.tokens + (observed.tokens || 0),
            turns: previousUsage.turns + 1,
          },
        };
        const decision = usageDecision({ usage, budget: current.budget || {} });
        const ci = current.ciTracking?.prNumber
          ? refreshCi({ workspace: current.workspace, prNumber: current.ciTracking.prNumber })
          : current.ci;
        let decisions = current.decisions || [];
        let decisionEscalation = current.decisionEscalation || null;
        if (turn.decision) {
          try {
            if (turn.decision.invalid) throw new Error(turn.decision.invalid);
            const receipt = createDecisionReceipt({
              ...turn.decision,
              additionalEscalations: current.decisionPolicy?.additionalEscalations || [],
            });
            const recorded = { ...receipt, recordedAt: new Date().toISOString(), sourceAgent: turn.agent, turn: turn.number };
            decisions = [...decisions, recorded];
            if (receipt.action === "needs_user") decisionEscalation = recorded;
          } catch (error) {
            decisionEscalation = {
              action: "needs_user",
              reason: `Invalid decision receipt from ${turn.agent}: ${error.message}`,
              recordedAt,
            };
          }
        }
        let completion = current.completion || null;
        let handoffs = current.handoffs || [];
        const observedWorkspaceHead = turn.metadata?.workspaceHeadSha;
        const adoptWorkspaceHead = current.githubBuilder?.allowWorkspaceHead === true
          && /^[0-9a-f]{40}$/i.test(observedWorkspaceHead || "");
        const githubBuilder = current.githubBuilder
          ? {
            ...current.githubBuilder,
            ...(turn.metadata?.writerBinding || {}),
            ...(adoptWorkspaceHead ? { headSha: observedWorkspaceHead } : {}),
          }
          : null;
        const issueClaim = adoptWorkspaceHead && current.issueClaim
          ? { ...current.issueClaim, headSha: observedWorkspaceHead }
          : current.issueClaim;
        if (turn.handoff) {
          completion = completionAfterHandoff(completion, {
            handoff: turn.handoff,
            agent: turn.agent,
            turn: turn.number,
          });
          handoffs = [...handoffs, completion.lastHandoff];
          // Carry the durable, provider-neutral delivery outcome structurally
          // into completion so coordinator wakes distinguish succeeded / rejected
          // / indeterminate / reconciled remote verification (not free text).
          if (githubBuilder) {
            const receiptPath = githubBuilder.receiptPath
              || resolve(current.workspace, ".bridge", "github-builder-receipts.jsonl");
            const delivery = summarizeDeliveryOutcomes(receiptPath, { headSha: githubBuilder.headSha });
            const handoffDelivery = deliverySummaryForHandoff({
              delivery,
              handoff: turn.handoff,
              agent: turn.agent,
              writer: current.writer,
            });
            if (handoffDelivery) completion = { ...completion, delivery: handoffDelivery };
          }
        }
        const reviewPublication = turn.metadata?.reviewPublication?.published
          ? recordReviewPublicationResult(current.reviewPublication, {
            agent: turn.agent,
            published: true,
            trustRoster: turn.metadata.reviewPublication.trustRoster || null,
          })
          : current.reviewPublication;
        return {
          ...current, usage, budgetExceeded: decision.exceeded, ci, decisions, decisionEscalation,
          completion, handoffs, reviewPublication, githubBuilder, issueClaim,
          writerAuthority: turn.metadata?.writerAuthority || current.writerAuthority || null,
        };
      });
      if (turn.handoff) {
        await recordTiming({
          action: "milestone",
          name: "handoff_completed",
          at: recordedAt,
          metadata: { agent: turn.agent, turn: turn.number, outcome: turn.handoff.outcome },
        });
      }
    },
    onAgentUnavailable: async (failure) => {
      const writerTransferred = failure.previousWriter === failure.agent && failure.writer;
      const failoverTarget = writerTransferred ? failure.writer : failure.nextAgent;
      const failover = writerTransferred && failoverTarget
        ? {
          from: failure.agent,
          to: failoverTarget,
          role: "writer",
          failureClass: failure.failureClass,
          reason: failure.reason,
          phase: "turn",
          at: new Date().toISOString(),
        }
        : null;
      await appendEvent(workspaceRoot, id, {
        type: failover ? "provider_failover" : "agent_unavailable",
        at: failover?.at || new Date().toISOString(),
        phase: "turn",
        ...failure,
        ...(failover || {}),
      });
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        writer: failure.writer,
        issueClaim: current.issueClaim && failure.writer
          ? { ...current.issueClaim, writer: failure.writer }
          : current.issueClaim,
        semanticLifecycle: recordLifecycleAssignment(current.semanticLifecycle || {}, {
          writer: failure.writer,
          at: failover?.at,
          reason: failover ? "provider_failover" : "assigned",
        }),
        providerFailoverState: failover
          ? {
            status: "transferred",
            transitions: [...(current.providerFailoverState?.transitions || []), failover].slice(-20),
            lastTransition: failover,
          }
          : failure.rosterExhausted || failure.writerExhausted
            ? { ...(current.providerFailoverState || {}), status: "exhausted" }
            : current.providerFailoverState,
        reviewPublication: recordReviewPublicationResult(current.reviewPublication, {
          agent: failure.agent,
          unavailableReason: failure.reason,
        }),
        runtime: {
          ...current.runtime,
          activeCall: failover
            ? {
              agent: failoverTarget,
              mode: current.mode,
              status: "failing_over",
              phase: "provider_failover",
              startedAt: failover.at,
              heartbeatAt: failover.at,
              summary: `${failure.agent} failed (${failure.failureClass}); ${writerTransferred ? "transferring writer" : "advancing the turn"} to ${failoverTarget}.`,
              summaryAt: failover.at,
              summarySource: "broker",
            }
            : current.runtime?.activeCall || null,
        },
      }));
      if (claimClient && writerTransferred) {
        const metadata = claimWorkspaceMetadata(state);
        workerHeadSha = metadata.headSha;
        await checkpointClaim({
          phase: "running",
          writer: failure.writer,
          previousWriter: failover.from,
          summary: `${failure.agent} failed (${failure.failureClass}); writer transferred to ${failure.writer}.`,
        });
      }
    },
    onState: async (runtime) => {
      const metadata = claimClient ? claimWorkspaceMetadata(state) : null;
      if (metadata) workerHeadSha = metadata.headSha;
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        writer: runtime.writer,
        issueClaim: current.issueClaim
          ? { ...current.issueClaim, ...(metadata || {}), ...(runtime.writer ? { writer: runtime.writer } : {}) }
          : current.issueClaim,
        runtime: {
          ...runtime,
          activeCall: runtime.activeCall === undefined ? current.runtime?.activeCall || null : runtime.activeCall,
        },
      }));
      if (claimClient) {
        await checkpointClaim({
          phase: runtime.activeCall?.phase || "running",
          summary: runtime.activeCall?.summary || "Provider work is active.",
          writer: runtime.writer,
        });
      }
    },
  });

  const outcomeError = outcome.reason === "failed" ? providerExhaustionError(outcome.error) : null;
  if (!(outcome.reason === "failed" && await scheduleProviderRecovery(outcomeError))) {
    const finalRuntime = outcome.reason === "indeterminate" ? outcome.state : { ...outcome.state, activeCall: null };
    const finalClaimMetadata = claimClient ? claimWorkspaceMetadata(state) : null;
    if (finalClaimMetadata) workerHeadSha = finalClaimMetadata.headSha;
    await updateCollaboration(workspaceRoot, id, (current) => clearTerminalRuntime({
      ...current, runtime: finalRuntime, writer: outcome.state.writer,
      issueClaim: finalClaimMetadata ? { ...current.issueClaim, ...finalClaimMetadata } : current.issueClaim,
      cancelRequested: outcome.reason === "cancelled",
      providerRecoveryState: outcome.reason === "failed"
          ? current.providerRecoveryState
          : { ...(current.providerRecoveryState || {}), status: "recovered" },
      providerFailoverState: outcome.reason !== "failed"
        && ["recovering", "retrying", "exhausted"].includes(current.providerFailoverState?.status)
        ? { ...(current.providerFailoverState || {}), status: "recovered" }
        : current.providerFailoverState,
    }, { status: outcome.reason, error: outcome.error || null }));
    await appendEvent(workspaceRoot, id, {
      type: "run_finished",
      at: new Date().toISOString(),
      reason: outcome.reason,
      turnCount: outcome.state.turnCount,
    });
    if (claimClient) {
      if (outcome.reason === "completed") {
        await checkpointClaim({
          phase: "completed",
          summary: "Provider work completed; the claim remains held through review and merge.",
          writer: outcome.state.writer,
          terminal: true,
        });
      } else if (["cancelled", "obsolete"].includes(outcome.reason)) {
        await checkpointClaim({
          kind: "release",
          phase: outcome.reason,
          summary: `Claim released after ${outcome.reason}.`,
          writer: outcome.state.writer,
          terminal: true,
        });
      } else if (["failed", "indeterminate"].includes(outcome.reason)) {
        await checkpointClaim({
          phase: outcome.reason,
          summary: outcome.error || `Provider work stopped with ${outcome.reason}; the claim remains held.`,
          writer: outcome.state.writer,
          terminal: true,
        });
      }
    }
    await enqueueCoordinatorWake(workspaceRoot, id);
  }
} catch (error) {
  if (!(await scheduleProviderRecovery(error).catch(() => false))) {
    let failure = error;
    if (claimClient && shouldCheckpointWorkerFailure(error)) {
      try {
        const metadata = claimWorkspaceMetadata(state);
        workerHeadSha = metadata.headSha;
        await checkpointClaim({
          phase: error?.indeterminate ? "indeterminate" : "failed",
          summary: error.message,
          writer: state.writer,
          terminal: true,
        });
      } catch (claimErr) {
        failure = new AggregateError(
          [error, claimErr],
          `Provider work failed and the GitHub claim could not be refreshed: ${error.message}; ${claimErr.message}`,
        );
      }
    }
    await updateCollaboration(workspaceRoot, id, (current) => error?.indeterminate
      ? ({ ...current, status: "indeterminate", error: failure.stack || failure.message })
      : clearTerminalRuntime({
        ...current,
        providerRecoveryState: current.providerRecoveryState,
      }, { status: "failed", error: failure.stack || failure.message })).catch(() => {});
    await appendEvent(workspaceRoot, id, {
      type: "run_failed",
      at: new Date().toISOString(),
      error: failure.stack || failure.message,
    }).catch(() => {});

    await enqueueCoordinatorWake(workspaceRoot, id).catch(() => {});
    process.exitCode = 1;
  }
} finally {
  const cleanupTimingKey = `cleanup:${state?.runSequence || 1}:${Date.now()}`;
  await recordTiming({ action: "start", name: "cleanup", key: cleanupTimingKey, metadata: { runSequence: state?.runSequence || 1 } }).catch(() => {});
  await pool?.close().catch(() => {});
  await releaseWorkspace?.().catch(() => {});
  await releaseWorker?.().catch(() => {});
  await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    cleanup: {
      ...(current.cleanup || {}), providerClosed: true, workspaceLeaseReleased: true,
      workerLeaseReleased: true, finishedAt: new Date().toISOString(),
    },
  })).catch(() => {});
  await recordTiming({ action: "finish", name: "cleanup", key: cleanupTimingKey, metadata: { runSequence: state?.runSequence || 1 } }).catch(() => {});
}

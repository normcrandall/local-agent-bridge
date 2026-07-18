#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
import { createAgentPool } from "../src/agent-pool.mjs";
import { summarizeDeliveryOutcomes } from "../src/builder-operation-store.mjs";
import {
  acquireWorkerLock,
  acquireWorkspaceLock,
  appendEvent,
  readCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";
import { runConversation } from "../src/talk-protocol.mjs";
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
import { activeVerificationCommand, capacityWaitNarrative, verificationNarrative } from "../src/collaboration-narrative.mjs";
import { enqueueCoordinatorWake } from "../src/coordinator-wake.mjs";
import { createBoundBuilderClient } from "../src/github-builder-client.mjs";
import { createInstallationToken } from "../src/github-app-auth.mjs";
import { providerPermissionDecisionForRequest } from "../src/verification-allowlist.mjs";

const runtimeRoot = realpathSync(
  process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);
const workspaceRoot = realpathSync(
  process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || runtimeRoot,
);
const id = process.argv[2];
if (!id) throw new Error("A collaboration ID is required.");

let releaseWorker = null;
let releaseWorkspace = null;
let pool = null;
let state = null;
let claimClient = null;
let workerHeadSha = null;

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
  if (!/No requested model is currently available/i.test(error?.message || String(error))) return false;
  const current = await readCollaboration(workspaceRoot, id);
  const unavailableReasons = Object.values(current.runtime?.unavailableAgents || {});
  const transientModelFailure = (reason) => (
    /\boverload(?:ed)?\b|\bover[_ -]?capacity\b|\bat capacity\b|\bno capacity\b|\bhigh demand\b|\bmodel\b[^\n]{0,80}\bunavailable\b|\btemporarily unavailable\b|(?:^|\D)(?:503|529)(?:\D|$)/i
      .test(reason || "")
  );
  if (!unavailableReasons.length || unavailableReasons.some((reason) => !transientModelFailure(reason))) {
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
  if (state.cancelRequested) {
    await updateCollaboration(workspaceRoot, id, (current) => ({ ...current, status: "cancelled", workerPid: null }));
    process.exit(0);
  }

  if (state.issueClaim) {
    const repository = state.issueClaim.repository;
    const expectedLogin = state.issueClaim.expectedLogin;
    const credential = await createInstallationToken({ role: "builder", repository });

    workerHeadSha = claimWorkspaceMetadata(state).headSha;

    claimClient = createBoundBuilderClient({
      apiUrl: state.issueClaim.apiUrl || "https://api.github.com",
      token: credential.token,
      verifiedLogin: credential.verifiedLogin,
      repository,
      expectedLogin,
      headSha: workerHeadSha,
      issueNumber: state.issueClaim.issueNumber,
      allowedOperations: ["get_issue", "add_issue_label", "remove_issue_label", "get_issue_comments", "post_issue_comment", "update_issue_comment", "delete_issue_comment", "list_tag_locks", "acquire_tag_lock", "release_tag_lock"],
      workspace: state.workspace,
      fetchImpl: fetch,
    });
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
  await appendEvent(workspaceRoot, id, { type: "run_started", at: new Date().toISOString(), pid: process.pid });

  if (claimClient) {
    const { refreshClaimLease } = await import("../src/github-issue-claims.mjs");
    const metadata = claimWorkspaceMetadata(state);
    workerHeadSha = metadata.headSha;
    await refreshClaimLease({
      client: claimClient,
      issueNumber: state.issueClaim.issueNumber,
      collaborationId: id,
      phase: "running",
      summary: "Starting provider work.",
      ...metadata,
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

  pool = createAgentPool({
    root: runtimeRoot,
    workspace: state.workspace,
    models: state.models,
    modelFallbacks: state.modelFallbacks || {},
    allowClaudeFable: state.allowClaudeFable === true,
    verificationCommands: state.verificationCommands || [],
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
  });
  const probes = await Promise.all(state.agents.map((agent) => pool.probe(agent)));
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
    await appendEvent(workspaceRoot, id, {
      type: "agent_unavailable",
      at: new Date().toISOString(),
      agent: probe.agent,
      reason: probe.reason,
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
  const writer = state.mode === "work" && availableAgents.length
    ? (availableAgents.includes(state.writer) ? state.writer : availableAgents[0])
    : null;
  state = await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    writer,
    reviewPublication: reviewOrder.publication,
    runtime: {
      ...current.runtime,
      nextAgent: availableAgents.includes(current.runtime?.nextAgent)
        ? current.runtime.nextAgent
        : startAgent,
      availableAgents,
      unavailableAgents,
      writer,
    },
  }));
  if (!availableAgents.length) {
    throw new Error("No requested model is currently available.");
  }
  const outcome = await runConversation({
    task: state.task,
    maxTurns: state.run.maxTurns,
    agents: availableAgents,
    startAgent,
    mode: state.mode,
    browser: state.browser,
    writer,
    initialState: state.runtime,
    workspace: workspaceRoot,
    collaborationId: id,
    send: async (call) => {
      const startedAt = new Date().toISOString();
      const capacityRole = call.mode === "work" ? "work" : "review";
      const capacityLimits = state.providerConcurrency || await loadProviderConcurrency();
      let lastCapacityWaitSignature = null;
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
      try {
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
          if (incoming && isTransportLivenessSummary(incoming)) livenessMessage = incoming;
          else if (incoming) {
            // Issue #55: name the active verification command in the live narrative.
            activeCommand = activeVerificationCommand(incoming, state.verificationCommands || []);
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
      await appendEvent(workspaceRoot, id, { type: "turn", at: new Date().toISOString(), ...turn });
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
            decisionEscalation = { action: "needs_user", reason: `Invalid decision receipt from ${turn.agent}: ${error.message}` };
          }
        }
        let completion = current.completion || null;
        let handoffs = current.handoffs || [];
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
          if (current.githubBuilder) {
            const receiptPath = current.githubBuilder.receiptPath
              || resolve(current.workspace, ".bridge", "github-builder-receipts.jsonl");
            const delivery = summarizeDeliveryOutcomes(receiptPath, { headSha: current.githubBuilder.headSha });
            if (delivery) completion = { ...completion, delivery: { ...delivery, at: new Date().toISOString() } };
          }
        }
        const reviewPublication = turn.metadata?.reviewPublication?.available
          ? recordReviewPublicationResult(current.reviewPublication, { agent: turn.agent, published: true })
          : current.reviewPublication;
        return {
          ...current, usage, budgetExceeded: decision.exceeded, ci, decisions, decisionEscalation,
          completion, handoffs, reviewPublication,
        };
      });
    },
    onAgentUnavailable: async (failure) => {
      await appendEvent(workspaceRoot, id, {
        type: "agent_unavailable",
        at: new Date().toISOString(),
        phase: "turn",
        ...failure,
      });
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        reviewPublication: recordReviewPublicationResult(current.reviewPublication, {
          agent: failure.agent,
          unavailableReason: failure.reason,
        }),
      }));
    },
    onState: async (runtime) => {
      const metadata = claimClient ? claimWorkspaceMetadata(state) : null;
      if (metadata) workerHeadSha = metadata.headSha;
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        issueClaim: metadata ? { ...current.issueClaim, ...metadata } : current.issueClaim,
        runtime: {
          ...runtime,
          activeCall: runtime.activeCall === undefined ? current.runtime?.activeCall || null : runtime.activeCall,
        },
      }));
      if (claimClient) {
        const { refreshClaimLease } = await import("../src/github-issue-claims.mjs");
        await refreshClaimLease({
          client: claimClient,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          phase: runtime.activeCall?.phase || "running",
          summary: runtime.activeCall?.summary || "Provider work is active.",
          ...metadata,
        });
      }
    },
  });

  if (!(outcome.reason === "failed" && await scheduleProviderRecovery(new Error(outcome.error)))) {
    const recoveryExhausted = outcome.reason === "failed"
      && /No requested model is currently available/i.test(outcome.error || "");
    const finalRuntime = outcome.reason === "indeterminate" ? outcome.state : { ...outcome.state, activeCall: null };
    const finalClaimMetadata = claimClient ? claimWorkspaceMetadata(state) : null;
    if (finalClaimMetadata) workerHeadSha = finalClaimMetadata.headSha;
    await updateCollaboration(workspaceRoot, id, (current) => clearTerminalRuntime({
      ...current, runtime: finalRuntime, writer: outcome.state.writer,
      issueClaim: finalClaimMetadata ? { ...current.issueClaim, ...finalClaimMetadata } : current.issueClaim,
      cancelRequested: outcome.reason === "cancelled",
      providerRecoveryState: recoveryExhausted
        ? {
          ...(current.providerRecoveryState || {}),
          status: "exhausted",
          exhaustedAt: new Date().toISOString(),
          lastError: outcome.error,
        }
        : outcome.reason === "failed"
          ? current.providerRecoveryState
          : { ...(current.providerRecoveryState || {}), status: "recovered" },
    }, { status: outcome.reason, error: outcome.error || null }));
    await appendEvent(workspaceRoot, id, {
      type: "run_finished",
      at: new Date().toISOString(),
      reason: outcome.reason,
      turnCount: outcome.state.turnCount,
    });
    if (claimClient) {
      if (outcome.reason === "completed") {
        const { refreshClaimLease } = await import("../src/github-issue-claims.mjs");
        await refreshClaimLease({
          client: claimClient,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          phase: "completed",
          summary: "Provider work completed; the claim remains held through review and merge.",
          ...finalClaimMetadata,
        });
      } else if (["cancelled", "obsolete"].includes(outcome.reason)) {
        const { releaseClaimLease } = await import("../src/github-issue-claims.mjs");
        await releaseClaimLease({
          client: claimClient,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          outcome: outcome.reason,
        });
      } else if (["failed", "indeterminate"].includes(outcome.reason)) {
        const { refreshClaimLease } = await import("../src/github-issue-claims.mjs");
        await refreshClaimLease({
          client: claimClient,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          phase: outcome.reason,
          summary: outcome.error || `Provider work stopped with ${outcome.reason}; the claim remains held.`,
          ...finalClaimMetadata,
        });
      }
    }
    await enqueueCoordinatorWake(workspaceRoot, id);
  }
} catch (error) {
  if (!(await scheduleProviderRecovery(error).catch(() => false))) {
    let failure = error;
    if (claimClient) {
      try {
        const { refreshClaimLease } = await import("../src/github-issue-claims.mjs");
        const metadata = claimWorkspaceMetadata(state);
        workerHeadSha = metadata.headSha;
        await refreshClaimLease({
          client: claimClient,
          issueNumber: state.issueClaim.issueNumber,
          collaborationId: id,
          phase: error?.indeterminate ? "indeterminate" : "failed",
          summary: error.message,
          ...metadata,
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
        providerRecoveryState: /No requested model is currently available/i.test(error.message || "")
          ? {
            ...(current.providerRecoveryState || {}),
            status: "exhausted",
            exhaustedAt: new Date().toISOString(),
            lastError: error.message,
          }
          : current.providerRecoveryState,
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
}

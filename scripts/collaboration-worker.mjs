#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createAgentPool } from "../src/agent-pool.mjs";
import {
  acquireWorkerLock,
  acquireWorkspaceLock,
  appendEvent,
  readCollaboration,
  updateCollaboration,
} from "../src/collaboration-store.mjs";
import { runConversation } from "../src/talk-protocol.mjs";
import { isTransportLivenessSummary, refreshCi, usageDecision } from "../src/operations.mjs";

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

try {
  releaseWorker = await acquireWorkerLock(workspaceRoot, id);
  let state = await readCollaboration(workspaceRoot, id);
  if (state.cancelRequested) {
    await updateCollaboration(workspaceRoot, id, (current) => ({ ...current, status: "cancelled", workerPid: null }));
    process.exit(0);
  }

  state = await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    status: "running",
    workerPid: process.pid,
    error: null,
    runStartedAt: new Date().toISOString(),
  }));
  await appendEvent(workspaceRoot, id, { type: "run_started", at: new Date().toISOString(), pid: process.pid });

  if (state.mode === "work") releaseWorkspace = await acquireWorkspaceLock(workspaceRoot, state.workspace);

  pool = createAgentPool({
    root: runtimeRoot,
    workspace: state.workspace,
    models: state.models,
    verificationCommands: state.verificationCommands || [],
    workCommands: state.workCommands || [],
    workProfile: state.workProfile || "exact",
    permissionProfile: state.permissionProfile || "standard",
    handoffPath: state.handoffPath || null,
    githubReview: state.githubReview || null,
    turnTimeoutSeconds: state.turnTimeoutSeconds || 600,
    requestTimeoutMs: (state.turnTimeoutSeconds || 600) * 1000 + 5_000,
  });
  const probes = await Promise.all(state.agents.map((agent) => pool.probe(agent)));
  const availableAgents = probes.filter((probe) => probe.available).map((probe) => probe.agent);
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
  const startAgent = availableAgents.includes(state.startAgent) ? state.startAgent : availableAgents[0] || null;
  const writer = state.mode === "work" && availableAgents.length
    ? (availableAgents.includes(state.writer) ? state.writer : availableAgents[0])
    : null;
  state = await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    writer,
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
    send: async (call) => {
      const startedAt = new Date().toISOString();
      let lastSummary = `Waiting for ${call.agent}'s first progress update.`;
      let summaryAt = null;
      let summarySource = "broker";
      let livenessMessage = null;
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
              ...patch,
            },
          },
        }));
      };
      await writeActiveCall();
      await appendEvent(workspaceRoot, id, {
        type: "agent_started",
        at: startedAt,
        agent: call.agent,
        mode: call.mode,
        summary: lastSummary,
      });
      const heartbeat = setInterval(() => {
        writeActiveCall().catch(() => {});
      }, 5_000);
      heartbeat.unref?.();
      try {
        const response = await pool.send(call, async (progress) => {
          const incoming = progress.summary?.trim().slice(0, 500);
          if (incoming && isTransportLivenessSummary(incoming)) livenessMessage = incoming;
          else if (incoming) {
            lastSummary = incoming;
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
        clearInterval(heartbeat);
        await updateCollaboration(workspaceRoot, id, (current) => ({
          ...current,
          runtime: { ...current.runtime, activeCall: null },
        }));
        await appendEvent(workspaceRoot, id, {
          type: "agent_completed",
          at: new Date().toISOString(),
          agent: call.agent,
        });
        return response;
      } catch (error) {
        clearInterval(heartbeat);
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
        }
        throw error;
      }
    },
    shouldStop: async () => {
      const current = await readCollaboration(workspaceRoot, id);
      if (current.cancelRequested) return "cancelled";
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
        return { ...current, usage, budgetExceeded: decision.exceeded, ci };
      });
    },
    onAgentUnavailable: async (failure) => {
      await appendEvent(workspaceRoot, id, {
        type: "agent_unavailable",
        at: new Date().toISOString(),
        phase: "turn",
        ...failure,
      });
    },
    onState: async (runtime) => {
      await updateCollaboration(workspaceRoot, id, (current) => ({
        ...current,
        runtime: {
          ...runtime,
          activeCall: runtime.activeCall === undefined ? current.runtime?.activeCall || null : runtime.activeCall,
        },
      }));
    },
  });

  await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    status: outcome.reason,
    runtime: outcome.state,
    writer: outcome.state.writer,
    workerPid: null,
    error: outcome.error || null,
    cancelRequested: outcome.reason === "cancelled",
  }));
  await appendEvent(workspaceRoot, id, {
    type: "run_finished",
    at: new Date().toISOString(),
    reason: outcome.reason,
    turnCount: outcome.state.turnCount,
  });
} catch (error) {
  await updateCollaboration(workspaceRoot, id, (current) => ({
    ...current,
    status: "failed",
    workerPid: null,
    error: error.stack || error.message,
  })).catch(() => {});
  await appendEvent(workspaceRoot, id, {
    type: "run_failed",
    at: new Date().toISOString(),
    error: error.stack || error.message,
  }).catch(() => {});
  process.exitCode = 1;
} finally {
  await pool?.close().catch(() => {});
  await releaseWorkspace?.().catch(() => {});
  await releaseWorker?.().catch(() => {});
}

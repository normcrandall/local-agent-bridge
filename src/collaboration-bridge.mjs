#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";
import {
  appendEvent,
  archiveCollaboration,
  collaborationView,
  createCollaboration,
  listCollaborations,
  pruneTerminalCollaborations,
  readCollaboration,
  updateCollaboration,
  waitForCollaborationChange,
} from "./collaboration-store.mjs";
import { KNOWN_AGENTS, validateAgents } from "./talk-protocol.mjs";
import { createWorktree, isSafeWorkerPid, preflight, selectRoles } from "./operations.mjs";
import { createDecisionReceipt, DECISION_CATEGORIES } from "./decision-policy.mjs";
import { resolveNativeChair } from "./native-chair.mjs";
import { clearTerminalRuntime, legacyWorkerCommandMatches, reconciliationAction, workerCancellationMatches, workerCommandMatches } from "./collaboration-cleanup.mjs";

const RUNTIME_ROOT = realpathSync(process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const WORKER = resolve(RUNTIME_ROOT, "scripts/collaboration-worker.mjs");
const TERMINAL_STATUSES = new Set(["agreed", "needs_user", "turn_limit", "failed", "cancelled", "budget"]);
const STATUS_VALUES = ["queued", "running", "cancelling", "indeterminate", ...TERMINAL_STATUSES];

function blockNestedCollaboration() {
  if (process.env.BRIDGE_DELEGATED_SESSION === "1") {
    throw new Error("Nested collaboration mutation blocked; the active broker owns participant routing.");
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

function startWorker(id) {
  const workerToken = randomUUID();
  const child = spawn(process.execPath, [WORKER, id], {
    cwd: RUNTIME_ROOT,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: RUNTIME_ROOT, BRIDGE_WORKSPACE_ROOT: WORKSPACE_ROOT, BRIDGE_WORKER_TOKEN: workerToken },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, token: workerToken };
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
      `PR review: ${view.githubReview.repository}#${view.githubReview.prNumber}@${view.githubReview.headSha.slice(0, 12)} as ${view.githubReview.expectedLogin}`,
    );
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
  if (lastTurn) {
    const excerpt = lastTurn.message.length > 4_000
      ? `${lastTurn.message.slice(0, 4_000)}\n[turn excerpt truncated]`
      : lastTurn.message;
    lines.push(`Latest turn (${lastTurn.agent}, ${lastTurn.status}):\n${excerpt}`);
  }
  if (view.error) lines.push(`Error: ${view.error}`);
  if (["queued", "running", "cancelling"].includes(view.status)) {
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
    if (!["queued", "running", "cancelling"].includes(state.status)) continue;
    const ageMs = Date.now() - Date.parse(state.updatedAt || state.createdAt);
    if (!state.workerPid && ageMs < 30_000) continue;
    const alive = processAlive(state.workerPid);
    if (alive && !state.workerOwner && legacyWorkerCommandMatches(state)) continue;
    const ownershipMatches = workerCommandMatches(state);
    const action = reconciliationAction(state, { processAlive: alive, commandMatches: ownershipMatches });
    if (action === "mark-indeterminate" || action === "retain-indeterminate-owner-mismatch") {
      await updateCollaboration(WORKSPACE_ROOT, state.id, (current) => ({
        ...current, status: "indeterminate",
        error: !alive ? "Broker restart found no owned worker process." : "Worker PID exists but ownership command did not match; no process was terminated.",
        runtime: {
          ...(current.runtime || {}),
          activeCall: current.runtime?.activeCall ? { ...current.runtime.activeCall, status: "indeterminate", phase: "unknown" } : null,
        },
      }));
      await appendEvent(WORKSPACE_ROOT, state.id, { type: "cleanup_reconciled", at: new Date().toISOString(), action });
    }
  }
}

function compactStatusView(view) {
  const {
    task: _task,
    models: _models,
    modelFallbacks: _modelFallbacks,
    verificationCommands: _verificationCommands,
    workCommands: _workCommands,
    preflight: _preflight,
    capabilities: _capabilities,
    ...status
  } = view;
  return status;
}

const collaborationId = z.string().regex(/^bridge-[0-9a-f-]{36}$/).describe(
  "Portable collaboration ID returned by start_collaboration.",
);
const modelsSchema = z.object({
  claude: z.string().min(1).optional(),
  codex: z.string().min(1).optional(),
  antigravity: z.string().min(1).optional(),
}).optional().describe(
  "Optional exact model overrides. Omit a provider to use that provider's configured model.",
);
const modelFallbacksSchema = z.object({
  claude: z.array(z.string().trim().min(1)).max(5).optional(),
  codex: z.array(z.string().trim().min(1)).max(5).optional(),
}).strict().optional().describe(
  "Ordered provider models to try after an overload response. Claude uses its native fallback flag; Codex retries through the bridge. Omit to use the machine-local config; pass a provider's [] to disable it for this collaboration.",
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
  expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
}).strict().optional().describe(
  "Explicitly authorize the delegated Claude or Codex reviewer to write its handoff and submit one formal review to this exact PR head with the dedicated bot identity. Requires handoffPath.",
);
const githubBuilderSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.number().int().min(1).optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  headRef: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  allowedOperations: z.array(z.enum(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge"])).min(1).max(6)
    .default(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready"]),
}).strict().optional().describe(
  "Authorize only target-bound builder GitHub operations for one repository and head SHA. Available only to the work-mode writer.",
);
const budgetSchema = z.object({
  maxCostUsd: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxMinutes: z.number().positive().optional(),
}).strict().optional().describe("Optional collaboration budget. The broker stops after the current turn when a known limit is reached.");
const ciTrackingSchema = z.object({
  prNumber: z.number().int().positive(),
}).strict().optional().describe("Refresh GitHub PR checks after each completed turn.");
const worktreeSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  base: z.string().min(1).default("HEAD"),
  root: z.string().optional(),
}).strict().optional().describe("Explicitly create and pin this work collaboration to an isolated Git worktree.");
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

const server = new McpServer(
  { name: "desktop-agent-collaboration", version: "0.2.0" },
  {
    instructions:
      "Use start_collaboration for an asynchronous durable job with one provider or a bounded roundtable with multiple providers. It returns immediately with a portable collaborationId. Unavailable providers are skipped and the run continues with any remaining participant. Pass verificationCommands and handoffPath for independently verified reviews. Choose workProfile implement for local ownership through commit or deliver when the writer also owns push and PR delivery; use workCommands only for unusual additions. When repository policy requires reviewer-authored PR feedback, pass githubReview so the delegated Claude or Codex reviewer receives target-bound handoff and formal-review tools. Use modelFallbacks.claude or modelFallbacks.codex for ordered overload-only downgrade chains. Use get_collaboration to poll or inspect it, continue_collaboration for another phase, and cancel_collaboration to stop. Omit model overrides to preserve configured models. The broker owns routing; never ask a peer to call another peer.",
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
      agents: z.array(z.enum(KNOWN_AGENTS)).min(1).max(3).default(KNOWN_AGENTS),
      startAgent: z.enum(KNOWN_AGENTS).optional().describe("Defaults to the first item in agents."),
      workspace: z.string().optional().describe("Project-relative directory; defaults to the bridge project."),
      mode: z.enum(["review", "work"]).default("review"),
      writer: z.enum(KNOWN_AGENTS).optional().describe(
        "The only agent allowed to edit in work mode. Defaults to startAgent and must be selected in agents.",
      ),
      browser: z.boolean().default(false).describe("Enable isolated browser access where supported."),
      maxTurns: z.number().int().min(1).max(20).default(6),
      turnTimeoutSeconds: z.number().int().min(30).max(7200).default(600).describe("Per-model inactivity limit. Progress resets it; ordered fallback chains have a hard total bound of this limit multiplied by the number of permitted model attempts."),
      models: modelsSchema,
      modelFallbacks: modelFallbacksSchema,
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema,
      permissionProfile: permissionProfileSchema,
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      githubBuilder: githubBuilderSchema,
      taskNumber: z.number().int().nonnegative().optional().describe("When supplied, rotate the writer deterministically across the selected agents unless writer is explicit."),
      rotationOffset: z.number().int().default(0),
      worktree: worktreeSchema,
      budget: budgetSchema,
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
    const worktree = input.worktree
      ? createWorktree({
        workspace: requestedWorkspace,
        taskId: input.worktree.taskId,
        branch: input.worktree.branch,
        base: input.worktree.base,
        worktreeRoot: input.worktree.root,
      })
      : null;
    const workspace = worktree?.path || requestedWorkspace;
    if (input.chair?.workspace && projectDirectory(input.chair.workspace) !== realpathSync(workspace)) {
      throw new Error("Native chair workspace must match the collaboration workspace.");
    }
    const readiness = preflight({ workspace, agents: delegatedAgents, mode: effectiveMode, workProfile: input.workProfile || "exact", permissionProfile: effectivePermissionProfile });
    if (!readiness.checks.find((check) => check.name === "workspace")?.ok
      || !readiness.checks.find((check) => check.name === "git-repository")?.ok) {
      throw new Error("Collaboration preflight failed: workspace must exist and be a Git repository.");
    }
    const existing = await listCollaborations(WORKSPACE_ROOT, { status: "indeterminate", limit: 100 });
    const ownershipConflict = existing.find((candidate) => candidate.workspace === workspace);
    if (ownershipConflict) {
      throw new Error(`Workspace ownership is preserved by indeterminate collaboration ${ownershipConflict.id}; inspect and cancel it before starting replacement work.`);
    }
    const state = await createCollaboration(WORKSPACE_ROOT, {
      task: input.task,
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
      verificationCommands: input.verificationCommands || [],
      workCommands: input.workCommands || [],
      workProfile: input.workProfile || "exact",
      permissionProfile: effectivePermissionProfile,
      requestedPermissionProfile: input.permissionProfile || "standard",
      handoffPath: input.handoffPath || null,
      githubReview: input.githubReview || null,
      githubBuilder: input.githubBuilder || null,
      rotation: rotated ? { taskNumber: input.taskNumber, offset: input.rotationOffset, ...rotated } : null,
      worktree,
      preflight: readiness,
      capabilities: readiness.capabilities,
      budget: input.budget || {},
      usage: {},
      ciTracking: input.ciTracking || null,
      ci: null,
      decisionPolicy: input.decisionPolicy || { additionalEscalations: [], maxDialogueTurns: 4 },
      decisionPolicyEnabled: Boolean(input.decisionPolicy),
      decisions: [],
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
    startWorker(state.id);
    return toolResponse(await collaborationView(WORKSPACE_ROOT, state.id, 1));
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
    if (["queued", "running", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; record the native chair receipt after the delegated phase stops.`);
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
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema.optional(),
      permissionProfile: permissionProfileSchema.optional(),
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      githubBuilder: githubBuilderSchema,
      budget: budgetSchema,
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
    verificationCommands,
    workCommands,
    workProfile,
    permissionProfile,
    handoffPath,
    githubReview,
    githubBuilder,
    budget,
    ciTracking,
    turnTimeoutSeconds,
    decisionPolicy,
  }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (["queued", "running", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; wait for it to stop before continuing.`);
    }
    if (githubReview && !(handoffPath || current.handoffPath)) {
      throw new Error("githubReview requires handoffPath.");
    }
    if (githubBuilder && current.mode !== "work") throw new Error("githubBuilder is available only in work mode.");
    if ((permissionProfile || current.permissionProfile) === "yolo" && current.mode !== "work") {
      throw new Error("permissionProfile yolo is available only in work mode.");
    }
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous,
      status: "queued",
      cancelRequested: false,
      error: null,
      cleanup: null,
      models: models ? { ...previous.models, ...models } : previous.models,
      modelFallbacks: modelFallbacks
        ? { ...(previous.modelFallbacks || {}), ...modelFallbacks }
        : previous.modelFallbacks || {},
      verificationCommands: verificationCommands || previous.verificationCommands || [],
      workCommands: workCommands || previous.workCommands || [],
      workProfile: workProfile || previous.workProfile || "exact",
      permissionProfile: permissionProfile || previous.permissionProfile || "standard",
      handoffPath: handoffPath || previous.handoffPath || null,
      githubReview: githubReview || previous.githubReview || null,
      githubBuilder: githubBuilder || previous.githubBuilder || null,
      budget: budget || previous.budget || {},
      ciTracking: ciTracking || previous.ciTracking || null,
      turnTimeoutSeconds: turnTimeoutSeconds || previous.turnTimeoutSeconds || 600,
      decisionPolicy: decisionPolicy || previous.decisionPolicy || { additionalEscalations: [], maxDialogueTurns: 4 },
      decisionPolicyEnabled: decisionPolicy ? true : previous.decisionPolicyEnabled || false,
      budgetExceeded: false,
      decisionEscalation: null,
      run: { maxTurns: (decisionPolicy || previous.decisionPolicyEnabled)
        ? Math.min(additionalTurns, (decisionPolicy || previous.decisionPolicy).maxDialogueTurns)
        : additionalTurns },
      runtime: {
        ...previous.runtime,
        previousMessage: message,
        previousAgent: null,
        agreementStreak: 0,
        availableAgents: previous.agents,
        unavailableAgents: {},
      },
    }));
    await appendEvent(WORKSPACE_ROOT, id, { type: "user_continued", at: new Date().toISOString(), message });
    startWorker(id);
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
    if (["queued", "running", "cancelling", "indeterminate"].includes(current.status)) {
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
    if (isSafeWorkerPid(before.workerPid) && processAlive(before.workerPid)) {
      if (!workerCancellationMatches(before)) {
        throw new Error("Refusing to cancel: the live PID does not match this collaboration's owned worker metadata. Inspect with bridge recover; no process was terminated.");
      }
      try { process.kill(-before.workerPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => clearTerminalRuntime({
      ...previous,
      cancelRequested: true,
    }, { status: "cancelled" }));
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "cancelled",
      at: new Date().toISOString(),
      terminatedWorkerPid: before.workerPid || null,
    });
    return toolResponse({ ...state, turns: [] });
  },
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

await reconcileInterruptedCleanup();
await server.connect(new StdioServerTransport());

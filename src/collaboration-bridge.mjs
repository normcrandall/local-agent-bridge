#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";
import {
  appendEvent,
  collaborationView,
  createCollaboration,
  listCollaborations,
  readCollaboration,
  updateCollaboration,
  waitForCollaborationChange,
} from "./collaboration-store.mjs";
import { KNOWN_AGENTS, validateAgents } from "./talk-protocol.mjs";
import { createWorktree, isSafeWorkerPid, preflight, selectRoles } from "./operations.mjs";

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
  const child = spawn(process.execPath, [WORKER, id], {
    cwd: RUNTIME_ROOT,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: RUNTIME_ROOT, BRIDGE_WORKSPACE_ROOT: WORKSPACE_ROOT },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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
  if (view.worktree) lines.push(`Worktree: ${view.worktree.path} (${view.worktree.branch} from ${view.worktree.base})`);
  if (view.ciTracking) {
    const checks = view.ci?.checks || [];
    lines.push(`CI: PR #${view.ciTracking.prNumber}; ${view.ci?.ok ? `${checks.length} checks refreshed` : view.ci?.error || "awaiting refresh"}`);
  }
  if (view.budget && Object.keys(view.budget).length) {
    lines.push(`Budget: ${JSON.stringify(view.budget)}${view.budgetExceeded ? " — reached" : ""}`);
  }
  if (view.usage && Object.keys(view.usage).length) lines.push(`Usage: ${JSON.stringify(view.usage)}`);
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
  return {
    content: [{ type: "text", text: summary(view) }],
    structuredContent: view,
  };
}

function compactStatusView(view) {
  const {
    task: _task,
    models: _models,
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

const server = new McpServer(
  { name: "desktop-agent-collaboration", version: "0.2.0" },
  {
    instructions:
      "Use start_collaboration for an asynchronous durable job with one provider or a bounded roundtable with multiple providers. It returns immediately with a portable collaborationId. Unavailable providers are skipped and the run continues with any remaining participant. Pass verificationCommands and handoffPath for independently verified reviews. Choose workProfile implement for local ownership through commit or deliver when the writer also owns push and PR delivery; use workCommands only for unusual additions. When repository policy requires reviewer-authored PR feedback, pass githubReview so the delegated Claude or Codex reviewer receives target-bound handoff and formal-review tools. Use get_collaboration to poll or inspect it, continue_collaboration for another phase, and cancel_collaboration to stop. Omit model overrides to preserve configured models. The broker owns routing; never ask a peer to call another peer.",
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
      turnTimeoutSeconds: z.number().int().min(30).max(7200).default(600).describe("Hard wall-clock limit for each provider turn; heartbeats do not extend it."),
      models: modelsSchema,
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema,
      permissionProfile: permissionProfileSchema,
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      taskNumber: z.number().int().nonnegative().optional().describe("When supplied, rotate the writer deterministically across the selected agents unless writer is explicit."),
      rotationOffset: z.number().int().default(0),
      worktree: worktreeSchema,
      budget: budgetSchema,
      ciTracking: ciTrackingSchema,
    },
  },
  async (input) => {
    blockNestedCollaboration();
    const rotated = input.taskNumber === undefined ? null : selectRoles({
      taskNumber: input.taskNumber, agents: input.agents, offset: input.rotationOffset,
    });
    const startAgent = input.startAgent || rotated?.writer || input.agents[0];
    validateAgents(input.agents, startAgent);
    const writer = input.mode === "work" ? (input.writer || rotated?.writer || startAgent) : null;
    if (input.githubReview && !input.handoffPath) throw new Error("githubReview requires handoffPath.");
    if (input.githubReview && input.mode === "work" && input.agents.every((agent) => agent === writer)) {
      throw new Error("githubReview requires at least one reviewer distinct from the work-mode writer.");
    }
    if (input.permissionProfile === "yolo" && input.mode !== "work") {
      throw new Error("permissionProfile yolo is available only in work mode.");
    }
    if (writer && !input.agents.includes(writer)) throw new Error("writer must be included in agents.");
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
    const readiness = preflight({ workspace, agents: input.agents, mode: input.mode, workProfile: input.workProfile || "exact", permissionProfile: input.permissionProfile || "standard" });
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
      agents: input.agents,
      startAgent,
      mode: input.mode,
      writer,
      browser: input.browser,
      models: input.models || {},
      verificationCommands: input.verificationCommands || [],
      workCommands: input.workCommands || [],
      workProfile: input.workProfile || "exact",
      permissionProfile: input.permissionProfile || "standard",
      handoffPath: input.handoffPath || null,
      githubReview: input.githubReview || null,
      rotation: rotated ? { taskNumber: input.taskNumber, offset: input.rotationOffset, ...rotated } : null,
      worktree,
      preflight: readiness,
      capabilities: readiness.capabilities,
      budget: input.budget || {},
      usage: {},
      ciTracking: input.ciTracking || null,
      ci: null,
      turnTimeoutSeconds: input.turnTimeoutSeconds,
      run: { maxTurns: input.maxTurns },
      runtime: {
        sessions: Object.fromEntries(input.agents.map((agent) => [agent, null])),
        nextAgent: startAgent,
        previousMessage: null,
        previousAgent: null,
        agreementStreak: 0,
        turnCount: 0,
        availableAgents: input.agents,
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
      verificationCommands: verificationCommandsSchema,
      workCommands: workCommandsSchema,
      workProfile: workProfileSchema.optional(),
      permissionProfile: permissionProfileSchema.optional(),
      handoffPath: handoffPathSchema,
      githubReview: githubReviewSchema,
      budget: budgetSchema,
      ciTracking: ciTrackingSchema,
      turnTimeoutSeconds: z.number().int().min(30).max(7200).optional(),
    },
  },
  async ({
    collaborationId: id,
    message,
    additionalTurns,
    models,
    verificationCommands,
    workCommands,
    workProfile,
    permissionProfile,
    handoffPath,
    githubReview,
    budget,
    ciTracking,
    turnTimeoutSeconds,
  }) => {
    blockNestedCollaboration();
    const current = await readCollaboration(WORKSPACE_ROOT, id);
    if (["queued", "running", "cancelling", "indeterminate"].includes(current.status)) {
      throw new Error(`Collaboration ${id} is ${current.status}; wait for it to stop before continuing.`);
    }
    if (githubReview && !(handoffPath || current.handoffPath)) {
      throw new Error("githubReview requires handoffPath.");
    }
    if ((permissionProfile || current.permissionProfile) === "yolo" && current.mode !== "work") {
      throw new Error("permissionProfile yolo is available only in work mode.");
    }
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous,
      status: "queued",
      cancelRequested: false,
      error: null,
      models: models ? { ...previous.models, ...models } : previous.models,
      verificationCommands: verificationCommands || previous.verificationCommands || [],
      workCommands: workCommands || previous.workCommands || [],
      workProfile: workProfile || previous.workProfile || "exact",
      permissionProfile: permissionProfile || previous.permissionProfile || "standard",
      handoffPath: handoffPath || previous.handoffPath || null,
      githubReview: githubReview || previous.githubReview || null,
      budget: budget || previous.budget || {},
      ciTracking: ciTracking || previous.ciTracking || null,
      turnTimeoutSeconds: turnTimeoutSeconds || previous.turnTimeoutSeconds || 600,
      budgetExceeded: false,
      run: { maxTurns: additionalTurns },
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
  "cancel_collaboration",
  {
    title: "Cancel agent collaboration",
    description: "Cancel the collaboration and terminate its detached worker process group, including the active provider adapter.",
    inputSchema: { collaborationId },
  },
  async ({ collaborationId: id }) => {
    const before = await readCollaboration(WORKSPACE_ROOT, id);
    if (isSafeWorkerPid(before.workerPid)) {
      try {
        process.kill(-before.workerPid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    const state = await updateCollaboration(WORKSPACE_ROOT, id, (previous) => ({
      ...previous,
      cancelRequested: true,
      status: "cancelled",
      workerPid: null,
      runtime: { ...previous.runtime, activeCall: null },
    }));
    await appendEvent(WORKSPACE_ROOT, id, {
      type: "cancelled",
      at: new Date().toISOString(),
      terminatedWorkerPid: before.workerPid || null,
    });
    return toolResponse({ ...state, turns: [] });
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

await server.connect(new StdioServerTransport());

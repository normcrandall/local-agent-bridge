#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfiguredFallbackModels, normalizeFallbackModels } from "./model-fallbacks.mjs";
import { resolveModelRoute } from "./model-policy.mjs";
import { loadConfiguredCodexModel } from "./provider-model-settings.mjs";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const MAX_OUTPUT_CHARS = 200_000;
function overloadRetryPrompt(originalPrompt) {
  return `A previous model attempt failed because that model was overloaded. Inspect the workspace before acting so you preserve any completed work, then complete this original request:\n\n${originalPrompt}`;
}

function findCodex() {
  const candidates = [
    process.env.CODEX_BRIDGE_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".codex/plugins/.plugin-appserver/codex"),
  ];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (directory) candidates.push(join(directory, "codex"));
  }
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("A working Codex binary was not found. Set CODEX_BRIDGE_CODEX_BIN.");
  return found;
}

const CODEX_BIN = findCodex();
const CODEX_CAPABILITIES = negotiateProviderCapabilities({ provider: "codex", binary: CODEX_BIN });

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

function clipped(value, maximum = MAX_OUTPUT_CHARS) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n\n[bridge output truncated]`;
}

function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isModelOverload(message) {
  return /\bno requested model is currently available\b|(?:^|[^a-z0-9])overloaded(?:[^a-z0-9]|$)|\bmodel[_ -]?overload(?:ed)?\b|\bover[_ -]?capacity\b|\bmodel\b[^\n]{0,80}\bat capacity\b|\bno capacity\b[^\n]{0,80}\bmodel\b|\bmodel\b[^\n]{0,80}\bhigh demand\b|\bhigh demand\b[^\n]{0,80}\bmodel\b|\bexperiencing high demand\b/i.test(message);
}

function eventErrorText(event) {
  return [
    event.message,
    event.code,
    event.error?.message,
    event.error?.code,
    event.error?.type,
    typeof event.error === "string" ? event.error : null,
  ].filter((value) => typeof value === "string" && value.trim()).join(" — ") || "Codex reported an error.";
}

function eventSummary(event) {
  if (event.type === "thread.started") return "Codex session started.";
  if (event.type === "turn.started") return "Codex is analyzing the task.";
  if (event.type === "turn.completed") return "Codex finished the turn.";
  if (event.type === "turn.failed" || event.type === "error") return "Codex reported an error.";
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = event.item || {};
  if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return clipped(item.text.trim(), 500);
  }
  if (item.type === "command_execution") {
    return event.type === "item.started"
      ? `Codex is running workspace command: ${clipped(String(item.command || "unknown"), 300)}`
      : `Codex finished workspace command: ${clipped(String(item.command || "unknown"), 300)}${item.exit_code === null || item.exit_code === undefined ? "." : ` (exit ${item.exit_code}).`}`;
  }
  if (item.type === "file_change") return "Codex is applying workspace changes.";
  if (item.type === "mcp_tool_call") return "Codex is using an MCP tool.";
  if (item.type === "web_search") return "Codex is searching the web.";
  return null;
}

function runCodexAttempt({ prompt, cwd, sandbox, approvalPolicy, config = {}, model, threadId, verificationCommands = [], onProgress }) {
  if (process.env.CODEX_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Codex bridge invocation blocked to prevent an agent loop.");
  }
  const actualCwd = projectDirectory(cwd);
  const capabilities = threadId ? CODEX_CAPABILITIES.resume : CODEX_CAPABILITIES.newSession;
  if (!capabilities.json) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} does not support required JSON event output on ${threadId ? "exec resume" : "exec"}.`);
  if (!capabilities.config) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} does not support required --config overrides on ${threadId ? "exec resume" : "exec"}.`);
  if (model && !capabilities.model) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} cannot select a model on ${threadId ? "exec resume" : "exec"}.`);
  const args = ["exec"];
  if (threadId) args.push("resume");
  args.push("--json");
  if (capabilities.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (!threadId) {
    if (capabilities.sandbox) args.push("--sandbox", sandbox);
    else args.push("--config", `sandbox_mode=${tomlValue(sandbox)}`);
    if (capabilities.cd) args.push("--cd", actualCwd);
  } else {
    args.push("--config", `sandbox_mode=${tomlValue(sandbox)}`);
  }
  args.push("--config", `approval_policy=${tomlValue(approvalPolicy)}`);
  for (const [key, value] of Object.entries(config || {})) {
    args.push("--config", `${key}=${tomlValue(value)}`);
  }
  if (model) args.push("--model", model);
  if (threadId) args.push(threadId);
  args.push(prompt);

  return new Promise((resolvePromise, rejectPromise) => {
    const wallStartedAt = Date.now();
    const child = spawn(CODEX_BIN, args, {
      cwd: actualCwd,
      env: { ...process.env, CODEX_BRIDGE_ACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let sessionId = threadId || null;
    let finalMessage = "";
    let eventError = null;
    let firstEventMs = null;
    let toolMs = 0;
    let toolCalls = 0;
    const activeTools = new Map();
    const verificationSet = new Set(verificationCommands.map((command) => String(command).trim()));
    const verificationResults = [];
    let reviewPublished = false;

    const consume = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const observedAt = Date.now();
      if (firstEventMs === null) firstEventMs = observedAt - wallStartedAt;
      const item = event.item || {};
      const timedTool = ["command_execution", "mcp_tool_call", "web_search"].includes(item.type);
      if (timedTool && event.type === "item.started") {
        activeTools.set(item.id || `${item.type}:${toolCalls}`, {
          observedAt,
          startedAt: new Date(observedAt).toISOString(),
          command: item.type === "command_execution" ? String(item.command || "").trim() : null,
        });
        toolCalls += 1;
      } else if (timedTool && event.type === "item.completed") {
        const key = item.id || [...activeTools.keys()].find((candidate) => candidate.startsWith(`${item.type}:`));
        const started = activeTools.get(key);
        if (started !== undefined) {
          toolMs += Math.max(0, observedAt - started.observedAt);
          if (verificationSet.has(started.command) && Number.isInteger(item.exit_code)) {
            const serializedOutput = String(item.aggregated_output ?? item.output ?? "");
            verificationResults.push({
              command: started.command,
              exitCode: item.exit_code,
              startedAt: started.startedAt,
              completedAt: new Date(observedAt).toISOString(),
              outputDigest: createHash("sha256").update(serializedOutput).digest("hex"),
              outputSummary: clipped(serializedOutput, 1_000),
            });
          }
          activeTools.delete(key);
        }
        const server = String(item.server || item.server_name || "").replace(/^mcp__/, "");
        const tool = String(item.tool || item.name || item.tool_name || "").replace(/^mcp__github_review__/, "");
        if (item.type === "mcp_tool_call"
          && server === "github_review"
          && tool === "submit_pr_review"
          && !item.error
          && String(item.status || "").toLowerCase() === "completed") {
          reviewPublished = true;
        }
      }
      if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text?.trim()) {
        finalMessage = event.item.text.trim();
      }
      if (event.type === "error" || event.type === "turn.failed") {
        eventError = eventErrorText(event);
      }
      const summary = eventSummary(event);
      if (summary) onProgress(summary);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      consume(buffer);
      if (code !== 0 || eventError) {
        const error = new Error(clipped(eventError || stderr.trim() || `Codex exited with ${code ?? signal}.`));
        error.modelOverloaded = isModelOverload(error.message);
        rejectPromise(error);
        return;
      }
      const totalMs = Date.now() - wallStartedAt;
      resolvePromise({
        content: clipped(finalMessage || "Codex returned no text."),
        threadId: sessionId,
        isError: false,
        timing: {
          totalMs,
          firstResponseMs: firstEventMs,
          toolMs,
          toolCalls,
          inferenceMs: Math.max(0, totalMs - toolMs),
          inferenceEstimated: true,
        },
        verificationResults,
        reviewPublished,
      });
    });
  });
}

async function runCodex({
  prompt,
  cwd,
  sandbox,
  approvalPolicy,
  config = {},
  model,
  fallbackModels,
  threadId,
  verificationCommands = [],
  onProgress,
}) {
  let configured;
  if (fallbackModels === undefined) {
    try {
      configured = loadConfiguredFallbackModels("codex");
    } catch (error) {
      configured = [];
      onProgress(`Ignoring invalid machine model-fallback policy: ${error.message}`);
    }
  } else {
    configured = normalizeFallbackModels(fallbackModels, "fallbackModels");
  }
  const machineModelPolicy = resolveModelRoute({
    provider: "codex",
    model,
    configuredModel: loadConfiguredCodexModel(),
    fallbackModels: configured,
  });
  configured = machineModelPolicy.fallbackModels;
  if (machineModelPolicy.blockedModels.length) {
    onProgress(`Machine model policy skipped ${machineModelPolicy.blockedModels.join(", ")}; using ${machineModelPolicy.model || "the provider-configured model"}.`);
  }
  const candidates = [machineModelPolicy.model || null, ...configured]
    .filter((candidate, index, values) => values.indexOf(candidate) === index);
  const attemptedModels = [];
  const originalThreadId = threadId || null;
  let activeThreadId = originalThreadId;
  let attemptPrompt = prompt;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const label = candidate || "configured default";
    attemptedModels.push(label);
    try {
      const result = await runCodexAttempt({
        prompt: attemptPrompt,
        cwd,
        sandbox,
        approvalPolicy,
        config,
        model: candidate,
        threadId: activeThreadId,
        verificationCommands,
        onProgress,
      });
      return {
        ...result,
        requestedModel: model || null,
        model: candidate,
        fallbackUsed: machineModelPolicy.source === "fallback" || index > 0,
        attemptedModels,
        modelFallbacks: configured,
        fallbackManagedBy: configured.length ? "bridge" : null,
        modelPolicy: machineModelPolicy,
      };
    } catch (error) {
      const next = candidates[index + 1];
      if (!error.modelOverloaded) throw error;
      if (next === undefined) {
        const suffix = configured.length
          ? `Codex model fallback chain exhausted: ${attemptedModels.join(" -> ")}.`
          : "No Codex model fallback was configured.";
        throw new Error(`${error.message}\n${suffix}`);
      }
      const nextLabel = next || "configured default";
      onProgress(`Codex model ${label} is overloaded; retrying with ${nextLabel} (${index + 1}/${candidates.length - 1}).`);
      // A newly-created failed thread may not contain the original user turn. Start a
      // fresh attempt in that case. For codex-reply, retain only the caller's established
      // thread and repeat the prompt so the fallback cannot silently lose the new ask.
      activeThreadId = originalThreadId;
      attemptPrompt = overloadRetryPrompt(prompt);
    }
  }
  throw new Error("Codex model fallback chain was empty.");
}

const server = new McpServer(
  { name: "codex-live-progress-bridge", version: "0.2.0" },
  { instructions: "Use codex for a new delegated turn and codex-reply with the returned threadId for continuation. Structured Codex lifecycle events are forwarded as progress notifications." },
);

const configSchema = z.record(z.string(), z.unknown()).default({});
const newTurnInput = {
  prompt: z.string().min(1),
  cwd: z.string().default("."),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  "approval-policy": z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
  config: configSchema,
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe(
    "Ordered models to try only when Codex reports that the current model is overloaded. Omit to use ~/.config/local-agent-bridge/model-fallbacks.json; pass [] to disable configured fallbacks.",
  ),
  verificationCommands: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
};

async function runWithProgress(input, extra, threadId) {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  const notify = (message) => {
    if (token === undefined) return;
    progress += 1;
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    }).catch(() => {});
  };
  return runCodex({
    prompt: input.prompt,
    cwd: input.cwd || ".",
    sandbox: input.sandbox || "read-only",
    approvalPolicy: input["approval-policy"] || "never",
    config: input.config,
    model: input.model,
    fallbackModels: input.fallbackModels,
    threadId,
    verificationCommands: input.verificationCommands || [],
    onProgress: notify,
  });
}

function toolResponse(result) {
  return {
    content: [{ type: "text", text: result.content }],
    structuredContent: result,
    isError: result.isError,
  };
}

server.registerTool("codex", {
  title: "Codex",
  description: "Start a Codex turn with live lifecycle progress.",
  inputSchema: newTurnInput,
}, async (input, extra) => toolResponse(await runWithProgress(input, extra)));

server.registerTool("codex-reply", {
  title: "Continue Codex",
  description: "Continue a Codex turn by threadId with live lifecycle progress. Re-pass the intended sandbox and approval policy; omitted continuation permissions fail closed to read-only and never.",
  inputSchema: {
    threadId: z.string().min(1),
    ...newTurnInput,
  },
}, async ({ threadId, ...input }, extra) => toolResponse(await runWithProgress(input, extra, threadId)));

await server.connect(new StdioServerTransport());

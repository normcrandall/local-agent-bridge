#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const MAX_OUTPUT_CHARS = 200_000;

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
      ? "Codex is running a workspace command."
      : `Codex finished a workspace command${item.exit_code === null || item.exit_code === undefined ? "." : ` (exit ${item.exit_code}).`}`;
  }
  if (item.type === "file_change") return "Codex is applying workspace changes.";
  if (item.type === "mcp_tool_call") return "Codex is using an MCP tool.";
  if (item.type === "web_search") return "Codex is searching the web.";
  return null;
}

function runCodex({ prompt, cwd, sandbox, approvalPolicy, config = {}, model, threadId, onProgress }) {
  if (process.env.CODEX_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Codex bridge invocation blocked to prevent an agent loop.");
  }
  const actualCwd = projectDirectory(cwd);
  const args = ["exec"];
  if (threadId) args.push("resume");
  args.push("--json", "--skip-git-repo-check", "--color", "never");
  if (!threadId) args.push("--sandbox", sandbox, "--cd", actualCwd);
  else args.push("--config", `sandbox_mode=${tomlValue(sandbox)}`);
  args.push("--config", `approval_policy=${tomlValue(approvalPolicy)}`);
  for (const [key, value] of Object.entries(config || {})) {
    args.push("--config", `${key}=${tomlValue(value)}`);
  }
  if (model) args.push("--model", model);
  if (threadId) args.push(threadId);
  args.push(prompt);

  return new Promise((resolvePromise, rejectPromise) => {
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

    const consume = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text?.trim()) {
        finalMessage = event.item.text.trim();
      }
      if (event.type === "error" || event.type === "turn.failed") {
        eventError = event.message || event.error?.message || "Codex reported an error.";
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
        rejectPromise(new Error(clipped(eventError || stderr.trim() || `Codex exited with ${code ?? signal}.`)));
        return;
      }
      resolvePromise({ content: clipped(finalMessage || "Codex returned no text."), threadId: sessionId, isError: false });
    });
  });
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
    threadId,
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

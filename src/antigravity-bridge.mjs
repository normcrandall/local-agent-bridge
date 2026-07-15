#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;
const CONVERSATION_CACHE = process.env.AGY_CONVERSATION_CACHE
  || join(homedir(), ".gemini/antigravity-cli/cache/last_conversations.json");

function findExecutable(name, candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, name);
    if (directory && existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find ${name}. Set AGY_BIN to its absolute path.`);
}

const AGY_BIN = findExecutable("agy", [process.env.AGY_BIN, join(homedir(), ".local/bin/agy")]);
const AGY_CAPABILITIES = negotiateProviderCapabilities({ provider: "antigravity", binary: AGY_BIN });

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

function timeoutMs(requestedSeconds) {
  if (requestedSeconds === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(requestedSeconds * 1000, MAX_TIMEOUT_MS);
}

function clipped(value) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[bridge output truncated]`;
}

function cachedConversation(cwd) {
  try {
    const cache = JSON.parse(readFileSync(CONVERSATION_CACHE, "utf8"));
    return typeof cache[cwd] === "string" ? cache[cwd] : null;
  } catch {
    return null;
  }
}

function loggedConversation(path) {
  try {
    const content = readFileSync(path, "utf8");
    const matches = [...content.matchAll(/(?:conversation(?:Id|_id)?["'=:\s]+)([0-9a-f]{8}-[0-9a-f-]{27,})/gi)];
    return matches.at(-1)?.[1] || null;
  } catch { return null; }
}

function runAntigravity({ prompt, cwd, mode, model, timeoutSeconds, permissionProfile = "standard", conversationId, onProgress = () => {} }) {
  if (process.env.ANTIGRAVITY_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Antigravity bridge invocation blocked to prevent an agent loop.");
  }
  if (permissionProfile === "yolo" && mode !== "work") {
    throw new Error("permissionProfile yolo is available only in work mode.");
  }

  const actualCwd = projectDirectory(cwd);
  const duration = timeoutMs(timeoutSeconds);
  const temporaryDirectory = AGY_CAPABILITIES.logFile ? mkdtempSync(join(tmpdir(), "antigravity-agent-bridge-")) : null;
  const logFile = temporaryDirectory ? join(temporaryDirectory, "session.log") : null;
  for (const [feature, supported] of [
    ["--print", AGY_CAPABILITIES.print], ["--print-timeout", AGY_CAPABILITIES.printTimeout], ["--mode", AGY_CAPABILITIES.mode],
  ]) if (!supported) throw new Error(`Installed Antigravity ${AGY_CAPABILITIES.version} lacks required ${feature} support.`);
  if (model && !AGY_CAPABILITIES.model) throw new Error(`Installed Antigravity ${AGY_CAPABILITIES.version} cannot select a model.`);
  if (conversationId && !AGY_CAPABILITIES.conversation) throw new Error(`Installed Antigravity ${AGY_CAPABILITIES.version} cannot resume a conversation.`);
  if (!AGY_CAPABILITIES.addDir) {
    throw new Error(`Installed Antigravity ${AGY_CAPABILITIES.version} lacks required --add-dir support for delegated workspace binding.`);
  }
  const args = [
    "--print",
    prompt,
    "--print-timeout",
    `${Math.ceil(duration / 1000)}s`,
    "--mode",
    mode === "work" ? "accept-edits" : "plan",
  ];
  if (logFile) args.push("--log-file", logFile);
  // Headless sandbox sessions otherwise open in Antigravity's scratch project
  // instead of granting the delegated worktree to terminal tools.
  args.push("--add-dir", actualCwd);
  if (mode === "work" && permissionProfile === "yolo") {
    if (!AGY_CAPABILITIES.yolo) throw new Error(`Installed Antigravity ${AGY_CAPABILITIES.version} cannot enable YOLO mode.`);
    args.push("--dangerously-skip-permissions");
  } else if (AGY_CAPABILITIES.sandbox) args.push("--sandbox");
  if (model) args.push("--model", model);
  if (conversationId) args.push("--conversation", conversationId);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(AGY_BIN, args, {
      cwd: actualCwd,
      env: { ...process.env, ANTIGRAVITY_BRIDGE_ACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, duration);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const summary = chunk.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 500);
      if (summary) onProgress(summary);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
        rejectPromise(new Error("Antigravity delegation timed out."));
        return;
      }
      if (code !== 0) {
        if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
        rejectPromise(new Error(clipped(stderr || `Antigravity exited with ${code ?? signal}.`)));
        return;
      }
      const fromLog = logFile ? loggedConversation(logFile) : null;
      const resolvedConversation = conversationId || fromLog || cachedConversation(actualCwd);
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
      resolvePromise({
        result: clipped(stdout.trim()),
        conversationId: resolvedConversation,
        conversationSource: conversationId ? "caller" : fromLog ? "log-file" : "cwd-cache",
        resumeReliability: fromLog || conversationId ? "session-bound" : "best-effort-cwd-cache",
        isError: false,
      });
    });
  });
}

function toolResponse(result) {
  return {
    content: [{ type: "text", text: result.result || "Antigravity returned no text." }],
    structuredContent: result,
    isError: result.isError,
  };
}

const sharedInput = {
  prompt: z.string().min(1).describe("A self-contained task or question for Antigravity."),
  cwd: z.string().optional().describe("Project-relative directory. Defaults to the project root."),
  mode: z.enum(["review", "work"]).default("review").describe(
    "review uses Antigravity plan mode; work uses accept-edits. Both run inside Antigravity's terminal sandbox.",
  ),
  model: z.string().min(1).optional().describe(
    "Optional Antigravity model label. Omit it to use the model selected in the user's Antigravity settings.",
  ),
  timeoutSeconds: z.number().int().min(10).max(14400).optional(),
  permissionProfile: z.enum(["standard", "yolo"]).default("standard").describe(
    "Explicit work-mode permission policy. yolo auto-approves tools and disables the terminal sandbox; it must never be inferred.",
  ),
};

const server = new McpServer(
  { name: "codex-antigravity-bridge", version: "0.1.0" },
  {
    instructions:
      "Use ask_antigravity for a bounded independent task and continue_antigravity only with the exact returned conversationId. Omit model to honor the user's configured Antigravity model. Delegated sessions run sandboxed; review is plan mode and work is accept-edits. Never ask Antigravity to call Codex or Claude through MCP from a delegated session.",
  },
);

async function runWithProgress(input, extra, conversationId) {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  const notify = async (message) => {
    if (token === undefined) return;
    progress += 1;
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    }).catch(() => {});
  };
  await notify("Antigravity started the delegated turn.");
  const timer = setInterval(() => {
    notify(`Antigravity is still working (${progress * 10}s heartbeat).`).catch(() => {});
  }, 10_000);
  timer.unref?.();
  try {
    return await runAntigravity({
      ...input,
      conversationId,
      onProgress: (summary) => notify(summary).catch(() => {}),
    });
  } finally {
    clearInterval(timer);
  }
}

server.registerTool(
  "ask_antigravity",
  {
    title: "Ask Antigravity",
    description: "Start a bounded, sandboxed Antigravity CLI session. Defaults to read-only plan mode.",
    inputSchema: sharedInput,
  },
  async (input, extra) => toolResponse(await runWithProgress(input, extra)),
);

server.registerTool(
  "continue_antigravity",
  {
    title: "Continue Antigravity",
    description: "Continue the exact Antigravity conversation returned by ask_antigravity.",
    inputSchema: {
      ...sharedInput,
      conversationId: z.string().uuid().describe(
        "The conversationId returned by a previous Antigravity bridge call.",
      ),
    },
  },
  async ({ conversationId, ...input }, extra) => toolResponse(
    await runWithProgress(input, extra, conversationId),
  ),
);

await server.connect(new StdioServerTransport());

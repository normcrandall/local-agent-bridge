#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";
import { loadConfiguredFallbackModels, normalizeFallbackModels } from "./model-fallbacks.mjs";
import { resolveModelRoute } from "./model-policy.mjs";
import { loadConfiguredAntigravityModel } from "./provider-model-settings.mjs";
import { normalizeVerificationAllowlist } from "./verification-allowlist.mjs";
import { resolveContainedWritableRoots } from "./writable-roots.mjs";

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

function gitMetadataDirectories(cwd) {
  const directories = [];
  for (const argument of ["--absolute-git-dir", "--git-common-dir"]) {
    const result = spawnSync("git", ["rev-parse", "--path-format=absolute", argument], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
    });
    const directory = result.status === 0 ? result.stdout.trim() : "";
    if (directory && existsSync(directory) && statSync(directory).isDirectory()) directories.push(realpathSync(directory));
  }
  return [...new Set(directories)];
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

function isModelOverload(error) {
  return /\bno requested model is currently available\b|(?:^|[^a-z0-9])overloaded(?:[^a-z0-9]|$)|\bmodel[_ -]?overload(?:ed)?\b|\bover[_ -]?capacity\b|\bmodel\b[^\n]{0,80}\bat capacity\b|\bno capacity\b[^\n]{0,80}\bmodel\b|\bmodel\b[^\n]{0,80}\bhigh demand\b|\bhigh demand\b[^\n]{0,80}\bmodel\b|\bexperiencing high demand\b/i
    .test(error?.message || String(error));
}

function runAntigravityAttempt({ prompt, cwd, mode, model, timeoutSeconds, permissionProfile = "standard", verificationCommands = [], writableRoots = [], conversationId, onProgress = () => {} }) {
  if (process.env.ANTIGRAVITY_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Antigravity bridge invocation blocked to prevent an agent loop.");
  }
  const actualCwd = projectDirectory(cwd);
  const containedWritableRoots = mode === "work"
    ? resolveContainedWritableRoots(actualCwd, writableRoots, { label: "Antigravity writable root" })
    : [];
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
  const commands = normalizeVerificationAllowlist(verificationCommands);
  if (mode === "review" && permissionProfile === "yolo" && commands.length === 0) {
    throw new Error("Antigravity review mode may use unrestricted permissions only when verificationCommands are present; static reviews remain sandboxed.");
  }
  const commandRunningReview = mode === "review" && commands.length > 0;
  const verificationContract = commandRunningReview
    ? `\n\nDelegated Antigravity verification contract:\n- Run these coordinator-selected commands and report their exact observed results:\n${commands.map((command) => `  - ${command}`).join("\n")}\n- The Antigravity CLI cannot enforce an exact command allowlist, so this command-running review uses unrestricted tool approval. Do not run unrelated commands or modify the workspace.`
    : "";
  const args = [
    "--print",
    `${prompt}${verificationContract}`,
    "--print-timeout",
    `${Math.ceil(duration / 1000)}s`,
    "--mode",
    mode === "work" ? "accept-edits" : "plan",
  ];
  if (logFile) args.push("--log-file", logFile);
  // Headless sandbox sessions otherwise open in Antigravity's scratch project
  // instead of granting the delegated worktree to terminal tools.
  for (const directory of [...new Set([actualCwd, ...gitMetadataDirectories(actualCwd), ...containedWritableRoots])]) {
    args.push("--add-dir", directory);
  }
  if (permissionProfile === "yolo" || commandRunningReview) {
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

async function runAntigravity(input) {
  let fallbackModels;
  if (input.fallbackModels === undefined) {
    try {
      fallbackModels = loadConfiguredFallbackModels("antigravity");
    } catch (error) {
      input.onProgress?.(`Ignoring invalid machine Antigravity model-fallback policy: ${error.message}`);
      fallbackModels = [];
    }
  } else {
    fallbackModels = normalizeFallbackModels(input.fallbackModels, "fallbackModels");
  }
  const machineModelPolicy = resolveModelRoute({
    provider: "antigravity",
    model: input.model,
    configuredModel: loadConfiguredAntigravityModel(),
    fallbackModels,
  });
  fallbackModels = machineModelPolicy.fallbackModels;
  if (machineModelPolicy.blockedModels.length) {
    input.onProgress?.(`Machine model policy skipped ${machineModelPolicy.blockedModels.join(", ")}; using ${machineModelPolicy.model || "the provider-configured model"}.`);
  }
  const candidates = [machineModelPolicy.model || null, ...fallbackModels];
  const attemptedModels = [];
  let prompt = input.prompt;
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    const label = model || "provider-configured model";
    attemptedModels.push(label);
    try {
      const result = await runAntigravityAttempt({ ...input, prompt, model });
      return {
        ...result,
        modelRouting: {
          requestedModel: input.model || null,
          model,
          fallbackUsed: machineModelPolicy.source === "fallback" || index > 0,
          attemptedModels,
          fallbackModels,
          fallbackManagedBy: fallbackModels.length ? "bridge" : null,
          modelPolicy: machineModelPolicy,
        },
      };
    } catch (error) {
      if (!isModelOverload(error) || index === candidates.length - 1) {
        if (isModelOverload(error) && candidates.length > 1) {
          error.message = `Antigravity model fallback chain exhausted: ${attemptedModels.join(" -> ")}. ${error.message}`;
        }
        throw error;
      }
      const nextLabel = candidates[index + 1] || "provider-configured model";
      input.onProgress?.(`Antigravity model ${label} is overloaded; retrying with ${nextLabel}.`);
      prompt = `A previous model attempt failed because that model was overloaded. Inspect the workspace before acting so you preserve any completed work, then complete this original request:\n\n${input.prompt}`;
    }
  }
  throw new Error("Antigravity model fallback chain produced no attempt.");
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
    "review uses Antigravity plan mode; work uses accept-edits. Standard calls run inside Antigravity's terminal sandbox.",
  ),
  model: z.string().min(1).optional().describe(
    "Optional Antigravity model label. Omit it to use the model selected in the user's Antigravity settings.",
  ),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe(
    "Ordered Antigravity models to try only after a recognized overload. Omit to use the machine-local fallback policy; pass [] to disable it.",
  ),
  timeoutSeconds: z.number().int().min(10).max(14400).optional(),
  verificationCommands: z.array(z.string()).max(50).default([]).describe(
    "Coordinator-selected commands for a command-running review. Their presence automatically enables unrestricted tool approval because agy has no exact non-interactive command grant.",
  ),
  permissionProfile: z.enum(["standard", "yolo"]).default("standard").describe(
    "Work-mode permission policy. In review mode, verificationCommands automatically enable unrestricted approval; manually selecting yolo without commands is rejected so static reviews stay sandboxed.",
  ),
  writableRoots: z.array(z.string().min(1)).max(10).default([]).describe(
    "Additional work-mode writable directories contained inside the delegated workspace. The broker uses this only for a private writer checkout's Git metadata.",
  ),
};

const server = new McpServer(
  { name: "codex-antigravity-bridge", version: "0.1.0" },
  {
    instructions:
      "Use ask_antigravity for a bounded independent task and continue_antigravity only with the exact returned conversationId. Omit model to honor the user's configured Antigravity model. Standard delegated sessions run sandboxed; review is plan mode and work is accept-edits. The collaboration broker uses unrestricted tool approval for command-running Antigravity reviews because agy exposes no exact command grant. Never ask Antigravity to call Codex or Claude through MCP from a delegated session.",
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

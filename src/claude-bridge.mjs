#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configuredReviewerLogin, GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";
import { loadConfiguredClaudeModel, resolveClaudeModelPolicy } from "./claude-model-policy.mjs";
import { loadConfiguredFallbackModels, normalizeFallbackModels } from "./model-fallbacks.mjs";
import { resolveModelRoute } from "./model-policy.mjs";
import { admitProviderCommands } from "./verification-allowlist.mjs";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";
import { ensureContainedHandoffPath } from "./handoff-path.mjs";
import { resolveContainedWritableRoots } from "./writable-roots.mjs";

const RUNTIME_ROOT = realpathSync(process.env.BRIDGE_RUNTIME_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const PLAYWRIGHT_MCP = join(RUNTIME_ROOT, "scripts/playwright-mcp.sh");
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;

function findExecutable(name, candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, name);
    if (directory && existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not find ${name}. Set CLAUDE_BIN to its absolute path.`);
}

const CLAUDE_BIN = findExecutable("claude", [
  process.env.CLAUDE_BIN,
  resolve(homedir(), ".local/bin/claude"),
]);
const CLAUDE_CAPABILITIES = negotiateProviderCapabilities({ provider: "claude", binary: CLAUDE_BIN });

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

function projectFile(cwd, requested) {
  return ensureContainedHandoffPath(cwd, requested);
}

function timeoutMs(requestedSeconds) {
  if (requestedSeconds === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(requestedSeconds * 1000, MAX_TIMEOUT_MS);
}

function clipped(value) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[bridge output truncated]`;
}

const IMPLEMENT_WORK_TOOLS = [
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
  "Bash(git rev-parse:*)", "Bash(git branch:*)", "Bash(git switch:*)", "Bash(git checkout:*)",
  "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(pnpm:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(yarn:*)", "Bash(bun:*)",
  "Bash(node:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(uv:*)",
  "Bash(cargo:*)", "Bash(go:*)", "Bash(make:*)",
  "Bash(shasum:*)", "Bash(sha256sum:*)",
];
const DELIVER_WORK_TOOLS = [
  ...IMPLEMENT_WORK_TOOLS,
  "Bash(git push:*)",
  "Bash(gh repo view:*)",
  "Bash(gh pr create:*)", "Bash(gh pr edit:*)", "Bash(gh pr view:*)",
  "Bash(gh pr checks:*)", "Bash(gh pr status:*)", "Bash(gh pr review:*)",
  "Bash(gh pr comment:*)", "Bash(gh pr ready:*)",
  "Bash(gh pr close:*)", "Bash(gh pr reopen:*)",
];

function profileTools(workProfile) {
  if (workProfile === "deliver") return DELIVER_WORK_TOOLS;
  if (workProfile === "implement") return IMPLEMENT_WORK_TOOLS;
  return [];
}

function validatePinnedMergeCommands(commands) {
  for (const command of commands) {
    if (!/\bgh\s+pr\s+merge(?:\s|$)/.test(command)) continue;
    if (!/^gh pr merge [1-9]\d* --(?:merge|rebase|squash) --match-head-commit [0-9a-fA-F]{40}(?: --delete-branch)?$/.test(command)) {
      throw new Error(
        "Exact gh pr merge commands must use: gh pr merge <number> --<merge|rebase|squash> --match-head-commit <40-character SHA> [--delete-branch]",
      );
    }
  }
}

function runClaude({
  prompt,
  cwd,
  mode,
  browser,
  model,
  fallbackModels,
  allowFable = false,
  timeoutSeconds,
  resume,
  verificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath,
  githubReview,
  githubBuilder,
  writableRoots = [],
  onProgress = () => {},
}) {
  if (process.env.CLAUDE_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Claude bridge invocation blocked to prevent an agent loop.");
  }
  if (permissionProfile === "yolo" && mode !== "work") {
    throw new Error("permissionProfile yolo is available only in work mode.");
  }
  if (mode === "work" && permissionProfile !== "yolo") {
    validatePinnedMergeCommands(workCommands);
  }

  const actualCwd = projectDirectory(cwd);
  const containedWritableRoots = mode === "work"
    ? resolveContainedWritableRoots(actualCwd, writableRoots, { label: "Claude writable root" })
    : [];
  let resolvedFallbackModels;
  if (fallbackModels === undefined) {
    try {
      resolvedFallbackModels = loadConfiguredFallbackModels("claude");
    } catch (error) {
      resolvedFallbackModels = [];
      onProgress(`Ignoring invalid machine model-fallback policy: ${error.message}`);
    }
  } else {
    resolvedFallbackModels = normalizeFallbackModels(fallbackModels, "fallbackModels");
  }
  const requestedModel = model || null;
  const modelPolicy = resolveClaudeModelPolicy({
    model,
    fallbackModels: resolvedFallbackModels,
    allowFable,
    configuredModel: loadConfiguredClaudeModel({ cwd: actualCwd }),
  });
  let resolvedModel = modelPolicy.model;
  resolvedFallbackModels = modelPolicy.fallbackModels;
  if (modelPolicy.blockedModels.length) {
    onProgress(`Fable is not authorized for this request; using ${resolvedModel} and removing ${modelPolicy.blockedModels.join(", ")} from Claude routing.`);
  } else if (allowFable && [resolvedModel, ...resolvedFallbackModels].some((value) => typeof value === "string" && value.toLowerCase().includes("fable"))) {
    onProgress("Fable use was explicitly authorized for this request.");
  }
  const machineModelPolicy = resolveModelRoute({
    provider: "claude",
    model: resolvedModel,
    fallbackModels: resolvedFallbackModels,
  });
  resolvedModel = machineModelPolicy.model;
  resolvedFallbackModels = machineModelPolicy.fallbackModels;
  if (machineModelPolicy.blockedModels.length) {
    onProgress(`Machine model policy skipped ${machineModelPolicy.blockedModels.join(", ")}; using ${resolvedModel}.`);
  }
  const actualHandoffPath = mode === "review" ? projectFile(actualCwd, handoffPath) : null;
  if (githubReview && mode !== "review") {
    throw new Error("githubReview is available only in review mode.");
  }
  if (githubReview && !actualHandoffPath) {
    throw new Error("githubReview requires handoffPath so the durable review is written before posting.");
  }
  if (githubBuilder && mode !== "work") throw new Error("githubBuilder is available only in work mode.");
  if (!CLAUDE_CAPABILITIES.print || !CLAUDE_CAPABILITIES.streamJson) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required non-interactive stream-json output.`);
  }
  if (!CLAUDE_CAPABILITIES.mcpConfig) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required --mcp-config support.`);
  }
  if (!CLAUDE_CAPABILITIES.strictMcpConfig) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required --strict-mcp-config isolation; upgrade Claude Code before delegation.`);
  }
  if (resolvedModel && !CLAUDE_CAPABILITIES.model) throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} cannot select a model.`);
  if (resume && !CLAUDE_CAPABILITIES.resume) throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} cannot resume a session.`);
  if (resolvedFallbackModels.length && !CLAUDE_CAPABILITIES.fallbackModel) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} cannot use the configured fallback model chain; upgrade Claude Code or remove the chain.`);
  }
  if (mode === "review" && (!CLAUDE_CAPABILITIES.allowedTools || !CLAUDE_CAPABILITIES.permissionMode)) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required bounded review permission flags.`);
  }
  if (mode === "work" && permissionProfile === "standard" && (!CLAUDE_CAPABILITIES.allowedTools || !CLAUDE_CAPABILITIES.permissionMode)) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required bounded work permission flags.`);
  }
  if (containedWritableRoots.length && !CLAUDE_CAPABILITIES.addDir) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} lacks required --add-dir support for private writer Git metadata.`);
  }
  if (mode === "work" && permissionProfile === "yolo" && !CLAUDE_CAPABILITIES.yolo) {
    throw new Error(`Installed Claude ${CLAUDE_CAPABILITIES.version} cannot enable YOLO mode.`);
  }
  const delegatedMcpConfig = { mcpServers: {} };
  if (browser) {
    delegatedMcpConfig.mcpServers.playwright = {
      command: "/bin/zsh",
      args: [PLAYWRIGHT_MCP],
    };
  }
  if (githubReview) {
    delegatedMcpConfig.mcpServers.github_review = {
      command: process.execPath,
      args: [join(RUNTIME_ROOT, "src/github-review-bridge.mjs")],
      env: {
        GITHUB_REVIEW_REPOSITORY: githubReview.repository,
        GITHUB_REVIEW_PR_NUMBER: String(githubReview.prNumber),
        GITHUB_REVIEW_HEAD_SHA: githubReview.headSha,
        GITHUB_REVIEW_EXPECTED_LOGIN: githubReview.expectedLogin,
        GITHUB_REVIEW_PUBLISH_STATUS_GATE: githubReview.publishStatusGate ? "1" : "0",
        GITHUB_REVIEW_HANDOFF_PATH: actualHandoffPath,
        GITHUB_REVIEW_TOKEN_FILE: process.env.GITHUB_REVIEW_TOKEN_FILE || join(homedir(), ".config/ghtoken"),
        GITHUB_REVIEW_API_URL: process.env.GITHUB_REVIEW_API_URL || "https://api.github.com",
      },
    };
  }
  if (githubBuilder) {
    delegatedMcpConfig.mcpServers.github_builder = {
      command: process.execPath,
      args: [join(RUNTIME_ROOT, "src/github-builder-bridge.mjs")],
      env: Object.fromEntries(Object.entries({
        GITHUB_BUILDER_REPOSITORY: githubBuilder.repository,
        GITHUB_BUILDER_PR_NUMBER: githubBuilder.prNumber ? String(githubBuilder.prNumber) : null,
        GITHUB_BUILDER_BASE_SHA: githubBuilder.baseSha || null,
        GITHUB_BUILDER_HEAD_SHA: githubBuilder.headSha,
        GITHUB_BUILDER_EXPECTED_LOGIN: githubBuilder.expectedLogin,
        GITHUB_BUILDER_HEAD_REF: githubBuilder.headRef || null,
        GITHUB_BUILDER_BASE_REF: githubBuilder.baseRef || null,
        GITHUB_BUILDER_ALLOWED_OPERATIONS: githubBuilder.allowedOperations?.join(",") || null,
        GITHUB_BUILDER_WORKSPACE: actualCwd,
      }).filter(([, value]) => value)),
    };
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-agent-bridge-"));
  const delegatedMcpPath = join(temporaryDirectory, "mcp.json");
  writeFileSync(delegatedMcpPath, `${JSON.stringify(delegatedMcpConfig)}\n`, { mode: 0o600 });

  const args = [
    "-p",
    "--output-format",
    "stream-json",
  ];
  if (CLAUDE_CAPABILITIES.verbose) args.push("--verbose");
  if (resolvedModel) args.push("--model", resolvedModel);
  if (resolvedFallbackModels.length) args.push("--fallback-model", resolvedFallbackModels.join(","));
  if (containedWritableRoots.length) args.push("--add-dir", ...containedWritableRoots);
  if (mode === "review") {
    const allowedTools = [
      "Read",
      "Glob",
      "Grep",
      ...admitProviderCommands({ mode: "review", verificationCommands }).map((command) => `Bash(${command})`),
    ];
    if (actualHandoffPath) {
      const permissionPath = actualHandoffPath.startsWith("/")
        ? `/${actualHandoffPath}`
        : actualHandoffPath;
      allowedTools.push(`Edit(${permissionPath})`, `Write(${permissionPath})`);
    }
    if (browser) allowedTools.push("mcp__playwright__*");
    if (githubReview) {
      allowedTools.push(
        "mcp__github_review__write_handoff",
        "mcp__github_review__submit_pr_review",
      );
    }
    args.push("--allowedTools", ...allowedTools, "--permission-mode", "dontAsk");
  } else if (permissionProfile === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    const allowedTools = [
      "Read", "Glob", "Grep", "Edit", "Write",
      ...profileTools(workProfile),
      ...admitProviderCommands({ mode: "work", verificationCommands, workCommands }).map((command) => `Bash(${command})`),
    ];
    if (browser) allowedTools.push("mcp__playwright__*");
    if (githubBuilder) allowedTools.push("mcp__github_builder__*");
    args.push("--allowedTools", ...allowedTools, "--permission-mode", "dontAsk");
  }
  args.push("--strict-mcp-config", "--mcp-config", delegatedMcpPath);
  if (resume) args.push("--resume", resume);
  const permissionContract = mode === "review"
    ? `

Review permission contract:
- Treat the workspace source as read-only. Do not modify source, configuration, Git state, or external systems.
- You may run only these exact verification commands: ${verificationCommands.length ? verificationCommands.map((command) => `\`${command}\``).join(", ") : "none"}.
${actualHandoffPath ? `- Write the final handoff to exactly \`${actualHandoffPath}\`. This is the only file you may create or edit.` : "- Return the handoff in your response; no file write was authorized."}
${githubReview ? `- After writing the handoff, submit one formal PR review to \`${githubReview.repository}\` PR #${githubReview.prNumber} at \`${githubReview.headSha}\` using \`github_review.submit_pr_review\`. Include a general verdict and inline comments for actionable line-specific findings. The tool is pre-bound to \`${githubReview.expectedLogin}\` and this exact PR head${githubReview.publishStatusGate ? "; it also publishes the exact-head agent-review status" : "; the formal App review is the configured review gate"}.` : "- Do not post comments or send messages."}
- Do not push, commit, deploy, or perform any other external mutation.`
    : `

Work permission contract:
- You are the designated writer for this bounded task and may create or edit workspace files with the file tools.
- Permission profile: ${permissionProfile}.${permissionProfile === "yolo" ? " YOLO was explicitly selected by the user; Claude Code permission checks are bypassed for this turn." : " Standard provider restrictions remain active."}
- Work profile: ${workProfile}. ${githubBuilder ? `GitHub mutation is authorized only through the target-bound github_builder tools for ${githubBuilder.repository}${githubBuilder.prNumber ? ` PR #${githubBuilder.prNumber}` : ""} at ${githubBuilder.headSha} as ${githubBuilder.expectedLogin}; do not use gh or general GitHub tools.` : workProfile === "deliver" ? "Repository delivery is authorized, including push and PR lifecycle commands covered by the profile." : workProfile === "implement" ? "Local implementation through commit is authorized; pushing and PR mutation are not." : "Only exact commands are authorized."}
- You may run only these exact shell commands: ${[...new Set([...workCommands, ...verificationCommands])].length ? [...new Set([...workCommands, ...verificationCommands])].map((command) => `\`${command}\``).join(", ") : "none"}.
- You may also use commands covered by the selected work profile. Uncovered external mutations remain denied.
- Do not substitute, combine, wrap, or broaden the commands. If another command is needed, stop and report it for explicit authorization.
- Report changed files, command results, commit SHA, and push result as applicable.`;
  args.push("--", `${prompt}${permissionContract}`);

  return new Promise((resolvePromise, rejectPromise) => {
    const wallStartedAt = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      cwd: actualCwd,
      env: { ...process.env, CLAUDE_BRIDGE_ACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let lineBuffer = "";
    let lastProgressSummary = "";
    let stderr = "";
    let timedOut = false;
    let firstEventMs = null;
    let toolMs = 0;
    let toolCalls = 0;
    let testsMs = 0;
    let testCalls = 0;
    const activeTools = new Map();
    const verificationResults = [];
    let reviewPublished = false;
    const verificationSet = new Set(verificationCommands.map((command) => command.trim()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs(timeoutSeconds) * (1 + resolvedFallbackModels.length));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const observedAt = Date.now();
          if (firstEventMs === null) firstEventMs = observedAt - wallStartedAt;
          const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_use") {
              const command = block.name === "Bash" ? String(block.input?.command || "").trim() : null;
              activeTools.set(block.id, {
                startedAt: observedAt,
                startedAtIso: new Date(observedAt).toISOString(),
                name: block.name,
                command,
              });
              toolCalls += 1;
              if (verificationSet.has(command)) {
                testCalls += 1;
                const summary = `Claude is running verification command: ${command}`;
                if (summary !== lastProgressSummary) {
                  lastProgressSummary = summary;
                  onProgress(summary);
                }
              }
            }
            if (block.type === "tool_result" && block.tool_use_id) {
              const active = activeTools.get(block.tool_use_id);
              if (active) {
                const durationMs = Math.max(0, observedAt - active.startedAt);
                toolMs += durationMs;
                if (verificationSet.has(active.command)) {
                  testsMs += durationMs;
                  if (typeof block.is_error === "boolean") {
                    const serializedOutput = typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content ?? null);
                    verificationResults.push({
                      command: active.command,
                      exitCode: block.is_error ? 1 : 0,
                      startedAt: active.startedAtIso,
                      completedAt: new Date(observedAt).toISOString(),
                      outputDigest: createHash("sha256").update(serializedOutput).digest("hex"),
                      outputSummary: clipped(serializedOutput, 1_000),
                    });
                  }
                  const summary = `Claude finished verification command: ${active.command}`;
                  if (summary !== lastProgressSummary) {
                    lastProgressSummary = summary;
                    onProgress(summary);
                  }
                }
                if (active.name === "mcp__github_review__submit_pr_review" && block.is_error === false) {
                  reviewPublished = true;
                }
                activeTools.delete(block.tool_use_id);
              }
            }
          }
          if (event.type !== "assistant") continue;
          const summary = blocks
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join(" ")
            .slice(0, 500);
          if (summary && summary !== lastProgressSummary) {
            lastProgressSummary = summary;
            onProgress(summary);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      rmSync(temporaryDirectory, { recursive: true, force: true });
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      rmSync(temporaryDirectory, { recursive: true, force: true });
      if (timedOut) {
        rejectPromise(new Error("Claude delegation timed out."));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(clipped(stderr || `Claude exited with ${code ?? signal}.`)));
        return;
      }

      try {
        const parsedLines = stdout.trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);
        const parsed = parsedLines.findLast((event) => event.type === "result") || parsedLines.at(-1) || JSON.parse(stdout);
        const modelsUsed = Object.keys(parsed.modelUsage || {});
        const totalMs = Date.now() - wallStartedAt;
        const timing = {
          totalMs,
          providerReportedMs: parsed.duration_ms ?? null,
          firstResponseMs: firstEventMs,
          toolMs,
          toolCalls,
          testsMs,
          testCalls,
          inferenceMs: Math.max(0, totalMs - toolMs),
          inferenceEstimated: true,
        };
        resolvePromise({
          result: parsed.result ?? "",
          sessionId: parsed.session_id ?? null,
          isError: Boolean(parsed.is_error),
          durationMs: parsed.duration_ms ?? null,
          usage: {
            costUsd: parsed.total_cost_usd ?? 0,
            tokens: (parsed.usage?.input_tokens || 0)
              + (parsed.usage?.output_tokens || 0)
              + (parsed.usage?.cache_creation_input_tokens || 0)
              + (parsed.usage?.cache_read_input_tokens || 0),
          },
          requestedModel,
          model: modelsUsed.length === 1 ? modelsUsed[0] : null,
          modelsUsed,
          fallbackUsed: null,
          modelFallbacks: resolvedFallbackModels,
          fallbackManagedBy: resolvedFallbackModels.length ? "claude-cli" : null,
          modelPolicy: { ...modelPolicy, machine: machineModelPolicy },
          handoffPath: actualHandoffPath,
          timing,
          verificationResults,
          reviewPublished,
        });
      } catch {
        const totalMs = Date.now() - wallStartedAt;
        resolvePromise({
          result: clipped(stdout),
          sessionId: null,
          isError: false,
          durationMs: null,
          usage: { costUsd: 0, tokens: 0 },
          requestedModel,
          model: null,
          modelsUsed: [],
          fallbackUsed: null,
          modelFallbacks: resolvedFallbackModels,
          fallbackManagedBy: resolvedFallbackModels.length ? "claude-cli" : null,
          modelPolicy: { ...modelPolicy, machine: machineModelPolicy },
          handoffPath: actualHandoffPath,
          timing: {
            totalMs,
            providerReportedMs: null,
            firstResponseMs: firstEventMs,
            toolMs,
            toolCalls,
            testsMs,
            testCalls,
            inferenceMs: Math.max(0, totalMs - toolMs),
            inferenceEstimated: true,
          },
          verificationResults,
          reviewPublished,
        });
      }
    });
  });
}

function toolResponse(result) {
  return {
    content: [{ type: "text", text: clipped(result.result || "Claude returned no text.") }],
    structuredContent: result,
    isError: result.isError,
  };
}

const sharedInput = {
  prompt: z.string().min(1).describe("A self-contained task or question for Claude Code."),
  cwd: z.string().optional().describe("Project-relative directory. Defaults to the project root."),
  mode: z.enum(["review", "work"]).default("review").describe(
    "review allows reads, exact verification commands, and one declared handoff file; work allows project-file edits and only exact declared work commands.",
  ),
  browser: z.boolean().default(false).describe(
    "Enable an isolated Playwright browser for this delegated session. It does not use the Codex app browser or an existing signed-in profile.",
  ),
  model: z.string().min(1).optional().describe(
    "Optional Claude Code model alias or full model ID. Omit it to use the model from the user's Claude Code settings or environment.",
  ),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe(
    "Ordered Claude models passed to Claude Code's native --fallback-model overload handling. Omit to use ~/.config/local-agent-bridge/model-fallbacks.json; pass [] to disable configured fallbacks.",
  ),
  allowFable: z.boolean().default(false).describe(
    "Explicit Fable authorization. Set true only when the user's current request asks for Fable by name; saved settings and earlier requests do not count.",
  ),
  timeoutSeconds: z.number().int().min(10).max(14400).optional(),
  verificationCommands: z.array(
    z.string().trim().min(1).max(500).refine((command) => !/[\r\n]/.test(command), "Commands must be single-line."),
  ).max(20).optional().describe(
    "Exact shell commands Claude may run in review mode. All other shell commands are denied.",
  ),
  workCommands: z.array(
    z.string().trim().min(1).max(500).refine((command) => !/[\r\n]/.test(command), "Commands must be single-line."),
  ).max(50).optional().describe(
    "Exact shell commands Claude may run in work mode, including authorized branch, test, commit, and push commands. All other shell commands are denied.",
  ),
  workProfile: z.enum(["exact", "implement", "deliver"]).default("exact").describe(
    "Reusable work-mode permission profile. implement permits common local development and Git commands through commit; deliver additionally permits git push and bounded gh pr lifecycle commands. exact permits only workCommands.",
  ),
  permissionProfile: z.enum(["standard", "yolo"]).default("standard").describe(
    "Explicit work-mode permission policy. yolo bypasses Claude Code permission checks and must never be inferred.",
  ),
  writableRoots: z.array(z.string().min(1)).max(10).default([]).describe(
    "Additional work-mode writable directories contained inside the delegated workspace. The broker uses this only for a private writer checkout's Git metadata.",
  ),
  handoffPath: z.string().trim().min(1).optional().describe(
    "Optional project-relative file Claude may create or edit in review mode. No other file writes are allowed.",
  ),
  githubReview: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prNumber: z.number().int().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
    expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN).optional().describe("Omit to use the configured Claude reviewer App."),
    publishStatusGate: z.boolean().optional().default(true),
  }).strict().optional().describe(
    "Explicit authorization for Claude to submit one formal review to an exact GitHub PR head using its configured reviewer App by default. Requires handoffPath.",
  ),
  githubBuilder: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prNumber: z.number().int().min(1).optional(),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
    expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
    headRef: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    allowedOperations: z.array(z.enum(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready", "merge", "create_branch", "push_branch", "replace_branch"])).min(1).max(9)
      .default(["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready"]),
  }).strict().superRefine((value, ctx) => {
    if (value.allowedOperations.includes("create_branch") && !value.baseSha) {
      ctx.addIssue({ code: "custom", path: ["baseSha"], message: "create_branch requires an exact baseSha authorization" });
    }
    if (value.allowedOperations.includes("create_branch") && !value.baseRef) {
      ctx.addIssue({ code: "custom", path: ["baseRef"], message: "create_branch requires an exact baseRef authorization" });
    }
  }).optional().describe(
    "Explicit work-mode authorization for target-bound GitHub builder operations at one repository and head SHA.",
  ),
};

const server = new McpServer(
  { name: "codex-claude-bridge", version: "0.1.0" },
  {
    instructions:
      "Use ask_claude for a bounded independent review or delegated task. Use continue_claude only with the returned sessionId. In review mode, pass exact verificationCommands and an optional project-relative handoffPath. In work mode, choose workProfile implement for local ownership through commit or deliver when Claude also owns push and PR delivery; use exact workCommands only for unusual additions. File edits are allowed but commands outside the profile and additions are denied. When project policy requires the reviewer to post to the PR, pass githubReview with the exact repository, PR number, and head SHA; the configured Claude reviewer App is selected when expectedLogin is omitted. Fable is denied by default; set allowFable only when the user's current request explicitly asks for Fable by name. Never ask Claude to call Codex from a delegated session.",
  },
);

async function runWithProgress(input, extra, resume) {
  const effectiveInput = input.githubReview && !input.githubReview.expectedLogin
    ? {
      ...input,
      githubReview: {
        ...input.githubReview,
        expectedLogin: await configuredReviewerLogin({ provider: "claude" }),
      },
    }
    : input;
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
  await notify("Claude Code started the delegated turn.");
  const timer = setInterval(() => {
    notify(`Claude Code is still working (${progress * 10}s heartbeat).`).catch(() => {});
  }, 10_000);
  timer.unref?.();
  try {
    return await runClaude({
      ...effectiveInput,
      resume,
      onProgress: (summary) => notify(summary).catch(() => {}),
    });
  } finally {
    clearInterval(timer);
  }
}

server.registerTool(
  "ask_claude",
  {
    title: "Ask Claude Code",
    description: "Start a bounded Claude Code session. Review mode is read-mostly; work mode permits file edits and exact declared workCommands.",
    inputSchema: sharedInput,
  },
  async (input, extra) => toolResponse(await runWithProgress(input, extra)),
);

server.registerTool(
  "continue_claude",
  {
    title: "Continue Claude Code",
    description: "Continue a prior Claude Code session returned by ask_claude.",
    inputSchema: {
      ...sharedInput,
      sessionId: z.string().min(1).describe("The sessionId returned by a previous bridge call."),
    },
  },
  async ({ sessionId, ...input }, extra) => toolResponse(
    await runWithProgress(input, extra, sessionId),
  ),
);

await server.connect(new StdioServerTransport());

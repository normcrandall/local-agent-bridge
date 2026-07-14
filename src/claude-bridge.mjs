#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";

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

function projectDirectory(requested) {
  const candidate = resolve(WORKSPACE_ROOT, requested || ".");
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`Working directory does not exist: ${candidate}`);
  }

  const actual = realpathSync(candidate);
  const fromRoot = relative(WORKSPACE_ROOT, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${delimiter}`) || isAbsolute(fromRoot)) {
    throw new Error(`Working directory must stay within ${WORKSPACE_ROOT}`);
  }
  return actual;
}

function projectFile(cwd, requested) {
  if (!requested) return null;
  if (isAbsolute(requested)) throw new Error("handoffPath must be relative to the delegated working directory.");
  const candidate = resolve(cwd, requested);
  const fromWorkspace = relative(cwd, candidate);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${delimiter}`) || isAbsolute(fromWorkspace)) {
    throw new Error("handoffPath must stay inside the delegated working directory.");
  }

  let existing = existsSync(candidate) ? candidate : dirname(candidate);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const actual = realpathSync(existing);
  const actualFromWorkspace = relative(cwd, actual);
  if (
    actualFromWorkspace === ".."
    || actualFromWorkspace.startsWith(`..${delimiter}`)
    || isAbsolute(actualFromWorkspace)
  ) {
    throw new Error("handoffPath resolves outside the delegated working directory.");
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    throw new Error("handoffPath must name a file, not a directory.");
  }
  mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
  return candidate;
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
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "Bash(git rev-parse*)", "Bash(git branch*)", "Bash(git switch*)", "Bash(git checkout*)",
  "Bash(git add *)", "Bash(git commit *)",
  "Bash(pnpm *)", "Bash(npm *)", "Bash(npx *)", "Bash(yarn *)", "Bash(bun *)",
  "Bash(node *)", "Bash(python *)", "Bash(python3 *)", "Bash(pytest *)", "Bash(uv *)",
  "Bash(cargo *)", "Bash(go *)", "Bash(make *)",
  "Bash(shasum *)", "Bash(sha256sum *)",
];
const DELIVER_WORK_TOOLS = [
  ...IMPLEMENT_WORK_TOOLS,
  "Bash(git push *)",
  "Bash(gh pr create *)", "Bash(gh pr edit *)", "Bash(gh pr view *)",
  "Bash(gh pr checks *)", "Bash(gh pr status*)",
];

function profileTools(workProfile) {
  if (workProfile === "deliver") return DELIVER_WORK_TOOLS;
  if (workProfile === "implement") return IMPLEMENT_WORK_TOOLS;
  return [];
}

function runClaude({
  prompt,
  cwd,
  mode,
  browser,
  model,
  timeoutSeconds,
  resume,
  verificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath,
  githubReview,
  onProgress = () => {},
}) {
  if (process.env.CLAUDE_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Claude bridge invocation blocked to prevent an agent loop.");
  }
  if (permissionProfile === "yolo" && mode !== "work") {
    throw new Error("permissionProfile yolo is available only in work mode.");
  }

  const actualCwd = projectDirectory(cwd);
  const actualHandoffPath = mode === "review" ? projectFile(actualCwd, handoffPath) : null;
  if (githubReview && mode !== "review") {
    throw new Error("githubReview is available only in review mode.");
  }
  if (githubReview && !actualHandoffPath) {
    throw new Error("githubReview requires handoffPath so the durable review is written before posting.");
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
        GITHUB_REVIEW_HANDOFF_PATH: actualHandoffPath,
        GITHUB_REVIEW_TOKEN_FILE: process.env.GITHUB_REVIEW_TOKEN_FILE || join(homedir(), ".config/ghtoken"),
        GITHUB_REVIEW_API_URL: process.env.GITHUB_REVIEW_API_URL || "https://api.github.com",
      },
    };
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-agent-bridge-"));
  const delegatedMcpPath = join(temporaryDirectory, "mcp.json");
  writeFileSync(delegatedMcpPath, `${JSON.stringify(delegatedMcpConfig)}\n`, { mode: 0o600 });

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (model) args.push("--model", model);
  if (mode === "review") {
    const allowedTools = [
      "Read",
      "Glob",
      "Grep",
      ...verificationCommands.map((command) => `Bash(${command})`),
    ];
    if (actualHandoffPath) {
      const permissionPath = actualHandoffPath.startsWith("/")
        ? `/${actualHandoffPath}`
        : actualHandoffPath;
      allowedTools.push(`Edit(${permissionPath})`, `Write(${permissionPath})`);
    }
    if (browser) allowedTools.push("mcp__playwright__*");
    if (githubReview) allowedTools.push("mcp__github_review__submit_pr_review");
    args.push("--allowedTools", ...allowedTools, "--permission-mode", "dontAsk");
  } else if (permissionProfile === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    const allowedTools = [
      "Read", "Glob", "Grep", "Edit", "Write",
      ...profileTools(workProfile),
      ...[...new Set([...workCommands, ...verificationCommands])].map((command) => `Bash(${command})`),
    ];
    if (browser) allowedTools.push("mcp__playwright__*");
    args.push("--allowedTools", ...allowedTools, "--permission-mode", "dontAsk");
  }
  args.push(
    "--strict-mcp-config",
    "--mcp-config",
    delegatedMcpPath,
  );
  if (resume) args.push("--resume", resume);
  const permissionContract = mode === "review"
    ? `

Review permission contract:
- Treat the workspace source as read-only. Do not modify source, configuration, Git state, or external systems.
- You may run only these exact verification commands: ${verificationCommands.length ? verificationCommands.map((command) => `\`${command}\``).join(", ") : "none"}.
${actualHandoffPath ? `- Write the final handoff to exactly \`${actualHandoffPath}\`. This is the only file you may create or edit.` : "- Return the handoff in your response; no file write was authorized."}
${githubReview ? `- After writing the handoff, submit one formal PR review to \`${githubReview.repository}\` PR #${githubReview.prNumber} at \`${githubReview.headSha}\` using \`github_review.submit_pr_review\`. Include a general verdict and inline comments for actionable line-specific findings. The tool is pre-bound to \`${githubReview.expectedLogin}\` and this exact PR head.` : "- Do not post comments or send messages."}
- Do not push, commit, deploy, or perform any other external mutation.`
    : `

Work permission contract:
- You are the designated writer for this bounded task and may create or edit workspace files with the file tools.
- Permission profile: ${permissionProfile}.${permissionProfile === "yolo" ? " YOLO was explicitly selected by the user; Claude Code permission checks are bypassed for this turn." : " Standard provider restrictions remain active."}
- Work profile: ${workProfile}. ${workProfile === "deliver" ? "Repository delivery is authorized, including push and PR lifecycle commands covered by the profile." : workProfile === "implement" ? "Local implementation through commit is authorized; pushing and PR mutation are not." : "Only exact commands are authorized."}
- You may run only these exact shell commands: ${[...new Set([...workCommands, ...verificationCommands])].length ? [...new Set([...workCommands, ...verificationCommands])].map((command) => `\`${command}\``).join(", ") : "none"}.
- You may also use commands covered by the selected work profile. Uncovered external mutations remain denied.
- Do not substitute, combine, wrap, or broaden the commands. If another command is needed, stop and report it for explicit authorization.
- Report changed files, command results, commit SHA, and push result as applicable.`;
  args.push("--", `${prompt}${permissionContract}`);

  return new Promise((resolvePromise, rejectPromise) => {
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs(timeoutSeconds));

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
          if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
          const summary = event.message.content
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
          handoffPath: actualHandoffPath,
        });
      } catch {
        resolvePromise({
          result: clipped(stdout),
          sessionId: null,
          isError: false,
          durationMs: null,
          usage: { costUsd: 0, tokens: 0 },
          handoffPath: actualHandoffPath,
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
  handoffPath: z.string().trim().min(1).optional().describe(
    "Optional project-relative file Claude may create or edit in review mode. No other file writes are allowed.",
  ),
  githubReview: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prNumber: z.number().int().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
    expectedLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  }).strict().optional().describe(
    "Explicit authorization for Claude to submit one formal review to an exact GitHub PR head using the dedicated review-bot token. Requires handoffPath.",
  ),
};

const server = new McpServer(
  { name: "codex-claude-bridge", version: "0.1.0" },
  {
    instructions:
      "Use ask_claude for a bounded independent review or delegated task. Use continue_claude only with the returned sessionId. In review mode, pass exact verificationCommands and an optional project-relative handoffPath. In work mode, choose workProfile implement for local ownership through commit or deliver when Claude also owns push and PR delivery; use exact workCommands only for unusual additions. File edits are allowed but commands outside the profile and additions are denied. When project policy requires the reviewer to post to the PR, pass githubReview with the exact repository, PR number, head SHA, and expected bot login. Omit model to honor the user's configured Claude Code model. Never ask Claude to call Codex from a delegated session.",
  },
);

async function runWithProgress(input, extra, resume) {
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
      ...input,
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

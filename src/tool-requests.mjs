import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeVerificationAllowlist } from "./verification-allowlist.mjs";
import { resolveContainedWritableRoots } from "./writable-roots.mjs";

function workWritableRoots(provider, cwd, mode, writableRoots) {
  return mode === "work" && writableRoots.length
    ? resolveContainedWritableRoots(cwd, writableRoots, { label: `${provider} writable root` })
    : [];
}

export function claudeToolRequest({
  prompt,
  sessionId = null,
  cwd = ".",
  mode = "review",
  browser = false,
  model = null,
  fallbackModels,
  allowFable = false,
  timeoutSeconds = 7200,
  verificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath = null,
  githubReview = null,
  githubBuilder = null,
  writableRoots = [],
}) {
  const arguments_ = { prompt, cwd, mode, browser, timeoutSeconds, permissionProfile };
  if (verificationCommands.length) arguments_.verificationCommands = verificationCommands;
  if (workCommands.length) arguments_.workCommands = workCommands;
  if (workProfile !== "exact") arguments_.workProfile = workProfile;
  if (handoffPath) arguments_.handoffPath = handoffPath;
  if (githubReview) arguments_.githubReview = githubReview;
  if (githubBuilder) arguments_.githubBuilder = githubBuilder;
  const containedWritableRoots = workWritableRoots("Claude", cwd, mode, writableRoots);
  if (containedWritableRoots.length) arguments_.writableRoots = containedWritableRoots;
  if (model) arguments_.model = model;
  if (fallbackModels !== undefined) arguments_.fallbackModels = fallbackModels;
  if (allowFable) arguments_.allowFable = true;
  if (sessionId) {
    arguments_.sessionId = sessionId;
    return { name: "continue_claude", arguments: arguments_ };
  }
  return { name: "ask_claude", arguments: arguments_ };
}

export function codexToolRequest({
  prompt,
  sessionId = null,
  cwd,
  mode = "review",
  browser = false,
  model = null,
  fallbackModels,
  workProfile = "exact",
  permissionProfile = "standard",
  verificationCommands = [],
  handoffPath = null,
  githubReview = null,
  githubReviewBridgePath = null,
  githubBuilder = null,
  githubBuilderBridgePath = null,
  playwrightBridgePath = null,
  writableRoots = [],
}) {
  if (githubReview && mode !== "review") throw new Error("githubReview is available only in Codex review mode.");
  if (githubReview && (!handoffPath || !githubReviewBridgePath)) {
    throw new Error("Codex githubReview requires handoffPath and githubReviewBridgePath.");
  }
  if (githubBuilder && mode !== "work") throw new Error("githubBuilder is available only in Codex work mode.");
  if (githubBuilder && !githubBuilderBridgePath) throw new Error("Codex githubBuilder requires githubBuilderBridgePath.");
  const absoluteHandoffPath = handoffPath ? resolve(cwd, handoffPath) : null;
  if (absoluteHandoffPath) {
    const fromWorkspace = relative(cwd, absoluteHandoffPath);
    if (fromWorkspace === ".." || fromWorkspace.startsWith("../") || isAbsolute(fromWorkspace)) {
      throw new Error("Codex handoffPath must stay inside the delegated workspace.");
    }
  }
  const workContract = mode === "work"
    ? `\n\nDelegated Codex work contract:\n- You are the designated writer for this bounded task.\n- Work profile: ${workProfile}.\n- Permission profile: ${permissionProfile}.${permissionProfile === "yolo" ? " The user explicitly authorized danger-full-access with approvals disabled." : " Standard sandbox protections remain active."}\n- ${githubBuilder ? `Use only the github_builder tools for GitHub mutation. They are bound to ${githubBuilder.repository}${githubBuilder.prNumber ? ` PR #${githubBuilder.prNumber}` : ""} at ${githubBuilder.headSha} as ${githubBuilder.expectedLogin}. Do not use gh or general GitHub tools.` : workProfile === "deliver" ? "Repository delivery is authorized, including push and pull-request creation when requested by the task." : "Work locally through verification and commit. Do not push, create or modify pull requests, or mutate other external systems."}\n- Preserve branch ownership, report verification and Git/PR results, and do not delegate to another agent.`
    : githubReview
      ? `\n\nDelegated Codex review contract:\n- Treat workspace source and Git state as read-only.\n- Run only the requested verification commands when permitted by the sandbox.\n- Write the durable review only through github_review.write_handoff, which is bound to ${absoluteHandoffPath}.\n- Then submit exactly one formal review through github_review.submit_pr_review to ${githubReview.repository} PR #${githubReview.prNumber} at ${githubReview.headSha} as ${githubReview.expectedLogin}; ${githubReview.publishStatusGate ? "the reviewer App also publishes the exact-head agent-review status" : "the formal App review is the configured review gate"}.\n- If github_review.read_review_threads is available, use it after an APPROVE and resolve every satisfied thread opened by this same reviewer App. Leave unresolved any thread that is not satisfied or belongs to another reviewer.\n- Do not use general GitHub, shell mutation, commit, push, or another agent.`
      : "";
  const yolo = mode === "work" && permissionProfile === "yolo";
  const containedWritableRoots = workWritableRoots("Codex", cwd, mode, writableRoots);
  const arguments_ = {
    prompt: `${prompt}${workContract}`,
    cwd,
    sandbox: yolo ? "danger-full-access" : mode === "work" ? "workspace-write" : "read-only",
    "approval-policy": "never",
  };
  if (model) arguments_.model = model;
  if (fallbackModels !== undefined) arguments_.fallbackModels = fallbackModels;
  if (verificationCommands.length) arguments_.verificationCommands = verificationCommands;
  arguments_.config = {};
  if (mode === "work" && !yolo) {
    arguments_.config["sandbox_workspace_write.network_access"] = workProfile === "deliver";
    if (containedWritableRoots.length) {
      arguments_.config["sandbox_workspace_write.writable_roots"] = containedWritableRoots;
    }
  }
  if (githubReview) {
    arguments_.config["mcp_servers.github_review.enabled"] = true;
    arguments_.config["mcp_servers.github_review.command"] = process.execPath;
    arguments_.config["mcp_servers.github_review.args"] = [githubReviewBridgePath];
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_REPOSITORY"] = githubReview.repository;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_PR_NUMBER"] = String(githubReview.prNumber);
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_HEAD_SHA"] = githubReview.headSha;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_EXPECTED_LOGIN"] = githubReview.expectedLogin;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_PUBLISH_STATUS_GATE"] = githubReview.publishStatusGate ? "1" : "0";
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_HANDOFF_PATH"] = absoluteHandoffPath;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_TOKEN_FILE"] = resolve(homedir(), ".config/ghtoken");
    arguments_.config["mcp_servers.github_review.default_tools_approval_mode"] = "approve";
  }
  if (githubBuilder) {
    arguments_.config["mcp_servers.github_builder.enabled"] = true;
    arguments_.config["mcp_servers.github_builder.command"] = process.execPath;
    arguments_.config["mcp_servers.github_builder.args"] = [githubBuilderBridgePath];
    for (const [key, value] of Object.entries({
      GITHUB_BUILDER_REPOSITORY: githubBuilder.repository,
      GITHUB_BUILDER_PR_NUMBER: githubBuilder.prNumber ? String(githubBuilder.prNumber) : null,
      GITHUB_BUILDER_BASE_SHA: githubBuilder.baseSha || null,
      GITHUB_BUILDER_HEAD_SHA: githubBuilder.headSha,
      GITHUB_BUILDER_EXPECTED_LOGIN: githubBuilder.expectedLogin,
      GITHUB_BUILDER_HEAD_REF: githubBuilder.headRef || null,
      GITHUB_BUILDER_BASE_REF: githubBuilder.baseRef || null,
      GITHUB_BUILDER_ALLOWED_OPERATIONS: githubBuilder.allowedOperations?.join(",") || null,
      GITHUB_BUILDER_WORKSPACE: cwd,
      GITHUB_BUILDER_ALLOW_WORKSPACE_HEAD: githubBuilder.allowWorkspaceHead ? "1" : null,
    })) if (value) arguments_.config[`mcp_servers.github_builder.env.${key}`] = value;
    arguments_.config["mcp_servers.github_builder.default_tools_approval_mode"] = "approve";
  }
  if (browser) {
    if (!playwrightBridgePath) throw new Error("Codex browser mode requires playwrightBridgePath.");
    arguments_.config["mcp_servers.playwright.enabled"] = true;
    arguments_.config["mcp_servers.playwright.command"] = "/bin/zsh";
    arguments_.config["mcp_servers.playwright.args"] = [playwrightBridgePath];
    arguments_.config["mcp_servers.playwright.default_tools_approval_mode"] = "approve";
  }
  if (sessionId) {
    arguments_.threadId = sessionId;
    return { name: "codex-reply", arguments: arguments_ };
  }
  return { name: "codex", arguments: arguments_ };
}

export function antigravityToolRequest({
  prompt,
  sessionId = null,
  cwd = ".",
  mode = "review",
  model = null,
  fallbackModels,
  timeoutSeconds = 7200,
  permissionProfile = "standard",
  verificationCommands = [],
  writableRoots = [],
}) {
  const commands = normalizeVerificationAllowlist(verificationCommands);
  const arguments_ = { prompt, cwd, mode, timeoutSeconds, permissionProfile };
  if (commands.length) arguments_.verificationCommands = commands;
  const containedWritableRoots = workWritableRoots("Antigravity", cwd, mode, writableRoots);
  if (containedWritableRoots.length) arguments_.writableRoots = containedWritableRoots;
  if (model) arguments_.model = model;
  if (fallbackModels !== undefined) arguments_.fallbackModels = fallbackModels;
  if (sessionId) {
    arguments_.conversationId = sessionId;
    return { name: "continue_antigravity", arguments: arguments_ };
  }
  return { name: "ask_antigravity", arguments: arguments_ };
}

export function ollamaToolRequest({
  prompt,
  sessionId = null,
  cwd = ".",
  mode = "review",
  model = null,
  fallbackModels,
  timeoutSeconds = 1800,
}) {
  if (mode !== "review") throw new Error("Ollama is review-only and cannot receive a work-mode request.");
  const arguments_ = { prompt, cwd, mode, timeoutSeconds };
  if (model) arguments_.model = model;
  if (fallbackModels !== undefined) arguments_.fallbackModels = fallbackModels;
  if (sessionId) {
    arguments_.conversationId = sessionId;
    return { name: "continue_ollama", arguments: arguments_ };
  }
  return { name: "ask_ollama", arguments: arguments_ };
}

export function dockerToolRequest({
  prompt,
  sessionId = null,
  cwd = ".",
  mode = "review",
  model = null,
  fallbackModels,
  timeoutSeconds = 1800,
}) {
  if (mode !== "review") throw new Error("Docker Model Runner is review-only and cannot receive a work-mode request.");
  const arguments_ = { prompt, cwd, mode, timeoutSeconds };
  if (model) arguments_.model = model;
  if (fallbackModels !== undefined) arguments_.fallbackModels = fallbackModels;
  if (sessionId) {
    arguments_.conversationId = sessionId;
    return { name: "continue_docker", arguments: arguments_ };
  }
  return { name: "ask_docker", arguments: arguments_ };
}

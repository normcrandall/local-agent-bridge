import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

export function claudeToolRequest({
  prompt,
  sessionId = null,
  cwd = ".",
  mode = "review",
  browser = false,
  model = null,
  timeoutSeconds = 7200,
  verificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath = null,
  githubReview = null,
}) {
  const arguments_ = { prompt, cwd, mode, browser, timeoutSeconds, permissionProfile };
  if (verificationCommands.length) arguments_.verificationCommands = verificationCommands;
  if (workCommands.length) arguments_.workCommands = workCommands;
  if (workProfile !== "exact") arguments_.workProfile = workProfile;
  if (handoffPath) arguments_.handoffPath = handoffPath;
  if (githubReview) arguments_.githubReview = githubReview;
  if (model) arguments_.model = model;
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
  workProfile = "exact",
  permissionProfile = "standard",
  verificationCommands = [],
  handoffPath = null,
  githubReview = null,
  githubReviewBridgePath = null,
  playwrightBridgePath = null,
}) {
  if (githubReview && mode !== "review") throw new Error("githubReview is available only in Codex review mode.");
  if (githubReview && (!handoffPath || !githubReviewBridgePath)) {
    throw new Error("Codex githubReview requires handoffPath and githubReviewBridgePath.");
  }
  const absoluteHandoffPath = handoffPath ? resolve(cwd, handoffPath) : null;
  if (absoluteHandoffPath) {
    const fromWorkspace = relative(cwd, absoluteHandoffPath);
    if (fromWorkspace === ".." || fromWorkspace.startsWith("../") || isAbsolute(fromWorkspace)) {
      throw new Error("Codex handoffPath must stay inside the delegated workspace.");
    }
  }
  const workContract = mode === "work"
    ? `\n\nDelegated Codex work contract:\n- You are the designated writer for this bounded task.\n- Work profile: ${workProfile}.\n- Permission profile: ${permissionProfile}.${permissionProfile === "yolo" ? " The user explicitly authorized danger-full-access with approvals disabled." : " Standard sandbox protections remain active."}\n- ${workProfile === "deliver" ? "Repository delivery is authorized, including push and pull-request creation when requested by the task." : "Work locally through verification and commit. Do not push, create or modify pull requests, or mutate other external systems."}\n- Preserve branch ownership, report verification and Git/PR results, and do not delegate to another agent.`
    : githubReview
      ? `\n\nDelegated Codex review contract:\n- Treat workspace source and Git state as read-only.\n- Run only the requested verification commands when permitted by the sandbox.\n- Write the durable review only through github_review.write_handoff, which is bound to ${absoluteHandoffPath}.\n- Then submit exactly one formal review through github_review.submit_pr_review to ${githubReview.repository} PR #${githubReview.prNumber} at ${githubReview.headSha} as ${githubReview.expectedLogin}.\n- Do not use general GitHub, shell mutation, commit, push, or another agent.`
      : "";
  const yolo = mode === "work" && permissionProfile === "yolo";
  const arguments_ = {
    prompt: `${prompt}${workContract}`,
    cwd,
    sandbox: yolo ? "danger-full-access" : mode === "work" ? "workspace-write" : "read-only",
    "approval-policy": "never",
  };
  if (model) arguments_.model = model;
  arguments_.config = {};
  if (mode === "work" && !yolo) {
    arguments_.config["sandbox_workspace_write.network_access"] = workProfile === "deliver";
  }
  if (githubReview) {
    arguments_.config["mcp_servers.github_review.enabled"] = true;
    arguments_.config["mcp_servers.github_review.command"] = process.execPath;
    arguments_.config["mcp_servers.github_review.args"] = [githubReviewBridgePath];
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_REPOSITORY"] = githubReview.repository;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_PR_NUMBER"] = String(githubReview.prNumber);
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_HEAD_SHA"] = githubReview.headSha;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_EXPECTED_LOGIN"] = githubReview.expectedLogin;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_HANDOFF_PATH"] = absoluteHandoffPath;
    arguments_.config["mcp_servers.github_review.env.GITHUB_REVIEW_TOKEN_FILE"] = resolve(homedir(), ".config/ghtoken");
    arguments_.config["mcp_servers.github_review.default_tools_approval_mode"] = "approve";
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
  timeoutSeconds = 7200,
  permissionProfile = "standard",
}) {
  const arguments_ = { prompt, cwd, mode, timeoutSeconds, permissionProfile };
  if (model) arguments_.model = model;
  if (sessionId) {
    arguments_.conversationId = sessionId;
    return { name: "continue_antigravity", arguments: arguments_ };
  }
  return { name: "ask_antigravity", arguments: arguments_ };
}

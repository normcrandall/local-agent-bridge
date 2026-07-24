import assert from "node:assert/strict";
import {
  antigravityToolRequest,
  claudeToolRequest,
  codexToolRequest,
} from "../src/tool-requests.mjs";
import {
  DEFAULT_NON_FABLE_CLAUDE_MODEL,
  isFableModel,
  loadConfiguredClaudeModel,
  resolveClaudeModelPolicy,
} from "../src/claude-model-policy.mjs";
import { configuredModelFallbacksPath, mergeRecommendedWriterFallbacks } from "../src/model-fallbacks.mjs";

const mergedWriterFallbacks = mergeRecommendedWriterFallbacks({
  version: 1,
  providers: { docker: { fallbackModels: ["custom-docker"] }, codex: { fallbackModels: [] } },
});
assert.deepEqual(mergedWriterFallbacks.providers.codex.fallbackModels, [], "explicit empty writer fallback is an opt-out");
assert.deepEqual(mergedWriterFallbacks.providers.docker.fallbackModels, ["custom-docker"], "unrelated user policy is preserved");
assert.deepEqual(mergedWriterFallbacks.providers.antigravity.fallbackModels, [
  "gemini-3.6-flash-medium", "gemini-3.6-flash-low", "gemini-3.5-flash-high",
]);
const priorFallbackPath = process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG;
process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG = "/tmp/bridge-custom-fallbacks.json";
assert.equal(configuredModelFallbacksPath(), "/tmp/bridge-custom-fallbacks.json");
if (priorFallbackPath === undefined) delete process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG;
else process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG = priorFallbackPath;

const claudeDefault = claudeToolRequest({ prompt: "test" });
assert.equal(claudeDefault.name, "ask_claude");
assert.equal(Object.hasOwn(claudeDefault.arguments, "model"), false);
assert.equal(Object.hasOwn(claudeDefault.arguments, "allowFable"), false);

const claudeFableOptIn = claudeToolRequest({ prompt: "test", model: "fable", allowFable: true });
assert.equal(claudeFableOptIn.arguments.allowFable, true);

const blockedRequestedFable = resolveClaudeModelPolicy({ model: "fable" });
assert.equal(DEFAULT_NON_FABLE_CLAUDE_MODEL, "claude-opus-5");
assert.equal(blockedRequestedFable.model, DEFAULT_NON_FABLE_CLAUDE_MODEL);
assert.deepEqual(blockedRequestedFable.blockedModels, ["fable"]);
const blockedConfiguredFable = resolveClaudeModelPolicy({ configuredModel: "claude-fable-latest" });
assert.equal(blockedConfiguredFable.model, DEFAULT_NON_FABLE_CLAUDE_MODEL);
const preservedConfiguredOpus = resolveClaudeModelPolicy({ configuredModel: "claude-opus-5" });
assert.equal(preservedConfiguredOpus.model, "claude-opus-5");
const filteredFableFallback = resolveClaudeModelPolicy({
  model: "claude-opus-4-8[1m]",
  fallbackModels: ["fable", "claude-opus-4-6", "fable"],
});
assert.deepEqual(filteredFableFallback.fallbackModels, ["claude-opus-4-6"]);
assert.deepEqual(filteredFableFallback.blockedModels, ["fable"]);
const allowedFable = resolveClaudeModelPolicy({
  model: "fable",
  fallbackModels: ["claude-fable-latest"],
  allowFable: true,
});
assert.equal(allowedFable.model, "fable");
assert.deepEqual(allowedFable.fallbackModels, ["claude-fable-latest"]);
assert.equal(allowedFable.allowFable, true);
assert.throws(
  () => resolveClaudeModelPolicy({ replacementModel: "fable" }),
  /must not resolve to Fable/,
);
assert.equal(isFableModel("CLAUDE-FABLE-LATEST"), true);
assert.equal(isFableModel("claude-opus-4-8[1m]"), false);
assert.equal(
  loadConfiguredClaudeModel({
    cwd: "/missing",
    home: "/missing",
    environment: { CLAUDE_MODEL: "configured-model" },
  }),
  "configured-model",
);

const claudeExplicit = claudeToolRequest({
  prompt: "test",
  model: "user-claude-model",
  fallbackModels: ["user-claude-fallback"],
});
assert.equal(claudeExplicit.arguments.model, "user-claude-model");
assert.deepEqual(claudeExplicit.arguments.fallbackModels, ["user-claude-fallback"]);
assert.equal(Object.hasOwn(claudeDefault.arguments, "fallbackModels"), false);
const claudeReply = claudeToolRequest({
  prompt: "continue",
  sessionId: "claude-session",
  model: "user-claude-model",
});
assert.equal(claudeReply.name, "continue_claude");
assert.equal(claudeReply.arguments.model, "user-claude-model");
const claudeReviewPermissions = claudeToolRequest({
  prompt: "verify",
  verificationCommands: ["npm test"],
  handoffPath: ".bridge/handoffs/review.md",
  githubReview: {
    repository: "owner/repo",
    prNumber: 42,
    headSha: "a".repeat(40),
    expectedLogin: "review-bot",
  },
});
assert.deepEqual(claudeReviewPermissions.arguments.verificationCommands, ["npm test"]);
assert.equal(claudeReviewPermissions.arguments.handoffPath, ".bridge/handoffs/review.md");
assert.equal(claudeReviewPermissions.arguments.githubReview.expectedLogin, "review-bot");
const claudeWorkPermissions = claudeToolRequest({
  prompt: "implement",
  mode: "work",
  workProfile: "deliver",
  workCommands: ["npm test", "git push -u origin task-08"],
});
assert.deepEqual(claudeWorkPermissions.arguments.workCommands, ["npm test", "git push -u origin task-08"]);
assert.equal(claudeWorkPermissions.arguments.workProfile, "deliver");
assert.equal(claudeToolRequest({ prompt: "go", mode: "work", permissionProfile: "yolo" }).arguments.permissionProfile, "yolo");

const antigravityCommandReview = antigravityToolRequest({
  prompt: "review",
  mode: "review",
  permissionProfile: "yolo",
  verificationCommands: ["npm test", "git diff --check"],
});
assert.equal(antigravityCommandReview.arguments.permissionProfile, "yolo");
assert.deepEqual(antigravityCommandReview.arguments.verificationCommands, ["npm test", "git diff --check"]);
assert.equal(antigravityCommandReview.arguments.prompt, "review");

const codexDefault = codexToolRequest({ prompt: "test", cwd: "/workspace" });
assert.equal(codexDefault.name, "codex");
assert.equal(Object.hasOwn(codexDefault.arguments, "model"), false);
for (const server of ["claude_code", "antigravity", "ollama", "docker", "collaboration", "playwright", "node_repl", "computer-use", "github_review"]) {
  assert.equal(
    Object.hasOwn(codexDefault.arguments.config, `mcp_servers.${server}.enabled`),
    false,
    `isolated delegated Codex must not create an incomplete ${server} MCP block`,
  );
}

const codexExplicit = codexToolRequest({
  prompt: "test",
  cwd: "/workspace",
  model: "user-codex-model",
  fallbackModels: ["user-codex-fallback"],
});
assert.equal(codexExplicit.arguments.model, "user-codex-model");
assert.deepEqual(codexExplicit.arguments.fallbackModels, ["user-codex-fallback"]);
assert.equal(Object.hasOwn(codexDefault.arguments, "fallbackModels"), false);
const codexImplement = codexToolRequest({
  prompt: "implement",
  cwd: "/workspace",
  mode: "work",
  workProfile: "implement",
});
assert.equal(codexImplement.arguments.sandbox, "workspace-write");
assert.equal(codexImplement.arguments.config["sandbox_workspace_write.network_access"], false);
assert.match(codexImplement.arguments.prompt, /Do not push/);
const codexDeliver = codexToolRequest({
  prompt: "deliver",
  cwd: "/workspace",
  mode: "work",
  workProfile: "deliver",
});
assert.equal(codexDeliver.arguments.config["sandbox_workspace_write.network_access"], true);
assert.match(codexDeliver.arguments.prompt, /push and pull-request creation/);
const codexWorkspaceHeadBuilder = codexToolRequest({
  prompt: "deliver a newly committed writer head",
  cwd: "/workspace",
  mode: "work",
  githubBuilder: {
    repository: "owner/repo",
    expectedLogin: "builder[bot]",
    baseSha: "a".repeat(40),
    headSha: "a".repeat(40),
    headRef: "codex/feature",
    baseRef: "main",
    allowedOperations: ["create_branch"],
    allowWorkspaceHead: true,
  },
  githubBuilderBridgePath: "/runtime/src/github-builder-bridge.mjs",
});
assert.equal(
  codexWorkspaceHeadBuilder.arguments.config["mcp_servers.github_builder.env.GITHUB_BUILDER_ALLOW_WORKSPACE_HEAD"],
  "1",
);
const codexYolo = codexToolRequest({ prompt: "go", cwd: "/workspace", mode: "work", permissionProfile: "yolo" });
assert.equal(codexYolo.arguments.sandbox, "danger-full-access");
assert.equal(codexYolo.arguments["approval-policy"], "never");
assert.equal(Object.hasOwn(codexYolo.arguments.config, "mcp_servers.collaboration.enabled"), false);
assert.match(codexYolo.arguments.prompt, /explicitly authorized danger-full-access/);
const codexBrowser = codexToolRequest({ prompt: "browse", cwd: "/workspace", browser: true, playwrightBridgePath: "/runtime/scripts/playwright-mcp.sh" });
assert.equal(codexBrowser.arguments.config["mcp_servers.playwright.enabled"], true);
assert.equal(codexBrowser.arguments.config["mcp_servers.playwright.command"], "/bin/zsh");
assert.deepEqual(codexBrowser.arguments.config["mcp_servers.playwright.args"], ["/runtime/scripts/playwright-mcp.sh"]);
assert.equal(Object.hasOwn(codexBrowser.arguments.config, "mcp_servers.collaboration.enabled"), false);
assert.throws(() => codexToolRequest({ prompt: "browse", cwd: "/workspace", browser: true }), /playwrightBridgePath/);
const codexReviewPublication = codexToolRequest({
  prompt: "review",
  cwd: "/workspace",
  mode: "review",
  verificationCommands: ["npm test"],
  handoffPath: "docs/handoffs/task-12.md",
  githubReview: {
    repository: "owner/repo",
    prNumber: 42,
    headSha: "a".repeat(40),
    expectedLogin: "review-bot",
  },
  githubReviewBridgePath: "/runtime/src/github-review-bridge.mjs",
});
assert.equal(codexReviewPublication.arguments.sandbox, "read-only");
assert.equal(codexReviewPublication.arguments.config["mcp_servers.github_review.command"], process.execPath);
assert.equal(codexReviewPublication.arguments.config["mcp_servers.github_review.enabled"], true);
assert.deepEqual(codexReviewPublication.arguments.config["mcp_servers.github_review.args"], ["/runtime/src/github-review-bridge.mjs"]);
assert.equal(codexReviewPublication.arguments.config["mcp_servers.github_review.env.GITHUB_REVIEW_REPOSITORY"], "owner/repo");
assert.equal(codexReviewPublication.arguments.config["mcp_servers.github_review.env.GITHUB_REVIEW_HANDOFF_PATH"], "/workspace/docs/handoffs/task-12.md");
assert.match(codexReviewPublication.arguments.prompt, /github_review\.write_handoff/);
assert.match(codexReviewPublication.arguments.prompt, /github_review\.submit_pr_review/);
assert.match(codexReviewPublication.arguments.prompt, /resolve every satisfied thread/);
const codexReply = codexToolRequest({
  prompt: "continue",
  cwd: "/workspace",
  sessionId: "codex-thread",
  model: "ignored-on-existing-thread",
});
assert.equal(codexReply.name, "codex-reply");
assert.equal(codexReply.arguments.prompt, "continue");
assert.equal(codexReply.arguments.threadId, "codex-thread");
assert.equal(codexReply.arguments.cwd, "/workspace");
assert.equal(codexReply.arguments.sandbox, "read-only");
assert.equal(codexReply.arguments["approval-policy"], "never");
assert.equal(codexReply.arguments.model, "ignored-on-existing-thread");

const antigravityYolo = antigravityToolRequest({ prompt: "go", mode: "work", permissionProfile: "yolo" });
assert.equal(antigravityYolo.arguments.permissionProfile, "yolo");

const antigravityDefault = antigravityToolRequest({ prompt: "test" });
assert.equal(antigravityDefault.name, "ask_antigravity");
assert.equal(Object.hasOwn(antigravityDefault.arguments, "model"), false);

const antigravityExplicit = antigravityToolRequest({
  prompt: "test",
  model: "Gemini 3.1 Pro (High)",
  fallbackModels: ["Gemini 3.1 Pro (Low)"],
});
assert.equal(antigravityExplicit.arguments.model, "Gemini 3.1 Pro (High)");
assert.deepEqual(antigravityExplicit.arguments.fallbackModels, ["Gemini 3.1 Pro (Low)"]);
const antigravityReply = antigravityToolRequest({
  prompt: "continue",
  sessionId: "00000000-0000-4000-8000-000000000000",
});
assert.equal(antigravityReply.name, "continue_antigravity");
assert.equal(antigravityReply.arguments.conversationId, "00000000-0000-4000-8000-000000000000");

console.log("Model routing tests passed: explicit overrides pass through and Fable requires per-request authorization.");

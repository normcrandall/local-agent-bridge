import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");
const cleanProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => (
      !name.startsWith("BRIDGE_")
      && !["CLAUDE_BRIDGE_ACTIVE", "CODEX_BRIDGE_ACTIVE", "ANTIGRAVITY_BRIDGE_ACTIVE"].includes(name)
    )),
  ),
  AGENT_BRIDGE_MODEL_POLICY_CONFIG: resolve(tmpdir(), `bridge-smoke-model-policy-${process.pid}.json`),
};

async function listTools(label, command, args, env) {
  const client = new Client({ name: "bridge-smoke-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command, args, cwd: root, env });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    console.log(`${label}: ${names.join(", ")}`);
    return result.tools;
  } finally {
    await client.close();
  }
}

async function callBridgeWithoutModel() {
  const client = new Client({ name: "bridge-call-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: [resolve(root, "scripts/claude-bridge-mcp.sh")],
    cwd: root,
    env: { ...cleanProcessEnv, CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs") },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "bridge smoke test",
        browser: true,
        model: "custom-claude-model-id",
        fallbackModels: ["claude-opus-4-6", "claude-sonnet-5"],
        mode: "review",
        verificationCommands: ["npm test", "git diff --check"],
        handoffPath: ".bridge/test-handoffs/smoke-review.md",
        githubReview: {
          repository: "owner/repo",
          prNumber: 42,
          headSha: "a".repeat(40),
          expectedLogin: "review-bot",
        },
      },
    });
    if (result.isError) throw new Error("Bridge tool returned an error");
    const serialized = JSON.stringify(result.content);
    if (
      !serialized.includes("mcp__playwright__*")
      || !serialized.includes("playwright")
      || !serialized.includes("--model")
      || !serialized.includes("custom-claude-model-id")
      || !serialized.includes("--fallback-model")
      || !serialized.includes("claude-opus-4-6,claude-sonnet-5")
    ) {
      throw new Error("Delegated browser or model configuration was not forwarded to Claude");
    }
    const invocation = JSON.parse(result.structuredContent.result);
    if (result.structuredContent.model !== "claude-opus-4-6") {
      throw new Error("Claude modelUsage was not surfaced in the routing receipt");
    }
    const permissionIndex = invocation.args.indexOf("--permission-mode");
    if (invocation.args[permissionIndex + 1] !== "dontAsk") {
      throw new Error("Claude review mode is not locked to dontAsk permissions");
    }
    const allowedIndex = invocation.args.indexOf("--allowedTools");
    const allowed = invocation.args.slice(allowedIndex + 1, permissionIndex);
    for (const rule of [
      "Read",
      "Glob",
      "Grep",
      "Bash(npm test)",
      "Bash(git diff --check)",
      `Edit(/${resolve(root, ".bridge/test-handoffs/smoke-review.md")})`,
      `Write(/${resolve(root, ".bridge/test-handoffs/smoke-review.md")})`,
      "mcp__github_review__submit_pr_review",
    ]) {
      if (!allowed.includes(rule)) throw new Error(`Claude review permission is missing: ${rule}`);
    }

    const noFallbackResult = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "bridge smoke test without fallback",
        fallbackModels: [],
        mode: "review",
      },
    });
    if (noFallbackResult.isError) throw new Error("Bridge no-fallback tool returned an error");
    const noFallbackInvocation = JSON.parse(noFallbackResult.structuredContent.result);
    if (noFallbackInvocation.args.includes("--fallback-model")) {
      throw new Error("An explicit empty Claude fallback list did not disable the machine policy");
    }
    const blockedFable = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "Fable must be replaced without current-request authorization",
        model: "fable",
        fallbackModels: ["claude-fable-latest", "claude-opus-4-6"],
      },
    });
    if (blockedFable.isError) throw new Error("Default-deny Fable bridge path returned an error");
    const blockedFableInvocation = JSON.parse(blockedFable.structuredContent.result);
    const blockedModelIndex = blockedFableInvocation.args.indexOf("--model");
    const blockedFallbackIndex = blockedFableInvocation.args.indexOf("--fallback-model");
    if (blockedFableInvocation.args[blockedModelIndex + 1].toLowerCase().includes("fable")) {
      throw new Error("Unauthorized Fable primary model reached Claude Code");
    }
    if (blockedFableInvocation.args[blockedFallbackIndex + 1].toLowerCase().includes("fable")) {
      throw new Error("Unauthorized Fable fallback reached Claude Code");
    }
    const allowedFable = await client.callTool({
      name: "ask_claude",
      arguments: { prompt: "Explicit Fable authorization", model: "fable", allowFable: true },
    });
    if (allowedFable.isError) throw new Error("Explicit Fable opt-in bridge path returned an error");
    const allowedFableInvocation = JSON.parse(allowedFable.structuredContent.result);
    const allowedModelIndex = allowedFableInvocation.args.indexOf("--model");
    if (allowedFableInvocation.args[allowedModelIndex + 1] !== "fable") {
      throw new Error("Explicitly authorized Fable model was not preserved");
    }
    const yolo = await client.callTool({
      name: "ask_claude",
      arguments: { prompt: "explicit yolo smoke test", mode: "work", permissionProfile: "yolo" },
    });
    if (yolo.isError) throw new Error("Claude YOLO work-mode bridge tool returned an error");
    const yoloInvocation = JSON.parse(yolo.structuredContent.result);
    if (!yoloInvocation.args.includes("--dangerously-skip-permissions")) {
      throw new Error("Claude YOLO mode did not bypass permission checks");
    }
    if (yoloInvocation.args.includes("--permission-mode")) {
      throw new Error("Claude YOLO mode retained the standard permission gate");
    }
    const rejectedReviewYolo = await client.callTool({
      name: "ask_claude",
      arguments: { prompt: "must reject", mode: "review", permissionProfile: "yolo" },
    });
    if (!rejectedReviewYolo.isError) throw new Error("Claude accepted YOLO permissions in review mode");
    if (!invocation.args.at(-1).includes("smoke-review.md")) {
      throw new Error("Claude review prompt did not identify the handoff path");
    }
    const delegatedConfig = invocation.mcpConfig.mcpServers.github_review;
    if (
      delegatedConfig?.env?.GITHUB_REVIEW_REPOSITORY !== "owner/repo"
      || delegatedConfig?.env?.GITHUB_REVIEW_PR_NUMBER !== "42"
      || delegatedConfig?.env?.GITHUB_REVIEW_EXPECTED_LOGIN !== "review-bot"
    ) {
      throw new Error("Bound GitHub review configuration was not forwarded to Claude");
    }
    const configuredDefault = await client.callTool({
      name: "ask_claude",
      arguments: { prompt: "configured model smoke test" },
    });
    if (configuredDefault.isError) throw new Error("Default-model bridge tool returned an error");
    const configuredDefaultInvocation = JSON.parse(configuredDefault.structuredContent.result);
    const configuredModelIndex = configuredDefaultInvocation.args.indexOf("--model");
    if (configuredModelIndex < 0 || !configuredDefaultInvocation.args[configuredModelIndex + 1]) {
      throw new Error("Bridge did not enforce a non-Fable configured/default model");
    }
    const work = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "implement task 8",
        mode: "work",
        workProfile: "deliver",
        workCommands: [
          "git switch -c task-08",
          "npm test",
          "git add src/task-08.mjs",
          "git commit -m 'feat: complete task 8'",
          "git push -u origin task-08",
          `gh pr merge 42 --squash --match-head-commit ${"a".repeat(40)}`,
        ],
      },
    });
    if (work.isError) throw new Error("Work-mode bridge tool returned an error");
    const workInvocation = JSON.parse(work.structuredContent.result);
    const workPermissionIndex = workInvocation.args.indexOf("--permission-mode");
    if (workInvocation.args[workPermissionIndex + 1] !== "dontAsk") {
      throw new Error("Claude work mode is not locked to dontAsk permissions");
    }
    const workAllowedIndex = workInvocation.args.indexOf("--allowedTools");
    const workAllowed = workInvocation.args.slice(workAllowedIndex + 1, workPermissionIndex);
    for (const rule of [
      "Read", "Glob", "Grep", "Edit", "Write",
      "Bash(git switch -c task-08)",
      "Bash(npm test)",
      "Bash(git add src/task-08.mjs)",
      "Bash(git commit -m 'feat: complete task 8')",
      "Bash(git push -u origin task-08)",
      `Bash(gh pr merge 42 --squash --match-head-commit ${"a".repeat(40)})`,
      "Bash(pnpm:*)",
      "Bash(shasum:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr comment:*)",
      "Bash(gh pr review:*)",
    ]) {
      if (!workAllowed.includes(rule)) throw new Error(`Claude work permission is missing: ${rule}`);
    }
    const exactWorkRules = new Set([
      "git switch -c task-08",
      "npm test",
      "git add src/task-08.mjs",
      "git commit -m 'feat: complete task 8'",
      "git push -u origin task-08",
      `gh pr merge 42 --squash --match-head-commit ${"a".repeat(40)}`,
    ].map((command) => `Bash(${command})`));
    const reusableBashRules = workAllowed.filter((rule) => (
      rule.startsWith("Bash(") && !exactWorkRules.has(rule)
    ));
    if (reusableBashRules.some((rule) => !/^Bash\([^)*]+:\*\)$/.test(rule))) {
      throw new Error("Claude work permissions contain an invalid reusable Bash prefix");
    }
    const expectedGitHubRules = new Set([
      "Bash(gh repo view:*)",
      "Bash(gh pr create:*)", "Bash(gh pr edit:*)", "Bash(gh pr view:*)",
      "Bash(gh pr checks:*)", "Bash(gh pr status:*)", "Bash(gh pr review:*)",
      "Bash(gh pr comment:*)", "Bash(gh pr ready:*)", "Bash(gh pr close:*)",
      "Bash(gh pr reopen:*)",
    ]);
    if (reusableBashRules.some((rule) => /^Bash\(gh(?::| )/.test(rule) && !expectedGitHubRules.has(rule))) {
      throw new Error("Claude deliver profile grants an unexpected broad GitHub command family");
    }
    if (workAllowed.includes("Bash(gh pr merge:*)")) {
      throw new Error("Claude deliver profile grants unbound pull-request merge access");
    }
    const rejectedUnpinnedMerge = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "must reject unpinned merge",
        mode: "work",
        workProfile: "deliver",
        workCommands: ["gh pr merge 42 --squash"],
      },
    });
    if (!rejectedUnpinnedMerge.isError) {
      throw new Error("Claude deliver profile accepted an unpinned pull-request merge");
    }
    const rejectedCrossRepositoryMerge = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "must reject cross-repository merge",
        mode: "work",
        workProfile: "deliver",
        workCommands: [`gh pr merge 42 --repo other/repo --squash --match-head-commit ${"a".repeat(40)}`],
      },
    });
    if (!rejectedCrossRepositoryMerge.isError) {
      throw new Error("Claude deliver profile accepted a cross-repository pull-request merge");
    }
    const rejectedComposedMerge = await client.callTool({
      name: "ask_claude",
      arguments: {
        prompt: "must reject shell-composed merge",
        mode: "work",
        workProfile: "deliver",
        workCommands: [`echo preparing && gh pr merge 42 --squash --match-head-commit ${"a".repeat(40)}`],
      },
    });
    if (!rejectedComposedMerge.isError) {
      throw new Error("Claude deliver profile accepted a shell-composed pull-request merge");
    }
    if (!workInvocation.args.at(-1).includes("git push -u origin task-08")) {
      throw new Error("Claude work prompt did not identify the exact authorized commands");
    }
    const implement = await client.callTool({
      name: "ask_claude",
      arguments: { prompt: "implement without delivery", mode: "work", workProfile: "implement" },
    });
    if (implement.isError) throw new Error("Claude implement-profile bridge tool returned an error");
    const implementInvocation = JSON.parse(implement.structuredContent.result);
    const implementPermissionIndex = implementInvocation.args.indexOf("--permission-mode");
    const implementAllowedIndex = implementInvocation.args.indexOf("--allowedTools");
    const implementAllowed = implementInvocation.args.slice(
      implementAllowedIndex + 1,
      implementPermissionIndex,
    );
    for (const rule of ["Bash(git status:*)", "Bash(git commit:*)", "Bash(pnpm:*)", "Bash(shasum:*)"]) {
      if (!implementAllowed.includes(rule)) {
        throw new Error(`Claude implement profile is missing its local permission: ${rule}`);
      }
    }
    if (implementAllowed.includes("Bash(git push:*)") || implementAllowed.some((rule) => /^Bash\(gh(?::| )/.test(rule))) {
      throw new Error("Claude implement profile unexpectedly grants delivery permissions");
    }
    console.log("Claude bridge call paths: explicit model forwarded; default-deny Fable policy enforced");
  } finally {
    await client.close();
    await rm(resolve(root, ".bridge/test-handoffs"), { recursive: true, force: true });
  }
}

async function callAntigravityWithoutModel() {
  const workspace = await mkdtemp(resolve(tmpdir(), `bridge-smoke-workspace-${process.pid}-`));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  const client = new Client({ name: "antigravity-call-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: [resolve(root, "scripts/antigravity-bridge-mcp.sh")],
    cwd: workspace,
    env: {
      ...cleanProcessEnv,
      AGY_BIN: resolve(root, "scripts/fake-antigravity.mjs"),
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspace,
      FAKE_ANTIGRAVITY_OVERLOAD_MODELS: "overloaded-antigravity-model",
    },
  });
  try {
    await client.connect(transport);
    const explicit = await client.callTool({
      name: "ask_antigravity",
      arguments: { prompt: "bridge smoke test", model: "custom-antigravity-model", mode: "review" },
    });
    if (explicit.isError) throw new Error("Antigravity bridge tool returned an error");
    const serialized = JSON.stringify(explicit.content);
    if (!serialized.includes("--model") || !serialized.includes("custom-antigravity-model")) {
      throw new Error("Explicit Antigravity model was not forwarded");
    }
    if (!serialized.includes("--mode") || !serialized.includes("plan") || !serialized.includes("--sandbox")) {
      throw new Error("Antigravity review sandbox configuration was not forwarded");
    }
    if (!serialized.includes("--add-dir")) {
      throw new Error("Antigravity delegated workspace was not added explicitly");
    }
    if ((serialized.match(/--add-dir/g) || []).length < 2) {
      throw new Error("Antigravity Git metadata directories were not added explicitly");
    }
    const fallback = await client.callTool({
      name: "ask_antigravity",
      arguments: {
        prompt: "bridge fallback smoke test",
        model: "overloaded-antigravity-model",
        fallbackModels: ["available-antigravity-model"],
        mode: "review",
      },
    });
    if (fallback.isError) throw new Error("Antigravity overload fallback returned an error");
    if (fallback.structuredContent?.modelRouting?.model !== "available-antigravity-model"
      || fallback.structuredContent?.modelRouting?.fallbackUsed !== true) {
      throw new Error("Antigravity bridge did not apply its overload fallback chain");
    }
    const configuredDefault = await client.callTool({
      name: "ask_antigravity",
      arguments: { prompt: "configured model smoke test" },
    });
    if (configuredDefault.isError) throw new Error("Default-model Antigravity tool returned an error");
    if (JSON.stringify(configuredDefault.content).includes("--model")) {
      throw new Error("Bridge injected an Antigravity model when the user did not request one");
    }
    const yolo = await client.callTool({
      name: "ask_antigravity",
      arguments: { prompt: "explicit yolo smoke test", mode: "work", permissionProfile: "yolo" },
    });
    if (yolo.isError) throw new Error("Antigravity YOLO work-mode bridge tool returned an error");
    const yoloSerialized = JSON.stringify(yolo.content);
    if (!yoloSerialized.includes("--dangerously-skip-permissions") || yoloSerialized.includes("--sandbox")) {
      throw new Error("Antigravity YOLO mode did not replace the terminal sandbox with auto-approval");
    }
    const staticReviewYolo = await client.callTool({
      name: "ask_antigravity",
      arguments: { prompt: "static review", mode: "review", permissionProfile: "yolo" },
    });
    if (!staticReviewYolo.isError) {
      throw new Error("Antigravity accepted manually configured YOLO permissions for a static review");
    }
    const reviewYolo = await client.callTool({
      name: "ask_antigravity",
      arguments: {
        prompt: "command-running review",
        mode: "review",
        permissionProfile: "standard",
        verificationCommands: ["npm test"],
      },
    });
    if (reviewYolo.isError) throw new Error("Antigravity rejected unrestricted permissions in review mode");
    const reviewYoloSerialized = JSON.stringify(reviewYolo.content);
    if (!reviewYoloSerialized.includes("--dangerously-skip-permissions")
      || reviewYoloSerialized.includes("--sandbox")
      || !reviewYoloSerialized.includes("plan")) {
      throw new Error("Antigravity review YOLO mode did not use plan mode with unrestricted tool approval");
    }
    console.log("Antigravity bridge call paths: explicit model forwarded; configured default preserved");
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testBrowserRuntime() {
  const client = new Client({ name: "browser-runtime-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(root, "node_modules/@playwright/mcp/cli.js"),
      "--browser",
      "chrome",
      "--isolated",
      "--headless",
    ],
    cwd: root,
  });
  try {
    await client.connect(transport);
    const navigation = await client.callTool({
      name: "browser_navigate",
      arguments: { url: "data:text/html,<title>Bridge Smoke</title><h1>Bridge browser works</h1>" },
    });
    if (navigation.isError || !JSON.stringify(navigation.content).includes("Bridge browser works")) {
      throw new Error("Playwright browser runtime did not return the test page");
    }
    await client.callTool({ name: "browser_close", arguments: {} });
    console.log("Playwright browser runtime: passed in isolated headless Chrome");
  } finally {
    await client.close();
  }
}

const bridgeTools = await listTools(
  "Claude bridge",
  "/bin/zsh",
  [resolve(root, "scripts/claude-bridge-mcp.sh")],
);
const codexTools = await listTools(
  "Codex server",
  "/bin/zsh",
  [resolve(root, "scripts/codex-mcp.sh")],
);
const antigravityTools = await listTools(
  "Antigravity bridge",
  "/bin/zsh",
  [resolve(root, "scripts/antigravity-bridge-mcp.sh")],
);
const collaborationTools = await listTools(
  "Persistent collaboration",
  "/bin/zsh",
  [resolve(root, "scripts/collaboration-bridge-mcp.sh")],
);
const browserTools = await listTools(
  "Playwright server",
  "/bin/zsh",
  [resolve(root, "scripts/playwright-mcp.sh")],
);

const names = (tools) => tools.map((tool) => tool.name);

for (const required of ["ask_claude", "continue_claude"]) {
  if (!names(bridgeTools).includes(required)) throw new Error(`Missing bridge tool: ${required}`);
}
for (const required of ["codex", "codex-reply"]) {
  if (!names(codexTools).includes(required)) throw new Error(`Missing Codex tool: ${required}`);
}
for (const required of ["ask_antigravity", "continue_antigravity"]) {
  if (!names(antigravityTools).includes(required)) throw new Error(`Missing bridge tool: ${required}`);
}
for (const required of [
  "acknowledge_coordinator_wake",
  "start_collaboration",
  "get_collaboration",
  "continue_collaboration",
  "cancel_collaboration",
  "list_collaborations",
  "plan_portfolio",
  "create_portfolio",
  "get_portfolio",
  "update_portfolio_item",
  "wait_for_portfolio_lane",
  "enqueue_portfolio_merge",
  "begin_portfolio_merge_validation",
  "record_portfolio_merge_validation",
  "authorize_portfolio_merge",
  "recover_portfolio_merge_validation",
  "refresh_portfolio_target",
  "record_portfolio_merge",
]) {
  if (!names(collaborationTools).includes(required)) throw new Error(`Missing collaboration tool: ${required}`);
}
if (!names(browserTools).includes("browser_navigate")) {
  throw new Error("Missing Playwright tool: browser_navigate");
}

const codexSchema = codexTools.find((tool) => tool.name === "codex")?.inputSchema?.properties || {};
for (const property of ["prompt", "cwd", "sandbox", "approval-policy", "config", "model", "fallbackModels"]) {
  if (!(property in codexSchema)) throw new Error(`Codex tool schema is missing: ${property}`);
}
const replySchema = codexTools.find((tool) => tool.name === "codex-reply")?.inputSchema?.properties || {};
if (!("threadId" in replySchema) || !("prompt" in replySchema)) {
  throw new Error("Codex reply schema is missing threadId or prompt");
}
const claudeSchema = bridgeTools.find((tool) => tool.name === "ask_claude")?.inputSchema?.properties || {};
for (const property of [
  "prompt",
  "mode",
  "browser",
  "model",
  "fallbackModels",
  "allowFable",
  "verificationCommands",
  "workCommands",
  "workProfile",
  "handoffPath",
  "githubReview",
]) {
  if (!(property in claudeSchema)) throw new Error(`Claude bridge schema is missing: ${property}`);
}
const antigravitySchema = antigravityTools.find((tool) => tool.name === "ask_antigravity")?.inputSchema?.properties || {};
for (const property of ["prompt", "mode", "model", "fallbackModels", "verificationCommands"]) {
  if (!(property in antigravitySchema)) throw new Error(`Antigravity bridge schema is missing: ${property}`);
}
const collaborationSchema = collaborationTools.find((tool) => tool.name === "start_collaboration")?.inputSchema?.properties || {};
for (const property of [
  "task",
  "agents",
  "startAgent",
  "workspace",
  "mode",
  "writer",
  "maxTurns",
  "models",
  "modelFallbacks",
  "allowClaudeFable",
  "providerRecovery",
  "verificationCommands",
  "workCommands",
  "workProfile",
  "handoffPath",
  "githubReview",
]) {
  if (!(property in collaborationSchema)) throw new Error(`Collaboration schema is missing: ${property}`);
}
console.log("Conversation broker schemas: compatible");

await callBridgeWithoutModel();
await callAntigravityWithoutModel();
await testBrowserRuntime();
console.log("MCP smoke test passed without invoking any model.");

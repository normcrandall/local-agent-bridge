import { isAbsolute, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { antigravityToolRequest, claudeToolRequest, codexToolRequest } from "./tool-requests.mjs";
import { parseReviewEnvelope, reviewEnvelopeInstructions } from "./review-envelope.mjs";
import { loadConfiguredFallbackModels } from "./model-fallbacks.mjs";

function textFrom(result) {
  const structured = result.structuredContent || {};
  const message = structured.result || structured.content;
  if (typeof message === "string" && message.trim()) return message;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function sessionFrom(agent, result) {
  const structured = result.structuredContent || {};
  if (agent === "claude") return structured.sessionId || null;
  if (agent === "codex") return structured.threadId || null;
  return structured.conversationId || null;
}

export function createAgentPool({
  root,
  workspace = root,
  models = {},
  modelFallbacks = {},
  verificationCommands = [],
  workCommands = [],
  workProfile = "exact",
  permissionProfile = "standard",
  handoffPath = null,
  githubReview = null,
  requestTimeoutMs = 4 * 60 * 60 * 1000 + 5 * 60 * 1000,
  turnTimeoutSeconds = 600,
}) {
  const clients = {};

  async function publishAntigravityReview(message) {
    const envelope = parseReviewEnvelope(message);
    const absoluteHandoffPath = resolve(workspace, handoffPath);
    const fromWorkspace = relative(workspace, absoluteHandoffPath);
    if (fromWorkspace === ".." || fromWorkspace.startsWith("../") || isAbsolute(fromWorkspace)) {
      throw new Error("Antigravity handoffPath must stay inside the delegated workspace.");
    }
    const publisher = new Client({ name: "agent-bridge-antigravity-review-publisher", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(root, "src/github-review-bridge.mjs")],
      cwd: root,
      env: {
        ...process.env,
        GITHUB_REVIEW_REPOSITORY: githubReview.repository,
        GITHUB_REVIEW_PR_NUMBER: String(githubReview.prNumber),
        GITHUB_REVIEW_HEAD_SHA: githubReview.headSha,
        GITHUB_REVIEW_EXPECTED_LOGIN: githubReview.expectedLogin,
        GITHUB_REVIEW_HANDOFF_PATH: absoluteHandoffPath,
        GITHUB_REVIEW_TOKEN_FILE: resolve(process.env.HOME, ".config/ghtoken"),
      },
    });
    try {
      await publisher.connect(transport, { timeout: 5_000 });
      const handoff = await publisher.callTool({
        name: "write_handoff",
        arguments: { content: envelope.handoff },
      });
      if (handoff.isError) throw new Error(`Antigravity handoff publication failed: ${textFrom(handoff)}`);
      const review = await publisher.callTool({
        name: "submit_pr_review",
        arguments: { event: envelope.event, body: envelope.body, comments: envelope.comments },
      });
      if (review.isError) throw new Error(`Antigravity PR review publication failed: ${textFrom(review)}`);
      return review.structuredContent;
    } finally {
      await publisher.close().catch(() => {});
    }
  }

  async function clientFor(agent) {
    if (clients[agent]) return clients[agent];
    const scripts = {
      claude: "scripts/claude-bridge-mcp.sh",
      codex: "scripts/codex-mcp.sh",
      antigravity: "scripts/antigravity-bridge-mcp.sh",
    };
    const client = new Client({ name: `agent-bridge-worker-${agent}`, version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: "/bin/zsh",
      args: [resolve(root, scripts[agent])],
      cwd: root,
      env: { ...process.env, BRIDGE_DELEGATED_SESSION: "1" },
    });
    try {
      await client.connect(transport, { timeout: 5_000 });
      clients[agent] = client;
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  return {
    async probe(agent) {
      try {
        const client = await clientFor(agent);
        const tools = await client.listTools({}, { timeout: 5_000 });
        if (!tools.tools?.length) throw new Error(`${agent} MCP server exposed no tools.`);
        return { agent, available: true };
      } catch (error) {
        return { agent, available: false, reason: error?.message || String(error) };
      }
    },
    async send({ agent, prompt, sessionId, mode, browser }, onProgress = () => {}) {
      const client = await clientFor(agent);
      const effectivePermissionProfile = mode === "work" ? permissionProfile : "standard";
      let request;
      if (agent === "claude") {
        request = claudeToolRequest({
          prompt,
          sessionId,
          cwd: workspace,
          mode,
          browser,
          model: models.claude,
          fallbackModels: modelFallbacks.claude,
          verificationCommands,
          workCommands,
          workProfile,
          permissionProfile: effectivePermissionProfile,
          handoffPath,
          githubReview: mode === "review" ? githubReview : null,
          timeoutSeconds: turnTimeoutSeconds,
        });
      } else if (agent === "codex") {
        request = codexToolRequest({
          prompt,
          sessionId,
          cwd: workspace,
          mode,
          browser,
          model: models.codex,
          fallbackModels: modelFallbacks.codex,
          workProfile,
          permissionProfile: effectivePermissionProfile,
          verificationCommands,
          handoffPath,
          githubReview: mode === "review" ? githubReview : null,
          githubReviewBridgePath: resolve(root, "src/github-review-bridge.mjs"),
          playwrightBridgePath: resolve(root, "scripts/playwright-mcp.sh"),
        });
      } else {
        const antigravityPrompt = githubReview && mode === "review"
          ? `${prompt}${reviewEnvelopeInstructions({ githubReview, handoffPath })}`
          : prompt;
        request = antigravityToolRequest({
          prompt: antigravityPrompt,
          sessionId,
          cwd: workspace,
          mode,
          model: models.antigravity,
          timeoutSeconds: turnTimeoutSeconds,
          permissionProfile: effectivePermissionProfile,
        });
      }
      request._meta = { progressToken: `${agent}-${Date.now()}` };
      let fallbackSlots = 0;
      if (["claude", "codex"].includes(agent)) {
        if (Array.isArray(modelFallbacks[agent])) {
          fallbackSlots = modelFallbacks[agent].length;
        } else {
          try {
            fallbackSlots = loadConfiguredFallbackModels(agent).length;
          } catch {
            // The provider adapter emits the visible warning and fails open.
            fallbackSlots = 0;
          }
        }
      }
      const maxTotalTimeoutMs = requestTimeoutMs * (1 + fallbackSlots);
      let result;
      try {
        result = await client.callTool(request, undefined, {
          timeout: requestTimeoutMs,
          maxTotalTimeout: maxTotalTimeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => onProgress({
            at: new Date().toISOString(),
            progress: progress.progress,
            total: progress.total,
            summary: progress.message || null,
          }),
        });
      } catch (error) {
        if (/timed out|timeout|transport closed|connection closed/i.test(error?.message || String(error))) {
          error.indeterminate = true;
        }
        throw error;
      }
      if (result.isError) throw new Error(`${agent} MCP call failed: ${textFrom(result)}`);
      let message = textFrom(result);
      if (agent === "antigravity" && githubReview && mode === "review") {
        const receipt = await publishAntigravityReview(message);
        message = `${message}\n\nBound review published as ${receipt.login}: ${receipt.url}`;
      }
      const structured = result.structuredContent || {};
      return {
        message,
        sessionId: sessionFrom(agent, result),
        metadata: {
          usage: structured.usage || structured.tokenUsage || null,
          durationMs: structured.durationMs || structured.duration_ms || null,
          modelRouting: ["claude", "codex"].includes(agent) ? {
            requestedModel: structured.requestedModel ?? null,
            model: structured.model ?? null,
            fallbackUsed: structured.fallbackUsed ?? null,
            attemptedModels: structured.attemptedModels || structured.modelsUsed || [],
            fallbackModels: structured.modelFallbacks || modelFallbacks[agent] || [],
            fallbackManagedBy: structured.fallbackManagedBy ?? null,
          } : null,
        },
      };
    },
    async close() {
      await Promise.allSettled(Object.values(clients).map((client) => client.close()));
    },
  };
}

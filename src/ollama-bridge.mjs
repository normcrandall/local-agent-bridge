#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertOllamaFallbackAllowed } from "./local-review-priority.mjs";
import { probeOllama, runOllamaReview } from "./ollama-review.mjs";
import { loadOllamaSession, saveOllamaSession } from "./ollama-session-store.mjs";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const sessions = new Map();

const sharedInput = {
  prompt: z.string().min(1).describe("A self-contained review task for the local Ollama model."),
  cwd: z.string().optional().describe("Project-relative directory. Defaults to the bridge workspace root."),
  mode: z.enum(["review", "work"]).default("review").describe("Ollama is review-only; work is rejected."),
  model: z.string().trim().min(1).optional().describe("Optional Ollama model. Omit to use ~/.config/local-agent-bridge/ollama.json or qwen3.6:latest."),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe("Ordered local models used only when the preferred model cannot fit or the Ollama server is overloaded."),
  timeoutSeconds: z.number().int().min(10).max(7200).default(1800),
};

function toolResponse(result, conversationId) {
  const structured = {
    ...result,
    messages: undefined,
    conversationId,
    isError: false,
  };
  return {
    content: [{ type: "text", text: result.result }],
    structuredContent: structured,
    isError: false,
  };
}

async function runWithProgress(input, extra, conversationId = null) {
  if (input.mode !== "review") {
    throw new Error("Ollama is configured as a review-only provider; mode work is not permitted.");
  }
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
  const priority = await assertOllamaFallbackAllowed();
  await notify(`Docker Model Runner is unavailable (${priority.dockerUnavailableReason}); using the Ollama fallback.`);
  const existing = conversationId
    ? sessions.get(conversationId) || await loadOllamaSession(WORKSPACE_ROOT, conversationId)
    : null;
  await notify("Starting the local Ollama review.");
  const heartbeat = setInterval(() => {
    notify("The local reviewer is still working; its last repository action remains current.").catch(() => {});
  }, 10_000);
  heartbeat.unref?.();
  try {
    const result = await runOllamaReview({
      prompt: input.prompt,
      cwd: input.cwd || existing?.cwd || ".",
      workspaceRoot: WORKSPACE_ROOT,
      model: input.model || existing?.model,
      fallbackModels: input.fallbackModels,
      timeoutSeconds: input.timeoutSeconds,
      messages: existing?.messages || [],
      onProgress: (summary) => notify(summary).catch(() => {}),
    });
    const id = conversationId || randomUUID();
    const session = { messages: result.messages, cwd: input.cwd || existing?.cwd || ".", model: result.model };
    sessions.set(id, session);
    await saveOllamaSession(WORKSPACE_ROOT, id, session);
    return toolResponse(result, id);
  } finally {
    clearInterval(heartbeat);
  }
}

const server = new McpServer(
  { name: "local-ollama-review-bridge", version: "0.1.0" },
  {
    instructions: "Use ask_ollama only as a bounded local-review fallback when Docker Model Runner is unavailable. Calls fail closed while Docker is healthy. Ollama is hard-limited to read-only repository inspection and can never be a writer.",
  },
);

server.registerTool(
  "get_ollama_status",
  {
    title: "Check local Ollama reviewer",
    description: "Verify that Docker Model Runner is unavailable, then check the fallback Ollama reviewer.",
    inputSchema: { model: z.string().trim().min(1).optional() },
  },
  async ({ model }) => {
    const priority = await assertOllamaFallbackAllowed();
    const result = await probeOllama({ model });
    return {
      content: [{
        type: "text",
        text: `Ollama ${result.model} is available as fallback because Docker Model Runner is unavailable: ${priority.dockerUnavailableReason}`,
      }],
      structuredContent: { ...result, dockerUnavailableReason: priority.dockerUnavailableReason },
    };
  },
);

server.registerTool(
  "ask_ollama",
  {
    title: "Ask local Ollama reviewer",
    description: "Start a bounded Ollama fallback review only when Docker Model Runner is unavailable.",
    inputSchema: sharedInput,
  },
  (input, extra) => runWithProgress(input, extra),
);

server.registerTool(
  "continue_ollama",
  {
    title: "Continue local Ollama review",
    description: "Continue an Ollama fallback review only while Docker Model Runner remains unavailable.",
    inputSchema: {
      ...sharedInput,
      conversationId: z.string().uuid().describe("The conversationId returned by ask_ollama."),
    },
  },
  ({ conversationId, ...input }, extra) => runWithProgress(input, extra, conversationId),
);

await server.connect(new StdioServerTransport());

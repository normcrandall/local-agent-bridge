#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { probeDockerModelRunner, runDockerModelReview } from "./docker-review.mjs";
import { loadDockerSession, saveDockerSession } from "./docker-session-store.mjs";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const sessions = new Map();

const sharedInput = {
  prompt: z.string().min(1).describe("A self-contained review task for Docker Model Runner."),
  cwd: z.string().optional().describe("Project-relative directory. Defaults to the bridge workspace root."),
  mode: z.enum(["review", "work"]).default("review").describe("Docker Model Runner is review-only; work is rejected."),
  model: z.string().trim().min(1).optional().describe("Optional Docker Model Runner model. Omit to use machine configuration."),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe("Ordered local Docker models used only for memory/capacity failures."),
  timeoutSeconds: z.number().int().min(10).max(7200).default(1800),
};

function toolResponse(result, conversationId) {
  const structured = { ...result, messages: undefined, conversationId, isError: false };
  return {
    content: [{ type: "text", text: result.result }],
    structuredContent: structured,
    isError: false,
  };
}

async function runWithProgress(input, extra, conversationId = null) {
  if (input.mode !== "review") {
    throw new Error("Docker Model Runner is configured as a review-only provider; mode work is not permitted.");
  }
  const existing = conversationId
    ? sessions.get(conversationId) || await loadDockerSession(WORKSPACE_ROOT, conversationId)
    : null;
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
  await notify("Starting the Docker Model Runner review.");
  const heartbeat = setInterval(() => {
    notify("The Docker local reviewer is still working; its last repository action remains current.").catch(() => {});
  }, 10_000);
  heartbeat.unref?.();
  try {
    const result = await runDockerModelReview({
      prompt: input.prompt,
      cwd: input.cwd || existing?.cwd || ".",
      workspaceRoot: WORKSPACE_ROOT,
      model: input.model || existing?.model,
      fallbackModels: input.fallbackModels,
      messages: existing?.messages || [],
      timeoutSeconds: input.timeoutSeconds,
      onProgress: notify,
    });
    const id = conversationId || randomUUID();
    const session = {
      cwd: input.cwd || existing?.cwd || ".",
      model: result.model,
      messages: result.messages,
    };
    sessions.set(id, session);
    await saveDockerSession(WORKSPACE_ROOT, id, session);
    return toolResponse(result, id);
  } finally {
    clearInterval(heartbeat);
  }
}

const server = new McpServer(
  { name: "local-docker-model-review-bridge", version: "0.1.0" },
  {
    instructions: "Use ask_docker for bounded local code review and continue_docker only with its returned conversationId. Docker Model Runner is hard-limited to read-only repository inspection and can never be a writer.",
  },
);

server.registerTool(
  "get_docker_status",
  {
    title: "Check Docker Model Runner reviewer",
    description: "Verify that the loopback Docker Model Runner service is reachable and the selected review model is installed.",
    inputSchema: { model: z.string().trim().min(1).optional() },
  },
  async ({ model }) => {
    const result = await probeDockerModelRunner({ model });
    return { content: [{ type: "text", text: `Docker Model Runner ${result.model} is available.` }], structuredContent: result };
  },
);

server.registerTool(
  "ask_docker",
  {
    title: "Ask Docker Model Runner reviewer",
    description: "Ask a local Docker-hosted model for a bounded read-only repository review.",
    inputSchema: sharedInput,
  },
  async (input, extra) => runWithProgress(input, extra),
);

server.registerTool(
  "continue_docker",
  {
    title: "Continue Docker Model Runner review",
    description: "Continue a durable Docker Model Runner review conversation.",
    inputSchema: {
      ...sharedInput,
      conversationId: z.string().uuid().describe("The conversationId returned by ask_docker."),
    },
  },
  async ({ conversationId, ...input }, extra) => runWithProgress(input, extra, conversationId),
);

await server.connect(new StdioServerTransport());

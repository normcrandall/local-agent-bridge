#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  acknowledgeCoordinatorWake,
  coordinatorProvider,
  coordinatorWorkspaceMatches,
  currentCoordinatorState,
  listCoordinatorStates,
  markCoordinatorWakeDelivered,
} from "./coordinator-wake.mjs";

const POLL_MS = Math.max(500, Number.parseInt(process.env.AGENT_BRIDGE_WAKE_POLL_MS || "2000", 10));
const REDELIVER_MS = Math.max(30_000, Number.parseInt(process.env.AGENT_BRIDGE_WAKE_REDELIVER_MS || "120000", 10));
const root = process.env.BRIDGE_RUNTIME_ROOT || process.cwd();
const cwd = process.env.BRIDGE_WORKSPACE_ROOT || process.cwd();

const server = new Server(
  { name: "collaboration-wake", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "Collaboration completion events arrive as <channel source=\"collaboration-wake\">.",
      "For an actionable event, inspect the collaboration through the collaboration MCP, process its exact next action, then call acknowledge_wake on this channel.",
      "For needs_user or indeterminate events, explain the boundary to the user and do not continue autonomously.",
    ].join(" "),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "acknowledge_wake",
    description: "Acknowledge that the current Claude coordinator processed a durable collaboration wake.",
    inputSchema: {
      type: "object",
      properties: {
        collaborationId: { type: "string", pattern: "^bridge-[0-9a-f-]{36}$" },
        sequence: { type: "integer", minimum: 1 },
        summary: { type: "string", minLength: 1, maxLength: 20000 },
        action: { type: "string", enum: ["processed", "continued", "needs_user", "completed"] },
      },
      required: ["collaborationId", "sequence", "summary"],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "acknowledge_wake") {
    throw new Error(`Unknown channel tool: ${request.params.name}`);
  }
  const input = request.params.arguments || {};
  const current = await currentCoordinatorState(root, input.collaborationId);
  if (coordinatorProvider(current) !== "claude") {
    throw new Error(`Collaboration ${input.collaborationId} is not chaired by Claude.`);
  }
  if (!coordinatorWorkspaceMatches(current.workspace, cwd)) {
    throw new Error(`Collaboration ${input.collaborationId} is outside this Claude channel workspace.`);
  }
  const state = await acknowledgeCoordinatorWake(root, input.collaborationId, input.sequence, {
    provider: "claude",
    summary: input.summary,
    action: input.action || "processed",
  });
  return {
    content: [{
      type: "text",
      text: `Acknowledged collaboration wake ${state.coordinatorWake.sequence} for ${state.id}.`,
    }],
    structuredContent: { collaborationId: state.id, wake: state.coordinatorWake },
  };
});

await server.connect(new StdioServerTransport());

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const states = await listCoordinatorStates({ root, provider: "claude", cwd });
    for (const state of states) {
      try {
        const wake = state.coordinatorWake;
        if (!wake || wake.status === "acknowledged") continue;
        const deliveredAt = wake.deliveredAt ? Date.parse(wake.deliveredAt) : 0;
        if (wake.delivery?.adapter === "claude_channel" && Date.now() - deliveredAt < REDELIVER_MS) continue;
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: [
              `Collaboration ${state.id} produced wake ${wake.sequence}.`,
              `Kind: ${wake.kind}.`,
              `Next action: ${wake.nextAction}.`,
              `Summary: ${wake.summary}`,
              wake.actionable
                ? `Inspect with get_collaboration, process the next action, then call acknowledge_wake with collaborationId ${state.id} and sequence ${wake.sequence}.`
                : "This event requires user input or inspection. Do not continue it autonomously.",
            ].join("\n"),
            meta: {
              collaboration_id: state.id,
              wake_sequence: String(wake.sequence),
              wake_kind: wake.kind,
              next_action: wake.nextAction,
            },
          },
        });
        await markCoordinatorWakeDelivered(root, state.id, wake.sequence, {
          adapter: "claude_channel",
          processId: process.pid,
        });
      } catch (error) {
        process.stderr.write(`[collaboration-wake:${state.id}] ${error.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[collaboration-wake] ${error.message}\n`);
  } finally {
    scanning = false;
  }
}

await scan();
const timer = setInterval(scan, POLL_MS);
await new Promise((resolvePromise) => {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    resolvePromise();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, stop);
  }
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
});

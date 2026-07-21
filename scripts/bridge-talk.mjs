#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runConversation } from "../src/talk-protocol.mjs";
import { antigravityToolRequest, claudeToolRequest, codexToolRequest, ollamaToolRequest } from "../src/tool-requests.mjs";

const root = resolve(import.meta.dirname, "..");

function usage() {
  return `Usage:
  ./bridge talk [options] "task for the selected agents"

Options:
  --turns <2-20>       Maximum individual agent turns (default: 6)
  --agents <list>      Comma-separated agents (default: claude,codex)
                       Supported: claude,codex,antigravity,ollama
  --start <agent>      First agent; defaults to the first name in --agents
  --claude-model <id>  Claude alias or full model ID
  --codex-model <id>   Codex alias or full model ID
  --antigravity-model <label>  Antigravity model label
  --ollama-model <name> Local Ollama review model
  --work               Allow sequential workspace edits (default is read-only)
  --browser            Give both agents an isolated Playwright browser
  --dry-run            Validate and print configuration without model calls
  --help               Show this help

Examples:
  ./bridge talk "Review the current diff and agree on the real defects"
  ./bridge talk --agents claude,codex,antigravity "Stress-test this design"
  ./bridge talk --turns 8 --start codex "Design the API boundary for this module"
  ./bridge talk --claude-model claude-opus-4-8 --codex-model gpt-5.6 "Plan and implement the task"
  ./bridge talk --work "Implement the feature, then cross-review it"`;
}

function parseArgs(argv) {
  const options = {
    maxTurns: 6,
    agents: ["claude", "codex"],
    startAgent: null,
    mode: "review",
    browser: false,
    dryRun: false,
    claudeModel: null,
    codexModel: null,
    antigravityModel: null,
    ollamaModel: null,
  };
  const taskParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--work") { options.mode = "work"; continue; }
    if (arg === "--browser") { options.browser = true; continue; }
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--turns") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--turns requires a value");
      options.maxTurns = Number(value);
      continue;
    }
    if (arg === "--start") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--start requires a value");
      options.startAgent = value;
      continue;
    }
    if (arg === "--agents") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--agents requires a value");
      options.agents = value.split(",").map((agent) => agent.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--claude-model") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--claude-model requires a value");
      options.claudeModel = value;
      continue;
    }
    if (arg === "--codex-model") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--codex-model requires a value");
      options.codexModel = value;
      continue;
    }
    if (arg === "--antigravity-model") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--antigravity-model requires a value");
      options.antigravityModel = value;
      continue;
    }
    if (arg === "--ollama-model") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--ollama-model requires a value");
      options.ollamaModel = value;
      continue;
    }
    if (arg === "--") {
      taskParts.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    taskParts.push(arg);
  }
  return {
    ...options,
    startAgent: options.startAgent || options.agents[0],
    task: taskParts.join(" ").trim(),
  };
}

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

async function connect(script, name) {
  const client = new Client({ name: `codex-claude-talk-${name}`, version: "0.1.0" });
  const transport = new StdioClientTransport({ command: "/bin/zsh", args: [script], cwd: root });
  await client.connect(transport);
  return client;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.task) throw new Error(`A task is required.\n\n${usage()}`);
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 2 || options.maxTurns > 20) {
    throw new Error("--turns must be an integer from 2 to 20");
  }
  const supportedAgents = ["claude", "codex", "antigravity", "ollama"];
  if (
    options.agents.length < 2
    || options.agents.length > 4
    || new Set(options.agents).size !== options.agents.length
    || options.agents.some((agent) => !supportedAgents.includes(agent))
  ) {
    throw new Error("--agents must contain two to four unique values from claude,codex,antigravity,ollama");
  }
  if (!options.agents.includes(options.startAgent)) {
    throw new Error("--start must be included in --agents");
  }
  if (options.dryRun) {
    console.log(JSON.stringify({
      task: options.task,
      maxTurns: options.maxTurns,
      agents: options.agents,
      startAgent: options.startAgent,
      mode: options.mode,
      browser: options.browser,
      claudeModel: options.claudeModel || "default",
      codexModel: options.codexModel || "default",
      antigravityModel: options.antigravityModel || "default",
      ollamaModel: options.ollamaModel || "default",
    }, null, 2));
    return;
  }

  const transcriptDir = resolve(root, ".bridge/conversations");
  await mkdir(transcriptDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const transcriptPath = resolve(transcriptDir, `${stamp}-${randomUUID()}.jsonl`);
  const writeEvent = (event) => appendFile(transcriptPath, `${JSON.stringify(event)}\n`);
  await writeEvent({
    type: "conversation_started",
    at: new Date().toISOString(),
    task: options.task,
    mode: options.mode,
    browser: options.browser,
    maxTurns: options.maxTurns,
    startAgent: options.startAgent,
    agents: options.agents,
    claudeModel: options.claudeModel,
    codexModel: options.codexModel,
    antigravityModel: options.antigravityModel,
    ollamaModel: options.ollamaModel,
  });

  const clients = {};
  async function clientFor(agent) {
    if (clients[agent]) return clients[agent];
    const scripts = {
      claude: "scripts/claude-bridge-mcp.sh",
      codex: "scripts/codex-mcp.sh",
      antigravity: "scripts/antigravity-bridge-mcp.sh",
      ollama: "scripts/ollama-bridge-mcp.sh",
    };
    const script = resolve(root, scripts[agent]);
    clients[agent] = await connect(script, agent);
    return clients[agent];
  }

  async function send({ agent, prompt, sessionId, mode, browser }) {
    const client = await clientFor(agent);
    let request;
    if (agent === "claude") {
      request = claudeToolRequest({
          prompt,
          sessionId,
          mode,
          browser,
          model: options.claudeModel,
        });
    } else if (agent === "codex") {
      request = codexToolRequest({
          prompt,
          sessionId,
          cwd: root,
          mode,
          browser,
          model: options.codexModel,
          playwrightBridgePath: resolve(root, "scripts/playwright-mcp.sh"),
        });
    } else if (agent === "antigravity") {
      request = antigravityToolRequest({
        prompt,
        sessionId,
        cwd: root,
        mode,
        model: options.antigravityModel,
      });
    } else {
      request = ollamaToolRequest({
        prompt,
        sessionId,
        cwd: root,
        mode,
        model: options.ollamaModel,
      });
    }
    const result = await client.callTool(request);
    if (result.isError) throw new Error(`${agent} MCP call failed: ${textFrom(result)}`);
    return { message: textFrom(result), sessionId: sessionFrom(agent, result) };
  }

  console.log(`Conversation: ${options.task}`);
  console.log(`Agents: ${options.agents.join(" → ")}`);
  console.log(`Mode: ${options.mode}; max turns: ${options.maxTurns}; browser: ${options.browser ? "isolated" : "off"}`);
  console.log(`Models: Claude=${options.claudeModel || "default"}; Codex=${options.codexModel || "default"}; Antigravity=${options.antigravityModel || "default"}; Ollama=${options.ollamaModel || "default"}`);
  console.log(`Transcript: ${transcriptPath}\n`);

  try {
    const outcome = await runConversation({
      task: options.task,
      maxTurns: options.maxTurns,
      agents: options.agents,
      startAgent: options.startAgent,
      mode: options.mode,
      browser: options.browser,
      send,
      onTurn: async (turn) => {
        console.log(`=== ${turn.agent.toUpperCase()} · turn ${turn.number} · ${turn.status} ===`);
        console.log(`${turn.message}\n`);
        await writeEvent({ type: "turn", at: new Date().toISOString(), ...turn });
      },
    });
    await writeEvent({
      type: "conversation_finished",
      at: new Date().toISOString(),
      reason: outcome.reason,
      sessions: outcome.sessions,
    });
    console.log(`Stopped: ${outcome.reason.replaceAll("_", " ")}`);
    console.log(`Transcript: ${transcriptPath}`);
  } finally {
    await Promise.allSettled(Object.values(clients).map((client) => client.close()));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TERMINAL = new Set(["agreed", "needs_user", "turn_limit", "failed", "cancelled", "budget", "indeterminate"]);

function takeValue(args, index, flag) {
  const candidate = args[index + 1];
  if (!candidate || candidate.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return candidate;
}

export function parseWorkflowArguments(args) {
  const workflow = args[0];
  if (!workflow) throw new Error("start requires a workflow name.");
  const options = {
    workflow,
    workspace: process.cwd(),
    url: null,
    agents: ["claude", "codex", "antigravity"],
    maxTurns: 6,
    follow: true,
    pollSeconds: 8,
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-follow") options.follow = false;
    else if (arg === "--workspace") options.workspace = resolve(takeValue(args, index++, arg));
    else if (arg === "--url") options.url = takeValue(args, index++, arg);
    else if (arg === "--agents") options.agents = takeValue(args, index++, arg).split(",").map((agent) => agent.trim()).filter(Boolean);
    else if (arg === "--turns") options.maxTurns = Number(takeValue(args, index++, arg));
    else if (arg === "--poll-seconds") options.pollSeconds = Math.min(8, Math.max(2, Number(takeValue(args, index++, arg))));
    else throw new Error(`Unknown start option: ${arg}`);
  }
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 20) throw new Error("--turns must be an integer from 1 to 20.");
  return options;
}

export function councilUxReviewInput(options) {
  const target = options.url ? `Rendered target: ${options.url}` : "Discover the runnable rendered target from the workspace.";
  return {
    task: [
      "Perform a council UX review of the existing application.",
      `Workspace: ${options.workspace}`,
      target,
      "Inspect the rendered product with isolated browser access before judging it. Review the primary journeys, navigation, hierarchy, accessibility, responsive behavior, error and empty states, trust, and conversion friction.",
      "Ground claims in observed evidence and, where useful, public competitor patterns. Separate verified defects from hypotheses.",
      "Reconcile findings into a prioritized, implementation-ready result with severity, evidence, user impact, recommendation, and acceptance criteria. Do not modify product source.",
      "Provide concise narrative progress while working.",
      'End every completed provider turn with exactly one single-line receipt: HANDOFF: {"outcome":"completed|blocked|needs_review|continue","summary":"what was accomplished","artifacts":[],"verification":[],"remaining":[],"nextAction":"chair_verify|peer_review|writer_fix|continue|needs_user"}',
    ].join("\n"),
    agents: options.agents,
    startAgent: options.agents[0],
    workspace: options.workspace,
    mode: "review",
    browser: true,
    maxTurns: options.maxTurns,
  };
}

export function workflowInput(options) {
  if (options.workflow === "council-ux-review") return councilUxReviewInput(options);
  throw new Error(`Unsupported deterministic workflow: ${options.workflow}`);
}

function printLifecycle(view, output, state) {
  const active = view.runtime?.activeCall;
  const narrative = active?.summary || null;
  const signature = [view.status, active?.agent, active?.phase, narrative, view.runtime?.turnCount, view.completion?.sequence].join(":");
  const now = Date.now();
  if (signature !== state.signature || now - state.lastPrintedAt >= 60_000) {
    const parts = [`[${view.status}]`, `turns=${view.runtime?.turnCount || 0}`];
    if (active) parts.push(`${active.agent}/${active.phase || "working"}`, narrative || "alive; no provider narrative yet");
    if (view.completion?.lastHandoff) parts.push(`handoff=${view.completion.sequence}/${view.completion.lastHandoff.outcome}`, `next=${view.completion.nextAction}`);
    output(`${parts.join(" · ")}\n`);
    state.signature = signature;
    state.lastPrintedAt = now;
  }
}

export async function startWorkflow(options, {
  runtimeRoot = resolve(import.meta.dirname, ".."),
  output = (message) => process.stdout.write(message),
} = {}) {
  const client = new Client({ name: "agent-bridge-workflow-launcher", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: [resolve(runtimeRoot, "scripts/collaboration-bridge-mcp.sh")],
    cwd: runtimeRoot,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot, BRIDGE_WORKSPACE_ROOT: options.workspace },
  });
  await client.connect(transport);
  try {
    const started = await client.callTool({ name: "start_collaboration", arguments: workflowInput(options) });
    if (started.isError) throw new Error(started.content?.map((item) => item.text).join("\n") || "Collaboration failed to start.");
    const initial = started.structuredContent;
    output(`Started ${options.workflow}: ${initial.id}\n`);
    output("The broker is running independently; this launcher will show lifecycle and changed narrative status.\n");
    if (!options.follow) return initial;

    const display = { signature: null, lastPrintedAt: 0 };
    let view = initial;
    let updatedAt = null;
    let lastTurn = 0;
    while (true) {
      printLifecycle(view, output, display);
      if ((view.runtime?.turnCount || 0) > lastTurn) {
        const full = await client.callTool({
          name: "get_collaboration",
          arguments: { collaborationId: initial.id, detail: "full", includeTurns: 20, afterTurn: lastTurn },
        });
        const complete = full.structuredContent;
        for (const turn of complete.turns || []) output(`\n${turn.agent} completed turn ${turn.number}:\n${turn.message}\n`);
        lastTurn = complete.runtime?.turnCount || lastTurn;
        view = complete;
      }
      if (TERMINAL.has(view.status)) return view;
      updatedAt = view.updatedAt || updatedAt;
      const polled = await client.callTool({
        name: "get_collaboration",
        arguments: {
          collaborationId: initial.id,
          detail: "status",
          includeTurns: 0,
          afterUpdatedAt: updatedAt,
          waitSeconds: options.pollSeconds,
        },
      });
      if (polled.isError) throw new Error(polled.content?.map((item) => item.text).join("\n") || "Collaboration polling failed.");
      view = polled.structuredContent;
    }
  } finally {
    await client.close();
  }
}

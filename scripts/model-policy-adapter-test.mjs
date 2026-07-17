import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { updateModelPolicy } from "../src/model-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "bridge-model-policy-adapters-"));
const configPath = join(temporary, "model-policy.json");
const fakeCodex = join(temporary, "codex");
const codexHome = join(temporary, "codex-home");
await mkdir(codexHome);
await writeFile(join(codexHome, "config.toml"), 'model = "5.6 sol"\n[features]\nexample = true\n');
await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, "fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(fakeCodex, 0o700);
updateModelPolicy("disable", "claude", "fable", { path: configPath });
updateModelPolicy("disable", "codex", "5.6 sol", { path: configPath });
updateModelPolicy("disable", "antigravity", "Gemini 3.1 Pro (High)", { path: configPath });

async function callBridge({ source, binaryEnvironment, tool, arguments: arguments_ }) {
  const client = new Client({ name: "model-policy-adapter-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, source)],
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: root,
      AGENT_BRIDGE_MODEL_POLICY_CONFIG: configPath,
      ...binaryEnvironment,
    },
  }));
  try {
    return await client.callTool({ name: tool, arguments: arguments_ });
  } finally {
    await client.close();
  }
}

try {
  const claude = await callBridge({
    source: "src/claude-bridge.mjs",
    binaryEnvironment: { CLAUDE_BIN: resolve(root, "scripts/fake-claude.mjs") },
    tool: "ask_claude",
    arguments: {
      prompt: "machine deny must outrank request opt-in",
      model: "claude-fable-5",
      fallbackModels: ["claude-opus-4-8[1m]"],
      allowFable: true,
    },
  });
  assert.notEqual(claude.isError, true);
  const claudeInvocation = JSON.parse(claude.structuredContent.result);
  const claudeModelIndex = claudeInvocation.args.indexOf("--model");
  assert.equal(claudeInvocation.args[claudeModelIndex + 1], "claude-opus-4-8[1m]");

  const codex = await callBridge({
    source: "src/codex-bridge.mjs",
    binaryEnvironment: { CODEX_BRIDGE_CODEX_BIN: fakeCodex, CODEX_HOME: codexHome },
    tool: "codex",
    arguments: {
      prompt: "skip a disabled primary",
      cwd: root,
      fallbackModels: ["5.6 terra"],
    },
  });
  assert.notEqual(codex.isError, true);
  assert.equal(codex.structuredContent.model, "5.6 terra");
  assert.deepEqual(codex.structuredContent.attemptedModels, ["5.6 terra"]);

  const antigravity = await callBridge({
    source: "src/antigravity-bridge.mjs",
    binaryEnvironment: {
      AGY_BIN: resolve(root, "scripts/fake-antigravity.mjs"),
      AGY_MODEL: "Gemini 3.1 Pro (High)",
    },
    tool: "ask_antigravity",
    arguments: {
      prompt: "skip a disabled primary",
      fallbackModels: ["Gemini 3.1 Pro (Low)"],
    },
  });
  assert.notEqual(antigravity.isError, true);
  assert.equal(antigravity.structuredContent.modelRouting.model, "Gemini 3.1 Pro (Low)");
  assert.deepEqual(antigravity.structuredContent.modelRouting.attemptedModels, ["Gemini 3.1 Pro (Low)"]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("Model policy adapter tests passed: Claude, Codex, and Antigravity skip machine-disabled models before launch.");

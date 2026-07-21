#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dockerSessionDirectory, loadDockerSession, saveDockerSession } from "../src/docker-session-store.mjs";
import {
  DEFAULT_DOCKER_MODEL_RUNNER_MODEL,
  loadDockerModelRunnerConfig,
  probeDockerModelRunner,
  runDockerModelReview,
} from "../src/docker-review.mjs";
import { executeLocalReviewTool } from "../src/ollama-review.mjs";
import { dockerToolRequest } from "../src/tool-requests.mjs";
import { runConversation } from "../src/talk-protocol.mjs";
import { selectRoles } from "../src/operations.mjs";

const repository = await mkdtemp(join(tmpdir(), "docker-review-test-"));
const configPath = join(repository, "docker-model-runner.json");
try {
  assert.equal(DEFAULT_DOCKER_MODEL_RUNNER_MODEL, "ai/qwen3.6");
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await writeFile(join(repository, "app.mjs"), "export const value = 1;\n");
  execFileSync("git", ["add", "app.mjs"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repository, stdio: "ignore" });
  await writeFile(configPath, `${JSON.stringify({ version: 1, model: "ai/qwen2.5-coder", baseUrl: "http://127.0.0.1:12434" })}\n`);
  process.env.AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG = configPath;

  const config = await loadDockerModelRunnerConfig();
  assert.equal(config.model, "ai/qwen2.5-coder");
  await assert.rejects(
    loadDockerModelRunnerConfig({ environment: { DOCKER_MODEL_RUNNER_HOST: "http://example.com:12434" } }),
    /loopback/,
  );
  const health = await probeDockerModelRunner({
    model: "ai/qwen2.5-coder",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "docker.io/ai/qwen2.5-coder:latest" }] }),
    }),
  });
  assert.equal(health.available, true);

  const stateRoot = join(repository, "session-state");
  const conversationId = "123e4567-e89b-42d3-a456-426614174000";
  await saveDockerSession(repository, conversationId, {
    messages: [{ role: "assistant", content: "prior review" }],
    cwd: ".",
    model: "ai/qwen2.5-coder",
  }, { stateRoot });
  const restored = await loadDockerSession(repository, conversationId, { stateRoot });
  assert.equal(restored.messages[0].content, "prior review");
  process.env.AGENT_BRIDGE_STATE_DIR = stateRoot;
  assert.equal(dockerSessionDirectory(repository).startsWith(stateRoot), true);
  delete process.env.AGENT_BRIDGE_STATE_DIR;
  await assert.rejects(
    loadDockerSession(repository, "123e4567-e89b-42d3-a456-426614174001", { stateRoot }),
    /Unknown Docker Model Runner conversation/,
  );

  const inspected = executeLocalReviewTool({ cwd: repository, name: "read_file", arguments: { path: "app.mjs" } });
  assert.match(inspected.content, /value = 1/);

  const requests = [];
  const responses = [
    {
      model: "docker.io/ai/qwen2.5-coder:latest",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: { path: "app.mjs" } } }],
      },
    },
    {
      model: "docker.io/ai/qwen2.5-coder:latest",
      message: { role: "assistant", content: "No blocking findings." },
    },
  ];
  const result = await runDockerModelReview({
    prompt: "Review the repository.",
    cwd: ".",
    workspaceRoot: repository,
    model: "ai/qwen2.5-coder",
    fallbackModels: [],
    fetchImpl: async (url, request) => {
      assert.equal(url, "http://127.0.0.1:12434/api/chat");
      requests.push(JSON.parse(request.body));
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.match(result.result, /No blocking findings/);
  assert.equal(requests[0].tools.some((tool) => tool.function.name === "git_diff"), true);
  assert.equal(requests[0].think, false);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(result.model, "docker.io/ai/qwen2.5-coder:latest");

  process.env.AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG = join(repository, "missing-docker-config.json");
  const defaultModelResponse = await runDockerModelReview({
    prompt: "Return a concise review.",
    cwd: ".",
    workspaceRoot: repository,
    fallbackModels: [],
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).model, "ai/qwen3.6");
      return { ok: true, json: async () => ({ model: "ai/qwen3.6", message: { role: "assistant", content: "No findings." } }) };
    },
  });
  assert.equal(defaultModelResponse.result, "No findings.");
  process.env.AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG = configPath;

  assert.throws(
    () => dockerToolRequest({ prompt: "implement", cwd: repository, mode: "work" }),
    /review-only/,
  );
  await assert.rejects(
    runConversation({ task: "implement", agents: ["docker"], startAgent: "docker", mode: "work", writer: "docker", send: async () => ({ message: "STATUS: AGREED" }) }),
    /review-only/,
  );
  assert.equal(selectRoles({ taskNumber: 3, agents: ["docker", "codex"] }).writer, "codex");

  const client = new Client({ name: "docker-review-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "docker-bridge.mjs")],
    cwd: repository,
    env: {
      ...process.env,
      BRIDGE_WORKSPACE_ROOT: repository,
      AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG: configPath,
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["ask_docker", "continue_docker", "get_docker_status"]);
    const rejected = await client.callTool({
      name: "ask_docker",
      arguments: { prompt: "Implement this", cwd: ".", mode: "work" },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /review-only/);
  } finally {
    await client.close();
  }

  console.log("Docker Model Runner review-only provider tests passed.");
} finally {
  delete process.env.AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG;
  await rm(repository, { recursive: true, force: true });
}

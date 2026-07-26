#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOllamaSession, saveOllamaSession } from "../src/ollama-session-store.mjs";
import {
  assertOllamaFallbackAllowed,
  availableDockerReviewer,
  classifyDockerProbeFailure,
  LOCAL_REVIEW_PREFLIGHT_BUDGET_MS,
  OLLAMA_DOCKER_PROBE_TIMEOUT_MS,
  OLLAMA_FALLBACK_PREFLIGHT_MAX_MS,
  OLLAMA_DOCKER_PRIORITY_MESSAGE,
} from "../src/local-review-priority.mjs";
import { DEFAULT_OLLAMA_MODEL, executeOllamaReviewTool, OLLAMA_PROBE_TIMEOUT_MS, probeOllama, runOllamaReview } from "../src/ollama-review.mjs";
import { ollamaToolRequest } from "../src/tool-requests.mjs";
import { runConversation } from "../src/talk-protocol.mjs";
import { selectRoles } from "../src/operations.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = await mkdtemp(join(tmpdir(), "ollama-review-test-"));
try {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen3.6:latest");
  const dockerAvailable = async () => ({ available: true, model: "ai/qwen3.6" });
  const privateConfigPath = join(repository, "private", "docker-model-runner.json");
  const dockerUnavailable = async () => {
    const error = new Error(`Unable to read Docker Model Runner config at ${privateConfigPath}: connect ECONNREFUSED`);
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  assert.equal((await availableDockerReviewer({ probeDocker: dockerAvailable })).model, "ai/qwen3.6");
  const unavailableDocker = await availableDockerReviewer({ probeDocker: dockerUnavailable });
  assert.equal(unavailableDocker.available, false);
  assert.equal(unavailableDocker.reason, "service_unreachable");
  assert.doesNotMatch(unavailableDocker.reason, new RegExp(repository));
  await assert.rejects(
    assertOllamaFallbackAllowed({ probeDocker: dockerAvailable }),
    new RegExp(OLLAMA_DOCKER_PRIORITY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const fallback = await assertOllamaFallbackAllowed({ probeDocker: dockerUnavailable });
  assert.equal(fallback.allowed, true);
  assert.equal(fallback.dockerUnavailableReason, "service_unreachable");
  assert.doesNotMatch(JSON.stringify(fallback), new RegExp(repository));
  assert.equal(classifyDockerProbeFailure(Object.assign(new Error("request timed out"), { name: "TimeoutError" })), "probe_timeout");
  assert.equal(classifyDockerProbeFailure(Object.assign(new Error("fetch failed"), { cause: { name: "TimeoutError" } })), "probe_timeout");
  assert.equal(classifyDockerProbeFailure(new Error("Docker Model Runner model ai/missing is not installed. Run: docker model pull ai/missing")), "model_unavailable");
  assert.equal(classifyDockerProbeFailure(new Error("Docker Model Runner health check returned HTTP 503.")), "health_check_failed");
  assert.equal(classifyDockerProbeFailure(new Error(`Unable to read Docker Model Runner config at ${privateConfigPath}: invalid JSON`)), "configuration_error");
  assert.equal(classifyDockerProbeFailure(new Error(`unexpected failure at ${privateConfigPath}`)), "probe_failed");
  assert.equal(OLLAMA_FALLBACK_PREFLIGHT_MAX_MS, OLLAMA_DOCKER_PROBE_TIMEOUT_MS + OLLAMA_PROBE_TIMEOUT_MS);
  assert.ok(
    OLLAMA_FALLBACK_PREFLIGHT_MAX_MS < LOCAL_REVIEW_PREFLIGHT_BUDGET_MS,
    "the serial Docker-priority and Ollama probes must fit within the agent-pool preflight budget",
  );
  await assert.rejects(
    probeOllama({
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 25,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => resolve({ ok: true, json: async () => ({ models: [] }) }), 1_000);
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    /health check timed out after 25ms/,
  );
  await assert.rejects(
    probeOllama({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }); },
    }),
    /health check could not connect: fetch failed/,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await writeFile(join(repository, "app.mjs"), "export function total(a, b) {\n  return a + b;\n}\n");
  execFileSync("git", ["add", "app.mjs"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["switch", "-c", "feature"], { cwd: repository, stdio: "ignore" });
  await writeFile(join(repository, "app.mjs"), "export function total(a, b) {\n  return a - b;\n}\n");
  execFileSync("git", ["add", "app.mjs"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "regression"], { cwd: repository, stdio: "ignore" });

  const summary = executeOllamaReviewTool({ cwd: repository, name: "workspace_summary" });
  assert.match(summary.head, /^[0-9a-f]{40}$/);
  assert.match(summary.changedFiles, /app\.mjs/);
  const file = executeOllamaReviewTool({ cwd: repository, name: "read_file", arguments: { path: "app.mjs" } });
  assert.match(file.content, /2:   return a - b/);
  assert.throws(
    () => executeOllamaReviewTool({ cwd: repository, name: "read_file", arguments: { path: "../outside" } }),
    /inside the delegated workspace/,
  );
  const outside = join(repository, "..", `${repository.split("/").at(-1)}-outside.txt`);
  await writeFile(outside, "outside workspace");
  await symlink(outside, join(repository, "escape-link"));
  assert.throws(
    () => executeOllamaReviewTool({ cwd: repository, name: "read_file", arguments: { path: "escape-link" } }),
    /inside the delegated workspace/,
  );
  await writeFile(join(repository, "oversized.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  assert.throws(
    () => executeOllamaReviewTool({ cwd: repository, name: "read_file", arguments: { path: "oversized.txt" } }),
    /read limit/,
  );
  assert.throws(
    () => executeOllamaReviewTool({ cwd: repository, name: "git_diff", arguments: { base: "missing-review-base" } }),
    /does not resolve to a commit/,
  );

  const stateRoot = join(repository, "session-state");
  const conversationId = "123e4567-e89b-42d3-a456-426614174000";
  await saveOllamaSession(repository, conversationId, { messages: [{ role: "assistant", content: "prior review" }], cwd: ".", model: "gemma4:latest" }, { stateRoot });
  const restored = await loadOllamaSession(repository, conversationId, { stateRoot });
  assert.equal(restored.messages[0].content, "prior review");
  await assert.rejects(
    loadOllamaSession(repository, "123e4567-e89b-42d3-a456-426614174001", { stateRoot }),
    /Unknown Ollama conversation/,
  );

  const requests = [];
  const responses = [
    {
      model: "gemma4:latest",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: { path: "app.mjs" } } }],
      },
      prompt_eval_count: 10,
      eval_count: 5,
    },
    {
      model: "gemma4:latest",
      message: { role: "assistant", content: "", thinking: "private reasoning must not be surfaced" },
      prompt_eval_count: 20,
      eval_count: 8,
    },
    {
      model: "gemma4:latest",
      message: { role: "assistant", content: "Finding: app.mjs:2 changes addition to subtraction." },
      prompt_eval_count: 20,
      eval_count: 8,
    },
  ];
  const progress = [];
  const result = await runOllamaReview({
    prompt: "Review the change.",
    cwd: ".",
    workspaceRoot: repository,
    model: "gemma4:latest",
    fallbackModels: [],
    onProgress: (message) => progress.push(message),
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      const body = responses.shift();
      return { ok: true, json: async () => body };
    },
  });
  assert.match(result.result, /app\.mjs:2/);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tools.some((tool) => tool.function.name === "git_diff"), true);
  assert.equal(requests[0].keep_alive, "30m");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[2].messages.at(-1).content, /final review now/);
  assert.equal(progress.some((message) => /inspecting app\.mjs/.test(message)), true);
  assert.equal(result.timing.apiCalls, 3);
  assert.equal(result.timing.toolCalls, 1);

  const defaultModelResult = await runOllamaReview({
    prompt: "Return a concise review.",
    cwd: ".",
    workspaceRoot: repository,
    fallbackModels: [],
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).model, "qwen3.6:latest");
      return { ok: true, json: async () => ({ model: "qwen3.6:latest", message: { role: "assistant", content: "No findings." } }) };
    },
  });
  assert.equal(defaultModelResult.result, "No findings.");

  assert.throws(
    () => ollamaToolRequest({ prompt: "implement", cwd: repository, mode: "work" }),
    /review-only/,
  );
  await assert.rejects(
    runConversation({ task: "implement", agents: ["ollama"], startAgent: "ollama", mode: "work", writer: "ollama", send: async () => ({ message: "STATUS: AGREED" }) }),
    /review-only/,
  );
  assert.equal(selectRoles({ taskNumber: 3, agents: ["ollama", "codex"] }).writer, "codex");

  const dockerStub = createServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "ai/qwen3.6" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    dockerStub.once("error", reject);
    dockerStub.listen(0, "127.0.0.1", resolve);
  });
  const dockerStubPort = dockerStub.address().port;
  const client = new Client({ name: "ollama-review-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "ollama-bridge.mjs")],
    cwd: repository,
    env: {
      ...process.env,
      BRIDGE_WORKSPACE_ROOT: repository,
      DOCKER_MODEL_RUNNER_HOST: `http://127.0.0.1:${dockerStubPort}`,
      DOCKER_MODEL_RUNNER_MODEL: "ai/qwen3.6",
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["ask_ollama", "continue_ollama", "get_ollama_status"]);
    const suppressed = await client.callTool({ name: "get_ollama_status", arguments: {} });
    assert.equal(suppressed.isError, true);
    assert.match(suppressed.content[0].text, /Ollama is disabled while Docker Model Runner is available/);
    const suppressedAsk = await client.callTool({
      name: "ask_ollama",
      arguments: { prompt: "Review this change", cwd: ".", mode: "review" },
    });
    assert.equal(suppressedAsk.isError, true);
    assert.match(suppressedAsk.content[0].text, /Ollama is disabled while Docker Model Runner is available/);
    const suppressedContinue = await client.callTool({
      name: "continue_ollama",
      arguments: {
        conversationId: "123e4567-e89b-42d3-a456-426614174099",
        prompt: "Continue the review",
        cwd: ".",
        mode: "review",
      },
    });
    assert.equal(suppressedContinue.isError, true);
    assert.match(suppressedContinue.content[0].text, /Ollama is disabled while Docker Model Runner is available/);
    const rejected = await client.callTool({
      name: "ask_ollama",
      arguments: { prompt: "Implement this", cwd: ".", mode: "work" },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /review-only/);
  } finally {
    await client.close();
    await new Promise((resolve) => dockerStub.close(resolve));
  }

  const invalidDockerConfig = join(repository, "private-docker-model-runner.json");
  await writeFile(invalidDockerConfig, "{not-json");
  const ollamaStub = createServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "qwen3.6:latest" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    ollamaStub.once("error", reject);
    ollamaStub.listen(0, "127.0.0.1", resolve);
  });
  const ollamaStubPort = ollamaStub.address().port;
  const fallbackClient = new Client({ name: "ollama-fallback-diagnostic-test", version: "0.1.0" });
  const fallbackTransport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "ollama-bridge.mjs")],
    cwd: repository,
    env: {
      ...process.env,
      BRIDGE_WORKSPACE_ROOT: repository,
      AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG: invalidDockerConfig,
      OLLAMA_HOST: `http://127.0.0.1:${ollamaStubPort}`,
      OLLAMA_MODEL: "qwen3.6:latest",
    },
  });
  try {
    await fallbackClient.connect(fallbackTransport);
    const availableFallback = await fallbackClient.callTool({ name: "get_ollama_status", arguments: {} });
    assert.notEqual(availableFallback.isError, true);
    assert.equal(availableFallback.structuredContent.dockerUnavailableReason, "configuration_error");
    assert.match(availableFallback.content[0].text, /configuration_error/);
    assert.doesNotMatch(JSON.stringify(availableFallback), new RegExp(repository));
  } finally {
    await fallbackClient.close();
    await new Promise((resolve) => ollamaStub.close(resolve));
  }

  console.log("Ollama review-only provider tests passed.");
} finally {
  await rm(repository, { recursive: true, force: true });
  await rm(join(repository, "..", `${repository.split("/").at(-1)}-outside.txt`), { force: true });
}

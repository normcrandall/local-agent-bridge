#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOllamaSession, saveOllamaSession } from "../src/ollama-session-store.mjs";
import {
  assertOllamaFallbackAllowed,
  availableDockerReviewer,
  OLLAMA_DOCKER_PRIORITY_MESSAGE,
} from "../src/local-review-priority.mjs";
import { DEFAULT_OLLAMA_MODEL, executeOllamaReviewTool, runOllamaReview } from "../src/ollama-review.mjs";
import { ollamaToolRequest } from "../src/tool-requests.mjs";
import { runConversation } from "../src/talk-protocol.mjs";
import { selectRoles } from "../src/operations.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = await mkdtemp(join(tmpdir(), "ollama-review-test-"));
try {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen3.6:latest");
  const dockerAvailable = async () => ({ available: true, model: "ai/qwen3.6" });
  const dockerUnavailable = async () => { throw new Error("connect ECONNREFUSED"); };
  assert.equal((await availableDockerReviewer({ probeDocker: dockerAvailable })).model, "ai/qwen3.6");
  assert.equal(await availableDockerReviewer({ probeDocker: dockerUnavailable }), null);
  await assert.rejects(
    assertOllamaFallbackAllowed({ probeDocker: dockerAvailable }),
    new RegExp(OLLAMA_DOCKER_PRIORITY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(await assertOllamaFallbackAllowed({ probeDocker: dockerUnavailable }), true);
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
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[2].messages.at(-1).content, /final review now/);
  assert.equal(progress.some((message) => /inspecting app\.mjs/.test(message)), true);

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

  const client = new Client({ name: "ollama-review-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "ollama-bridge.mjs")],
    cwd: repository,
    env: { ...process.env, BRIDGE_WORKSPACE_ROOT: repository },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["ask_ollama", "continue_ollama", "get_ollama_status"]);
    const rejected = await client.callTool({
      name: "ask_ollama",
      arguments: { prompt: "Implement this", cwd: ".", mode: "work" },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /review-only/);
  } finally {
    await client.close();
  }

  console.log("Ollama review-only provider tests passed.");
} finally {
  await rm(repository, { recursive: true, force: true });
  await rm(join(repository, "..", `${repository.split("/").at(-1)}-outside.txt`), { force: true });
}

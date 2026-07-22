import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporary = await mkdtemp(join(tmpdir(), "codex-progress-test-"));
const executable = join(temporary, "codex");
const argsFile = join(temporary, "args.jsonl");
const fallbackConfig = join(temporary, "model-fallbacks.json");
await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, "fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(executable, 0o700);
await writeFile(fallbackConfig, `${JSON.stringify({
  version: 1,
  providers: { codex: { fallbackModels: ["5.6 terra"] } },
})}\n`);

const client = new Client({ name: "codex-progress-test", version: "1" });
let nestedClient;
let fallbackClient;
let configuredFallbackClient;
let exhaustedFallbackClient;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../src/codex-bridge.mjs")],
  cwd: resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    CODEX_BRIDGE_CODEX_BIN: executable,
    BRIDGE_WORKSPACE_ROOT: resolve(import.meta.dirname, ".."),
    FAKE_CODEX_ARGS_FILE: argsFile,
  },
});

try {
  await client.connect(transport);
  const messages = [];
  const result = await client.callTool({
    name: "codex",
    arguments: {
      prompt: "test",
      cwd: resolve(import.meta.dirname, ".."),
      sandbox: "read-only",
      "approval-policy": "never",
      config: {},
      verificationCommands: ["test"],
    },
    _meta: { progressToken: "codex-progress-test" },
  }, undefined, {
    timeout: 10_000,
    onprogress: (progress) => messages.push(progress.message),
  });
  assert.equal(result.structuredContent.threadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.structuredContent.content, "FAKE_CODEX_COMPLETE");
  assert.equal(result.structuredContent.timing.toolCalls, 1);
  assert.ok(result.structuredContent.timing.totalMs >= result.structuredContent.timing.toolMs);
  assert.equal(result.structuredContent.verificationResults[0].command, "test");
  assert.equal(result.structuredContent.verificationResults[0].exitCode, 0);
  assert.match(result.structuredContent.verificationResults[0].outputDigest, /^[0-9a-f]{64}$/);
  assert.ok(messages.includes("Codex is analyzing the task."));
  assert.ok(messages.includes("Inspecting the relevant files."));
  assert.ok(messages.includes("Codex is running workspace command: test"));
  assert.ok(messages.includes("Codex finished workspace command: test (exit 0)."));
  assert.ok(messages.includes("Codex finished the turn."));

  const reply = await client.callTool({
    name: "codex-reply",
    arguments: {
      prompt: "continue",
      threadId: result.structuredContent.threadId,
      cwd: resolve(import.meta.dirname, ".."),
      sandbox: "read-only",
      "approval-policy": "never",
      config: { "example.flag": true },
    },
  });
  assert.equal(reply.structuredContent.content, "FAKE_CODEX_COMPLETE");
  const invocations = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(invocations[0].includes("--sandbox"));
  assert.ok(invocations[0].includes("read-only"));
  assert.ok(invocations[1].includes("resume"));
  assert.ok(invocations[1].includes('sandbox_mode="read-only"'));
  assert.ok(invocations[1].includes('approval_policy="never"'));
  assert.ok(invocations[1].includes("example.flag=true"));
  assert.equal(invocations[0].includes("--color"), false);
  assert.equal(invocations[1].includes("--color"), false);

  fallbackClient = new Client({ name: "codex-overload-fallback-test", version: "1" });
  const fallbackMessages = [];
  await fallbackClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../src/codex-bridge.mjs")],
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_BRIDGE_CODEX_BIN: executable,
      BRIDGE_WORKSPACE_ROOT: resolve(import.meta.dirname, ".."),
      FAKE_CODEX_ARGS_FILE: argsFile,
      FAKE_CODEX_OVERLOAD_MODELS: "5.6 sol",
    },
  }));
  const fallback = await fallbackClient.callTool({
    name: "codex",
    arguments: {
      prompt: "complete work despite overload",
      cwd: resolve(import.meta.dirname, ".."),
      model: "5.6 sol",
      fallbackModels: ["5.6 terra"],
    },
    _meta: { progressToken: "codex-overload-fallback" },
  }, undefined, {
    timeout: 10_000,
    onprogress: (progress) => fallbackMessages.push(progress.message),
  });
  assert.notEqual(fallback.isError, true);
  assert.equal(fallback.structuredContent.requestedModel, "5.6 sol");
  assert.equal(fallback.structuredContent.model, "5.6 terra");
  assert.equal(fallback.structuredContent.fallbackUsed, true);
  assert.deepEqual(fallback.structuredContent.attemptedModels, ["5.6 sol", "5.6 terra"]);
  assert.ok(fallbackMessages.some((message) => /5\.6 sol is overloaded; retrying with 5\.6 terra/.test(message)));
  const fallbackInvocations = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).slice(-2);
  assert.ok(fallbackInvocations[0].includes("5.6 sol"));
  assert.equal(fallbackInvocations[1].includes("resume"), false);
  assert.ok(fallbackInvocations[1].includes("5.6 terra"));
  assert.match(fallbackInvocations[1].at(-1), /complete work despite overload/);

  const continuation = await fallbackClient.callTool({
    name: "codex-reply",
    arguments: {
      threadId: "33333333-3333-4333-8333-333333333333",
      prompt: "continue this established conversation",
      cwd: resolve(import.meta.dirname, ".."),
      model: "5.6 sol",
      fallbackModels: ["5.6 terra"],
    },
  });
  assert.notEqual(continuation.isError, true);
  const continuationInvocations = (await readFile(argsFile, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line)).slice(-2);
  for (const invocation of continuationInvocations) {
    assert.ok(invocation.includes("resume"));
    assert.ok(invocation.includes("33333333-3333-4333-8333-333333333333"));
  }
  assert.match(continuationInvocations[1].at(-1), /continue this established conversation/);

  const nonOverloadCount = (await readFile(argsFile, "utf8")).trim().split("\n").length;
  const nonOverload = await fallbackClient.callTool({
    name: "codex",
    arguments: {
      prompt: "FAKE_NON_OVERLOAD_FAILURE",
      cwd: resolve(import.meta.dirname, ".."),
      model: "5.6 sol",
      fallbackModels: ["5.6 terra"],
    },
  });
  assert.equal(nonOverload.isError, true);
  assert.match(nonOverload.content[0].text, /authentication failed/i);
  assert.equal((await readFile(argsFile, "utf8")).trim().split("\n").length, nonOverloadCount + 1);

  configuredFallbackClient = new Client({ name: "codex-configured-overload-fallback-test", version: "1" });
  await configuredFallbackClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../src/codex-bridge.mjs")],
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_BRIDGE_CODEX_BIN: executable,
      BRIDGE_WORKSPACE_ROOT: resolve(import.meta.dirname, ".."),
      AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG: fallbackConfig,
      FAKE_CODEX_OVERLOAD_MODELS: "default",
    },
  }));
  const configuredFallback = await configuredFallbackClient.callTool({
    name: "codex",
    arguments: { prompt: "use machine fallback", cwd: resolve(import.meta.dirname, "..") },
  });
  assert.notEqual(configuredFallback.isError, true);
  assert.equal(configuredFallback.structuredContent.requestedModel, null);
  assert.equal(configuredFallback.structuredContent.model, "5.6 terra");
  assert.deepEqual(configuredFallback.structuredContent.attemptedModels, ["configured default", "5.6 terra"]);
  assert.deepEqual(configuredFallback.structuredContent.modelFallbacks, ["5.6 terra"]);
  assert.equal(configuredFallback.structuredContent.fallbackManagedBy, "bridge");
  const explicitFallback = await configuredFallbackClient.callTool({
    name: "codex",
    arguments: {
      prompt: "override machine fallback",
      cwd: resolve(import.meta.dirname, ".."),
      fallbackModels: ["5.6 base"],
    },
  });
  assert.notEqual(explicitFallback.isError, true);
  assert.equal(explicitFallback.structuredContent.model, "5.6 base");
  assert.deepEqual(explicitFallback.structuredContent.attemptedModels, ["configured default", "5.6 base"]);
  const disabledFallback = await configuredFallbackClient.callTool({
    name: "codex",
    arguments: {
      prompt: "disable machine fallback",
      cwd: resolve(import.meta.dirname, ".."),
      fallbackModels: [],
    },
  });
  assert.equal(disabledFallback.isError, true);
  assert.match(disabledFallback.content[0].text, /no codex model fallback was configured/i);

  exhaustedFallbackClient = new Client({ name: "codex-exhausted-overload-fallback-test", version: "1" });
  await exhaustedFallbackClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../src/codex-bridge.mjs")],
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_BRIDGE_CODEX_BIN: executable,
      BRIDGE_WORKSPACE_ROOT: resolve(import.meta.dirname, ".."),
      FAKE_CODEX_OVERLOAD_MODELS: "5.6 sol,5.6 terra",
    },
  }));
  const exhausted = await exhaustedFallbackClient.callTool({
    name: "codex",
    arguments: {
      prompt: "exhaust model chain",
      cwd: resolve(import.meta.dirname, ".."),
      model: "5.6 sol",
      fallbackModels: ["5.6 terra"],
    },
  });
  assert.equal(exhausted.isError, true);
  assert.match(exhausted.content[0].text, /fallback chain exhausted: 5\.6 sol -> 5\.6 terra/i);

  const escaped = await client.callTool({
    name: "codex",
    arguments: {
      prompt: "escape",
      cwd: resolve(import.meta.dirname, "../.."),
      sandbox: "workspace-write",
      "approval-policy": "never",
      config: {},
    },
  });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /must stay within/);

  nestedClient = new Client({ name: "codex-nested-guard-test", version: "1" });
  await nestedClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../src/codex-bridge.mjs")],
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_BRIDGE_CODEX_BIN: executable,
      CODEX_BRIDGE_ACTIVE: "1",
      BRIDGE_WORKSPACE_ROOT: resolve(import.meta.dirname, ".."),
    },
  }));
  const nested = await nestedClient.callTool({
    name: "codex",
    arguments: {
      prompt: "must be blocked",
      cwd: resolve(import.meta.dirname, ".."),
      sandbox: "read-only",
      "approval-policy": "never",
      config: {},
    },
  });
  assert.equal(nested.isError, true);
  assert.match(nested.content[0].text, /Nested Codex bridge invocation blocked/);
} finally {
  await nestedClient?.close().catch(() => {});
  await fallbackClient?.close().catch(() => {});
  await configuredFallbackClient?.close().catch(() => {});
  await exhaustedFallbackClient?.close().catch(() => {});
  await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

console.log("Codex live-progress adapter test passed without invoking a model.");

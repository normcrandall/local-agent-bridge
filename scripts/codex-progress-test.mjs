import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporary = await mkdtemp(join(tmpdir(), "codex-progress-test-"));
const executable = join(temporary, "codex");
const argsFile = join(temporary, "args.jsonl");
await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, "fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(executable, 0o700);

const client = new Client({ name: "codex-progress-test", version: "1" });
let nestedClient;
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
    },
    _meta: { progressToken: "codex-progress-test" },
  }, undefined, {
    timeout: 10_000,
    onprogress: (progress) => messages.push(progress.message),
  });
  assert.equal(result.structuredContent.threadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.structuredContent.content, "FAKE_CODEX_COMPLETE");
  assert.ok(messages.includes("Codex is analyzing the task."));
  assert.ok(messages.includes("Inspecting the relevant files."));
  assert.ok(messages.includes("Codex is running a workspace command."));
  assert.ok(messages.includes("Codex finished a workspace command (exit 0)."));
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
  await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

console.log("Codex live-progress adapter test passed without invoking a model.");

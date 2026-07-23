#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp("/tmp/bridge-custody-");
const stateDirectory = join(temporary, "state");
const standalone = join(temporary, "standalone");
const source = join(temporary, "source");
const linked = join(temporary, "linked");
const argsFile = join(temporary, "codex-args.jsonl");
const fakeCodex = join(temporary, "codex");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializeRepository(path) {
  await mkdir(path, { recursive: true });
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Bridge Test");
  git(path, "config", "user.email", "bridge@example.invalid");
  await writeFile(join(path, "README.md"), "fixture\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "Initial fixture");
}

async function waitForStop(client, collaborationId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_collaboration",
      arguments: { collaborationId, detail: "full", includeTurns: 1 },
    });
    const view = result.structuredContent;
    if (!["queued", "running", "recovering", "cancelling"].includes(view.status)
      && !view.workerPid && !view.workerOwner && !view.runtime?.activeCall) return view;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${collaborationId}`);
}

function writableRootArguments(calls) {
  return calls.flatMap((args) => args.flatMap((value, index) => (
    value === "--config" && args[index + 1]?.startsWith("sandbox_workspace_write.writable_roots=")
      ? [args[index + 1]]
      : []
  )));
}

await mkdir(stateDirectory, { recursive: true });
await initializeRepository(standalone);
await initializeRepository(source);
git(source, "worktree", "add", "-b", "codex/linked-writer", linked, "HEAD");
await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${resolve(root, "scripts/fixtures/fake-codex-progress.mjs")}" "$@"\n`);
await chmod(fakeCodex, 0o700);

const client = new Client({ name: "existing-writer-custody-test", version: "0.2.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [resolve(root, "scripts/collaboration-bridge-mcp.sh")],
  cwd: root,
  env: {
    ...process.env,
    AGENT_BRIDGE_TEST_MODE: "1",
    BRIDGE_WORKSPACE_ROOT: temporary,
    BRIDGE_COLLABORATION_DIR: stateDirectory,
    CODEX_BRIDGE_CODEX_BIN: fakeCodex,
    BRIDGE_CODEX_HOME: join(temporary, "codex-home"),
    FAKE_CODEX_ARGS_FILE: argsFile,
  },
});

try {
  await client.connect(transport);
  const started = await client.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Commit work in an existing self-contained checkout",
      workspace: standalone,
      agents: ["codex"],
      mode: "work",
      writer: "codex",
      workProfile: "implement",
      maxTurns: 1,
    },
  });
  assert.notEqual(started.isError, true, started.content?.map((item) => item.text || "").join("\n"));
  const standaloneGitDirectory = await realpath(resolve(standalone, ".git"));
  assert.equal(started.structuredContent.worktree.strategy, "self-contained");
  assert.equal(started.structuredContent.worktree.managed, false);
  assert.equal(started.structuredContent.worktree.gitMetadataRoot, standaloneGitDirectory);

  const firstRun = await waitForStop(client, started.structuredContent.id);
  assert.equal(firstRun.status, "turn_limit", firstRun.error || "existing checkout work turn failed");

  const calls = (await readFile(argsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(writableRootArguments(calls), [
    `sandbox_workspace_write.writable_roots=${JSON.stringify([standaloneGitDirectory])}`,
  ]);

  const linkedStart = await client.callTool({
    name: "start_collaboration",
    arguments: {
      task: "Do not start work with shared Git metadata",
      workspace: linked,
      agents: ["codex"],
      mode: "work",
      writer: "codex",
      workProfile: "implement",
      maxTurns: 1,
    },
  });
  assert.equal(linkedStart.isError, true);
  assert.match(linkedStart.content.map((item) => item.text || "").join("\n"), /shared Git metadata.*private writer checkout/i);
} finally {
  await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log("Existing writer custody test passed: private Git metadata is writable and linked metadata fails before provider launch.");

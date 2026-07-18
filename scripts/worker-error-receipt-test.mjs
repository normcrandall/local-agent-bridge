#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-worker-error-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
const id = "bridge-00000000-0000-4000-8000-000000000076";

try {
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(workspace, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: workspace }).status, 0);

  const now = new Date().toISOString();
  await writeFile(join(stateDirectory, `${id}.json`), `${JSON.stringify({
    id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    cancelRequested: false,
    task: "Surface the original worker startup error",
    workspace,
    agents: ["claude"],
    startAgent: "claude",
    writer: "claude",
    mode: "work",
    workProfile: "deliver",
    githubBuilder: null,
    runtime: {
      sessions: { claude: null },
      turnCount: 0,
      activeCall: null,
      availableAgents: ["claude"],
      unavailableAgents: {},
    },
  }, null, 2)}\n`);
  await writeFile(join(stateDirectory, `${id}.jsonl`), "");

  const worker = spawnSync(process.execPath, [resolve(root, "scripts/collaboration-worker.mjs"), id], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: root,
      BRIDGE_WORKSPACE_ROOT: workspace,
      BRIDGE_COLLABORATION_DIR: stateDirectory,
      AGENT_BRIDGE_TEST_MODE: "1",
    },
    encoding: "utf8",
  });
  assert.equal(worker.status, 1, "the deliberately invalid worker must exit unsuccessfully");

  const state = JSON.parse(await readFile(join(stateDirectory, `${id}.json`), "utf8"));
  assert.equal(state.status, "failed");
  assert.match(state.error, /Autonomous delivery requires a bound githubBuilder/);

  const events = (await readFile(join(stateDirectory, `${id}.jsonl`), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "run_failed");
  assert.ok(failure, "the worker must persist a terminal failure receipt");
  assert.match(failure.error, /Autonomous delivery requires a bound githubBuilder/);

  console.log("Worker startup errors preserve the original exception and terminal receipt.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

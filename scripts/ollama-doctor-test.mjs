#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const doctor = resolve(root, "scripts/doctor.mjs");
const temporary = await mkdtemp(join(tmpdir(), "ollama-doctor-test-"));
const configPath = join(temporary, "ollama.json");
const ollama = join(temporary, "ollama");

function runDoctor() {
  return spawnSync(process.execPath, [doctor], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Ollama local reviewer,Codex project config",
      AGENT_BRIDGE_OLLAMA_CONFIG: configPath,
      OLLAMA_BIN: ollama,
    },
  });
}

try {
  await writeFile(ollama, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ollama version 1.0.0"
  exit 0
fi
if [ "$1" = "list" ]; then
  printf 'NAME ID SIZE MODIFIED\\nqwen3.6:latest abc 1 GB now\\n'
  exit 0
fi
exit 1
`);
  await chmod(ollama, 0o755);

  await writeFile(configPath, "{ malformed json\n");
  const malformed = runDoctor();
  assert.equal(malformed.status, 1, malformed.stderr);
  assert.match(malformed.stderr, /FAIL Ollama local reviewer: .*JSON/i);
  assert.equal((malformed.stderr.match(/FAIL Ollama local reviewer:/g) || []).length, 1,
    "a malformed config should produce exactly one Ollama failure");
  assert.match(malformed.stdout, /OK   Codex project config/,
    "a malformed Ollama config must not abort later doctor checks");

  await writeFile(configPath, JSON.stringify({ version: 2, model: "qwen3.6" }));
  const unsupported = runDoctor();
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.match(unsupported.stderr, /FAIL Ollama local reviewer: Unsupported Ollama config version\./);
  assert.match(unsupported.stdout, /OK   Codex project config/,
    "an unsupported Ollama config must not abort later doctor checks");

  await writeFile(configPath, JSON.stringify({ version: 1, model: "QWEN3.6" }));
  const bareModel = runDoctor();
  assert.equal(bareModel.status, 0, bareModel.stderr);
  assert.match(bareModel.stdout, /OK   Ollama local reviewer/,
    "a configured bare model should match an installed :latest tag case-insensitively");

  console.log("Ollama doctor robustness tests passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

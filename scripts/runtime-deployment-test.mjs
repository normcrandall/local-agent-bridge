#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployRuntime } from "../src/runtime-deployment.mjs";

const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-runtime-deployment-"));
const installRoot = join(temporary, "install");
const runtimeRoot = join(installRoot, "runtime");
const sourceRoot = join(temporary, "source");

try {
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "version.txt"), "v1\n");
  await deployRuntime({
    sourceRoot,
    installRoot,
    runtimeRoot,
    entries: ["version.txt"],
    installDependencies: async () => {},
  });
  assert.equal(await readFile(join(runtimeRoot, "version.txt"), "utf8"), "v1\n");
  assert.equal((await stat(runtimeRoot)).mode & 0o777, 0o700);

  await writeFile(join(sourceRoot, "version.txt"), "v2\n");
  await deployRuntime({
    sourceRoot,
    installRoot,
    runtimeRoot,
    entries: ["version.txt"],
    installDependencies: async (stagedRuntime) => {
      assert.equal(await readFile(join(stagedRuntime, "version.txt"), "utf8"), "v2\n");
    },
  });
  assert.equal(await readFile(join(runtimeRoot, "version.txt"), "utf8"), "v2\n");

  await writeFile(join(sourceRoot, "version.txt"), "broken\n");
  await assert.rejects(() => deployRuntime({
    sourceRoot,
    installRoot,
    runtimeRoot,
    entries: ["version.txt"],
    installDependencies: async () => { throw new Error("staging validation failed"); },
  }), /staging validation failed/);
  assert.equal(await readFile(join(runtimeRoot, "version.txt"), "utf8"), "v2\n",
    "a failed staged install must leave the active runtime unchanged");

  await writeFile(join(sourceRoot, "version.txt"), "valid-but-unmodeable\n");
  await assert.rejects(() => deployRuntime({
    sourceRoot,
    installRoot,
    runtimeRoot,
    entries: ["version.txt"],
    installDependencies: async () => {},
    setMode: async (path, mode) => {
      if (path.includes(".runtime-stage-")) throw new Error("staged chmod failed");
      return chmod(path, mode);
    },
  }), /staged chmod failed/);
  assert.equal(await readFile(join(runtimeRoot, "version.txt"), "utf8"), "v2\n",
    "a staged permission failure must not replace or roll back the active runtime");
  assert.deepEqual((await readdir(installRoot)).sort(), ["runtime"], "staging and backup directories must be cleaned");
  console.log("Runtime deployment test passed: staging is validated before activation and failures preserve the active runtime.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

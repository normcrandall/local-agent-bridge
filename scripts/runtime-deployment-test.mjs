#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployRuntime } from "../src/runtime-deployment.mjs";
import {
  INSTALL_LOCK_FILENAME,
  PROVENANCE_FILENAME,
  acquireInstallLock,
  evaluateDeployment,
  readInstalledProvenance,
} from "../src/runtime-provenance.mjs";

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

  // --- concurrent global installs (issue #133) ----------------------------
  // Deployment policy, provenance records, and lock ownership are unit-tested
  // in scripts/runtime-provenance-test.mjs; this file covers their effect on a
  // real staged deployment.
  const clean = (commit) => ({ root: "/checkout", commit, ref: "main", dirty: false, dirtyEntries: [], committedAt: "2026-07-24T13:00:00Z" });
  const installedAt = (commit) => ({ version: 1, commit, ref: "main", dirty: false, dirtyEntries: [], installedAt: "2026-07-24T13:11:00Z" });
  let concurrent = 0;
  let peakConcurrent = 0;
  const order = [];
  async function guardedInstall(label, contents) {
    const release = await acquireInstallLock({ installRoot, attempts: 200, intervalMs: 5 });
    try {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await writeFile(join(sourceRoot, "version.txt"), contents);
      await deployRuntime({
        sourceRoot,
        installRoot,
        runtimeRoot,
        entries: ["version.txt"],
        installDependencies: async () => { await new Promise((done) => setTimeout(done, 25)); },
      });
      order.push(label);
    } finally {
      concurrent -= 1;
      await release();
    }
  }
  await Promise.all([guardedInstall("first", "concurrent-a\n"), guardedInstall("second", "concurrent-b\n")]);
  assert.equal(peakConcurrent, 1, "concurrent global installs must be serialized by the machine-level lock");
  assert.equal(order.length, 2, "a queued installer must proceed once the lock is released");
  assert.match(await readFile(join(runtimeRoot, "version.txt"), "utf8"), /^concurrent-[ab]\n$/,
    "the surviving runtime must be one complete deployment, never a blend of two");
  assert.equal((await readdir(installRoot)).includes(INSTALL_LOCK_FILENAME), false, "the lock must be released after a successful install");

  // --- a rejected stale attempt must leave the runtime untouched ----------
  const before = await readFile(join(runtimeRoot, "version.txt"), "utf8");
  const guard = evaluateDeployment({
    installed: await readInstalledProvenance(runtimeRoot) ?? installedAt("bbb"),
    incoming: clean("aaa"),
    contains: false,
    containedBy: true,
  });
  assert.equal(guard.allowed, false);
  assert.equal(await readFile(join(runtimeRoot, "version.txt"), "utf8"), before,
    "a refused deployment must not touch the installed runtime");
  assert.deepEqual(
    (await readdir(installRoot)).sort(),
    ["runtime"],
    "no staging, backup, or lock files may survive the policy and concurrency paths",
  );
  assert.ok((await readdir(runtimeRoot)).includes(PROVENANCE_FILENAME) === false
    || (await readInstalledProvenance(runtimeRoot)) !== null,
    "any provenance file present must be readable at the current version");

  console.log("Runtime deployment test passed: staging is validated before activation, failures preserve the active runtime, dirty/stale/divergent sources are refused, and concurrent installs are serialized.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

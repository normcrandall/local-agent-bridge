#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { deployRuntime } from "../src/runtime-deployment.mjs";
import {
  INSTALL_LOCK_FILENAME,
  PROVENANCE_FILENAME,
  acquireInstallLock,
  buildProvenance,
  computeRuntimeDigest,
  evaluateDeployment,
  readInstalledProvenance,
  writeInstalledProvenance,
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

  // --- deployment policy (issue #133) -------------------------------------
  const clean = (commit) => ({ root: "/checkout", commit, ref: "main", dirty: false, dirtyEntries: [], committedAt: "2026-07-24T13:00:00Z" });
  const installedAt = (commit) => ({ version: 1, commit, ref: "main", dirty: false, dirtyEntries: [], installedAt: "2026-07-24T13:11:00Z" });

  assert.equal(evaluateDeployment({ installed: null, incoming: clean("aaa"), contains: null }).code, "first_install");
  assert.equal(evaluateDeployment({ installed: installedAt("aaa"), incoming: clean("aaa"), contains: true }).code, "same_commit");
  assert.equal(evaluateDeployment({ installed: installedAt("aaa"), incoming: clean("bbb"), contains: true }).code, "fast_forward");

  const dirty = evaluateDeployment({
    installed: installedAt("aaa"),
    incoming: { ...clean("bbb"), dirty: true, dirtyEntries: ["src/mission-control.mjs"] },
    contains: true,
  });
  assert.equal(dirty.allowed, false, "a dirty checkout must never replace the global runtime by default");
  assert.equal(dirty.code, "source_dirty");
  assert.match(dirty.reason, /src\/mission-control\.mjs/);

  const stale = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("aaa"), contains: false, containedBy: true });
  assert.equal(stale.allowed, false, "a checkout strictly behind the installed runtime must be rejected");
  assert.equal(stale.code, "stale_source");

  const divergent = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("ccc"), contains: false, containedBy: false });
  assert.equal(divergent.allowed, false, "a diverged branch must be rejected, not silently deployed");
  assert.equal(divergent.code, "divergent_source", "divergence must be reported distinctly from staleness");

  const unverifiable = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("ccc"), contains: null });
  assert.equal(unverifiable.allowed, false, "unknown ancestry must fail closed");
  assert.equal(unverifiable.code, "unverifiable_ancestry");

  assert.equal(evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("aaa"), contains: false, containedBy: true, force: true }).allowed, true);
  assert.equal(evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("aaa"), contains: false, containedBy: true, force: true }).forced, true,
    "the repair path must record that the guard was overridden");
  assert.equal(evaluateDeployment({ installed: { ...installedAt("aaa"), dirty: true }, incoming: clean("bbb"), contains: null }).allowed, true,
    "recovering from a dirty install must not require the same ceremony as causing one");

  // --- provenance record and drift detection ------------------------------
  const source = { root: sourceRoot, commit: "abc123", ref: "main", dirty: false, dirtyEntries: [], committedAt: "2026-07-24T13:00:00Z" };
  const digest = await computeRuntimeDigest(runtimeRoot);
  await writeInstalledProvenance(runtimeRoot, buildProvenance({
    source,
    installedAt: "2026-07-24T13:11:00Z",
    digest,
    entries: ["version.txt"],
  }));
  const recorded = await readInstalledProvenance(runtimeRoot);
  assert.equal(recorded.commit, "abc123");
  assert.equal(recorded.installerWorkspace, sourceRoot);
  assert.equal(recorded.installerPid, process.pid);
  assert.equal(await computeRuntimeDigest(runtimeRoot), digest,
    "the provenance record itself must not perturb the digest it records");

  await writeFile(join(runtimeRoot, "version.txt"), "hand-edited\n");
  assert.notEqual(await computeRuntimeDigest(runtimeRoot), recorded.digest,
    "editing the installed runtime in place must be detectable as digest drift");
  await writeFile(join(runtimeRoot, "version.txt"), "v2\n");

  // --- machine-level install lock -----------------------------------------
  const lockPath = join(installRoot, INSTALL_LOCK_FILENAME);
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

  const held = await acquireInstallLock({ installRoot, attempts: 200, intervalMs: 5 });
  await assert.rejects(
    () => acquireInstallLock({ installRoot, attempts: 3, intervalMs: 1 }),
    /another global install holds/,
    "a live install must block a second installer rather than racing it",
  );
  await held();

  await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, host: hostname(), token: "abandoned" })}\n`, { mode: 0o600 });
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(lockPath, staleTime, staleTime);
  const reclaimed = await acquireInstallLock({
    installRoot,
    attempts: 3,
    intervalMs: 1,
    isAlive: () => false,
  });
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid,
    "a stale lock left by a dead installer must be reclaimed");
  await reclaimed();

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

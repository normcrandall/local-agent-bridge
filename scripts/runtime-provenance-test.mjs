#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALL_LOCK_FILENAME,
  acquireInstallLock,
  buildProvenance,
  computeRuntimeDigest,
  evaluateDeployment,
  inspectSource,
  locateCommitOnMain,
  readInstalledProvenance,
  writeInstalledProvenance,
} from "../src/runtime-provenance.mjs";

const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-runtime-provenance-"));
const installRoot = join(temporary, "install");
const runtimeRoot = join(installRoot, "runtime");
const sourceRoot = join(temporary, "source");

try {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "version.txt"), "v2\n");

  // --- source inspection ---------------------------------------------------
  function stubGit(responses) {
    const calls = [];
    return {
      calls,
      runGit: async (args) => {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        if (key in responses) return responses[key];
        throw Object.assign(new Error(`unexpected git ${args.join(" ")}`), { code: 1 });
      },
    };
  }

  const untracked = stubGit({
    "rev-parse HEAD": "aaa111\n",
    "rev-parse --abbrev-ref": "main\n",
    "status --porcelain": "?? src/mission-control.mjs\n",
    "show -s": "2026-07-24T13:00:00Z\n",
  });
  const withUntracked = await inspectSource({ sourceRoot, runGit: untracked.runGit });
  assert.equal(withUntracked.dirty, true,
    "an untracked file under src/ is copied into the global runtime, so it must count as dirty");
  assert.deepEqual(withUntracked.dirtyEntries, ["src/mission-control.mjs"]);
  const statusArgs = untracked.calls.find((args) => args[0] === "status");
  assert.equal(statusArgs.includes("--untracked-files=no"), false,
    "source inspection must never suppress untracked files");
  assert.equal(statusArgs.includes("--untracked-files=normal"), true);

  const modified = stubGit({
    "rev-parse HEAD": "aaa111\n",
    "rev-parse --abbrev-ref": "main\n",
    "status --porcelain": " M src/mission-control.mjs\n",
    "show -s": "2026-07-24T13:00:00Z\n",
  });
  assert.equal((await inspectSource({ sourceRoot, runGit: modified.runGit })).dirty, true);

  const cleanTree = stubGit({
    "rev-parse HEAD": "aaa111\n",
    "rev-parse --abbrev-ref": "main\n",
    "status --porcelain": "\n",
    "show -s": "2026-07-24T13:00:00Z\n",
  });
  const cleanSource = await inspectSource({ sourceRoot, runGit: cleanTree.runGit });
  assert.equal(cleanSource.dirty, false);
  assert.equal(cleanSource.commit, "aaa111");
  assert.equal(cleanSource.ref, "main");

  const unversioned = await inspectSource({ sourceRoot, runGit: stubGit({}).runGit });
  assert.equal(unversioned.commit, null, "a checkout with no commit must not masquerade as clean and current");
  assert.equal(unversioned.dirty, false);

  // An installed runtime has no .git directory. Drift checks must use the
  // recorded installer checkout, then the caller's current checkout as a
  // recovery source when the recorded path has moved.
  const recordedCheckout = join(temporary, "recorded-checkout");
  const currentCheckout = join(temporary, "current-checkout");
  const missingCheckout = join(temporary, "moved-checkout");
  const ancestryCalls = [];
  const ancestryGit = async (args, { cwd }) => {
    ancestryCalls.push({ args, cwd });
    if (cwd === missingCheckout) throw Object.assign(new Error("not a git repository"), { code: 128 });
    if (args[0] === "cat-file") return "";
    if (args[0] === "merge-base") {
      const candidate = args.at(-1);
      if (cwd === recordedCheckout && candidate === "main") {
        throw Object.assign(new Error("not an ancestor"), { code: 1 });
      }
      return "";
    }
    throw Object.assign(new Error(`unexpected git ${args.join(" ")}`), { code: 1 });
  };
  const located = await locateCommitOnMain({
    ancestor: "installed123",
    sourceRoots: [recordedCheckout, currentCheckout],
    runGit: ancestryGit,
  });
  assert.deepEqual(
    { contains: located.contains, sourceRoot: located.sourceRoot, candidate: located.candidate },
    { contains: true, sourceRoot: recordedCheckout, candidate: "origin/main" },
    "a stale local main must not hide a containing origin/main in the provenance checkout",
  );
  const recovered = await locateCommitOnMain({
    ancestor: "installed123",
    sourceRoots: [missingCheckout, currentCheckout],
    runGit: ancestryGit,
  });
  assert.equal(recovered.contains, true);
  assert.equal(recovered.sourceRoot, currentCheckout,
    "the caller checkout must recover ancestry verification when the recorded installer path moved");
  assert.ok(ancestryCalls.some((call) => call.cwd === missingCheckout));
  const unknown = await locateCommitOnMain({
    ancestor: "installed123",
    sourceRoots: [missingCheckout],
    runGit: ancestryGit,
  });
  assert.equal(unknown.contains, null, "no usable checkout must remain explicitly unverifiable");

  // --- deployment policy ---------------------------------------------------
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

  assert.equal(evaluateDeployment({ installed: installedAt("aaa"), incoming: { ...clean(null) }, contains: null }).code, "source_unversioned");

  const stale = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("aaa"), contains: false, containedBy: true });
  assert.equal(stale.allowed, false, "a checkout strictly behind the installed runtime must be rejected");
  assert.equal(stale.code, "stale_source");

  const divergent = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("ccc"), contains: false, containedBy: false });
  assert.equal(divergent.allowed, false, "a diverged branch must be rejected, not silently deployed");
  assert.equal(divergent.code, "divergent_source", "divergence must be reported distinctly from staleness");

  const unverifiable = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("ccc"), contains: null });
  assert.equal(unverifiable.allowed, false, "unknown ancestry must fail closed");
  assert.equal(unverifiable.code, "unverifiable_ancestry");

  const forced = evaluateDeployment({ installed: installedAt("bbb"), incoming: clean("aaa"), contains: false, containedBy: true, force: true });
  assert.equal(forced.allowed, true);
  assert.equal(forced.forced, true, "the repair path must record that the guard was overridden");
  assert.equal(evaluateDeployment({ installed: { ...installedAt("aaa"), dirty: true }, incoming: clean("bbb"), contains: null }).allowed, true,
    "recovering from a dirty install must not require the same ceremony as causing one");

  // --- provenance record and drift detection -------------------------------
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
  assert.equal(recorded.installerHost, hostname());
  assert.equal(await computeRuntimeDigest(runtimeRoot), digest,
    "the provenance record itself must not perturb the digest it records");

  await writeFile(join(runtimeRoot, "version.txt"), "hand-edited\n");
  assert.notEqual(await computeRuntimeDigest(runtimeRoot), recorded.digest,
    "editing the installed runtime in place must be detectable as digest drift");
  await writeFile(join(runtimeRoot, "version.txt"), "v2\n");
  assert.equal(await computeRuntimeDigest(runtimeRoot), recorded.digest,
    "restoring the recorded content must clear the drift");

  // --- install lock ownership ----------------------------------------------
  const lockPath = join(installRoot, INSTALL_LOCK_FILENAME);
  const held = await acquireInstallLock({ installRoot, attempts: 200, intervalMs: 5 });
  await assert.rejects(
    () => acquireInstallLock({ installRoot, attempts: 3, intervalMs: 1 }),
    /another global install holds/,
    "a live install must block a second installer rather than racing it",
  );
  await held();
  assert.equal((await readdir(installRoot)).includes(INSTALL_LOCK_FILENAME), false, "release must remove the lock");

  // A dead same-host owner is reclaimed immediately. The lock file is written
  // with a current mtime on purpose: an age threshold must not be what makes
  // this pass.
  await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, host: hostname(), token: "abandoned" })}\n`, { mode: 0o600 });
  const reclaimed = await acquireInstallLock({
    installRoot,
    attempts: 2,
    intervalMs: 1,
    isAlive: () => false,
  });
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid,
    "a fresh lock left by a dead same-host installer must be reclaimed at once, not after the stale window");
  await reclaimed();

  // A live same-host owner keeps its lock however long the install runs.
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, host: hostname(), token: "long-running" })}\n`, { mode: 0o600 });
  const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(lockPath, ancient, ancient);
  await assert.rejects(
    () => acquireInstallLock({ installRoot, attempts: 3, intervalMs: 1, isAlive: () => true }),
    /another global install holds/,
    "a slow but live install must never have its lock stolen on age alone",
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "long-running");

  // An unattributable lock — foreign host, or no usable pid — falls back to age.
  await writeFile(lockPath, `${JSON.stringify({ host: "some-other-machine", token: "foreign" })}\n`, { mode: 0o600 });
  await utimes(lockPath, ancient, ancient);
  const takenOver = await acquireInstallLock({ installRoot, attempts: 2, intervalMs: 1, isAlive: () => true });
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid,
    "an aged lock with no verifiable local owner must be reclaimable");
  await takenOver();

  // A half-written lock has no pid yet; it must be waited on, not stolen.
  await writeFile(lockPath, "{", { mode: 0o600 });
  await assert.rejects(
    () => acquireInstallLock({ installRoot, attempts: 3, intervalMs: 1, isAlive: () => false }),
    /another global install holds/,
    "a lock caught mid-write must not be reclaimed as if its owner were dead",
  );
  await rm(lockPath, { force: true });

  console.log("Runtime provenance test passed: untracked sources count as dirty, stale/divergent/unverifiable deployments are refused, digest drift is detectable, and lock ownership survives dead, live, foreign, and half-written owners.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

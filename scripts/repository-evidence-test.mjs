import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEvidenceStore } from "../src/evidence-store.mjs";
import { assertRepositoryEvidenceHead, captureRepositoryEvidence, readRepositoryHead } from "../src/repository-evidence.mjs";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "agent-bridge-repository-evidence-"));
const repo = join(root, "repo");
const evidence = join(root, "evidence");

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["config", "user.email", "bridge@example.test"], { cwd: repo });
  await run("git", ["config", "user.name", "Bridge Test"], { cwd: repo });
  await run("git", ["remote", "add", "origin", "https://github.com/veliqon/example.git"], { cwd: repo });
  await writeFile(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(join(repo, "src/index.mjs"), "export const first = true;\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "base"], { cwd: repo });
  const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, "src/index.mjs"), "export const first = false;\n");
  await writeFile(join(repo, "src/new.mjs"), "export const second = true;\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "head"], { cwd: repo });
  const headSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  assert.equal(await readRepositoryHead(repo), headSha, "the asynchronous continuation fence must read the exact current head");

  const store = createEvidenceStore({ directory: evidence });
  const first = await captureRepositoryEvidence({ workspace: repo, store, baseSha, headSha });
  assert.equal(first.repository, "veliqon/example");
  assert.equal(first.fileCount, 3);
  assert.deepEqual(first.changedFiles, ["src/index.mjs", "src/new.mjs"]);
  assert.match(first.environmentFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.cache.repositoryMap, "miss");
  assert.equal(first.cache.diff, "miss");

  const second = await captureRepositoryEvidence({ workspace: repo, store, baseSha, headSha });
  assert.equal(second.cache.repositoryMap, "hit");
  assert.equal(second.cache.diff, "hit");
  assert.ok(second.cacheMetrics.avoidedLoads >= 2);

  await writeFile(join(repo, "src/index.mjs"), "x".repeat(21 * 1024 * 1024));
  const oversizedDirty = await captureRepositoryEvidence({ workspace: repo, store, baseSha, headSha });
  assert.equal(oversizedDirty.clean, false, "oversized dirty diffs must disable receipt reuse without blocking collaboration startup");
  assert.equal(oversizedDirty.environmentFingerprintComplete, false);
  await run("git", ["restore", "src/index.mjs"], { cwd: repo });

  const limitedStore = createEvidenceStore({ directory: join(root, "limited-evidence") });
  const oversizedMap = await captureRepositoryEvidence({
    workspace: repo,
    store: limitedStore,
    baseSha,
    headSha,
    evidenceMaxBuffer: 16,
  });
  assert.equal(oversizedMap.repositoryMapComplete, false, "oversized tracked-file maps must degrade instead of blocking startup");
  assert.equal(oversizedMap.clean, false, "incomplete repository evidence must never permit receipt reuse");

  const longUntrackedName = `untracked-${"x".repeat(180)}`;
  await writeFile(join(repo, longUntrackedName), "untracked\n");
  const oversizedStatus = await captureRepositoryEvidence({
    workspace: repo,
    store: createEvidenceStore({ directory: join(root, "limited-status-evidence") }),
    baseSha,
    headSha,
    evidenceMaxBuffer: 128,
  });
  assert.equal(oversizedStatus.environmentFingerprintComplete, false, "oversized status output must weaken the fingerprint visibly");
  assert.equal(oversizedStatus.clean, false, "oversized status output must disable receipt reuse without blocking startup");
  await rm(join(repo, longUntrackedName));

  await run("git", ["checkout", "-q", baseSha], { cwd: repo });
  await assert.rejects(
    captureRepositoryEvidence({ workspace: repo, store, baseSha, headSha }),
    /head mismatch/,
    "an exact-head review must fail closed rather than inspect a different checkout",
  );
  assert.throws(
    () => assertRepositoryEvidenceHead({ expectedHeadSha: headSha, observedHeadSha: baseSha }),
    /head mismatch/,
    "continuation and worker fences must reject evidence captured for a superseded head",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository evidence tests passed.");

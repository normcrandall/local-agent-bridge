#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWriterCheckout } from "../src/writer-checkout.mjs";
import {
  inspectWriterRetirement,
  inspectLocalDefaultBranchUpdate,
  preflightWriterHydration,
  recoverExactSha,
  retirementFailureState,
  updateLocalDefaultBranch,
} from "../src/writer-lifecycle.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const temporary = mkdtempSync(join(tmpdir(), "bridge-writer-lifecycle-"));
const remote = join(temporary, "remote.git");
const source = join(temporary, "source");
mkdirSync(source);

try {
  git(temporary, "init", "--bare", "--initial-branch=main", remote);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Bridge Test");
  git(source, "config", "user.email", "bridge@example.invalid");
  writeFileSync(join(source, "README.md"), "base\n");
  writeFileSync(join(source, ".gitignore"), ".agent-bridge-write-probe-*\n");
  git(source, "add", "README.md", ".gitignore");
  git(source, "commit", "-m", "Base");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-u", "origin", "main");
  const baseSha = git(source, "rev-parse", "HEAD");

  const checkout = prepareWriterCheckout({
    workspace: source,
    taskId: "issue-153",
    branch: "codex/issue-153",
    base: baseSha,
    checkoutRoot: join(temporary, "writers"),
  });
  writeFileSync(join(checkout.path, ".agent-bridge-write-probe-stale"), "stale\n");
  mkdirSync(join(checkout.path, ".agent-bridge-write-probe-stale-directory"));
  writeFileSync(join(checkout.path, ".agent-bridge-write-probe-stale-directory", "nested"), "stale\n");
  const hydration = preflightWriterHydration({
    workspace: checkout.path,
    expectedRemoteUrl: remote,
    githubBuilder: {
      allowWorkspaceHead: true,
      repository: "norm/example",
      headSha: baseSha,
      expectedLogin: "builder[bot]",
      allowedOperations: ["push_branch", "ensure_pull_request"],
    },
  });
  assert.equal(hydration.status, "complete");
  assert.equal(hydration.proofs.workspaceWrite, true);
  assert.equal(hydration.proofs.indexWrite, true);
  assert.equal(hydration.proofs.scratchRefRemoved, true);
  assert.deepEqual(new Set(hydration.staleProbesRemoved), new Set([
    ".agent-bridge-write-probe-stale",
    ".agent-bridge-write-probe-stale-directory",
  ]));
  assert.equal(hydration.publicationRoute.configured, true);
  assert.equal(hydration.publicationRoute.authorized, true);
  assert.equal(hydration.publicationRoute.proven, false);
  assert.equal(hydration.publicationRoute.provenBy, null);
  assert.equal(JSON.parse(readFileSync(hydration.receiptPath, "utf8")).status, "complete");

  git(checkout.path, "remote", "set-url", "origin", `${remote}-moved`);
  assert.throws(
    () => preflightWriterHydration({ workspace: checkout.path, expectedRemoteUrl: remote }),
    /origin moved/,
  );
  assert.equal(JSON.parse(readFileSync(hydration.receiptPath, "utf8")).status, "failed");
  assert.equal(JSON.parse(readFileSync(hydration.receiptPath, "utf8")).stage, "preflight");
  git(checkout.path, "remote", "set-url", "origin", remote);

  writeFileSync(join(checkout.path, "feature.txt"), "feature\n");
  git(checkout.path, "add", "feature.txt");
  git(checkout.path, "commit", "-m", "Feature");
  const writerHead = git(checkout.path, "rev-parse", "HEAD");
  git(checkout.path, "push", "origin", `HEAD:refs/heads/${checkout.branch}`);
  git(checkout.path, "push", "origin", `HEAD:refs/heads/main`);

  writeFileSync(join(checkout.path, "dirty.txt"), "preserve\n");
  assert.throws(() => inspectWriterRetirement({
    workspace: checkout.path,
    expectedHeadSha: writerHead,
    expectedRemoteUrl: remote,
    mergedSha: writerHead,
    branch: checkout.branch,
  }), /dirty work/);
  rmSync(join(checkout.path, "dirty.txt"));

  const inspected = inspectWriterRetirement({
    workspace: checkout.path,
    expectedHeadSha: writerHead,
    expectedRemoteUrl: remote,
    mergedSha: writerHead,
    branch: checkout.branch,
  });
  assert.equal(inspected.recovery.source, "contained_git_object_database");
  const recovered = recoverExactSha({ workspace: checkout.path, sha: writerHead });
  assert.equal(recovered.sha, writerHead);

  const mainUpdate = updateLocalDefaultBranch({
    workspace: source,
    defaultBranch: "main",
    mergedSha: writerHead,
  });
  assert.equal(mainUpdate.disposition, "fast_forwarded");
  assert.equal(git(source, "rev-parse", "main"), writerHead);

  writeFileSync(join(checkout.path, "second.txt"), "second\n");
  git(checkout.path, "add", "second.txt");
  git(checkout.path, "commit", "-m", "Second");
  const secondHead = git(checkout.path, "rev-parse", "HEAD");
  git(checkout.path, "push", "origin", "HEAD:refs/heads/second");
  git(source, "checkout", "--detach");
  const linkedMain = join(temporary, "linked-main");
  git(source, "worktree", "add", linkedMain, "main");
  assert.throws(() => inspectLocalDefaultBranchUpdate({
    workspace: source,
    defaultBranch: "main",
    mergedSha: secondHead,
  }), /checked out in another worktree/);
  git(source, "worktree", "remove", linkedMain);

  const failedState = retirementFailureState({
    status: "indeterminate",
    workspaceOperation: { id: "retire-1", stage: "verified" },
  }, {
    operationId: "retire-1",
    previousStatus: "completed",
    workspaceExists: true,
    error: "deterministic failure",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(failedState.status, "completed");
  assert.equal(failedState.workspaceOperation, null);
  assert.equal(failedState.workspaceRetirementFailure.stage, "verified");
  const missingState = retirementFailureState({
    status: "indeterminate",
    workspaceOperation: { id: "retire-2", stage: "removing" },
  }, {
    operationId: "retire-2",
    previousStatus: "completed",
    workspaceExists: false,
    error: "state write failed after removal",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(missingState.status, "indeterminate");
  assert.equal(missingState.workspaceOperation.status, "reconciliation_required");

  git(checkout.path, "remote", "set-url", "origin", `${remote}-moved`);
  assert.throws(() => inspectWriterRetirement({
    workspace: checkout.path,
    expectedHeadSha: secondHead,
    expectedRemoteUrl: remote,
    mergedSha: secondHead,
    branch: checkout.branch,
  }), /origin moved/);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Writer lifecycle tests passed: hydration, scratch-ref cleanup, dirty/unmoved retirement, exact-SHA recovery, and safe main update are enforced.");

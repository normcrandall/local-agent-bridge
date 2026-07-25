#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWriterCheckout } from "../src/writer-checkout.mjs";
import {
  inspectWriterRetirement,
  preflightWriterHydration,
  recoverExactSha,
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
  git(source, "add", "README.md");
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
  const hydration = preflightWriterHydration({
    workspace: checkout.path,
    expectedRemoteUrl: remote,
    githubBuilder: {
      allowWorkspaceHead: true,
      repository: "norm/example",
      headSha: baseSha,
      expectedLogin: "builder[bot]",
    },
  });
  assert.equal(hydration.status, "complete");
  assert.equal(hydration.proofs.workspaceWrite, true);
  assert.equal(hydration.proofs.indexWrite, true);
  assert.equal(hydration.proofs.scratchRefRemoved, true);
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

  git(checkout.path, "remote", "set-url", "origin", `${remote}-moved`);
  assert.throws(() => inspectWriterRetirement({
    workspace: checkout.path,
    expectedHeadSha: writerHead,
    expectedRemoteUrl: remote,
    mergedSha: writerHead,
    branch: checkout.branch,
  }), /origin moved/);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Writer lifecycle tests passed: hydration, scratch-ref cleanup, dirty/unmoved retirement, exact-SHA recovery, and safe main update are enforced.");

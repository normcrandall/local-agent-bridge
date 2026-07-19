import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareWriterCheckout, recoverWriterCheckout } from "../src/writer-checkout.mjs";
import { antigravityToolRequest, claudeToolRequest, codexToolRequest } from "../src/tool-requests.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const temporary = mkdtempSync(join(tmpdir(), "bridge-writer-checkout-test-"));
const repository = join(temporary, "repository");
const checkoutRoot = join(temporary, "writer-checkouts");
mkdirSync(repository);

try {
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Bridge Test");
  git(repository, "config", "user.email", "bridge@example.invalid");
  writeFileSync(join(repository, "README.md"), "source\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial source");
  git(repository, "remote", "add", "origin", "https://example.invalid/owner/repository.git");
  const sourceHead = git(repository, "rev-parse", "HEAD");
  const sourceGitDirectory = realpathSync(join(repository, ".git"));

  const checkout = prepareWriterCheckout({
    workspace: repository,
    taskId: "issue-82",
    branch: "codex/issue-82-private-writer-checkouts",
    base: sourceHead,
    checkoutRoot,
  });

  const writerGitDirectory = realpathSync(resolve(checkout.path, git(checkout.path, "rev-parse", "--absolute-git-dir")));
  const writerCommonDirectory = realpathSync(resolve(checkout.path, git(checkout.path, "rev-parse", "--git-common-dir")));
  assert.equal(resolve(checkout.gitMetadataRoot), writerGitDirectory);
  assert.equal(writerCommonDirectory, writerGitDirectory);
  assert.notEqual(writerGitDirectory, sourceGitDirectory);
  assert.equal(git(checkout.path, "remote", "get-url", "origin"), "https://example.invalid/owner/repository.git");
  assert.equal(git(checkout.path, "branch", "--show-current"), "codex/issue-82-private-writer-checkouts");
  assert.equal(git(checkout.path, "rev-parse", "HEAD"), sourceHead);
  assert.deepEqual(checkout.cleanup, { strategy: "remove-directory", path: checkout.path });

  const writableRoots = [checkout.gitMetadataRoot];
  const codexRequest = codexToolRequest({
    prompt: "commit the implementation",
    cwd: checkout.path,
    mode: "work",
    workProfile: "implement",
    writableRoots,
  });
  assert.deepEqual(codexRequest.arguments.config["sandbox_workspace_write.writable_roots"], writableRoots);
  assert.deepEqual(codexToolRequest({
    prompt: "continue committing the implementation",
    sessionId: "existing-codex-thread",
    cwd: checkout.path,
    mode: "work",
    workProfile: "implement",
    writableRoots,
  }).arguments.config["sandbox_workspace_write.writable_roots"], writableRoots);
  assert.deepEqual(claudeToolRequest({
    prompt: "commit the implementation",
    cwd: checkout.path,
    mode: "work",
    workProfile: "implement",
    writableRoots,
  }).arguments.writableRoots, writableRoots);
  assert.deepEqual(antigravityToolRequest({
    prompt: "commit the implementation",
    cwd: checkout.path,
    mode: "work",
    writableRoots,
  }).arguments.writableRoots, writableRoots);

  writeFileSync(join(checkout.path, "writer.txt"), "committed by delegated writer\n");
  git(checkout.path, "add", "writer.txt");
  git(checkout.path, "commit", "-m", "Writer commit");

  assert.equal(readFileSync(join(checkout.path, "writer.txt"), "utf8"), "committed by delegated writer\n");
  assert.equal(git(repository, "rev-parse", "HEAD"), sourceHead);
  assert.notEqual(
    spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/issue-82-private-writer-checkouts"], { cwd: repository }).status,
    0,
  );

  const localOnlyRepository = join(temporary, "local-only-repository");
  mkdirSync(localOnlyRepository);
  git(localOnlyRepository, "init", "--initial-branch=main");
  git(localOnlyRepository, "config", "user.name", "Bridge Test");
  git(localOnlyRepository, "config", "user.email", "bridge@example.invalid");
  writeFileSync(join(localOnlyRepository, "local.txt"), "local only\n");
  git(localOnlyRepository, "add", "local.txt");
  git(localOnlyRepository, "commit", "-m", "Local-only source");
  const localOnlyCheckout = prepareWriterCheckout({
    workspace: localOnlyRepository,
    taskId: "local-only",
    branch: "codex/local-only",
    checkoutRoot: join(temporary, "local-only-writers"),
  });
  assert.notEqual(spawnSync("git", ["remote", "get-url", "origin"], { cwd: localOnlyCheckout.path }).status, 0);
  writeFileSync(join(localOnlyCheckout.path, "writer.txt"), "local writer\n");
  git(localOnlyCheckout.path, "add", "writer.txt");
  git(localOnlyCheckout.path, "commit", "-m", "Local writer commit");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Writer checkout test passed: delegated commits use private Git metadata without mutating the source repository.");

const recoveryTemporary = mkdtempSync(join(tmpdir(), "bridge-writer-recovery-test-"));
const recoveryRepository = join(recoveryTemporary, "repository");
const linkedWorktree = join(recoveryTemporary, "linked-worktree");
mkdirSync(recoveryRepository);

try {
  git(recoveryRepository, "init", "--initial-branch=main");
  git(recoveryRepository, "config", "user.name", "Bridge Test");
  git(recoveryRepository, "config", "user.email", "bridge@example.invalid");
  writeFileSync(join(recoveryRepository, "modified.txt"), "before\n");
  writeFileSync(join(recoveryRepository, "deleted.txt"), "delete me\n");
  git(recoveryRepository, "add", "modified.txt", "deleted.txt");
  git(recoveryRepository, "commit", "-m", "Recovery base");
  const recoveryBase = git(recoveryRepository, "rev-parse", "HEAD");
  git(recoveryRepository, "remote", "add", "origin", "https://example.invalid/owner/recovery.git");
  git(recoveryRepository, "worktree", "add", "-b", "codex/recover-lane", linkedWorktree, "HEAD");
  writeFileSync(join(linkedWorktree, "committed-after-base.txt"), "committed in stranded lane\n");
  git(linkedWorktree, "add", "committed-after-base.txt");
  git(linkedWorktree, "commit", "-m", "Stranded lane commit");
  writeFileSync(join(linkedWorktree, "modified.txt"), "after\n");
  rmSync(join(linkedWorktree, "deleted.txt"));
  mkdirSync(join(linkedWorktree, "nested"));
  writeFileSync(join(linkedWorktree, "nested/untracked.txt"), "untracked\n");
  git(linkedWorktree, "add", "modified.txt");
  const sourceHead = git(linkedWorktree, "rev-parse", "HEAD");
  const sourceDiff = git(linkedWorktree, "diff", "--binary", recoveryBase);

  const recovered = recoverWriterCheckout({
    workspace: linkedWorktree,
    taskId: "recover-lane",
    branch: "codex/recover-lane",
    base: recoveryBase,
    checkoutRoot: join(recoveryTemporary, "writer-checkouts"),
  });

  assert.equal(recovered.recoveredFrom, realpathSync(linkedWorktree));
  assert.equal(git(recovered.path, "rev-parse", "HEAD"), recoveryBase);
  assert.equal(recovered.recovery.recordedBaseSha, recoveryBase);
  assert.equal(recovered.recovery.sourceHeadSha, sourceHead);
  assert.equal(readFileSync(join(recovered.path, "committed-after-base.txt"), "utf8"), "committed in stranded lane\n");
  assert.equal(readFileSync(join(recovered.path, "nested/untracked.txt"), "utf8"), "untracked\n");
  assert.equal(
    git(recovered.path, "ls-files", "--others", "--exclude-standard"),
    "committed-after-base.txt\nnested/untracked.txt",
  );
  assert.equal(git(recovered.path, "rev-parse", "--git-common-dir"), ".git");
  assert.notEqual(realpathSync(join(recovered.path, ".git")), realpathSync(join(recoveryRepository, ".git")));
  git(recovered.path, "add", "--all", "committed-after-base.txt", "deleted.txt", "modified.txt");
  assert.equal(git(recovered.path, "diff", "--cached", "--binary", recoveryBase), sourceDiff);
} finally {
  rmSync(recoveryTemporary, { recursive: true, force: true });
}

console.log("Writer recovery test passed: tracked, deleted, staged, and untracked changes migrate into private Git custody.");

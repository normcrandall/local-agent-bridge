import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const SAFE_TASK_ID = /^[A-Za-z0-9._-]+$/;

function git(cwd, args, { errorMessage, trim = true } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(errorMessage || (result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function containedPath(root, candidate, label) {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay inside the writer checkout.`);
  }
  return candidate;
}

function localConfig(workspace, key) {
  const result = spawnSync("git", ["config", "--local", "--get", key], {
    cwd: workspace,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolvedGitDirectory(workspace, argument) {
  return realpathSync(resolve(workspace, git(workspace, ["rev-parse", argument])));
}

export function isLinkedGitCheckout(workspace) {
  const actualWorkspace = realpathSync(resolve(workspace));
  return resolvedGitDirectory(actualWorkspace, "--absolute-git-dir")
    !== resolvedGitDirectory(actualWorkspace, "--git-common-dir");
}

export function adoptExistingWriterCheckout({ workspace }) {
  const actualWorkspace = realpathSync(resolve(workspace));
  const gitMetadataRoot = resolvedGitDirectory(actualWorkspace, "--absolute-git-dir");
  const gitCommonRoot = resolvedGitDirectory(actualWorkspace, "--git-common-dir");
  if (gitMetadataRoot !== gitCommonRoot) {
    throw new Error(
      "Existing work workspace uses shared Git metadata; create a private writer checkout or call recover_writer_checkout before continuing.",
    );
  }
  containedPath(actualWorkspace, gitMetadataRoot, "Writer Git metadata");
  containedPath(actualWorkspace, gitCommonRoot, "Writer common Git metadata");
  if (!statSync(gitMetadataRoot).isDirectory()) {
    throw new Error("Writer Git metadata root is not a directory.");
  }
  return {
    path: actualWorkspace,
    workspace: actualWorkspace,
    gitMetadataRoot,
    branch: git(actualWorkspace, ["branch", "--show-current"]) || null,
    base: git(actualWorkspace, ["rev-parse", "HEAD"]),
    strategy: "self-contained",
    managed: false,
    cleanup: null,
  };
}

export function prepareWriterCheckout({
  workspace,
  taskId,
  branch,
  base = "HEAD",
  checkoutRoot,
}) {
  if (branch?.startsWith("-") || taskId?.startsWith("-")
    || !SAFE_BRANCH.test(branch || "") || !SAFE_TASK_ID.test(taskId || "")) {
    throw new Error("Unsafe task or branch name.");
  }

  const source = realpathSync(resolve(workspace));
  const root = resolve(checkoutRoot || join(source, ".bridge/writer-checkouts"));
  const path = resolve(root, taskId);
  if (existsSync(path)) throw new Error(`Writer checkout already exists: ${path}`);
  mkdirSync(root, { recursive: true });

  const originResult = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: source,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const canonicalOrigin = originResult.status === 0 ? originResult.stdout.trim() : null;
  const baseSha = git(source, ["rev-parse", "--verify", `${base}^{commit}`], {
    errorMessage: `Unable to resolve writer checkout base ${base}.`,
  });

  try {
    git(source, ["clone", "--no-hardlinks", "--no-checkout", "--no-tags", "--origin", "origin", source, path], {
      errorMessage: `Unable to create private writer checkout at ${path}.`,
    });
    if (canonicalOrigin) git(path, ["remote", "set-url", "origin", canonicalOrigin]);
    else git(path, ["remote", "remove", "origin"]);
    git(path, ["checkout", "--no-track", "-B", branch, baseSha], {
      errorMessage: `Unable to create writer branch ${branch} at ${baseSha}.`,
    });

    for (const key of ["user.name", "user.email", "commit.gpgsign"]) {
      const value = localConfig(source, key);
      if (value) git(path, ["config", "--local", key, value]);
    }

    const actualPath = realpathSync(path);
    const gitMetadataRoot = realpathSync(resolve(actualPath, git(actualPath, ["rev-parse", "--absolute-git-dir"])));
    const gitCommonRoot = realpathSync(resolve(actualPath, git(actualPath, ["rev-parse", "--git-common-dir"])));
    containedPath(actualPath, gitMetadataRoot, "Writer Git metadata");
    containedPath(actualPath, gitCommonRoot, "Writer common Git metadata");
    if (gitMetadataRoot !== gitCommonRoot) {
      throw new Error("Writer checkout must own one self-contained Git metadata directory.");
    }
    if (!statSync(gitMetadataRoot).isDirectory()) {
      throw new Error("Writer Git metadata root is not a directory.");
    }

    return {
      path: actualPath,
      workspace: actualPath,
      gitMetadataRoot,
      branch,
      base: baseSha,
      strategy: "self-contained",
      managed: true,
      cleanup: { strategy: "remove-directory", path: actualPath },
    };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

export function recoverWriterCheckout({
  workspace,
  taskId,
  branch,
  base = "HEAD",
  checkoutRoot,
}) {
  const source = realpathSync(resolve(workspace));
  if (!isLinkedGitCheckout(source)) {
    throw new Error("Writer recovery requires a linked Git worktree source.");
  }
  const sourceBranch = branch || git(source, ["branch", "--show-current"]);
  if (!sourceBranch) throw new Error("Writer recovery requires a named source branch.");
  const recordedBaseSha = git(source, ["rev-parse", "--verify", `${base}^{commit}`], {
    errorMessage: `Unable to resolve recorded writer base ${base}.`,
  });
  const sourceHeadSha = git(source, ["rev-parse", "HEAD"]);
  const patch = git(source, ["diff", "--binary", recordedBaseSha, "--"], { trim: false });
  const untracked = git(source, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false })
    .split("\0")
    .filter(Boolean);

  const commonGitRoot = resolvedGitDirectory(source, "--git-common-dir");
  const defaultCheckoutRoot = commonGitRoot.endsWith(`${sep}.git`)
    ? join(dirname(commonGitRoot), ".bridge/writer-checkouts")
    : join(source, ".bridge/writer-checkouts");
  const checkout = prepareWriterCheckout({
    workspace: source,
    taskId,
    branch: sourceBranch,
    base: recordedBaseSha,
    checkoutRoot: checkoutRoot || defaultCheckoutRoot,
  });

  try {
    if (patch) {
      const applied = spawnSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
        cwd: checkout.path,
        encoding: "utf8",
        input: patch,
      });
      if (applied.status !== 0) {
        throw new Error(`Unable to migrate tracked writer changes: ${(applied.stderr || applied.stdout).trim()}`);
      }
    }

    for (const relativePath of untracked) {
      const sourcePath = containedPath(source, resolve(source, relativePath), "Untracked recovery source");
      const destinationPath = containedPath(checkout.path, resolve(checkout.path, relativePath), "Untracked recovery destination");
      mkdirSync(resolve(destinationPath, ".."), { recursive: true });
      cpSync(sourcePath, destinationPath, { dereference: false, preserveTimestamps: true, recursive: true });
    }

    return {
      ...checkout,
      recoveredFrom: source,
      recovery: {
        recordedBaseSha,
        sourceHeadSha,
        trackedPatch: Boolean(patch),
        untrackedPaths: untracked,
      },
    };
  } catch (error) {
    rmSync(checkout.path, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupWriterCheckout({ workspace, expectedPath, discardChanges = false }) {
  const actualWorkspace = realpathSync(resolve(workspace));
  const actualExpectedPath = realpathSync(resolve(expectedPath));
  if (actualWorkspace !== actualExpectedPath) {
    throw new Error("Writer checkout cleanup path changed after inspection.");
  }
  if (isLinkedGitCheckout(actualWorkspace)) {
    throw new Error("Writer checkout cleanup refuses linked Git worktrees.");
  }
  const gitMetadataRoot = resolvedGitDirectory(actualWorkspace, "--absolute-git-dir");
  const gitCommonRoot = resolvedGitDirectory(actualWorkspace, "--git-common-dir");
  containedPath(actualWorkspace, gitMetadataRoot, "Writer Git metadata");
  containedPath(actualWorkspace, gitCommonRoot, "Writer common Git metadata");
  if (gitMetadataRoot !== gitCommonRoot) {
    throw new Error("Writer checkout cleanup requires self-contained Git metadata.");
  }
  const status = git(actualWorkspace, ["status", "--porcelain"], { trim: false });
  if (status && !discardChanges) {
    throw new Error("Writer checkout has uncommitted changes; set discardChanges only after preserving or intentionally discarding them.");
  }
  rmSync(actualWorkspace, { recursive: true, force: true });
  return {
    path: actualWorkspace,
    discardedChanges: Boolean(status),
    cleanedAt: new Date().toISOString(),
  };
}

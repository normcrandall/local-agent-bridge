import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function git(workspace, args, { environment = {}, input, optional = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
    input,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = (result.stdout || result.stderr || "").trim();
  if (result.status !== 0 && !optional) {
    throw new Error(output || `git ${args[0]} failed`);
  }
  return { ok: result.status === 0, output };
}

function contained(root, candidate, label) {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the writer checkout.`);
  }
  return candidate;
}

function publicationRoute(githubBuilder, remoteUrl) {
  const allowedOperations = new Set(githubBuilder?.allowedOperations || []);
  const builderCanPublish = allowedOperations.has("push_branch")
    && allowedOperations.has("ensure_pull_request");
  if (githubBuilder?.allowWorkspaceHead === true
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubBuilder.repository || "")
    && SHA_PATTERN.test(githubBuilder.headSha || "")) {
    return {
      kind: "bound_builder_app",
      repository: githubBuilder.repository,
      expectedLogin: githubBuilder.expectedLogin || null,
      configured: true,
      authorized: builderCanPublish,
      proven: false,
      provenBy: null,
      requiredOperations: ["push_branch", "ensure_pull_request"],
    };
  }
  return remoteUrl
    ? { kind: "configured_remote_handoff", remote: "origin", configured: true, authorized: false, proven: false, provenBy: null }
    : { kind: "none", configured: false, authorized: false, proven: false, provenBy: null };
}

function removeStaleHydrationProbes(root) {
  const prefix = ".agent-bridge-write-probe-";
  const removed = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const path = contained(root, join(root, name), "Stale writer probe");
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      throw new Error(`Unable to remove stale writer hydration probe ${path}: ${error.message}`);
    }
  }
  return removed;
}

export function recordWriterHydrationFailure({ workspace, stage, error, now = () => new Date().toISOString() }) {
  const root = realpathSync(resolve(workspace));
  const gitDirectory = realpathSync(resolve(root, git(root, ["rev-parse", "--absolute-git-dir"]).output));
  contained(root, gitDirectory, "Writer Git metadata");
  const receiptPath = join(gitDirectory, "agent-bridge-hydration.json");
  let existing = {};
  try { existing = JSON.parse(readFileSync(receiptPath, "utf8")); } catch {}
  const receipt = {
    ...existing,
    status: "failed",
    stage,
    failedAt: now(),
    workspace: root,
    error: error instanceof Error ? error.message : String(error),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, receiptPath };
}

/**
 * Prove that a writer can mutate the checkout and its private Git metadata
 * without advancing a user-visible branch. The scratch ref is deleted before
 * the function returns, while its exact receipt is durable collaboration state.
 */
export function preflightWriterHydration({
  workspace,
  expectedRemoteUrl = null,
  githubBuilder = null,
  now = () => new Date().toISOString(),
}) {
  const root = realpathSync(resolve(workspace));
  const gitDirectory = realpathSync(resolve(root, git(root, ["rev-parse", "--absolute-git-dir"]).output));
  contained(root, gitDirectory, "Writer Git metadata");
  const commonDirectory = realpathSync(resolve(root, git(root, ["rev-parse", "--git-common-dir"]).output));
  if (gitDirectory !== commonDirectory) {
    throw new Error("Writer hydration refuses linked Git metadata.");
  }

  const operationId = randomUUID();
  const startedAt = now();
  const probePath = contained(root, join(root, `.agent-bridge-write-probe-${operationId}`), "Writer probe");
  const scratchRoot = contained(gitDirectory, mkdtempSync(join(gitDirectory, "agent-bridge-hydration-")), "Hydration scratch directory");
  const scratchIndex = join(scratchRoot, "index");
  const scratchRef = `refs/agent-bridge/hydration/${operationId}`;
  const receiptPath = contained(gitDirectory, join(gitDirectory, "agent-bridge-hydration.json"), "Hydration receipt");
  const resolvedHead = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], { optional: true });
  const head = resolvedHead.ok ? resolvedHead.output : null;
  const staleProbesRemoved = removeStaleHydrationProbes(root);
  writeFileSync(receiptPath, `${JSON.stringify({
    operationId,
    status: "reserved",
    stage: "workspace_write",
    startedAt,
    workspace: root,
    headSha: head,
  }, null, 2)}\n`);
  let remoteUrl;
  let route;
  let treeSha;
  let commitSha;
  try {
    const remote = git(root, ["remote", "get-url", "origin"], { optional: true });
    remoteUrl = remote.ok ? remote.output : null;
    if (!remoteUrl) throw new Error("Writer hydration requires a configured origin remote.");
    if (expectedRemoteUrl && remoteUrl !== expectedRemoteUrl) {
      throw new Error(`Writer origin moved after checkout creation: expected ${expectedRemoteUrl}, observed ${remoteUrl}.`);
    }
    route = publicationRoute(githubBuilder, remoteUrl);
    if (!route.configured) throw new Error("Writer hydration requires a configured publication route.");
    if (route.kind === "bound_builder_app" && !route.authorized) {
      throw new Error("Writer hydration requires the bound builder App to authorize push_branch and ensure_pull_request.");
    }
    writeFileSync(probePath, `agent-bridge hydration ${operationId}\n`, { flag: "wx" });
    const indexEnvironment = { GIT_INDEX_FILE: scratchIndex };
    git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], { environment: indexEnvironment });
    git(root, ["add", "--force", "--", probePath], { environment: indexEnvironment });
    treeSha = git(root, ["write-tree"], { environment: indexEnvironment }).output;
    const identityEnvironment = {
      GIT_AUTHOR_NAME: "Agent Bridge Preflight",
      GIT_AUTHOR_EMAIL: "preflight@invalid",
      GIT_COMMITTER_NAME: "Agent Bridge Preflight",
      GIT_COMMITTER_EMAIL: "preflight@invalid",
    };
    commitSha = git(root, ["commit-tree", treeSha, ...(head ? ["-p", head] : [])], {
      environment: identityEnvironment,
      input: "Agent Bridge writer commit-capability preflight\n",
    }).output;
    git(root, ["update-ref", scratchRef, commitSha, "0".repeat(40)]);
    if (git(root, ["rev-parse", "--verify", scratchRef]).output !== commitSha) {
      throw new Error("Writer scratch ref could not be verified.");
    }
    git(root, ["update-ref", "-d", scratchRef, commitSha]);
  } catch (error) {
    recordWriterHydrationFailure({ workspace: root, stage: "preflight", error, now });
    throw error;
  } finally {
    rmSync(probePath, { force: true });
    git(root, ["update-ref", "-d", scratchRef], { optional: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }

  const receipt = {
    operationId,
    status: "complete",
    startedAt,
    completedAt: now(),
    workspace: root,
    gitMetadataRoot: gitDirectory,
    headSha: head,
    remote: { name: "origin", url: remoteUrl },
    publicationRoute: route,
    staleProbesRemoved,
    proofs: {
      workspaceWrite: true,
      indexWrite: true,
      commitObject: commitSha,
      scratchRef,
      scratchRefRemoved: !git(root, ["show-ref", "--verify", "--quiet", scratchRef], { optional: true }).ok,
    },
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, receiptPath };
}

export function inspectWriterRetirement({
  workspace,
  expectedHeadSha,
  expectedRemoteUrl,
  mergedSha,
  branch,
}) {
  const root = realpathSync(resolve(workspace));
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).output;
  if (status) throw new Error("Writer retirement refuses dirty work.");
  const headSha = git(root, ["rev-parse", "HEAD"]).output;
  if (headSha !== expectedHeadSha) {
    throw new Error(`Writer retirement HEAD changed: expected ${expectedHeadSha}, observed ${headSha}.`);
  }
  const remoteUrl = git(root, ["remote", "get-url", "origin"]).output;
  if (expectedRemoteUrl && remoteUrl !== expectedRemoteUrl) {
    throw new Error(`Writer origin moved: expected ${expectedRemoteUrl}, observed ${remoteUrl}.`);
  }
  if (!SHA_PATTERN.test(mergedSha || "")) throw new Error("Writer retirement requires an exact merged SHA.");
  const headObject = git(root, ["cat-file", "-e", `${expectedHeadSha}^{commit}`], { optional: true });
  if (!headObject.ok) throw new Error(`Writer head ${expectedHeadSha} is not recoverable from the checkout.`);
  const mergedObject = git(root, ["cat-file", "-e", `${mergedSha}^{commit}`], { optional: true });
  if (!mergedObject.ok) throw new Error(`Merged SHA ${mergedSha} is not recoverable from the checkout.`);
  return {
    workspace: root,
    headSha,
    mergedSha,
    branch: branch || null,
    remote: { name: "origin", url: remoteUrl },
    recovery: {
      headSha: expectedHeadSha,
      mergedSha,
      source: "contained_git_object_database",
    },
  };
}

export function recoverExactSha({ workspace, sha, remote = "origin" }) {
  if (!SHA_PATTERN.test(sha || "")) throw new Error("Exact-SHA recovery requires a full commit SHA.");
  const root = realpathSync(resolve(workspace));
  if (git(root, ["cat-file", "-e", `${sha}^{commit}`], { optional: true }).ok) {
    const refs = git(root, ["for-each-ref", "--format=%(refname)", "--contains", sha], { optional: true }).output
      .split("\n").filter(Boolean);
    return {
      sha,
      source: refs.find((ref) => ref.startsWith("refs/remotes/")) || "contained_git_object_database",
      fetched: false,
    };
  }
  const fetched = git(root, ["fetch", "--no-tags", remote, sha], { optional: true });
  if (!fetched.ok || !git(root, ["cat-file", "-e", `${sha}^{commit}`], { optional: true }).ok) {
    throw new Error(`Exact SHA ${sha} could not be recovered from ${remote}: ${fetched.output}`);
  }
  return { sha, source: `${remote}:exact-sha`, fetched: true };
}

function listedWorktrees(root) {
  const output = git(root, ["worktree", "list", "--porcelain"], { optional: true });
  if (!output.ok) throw new Error(`Unable to inspect local worktrees: ${output.output}`);
  const records = [];
  let current = null;
  for (const line of output.output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) records.push(current);
  return records;
}

export function inspectLocalDefaultBranchUpdate({
  workspace,
  defaultBranch = "main",
  mergedSha,
}) {
  const root = realpathSync(resolve(workspace));
  const ref = `refs/heads/${defaultBranch}`;
  if (!git(root, ["cat-file", "-e", `${mergedSha}^{commit}`], { optional: true }).ok) {
    recoverExactSha({ workspace: root, sha: mergedSha });
  }
  const current = git(root, ["rev-parse", "--verify", ref], { optional: true });
  if (current.ok && current.output !== mergedSha) {
    const ancestor = git(root, ["merge-base", "--is-ancestor", current.output, mergedSha], { optional: true });
    if (!ancestor.ok) {
      throw new Error(`Local ${defaultBranch} cannot be fast-forwarded safely to ${mergedSha}.`);
    }
  }
  const checkedOut = listedWorktrees(root).filter((entry) => entry.branch === ref);
  if (checkedOut.some((entry) => realpathSync(resolve(entry.path)) !== root)) {
    throw new Error(`Local ${defaultBranch} is checked out in another worktree and cannot be updated safely.`);
  }
  if (checkedOut.length && git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).output) {
    throw new Error(`Local ${defaultBranch} is dirty and cannot be updated safely.`);
  }
  return {
    branch: defaultBranch,
    previousSha: current.ok ? current.output : null,
    updatedSha: mergedSha,
    checkedOut: checkedOut.length > 0,
    disposition: current.ok && current.output === mergedSha ? "already_current" : "fast_forwarded",
  };
}

export function updateLocalDefaultBranch({
  workspace,
  defaultBranch = "main",
  mergedSha,
  expectedPreviousSha,
}) {
  const root = realpathSync(resolve(workspace));
  const ref = `refs/heads/${defaultBranch}`;
  const plan = inspectLocalDefaultBranchUpdate({ workspace: root, defaultBranch, mergedSha });
  if (plan.previousSha === mergedSha) return plan;
  if (expectedPreviousSha !== undefined && plan.previousSha !== expectedPreviousSha) {
    throw new Error(`Local ${defaultBranch} changed after retirement preflight: expected ${expectedPreviousSha || "missing"}, observed ${plan.previousSha || "missing"}.`);
  }
  if (plan.checkedOut) git(root, ["merge", "--ff-only", mergedSha]);
  else git(root, ["update-ref", ref, mergedSha, plan.previousSha || "0".repeat(40)]);
  return plan;
}

export function retirementFailureState(state, { operationId, previousStatus, workspaceExists, error, at = new Date().toISOString() }) {
  if (state.workspaceOperation?.id !== operationId) return state;
  const failure = { operationId, stage: state.workspaceOperation.stage, failedAt: at, error };
  if (workspaceExists) {
    return {
      ...state,
      status: previousStatus,
      workspaceOperation: null,
      workspaceRetirementFailure: failure,
    };
  }
  return {
    ...state,
    status: "indeterminate",
    workspaceOperation: {
      ...state.workspaceOperation,
      status: "reconciliation_required",
      failedAt: at,
      error,
    },
    workspaceRetirementFailure: failure,
  };
}

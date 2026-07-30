import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { canonicalGitHubAppLogin } from "./github-app-auth.mjs";

function revParse(workspace, revision, errorMessage) {
  const result = spawnSync("git", ["rev-parse", revision], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(errorMessage);
  return result.stdout.trim();
}

function currentBranch(workspace) {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const branch = result.status === 0 ? result.stdout.trim() : "";
  if (!branch) throw new Error("Unable to derive the governed pull-request base branch from the workspace.");
  return branch;
}

function hasRef(workspace, ref) {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: workspace,
    encoding: "utf8",
  }).status === 0;
}

function publicationBaseRef(workspace, base) {
  const value = String(base || "HEAD").trim();
  if (value === "HEAD") return currentBranch(workspace);
  const localRef = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  if (hasRef(workspace, localRef)) return localRef.slice("refs/heads/".length);
  const remoteRef = value.startsWith("refs/remotes/origin/")
    ? value
    : `refs/remotes/${value.startsWith("origin/") ? value : `origin/${value}`}`;
  if (hasRef(workspace, remoteRef)) return remoteRef.slice("refs/remotes/origin/".length);
  throw new Error("A derived GitHub writer binding requires worktree.base to identify an existing local or origin branch, not only a commit SHA.");
}

export function deriveIssueTargetBuilderBinding({
  workspace,
  issueTarget = null,
  issueClaim = null,
  worktree = null,
  expectedLogin,
  writerProvider,
  githubBuilder = null,
}) {
  if (githubBuilder) return githubBuilder;
  const target = issueClaim || issueTarget;
  if (!target?.repository || !target?.issueNumber) return null;
  if (!worktree?.branch) {
    throw new Error("An issueTarget-only GitHub writer requires a self-contained worktree with an explicit publication branch.");
  }
  const revisions = resolveIssueClaimRevisions({
    workspace,
    headSha: issueClaim?.headSha || null,
    baseRef: worktree.base || issueClaim?.baseSha || "HEAD",
  });
  const baseRef = publicationBaseRef(workspace, worktree.base || "HEAD");
  if (worktree.branch === baseRef) {
    if (!worktree.base) {
      throw new Error("worktree.base must explicitly identify the pull-request base when the workspace is already on the publication branch.");
    }
    throw new Error("The derived GitHub writer publication branch must differ from the pull-request base branch.");
  }
  return {
    repository: target.repository,
    issueNumber: target.issueNumber,
    expectedLogin: canonicalGitHubAppLogin(expectedLogin),
    writerProvider,
    headSha: revisions.headSha,
    baseSha: revisions.baseSha,
    headRef: worktree.branch,
    baseRef,
    allowedOperations: ["push_branch", "ensure_pull_request"],
  };
}

export function resolveIssueClaimRevisions({ workspace, headSha, baseRef }) {
  const resolvedHeadSha = headSha || revParse(
    workspace,
    "HEAD",
    "Unable to retrieve HEAD SHA from workspace.",
  );
  const baseSha = revParse(
    workspace,
    baseRef || resolvedHeadSha,
    `Unable to resolve claim base revision ${baseRef || resolvedHeadSha}.`,
  );
  return { headSha: resolvedHeadSha, baseSha };
}

export function plannedIssueClaimWorktree({ workspace, worktree, mode = "review" }) {
  if (!worktree) return null;
  const defaultDirectory = mode === "work" ? ".bridge/writer-checkouts" : ".bridge/worktrees";
  const root = resolve(worktree.root || join(workspace, defaultDirectory));
  return resolve(root, worktree.taskId);
}

export function resolveClaimedWorktreeHead(workspace) {
  return revParse(workspace, "HEAD", "Unable to resolve the claimed worktree HEAD.");
}

export function resolveIssueClaimAfterPreflight({
  issueClaim,
  writer,
  branch,
  worktree,
  baseSha,
  headSha,
}) {
  if (!issueClaim) return null;
  return {
    ...issueClaim,
    expectedLogin: canonicalGitHubAppLogin(issueClaim.expectedLogin),
    writer,
    branch: branch || issueClaim.branch || null,
    worktree,
    baseSha,
    headSha,
  };
}

export function resolveContinuationIssueClaim({ currentIssueClaim, issueClaim }) {
  if (!currentIssueClaim) return null;
  return {
    ...currentIssueClaim,
    ...(issueClaim || {}),
    // The verified authority is durable collaboration state. A continuation
    // may refresh lease details, but it cannot replace or discard that proof.
    authority: currentIssueClaim.authority,
    expectedLogin: canonicalGitHubAppLogin(currentIssueClaim.expectedLogin),
  };
}

export function workspaceHeadBuilderBinding({ githubBuilder, mode, worktree }) {
  if (!githubBuilder) return null;
  return {
    ...githubBuilder,
    // This is a broker-derived capability, never an additive caller override.
    allowWorkspaceHead: mode === "work" && worktree?.strategy === "self-contained",
  };
}

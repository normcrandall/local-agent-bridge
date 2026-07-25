import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createInstallationToken } from "./github-app-auth.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function repositoryForState(state) {
  return state.issueClaim?.repository
    || state.githubReview?.repository
    || state.githubBuilder?.repository
    || null;
}

function pullRequestForState(state) {
  return state.githubReview?.prNumber
    || state.githubBuilder?.prNumber
    || state.ciTracking?.prNumber
    || state.ci?.pr
    || null;
}

function issueForState(state) {
  return state.issueClaim?.issueNumber || null;
}

function headForState(state) {
  return state.githubReview?.headSha
    || state.githubBuilder?.headSha
    || state.issueClaim?.headSha
    || null;
}

function branchForState(state) {
  return state.githubBuilder?.headRef
    || state.issueClaim?.branch
    || state.branch
    || null;
}

function workspaceForState(state) {
  return state.writerCheckout?.path
    || state.worktree?.path
    || state.issueClaim?.worktree
    || state.workspace
    || null;
}

function needsWorkspaceProof(state) {
  return state.mode === "work" || Boolean(state.writer || state.issueClaim || state.writerCheckout || state.worktree);
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "local-agent-bridge",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest({ apiUrl, fetchImpl, token, path, allowMissing = false }) {
  const response = await fetchImpl(`${apiUrl}${path}`, { headers: githubHeaders(token) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${body?.message || text || response.statusText}`);
  return body;
}

async function remoteBranchHead({ apiUrl, fetchImpl, token, repository, branch }) {
  if (!REPOSITORY_PATTERN.test(repository || "") || !branch) return null;
  const encodedBranch = String(branch).split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest({
    apiUrl, fetchImpl, token, allowMissing: true,
    path: `/repos/${repository}/git/ref/heads/${encodedBranch}`,
  });
  return SHA_PATTERN.test(ref?.object?.sha || "") ? ref.object.sha : null;
}

export function collaborationRetirementBinding(state) {
  return {
    repository: repositoryForState(state),
    prNumber: pullRequestForState(state),
    issueNumber: issueForState(state),
    expectedHeadSha: headForState(state),
    branch: branchForState(state),
    workspace: workspaceForState(state),
    workspaceProofRequired: needsWorkspaceProof(state),
  };
}

export async function verifyCollaborationGitHubOutcome(state, {
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  configPath = process.env.GITHUB_APP_CONFIG,
  getInstallationToken = createInstallationToken,
} = {}) {
  const binding = collaborationRetirementBinding(state);
  if (!REPOSITORY_PATTERN.test(binding.repository || "")) {
    return { safe: false, reason: "github_binding_missing", ...binding };
  }
  if (!binding.prNumber && !binding.issueNumber) {
    return { safe: false, reason: "github_target_missing", ...binding };
  }
  const credential = await getInstallationToken({
    role: "builder",
    repository: binding.repository,
    tokenPermissions: {
      contents: "read",
      issues: "read",
      metadata: "read",
      pull_requests: "read",
    },
    ...(configPath ? { configPath } : {}),
    apiUrl,
    fetchImpl,
  });
  const token = credential.token;

  if (binding.prNumber) {
    const pull = await githubRequest({
      apiUrl, fetchImpl, token,
      path: `/repos/${binding.repository}/pulls/${binding.prNumber}`,
    });
    const githubHeadSha = SHA_PATTERN.test(pull?.head?.sha || "") ? pull.head.sha : null;
    const mergedSha = SHA_PATTERN.test(pull?.merge_commit_sha || "") ? pull.merge_commit_sha : null;
    const merged = Boolean(pull?.merged_at || pull?.merged);
    const closed = String(pull?.state || "").toLowerCase() === "closed";
    if (!merged && !closed) {
      return { safe: false, reason: "pull_request_open", outcome: "open", githubHeadSha, ...binding };
    }
    let remoteHeadSha = null;
    const headRepository = pull?.head?.repo?.full_name || binding.repository;
    const headBranch = pull?.head?.ref || binding.branch;
    if (headRepository === binding.repository && headBranch) {
      remoteHeadSha = await remoteBranchHead({ apiUrl, fetchImpl, token, repository: headRepository, branch: headBranch });
    }
    const closedHeadRecoverable = merged
      || (SHA_PATTERN.test(binding.expectedHeadSha || "") && remoteHeadSha === binding.expectedHeadSha);
    return {
      safe: closedHeadRecoverable,
      reason: merged
        ? "pull_request_merged"
        : (closedHeadRecoverable ? "pull_request_closed" : "pull_request_closed_head_unrecoverable"),
      outcome: merged ? "merged" : "closed",
      githubHeadSha,
      mergedSha,
      remoteHeadSha,
      url: pull?.html_url || null,
      ...binding,
    };
  }

  const issue = await githubRequest({
    apiUrl, fetchImpl, token,
    path: `/repos/${binding.repository}/issues/${binding.issueNumber}`,
  });
  if (String(issue?.state || "").toLowerCase() !== "closed") {
    return { safe: false, reason: "issue_open", outcome: "open", ...binding };
  }
  // An issue-only record has no delivery head of its own; the closed issue is
  // its complete durable GitHub outcome. Work-mode records still proceed to
  // workspace verification and must prove an exact recoverable head there.
  const remoteHeadSha = binding.branch
    ? await remoteBranchHead({ apiUrl, fetchImpl, token, repository: binding.repository, branch: binding.branch })
    : null;
  return {
    safe: true,
    reason: "issue_closed",
    outcome: "closed",
    githubHeadSha: null,
    remoteHeadSha,
    url: issue?.html_url || null,
    ...binding,
  };
}

async function runGit(workspace, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspace,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function inspectCollaborationWorkspace(state, githubOutcome) {
  const binding = collaborationRetirementBinding(state);
  if (!binding.workspaceProofRequired) return { safe: true, reason: "workspace_proof_not_required" };
  const expectedHeadSha = binding.expectedHeadSha;
  if (!SHA_PATTERN.test(expectedHeadSha || "")) {
    return { safe: false, reason: "workspace_head_unbound", workspace: binding.workspace };
  }
  if (!binding.workspace) {
    const mergedExact = githubOutcome?.outcome === "merged" && githubOutcome.githubHeadSha === expectedHeadSha;
    return mergedExact
      ? { safe: true, reason: "workspace_absent_head_merged", headSha: expectedHeadSha, workspace: null }
      : { safe: false, reason: "workspace_missing_unrecoverable", headSha: expectedHeadSha, workspace: null };
  }
  try {
    const info = await stat(binding.workspace);
    if (!info.isDirectory()) return { safe: false, reason: "workspace_not_directory", workspace: binding.workspace };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const mergedExact = githubOutcome?.outcome === "merged" && githubOutcome.githubHeadSha === expectedHeadSha;
    return mergedExact
      ? { safe: true, reason: "workspace_absent_head_merged", headSha: expectedHeadSha, workspace: binding.workspace }
      : { safe: false, reason: "workspace_missing_unrecoverable", headSha: expectedHeadSha, workspace: binding.workspace };
  }

  let status;
  let headSha;
  let topLevel;
  try {
    [status, headSha, topLevel] = await Promise.all([
      runGit(binding.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
      runGit(binding.workspace, ["rev-parse", "HEAD"]),
      runGit(binding.workspace, ["rev-parse", "--show-toplevel"]),
    ]);
    const [recordedRoot, discoveredRoot] = await Promise.all([
      realpath(binding.workspace),
      realpath(topLevel),
    ]);
    if (recordedRoot !== discoveredRoot) {
      return {
        safe: false,
        reason: "workspace_repository_mismatch",
        workspace: binding.workspace,
        repositoryRoot: topLevel,
      };
    }
  } catch (error) {
    return { safe: false, reason: "workspace_uninspectable", workspace: binding.workspace, error: error.message };
  }
  if (status) return { safe: false, reason: "workspace_dirty", workspace: binding.workspace, headSha };
  if (headSha !== expectedHeadSha) {
    return { safe: false, reason: "workspace_head_mismatch", workspace: binding.workspace, headSha, expectedHeadSha };
  }
  const mergedExact = githubOutcome?.outcome === "merged" && githubOutcome.githubHeadSha === headSha;
  const remoteExact = githubOutcome?.remoteHeadSha === headSha;
  if (!mergedExact && !remoteExact) {
    return { safe: false, reason: "workspace_head_unpublished", workspace: binding.workspace, headSha };
  }
  return {
    safe: true,
    reason: mergedExact ? "workspace_head_merged" : "workspace_head_remote",
    workspace: binding.workspace,
    headSha,
  };
}

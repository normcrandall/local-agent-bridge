import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function revParse(workspace, revision, errorMessage) {
  const result = spawnSync("git", ["rev-parse", revision], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(errorMessage);
  return result.stdout.trim();
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

export function plannedIssueClaimWorktree({ workspace, worktree }) {
  if (!worktree) return null;
  const root = resolve(worktree.root || join(workspace, ".bridge/worktrees"));
  return resolve(root, worktree.taskId);
}

export function resolveClaimedWorktreeHead(workspace) {
  return revParse(workspace, "HEAD", "Unable to resolve the claimed worktree HEAD.");
}

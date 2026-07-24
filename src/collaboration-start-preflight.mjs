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

export function plannedIssueClaimWorktree({ workspace, worktree, mode = "review" }) {
  if (!worktree) return null;
  const defaultDirectory = mode === "work" ? ".bridge/writer-checkouts" : ".bridge/worktrees";
  const root = resolve(worktree.root || join(workspace, defaultDirectory));
  return resolve(root, worktree.taskId);
}

export function resolveClaimedWorktreeHead(workspace) {
  return revParse(workspace, "HEAD", "Unable to resolve the claimed worktree HEAD.");
}

export function workspaceHeadBuilderBinding({ githubBuilder, mode, worktree }) {
  if (!githubBuilder) return null;
  return {
    ...githubBuilder,
    // This is a broker-derived capability, never an additive caller override.
    allowWorkspaceHead: mode === "work" && worktree?.strategy === "self-contained",
  };
}

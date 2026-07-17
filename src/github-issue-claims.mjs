import { readCollaboration } from "./collaboration-store.mjs";
import { listPortfolios, readPortfolio, updatePortfolio } from "./portfolio-store.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { inspectGitHubAppRoles, createInstallationToken } from "./github-app-auth.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function getRepositoryFromWorkspace(workspacePath) {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workspacePath, encoding: "utf8" });
    if (result.status === 0) {
      let url = result.stdout.trim();
      if (url.endsWith(".git")) {
        url = url.slice(0, -4);
      }
      const match = url.match(/github\.com[/:]([^/]+\/[^/]+)$/);
      if (match) return match[1];
    }
  } catch {}
  return process.env.GITHUB_BUILDER_REPOSITORY || null;
}

function getHeadShaFromWorkspace(workspacePath) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {}
  return "0000000000000000000000000000000000000000";
}

export async function getBuilderClientForWorkspace(workspace, issueNum, fetchImpl = fetch) {
  const repository = getRepositoryFromWorkspace(workspace);
  if (!repository) return null;
  const appRoles = await inspectGitHubAppRoles();
  const expectedLogin = appRoles.roles?.builder?.expectedLogin;
  if (!expectedLogin) return null;
  const credential = await createInstallationToken({ role: "builder", repository });
  const headSha = getHeadShaFromWorkspace(workspace);
  return createBoundBuilderClient({
    apiUrl: process.env.GITHUB_BUILDER_API_URL || "https://api.github.com",
    token: credential.token,
    verifiedLogin: credential.verifiedLogin,
    repository,
    expectedLogin,
    headSha,
    issueNumber: issueNum,
    allowedOperations: ["get_issue", "add_issue_label", "remove_issue_label", "get_issue_comments", "post_issue_comment", "update_issue_comment", "delete_issue_comment", "create_ref", "delete_ref"],
    workspace,
    fetchImpl,
  });
}

async function isClaimActive(claim, workspaceRoot, ttlMs) {
  const phase = claim.data.phase;
  if (["completed", "merged", "obsolete", "rolled_back", "taken_over"].includes(phase)) {
    return false;
  }
  if (claim.data.collaboration) {
    try {
      const collab = await readCollaboration(workspaceRoot, claim.data.collaboration);
      if (collab) {
        if (["completed", "cancelled", "obsolete"].includes(collab.status)) {
          return false;
        }
        if (collab.workerPid) {
          const alive = processAlive(collab.workerPid);
          if (!alive) {
            return false;
          }
          const heartbeat = collab.runtime?.activeCall?.heartbeatAt;
          if (heartbeat) {
            const ageMs = Date.now() - Date.parse(heartbeat);
            if (ageMs > 120_000) {
              return false;
            }
          }
        }
        return true;
      }
    } catch {}
  }
  const updated = claim.data.timestamps?.updated || claim.data.timestamps?.created;
  if (updated) {
    const ageMs = Date.now() - Date.parse(updated);
    if (ageMs > ttlMs) {
      return false;
    }
    return true;
  }
  return false;
}

export async function parseClaims(client, issueNumber) {
  const comments = await client.getIssueComments(issueNumber);
  const claims = [];
  for (const c of comments) {
    if (c.author?.login !== client.expectedLogin && c.author?.login !== "builder-app[bot]") {
      continue;
    }
    const match = c.body.match(/<!-- agent-bridge-issue-claim\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        claims.push({ commentId: c.id, data: JSON.parse(match[1]), author: c.author?.login });
      } catch {}
    }
  }
  return claims;
}

export async function acquireClaimLease({
  client,
  issueNumber,
  portfolioId,
  itemId,
  writer,
  collaborationId,
  branch,
  worktree,
  baseSha,
  headSha,
  ttlMs = 300_000,
  workspaceRoot,
}) {
  const claims = await parseClaims(client, issueNumber);
  let activeClaim = null;
  for (const claim of claims) {
    if (await isClaimActive(claim, workspaceRoot, ttlMs)) {
      activeClaim = claim;
      break;
    }
  }

  if (activeClaim) {
    if (activeClaim.data.collaboration !== collaborationId) {
      throw new Error(`Issue #${issueNumber} is already claimed by active collaboration ${activeClaim.data.collaboration} (writer: ${activeClaim.data.writer}).`);
    }
    await refreshClaimLease({ client, issueNumber, collaborationId, phase: "claiming", headSha });
    return;
  }

  const refName = `refs/tags/claims/issue-${issueNumber}`;
  const refSha = headSha || baseSha || getHeadShaFromWorkspace(workspaceRoot) || "0000000000000000000000000000000000000000";

  let mutexAcquired = false;
  try {
    await client.createRef(refName, refSha);
    mutexAcquired = true;
  } catch (err) {
    const staleClaims = claims.filter(c => c.data.collaboration !== collaborationId);
    if (staleClaims.length > 0 || claims.length === 0) {
      await client.deleteRef(refName).catch(() => {});
      await client.createRef(refName, refSha);
      mutexAcquired = true;
    } else {
      throw new Error(`Collision detected: tag lock for issue #${issueNumber} already exists and is owned by active collaboration.`);
    }
  }

  if (!mutexAcquired) {
    throw new Error(`Failed to acquire atomic tag lock for issue #${issueNumber}.`);
  }

  try {
    const staleClaims = claims.filter(c => c.data.collaboration !== collaborationId);
    if (staleClaims.length > 0) {
      const primaryStale = staleClaims[0];
      const msg = `Takeover receipt: collaboration ${collaborationId} (writer: ${writer}) took over stale lease from collaboration ${primaryStale.data.collaboration} (writer: ${primaryStale.data.writer}, phase: ${primaryStale.data.phase}, last updated: ${primaryStale.data.timestamps?.updated || primaryStale.data.timestamps?.created}).`;
      await client.postIssueComment(issueNumber, msg);
      for (const stale of staleClaims) {
        stale.data.phase = "taken_over";
        stale.data.timestamps.updated = new Date().toISOString();
        const updatedBody = `### Agent Bridge Issue Claim Lease\nThis claim lease has transitioned to taken_over.\n\n<!-- agent-bridge-issue-claim\n${JSON.stringify(stale.data, null, 2)}\n-->`;
        await client.updateIssueComment(stale.commentId, updatedBody).catch(() => {});
      }
    }

    const payload = {
      portfolio: portfolioId || null,
      item: itemId || null,
      writer,
      collaboration: collaborationId,
      branch: branch || null,
      worktree: worktree || null,
      base: baseSha || null,
      head: headSha || null,
      phase: "claiming",
      timestamps: {
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    };
    const commentBody = `### Agent Bridge Issue Claim Lease\nThis issue is claimed by Agent Bridge.\n\n<!-- agent-bridge-issue-claim\n${JSON.stringify(payload, null, 2)}\n-->`;
    await client.postIssueComment(issueNumber, commentBody);

    await client.addIssueLabel(issueNumber, "agent:in-progress");
  } catch (mutationError) {
    await client.deleteRef(refName).catch(() => {});
    throw mutationError;
  }
}

export async function refreshClaimLease({ client, issueNumber, collaborationId, phase, headSha }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) {
    throw new Error(`No active claim lease found on GitHub for collaboration ${collaborationId}.`);
  }

  const phases = ["claiming", "working", "reviewing", "verifying", "completed", "merged", "failed", "cancelled", "rolled_back", "taken_over"];
  const currentIdx = phases.indexOf(ours.data.phase);
  const newIdx = phases.indexOf(phase);
  let targetPhase = phase;
  if (newIdx < currentIdx) {
    targetPhase = ours.data.phase;
  }

  const samePhase = ours.data.phase === targetPhase;
  const sameHead = ours.data.head === headSha || !headSha;
  const lastUpdated = ours.data.timestamps?.updated;
  const ageMs = lastUpdated ? Date.now() - Date.parse(lastUpdated) : Infinity;

  if (samePhase && sameHead && ageMs < 60_000) {
    return;
  }

  ours.data.phase = targetPhase;
  if (headSha) {
    ours.data.head = headSha;
  }
  ours.data.timestamps.updated = new Date().toISOString();
  const commentBody = `### Agent Bridge Issue Claim Lease\nThis issue is claimed by Agent Bridge.\n\n<!-- agent-bridge-issue-claim\n${JSON.stringify(ours.data, null, 2)}\n-->`;
  await client.updateIssueComment(ours.commentId, commentBody);
}

export async function releaseClaimLease({ client, issueNumber, collaborationId, outcome }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) return;

  ours.data.phase = outcome;
  ours.data.timestamps.updated = new Date().toISOString();
  const commentBody = `### Agent Bridge Issue Claim Lease\nThis claim lease has transitioned to ${outcome}.\n\n<!-- agent-bridge-issue-claim\n${JSON.stringify(ours.data, null, 2)}\n-->`;
  await client.updateIssueComment(ours.commentId, commentBody).catch(() => {});

  const receiptBody = `Release receipt: collaboration ${collaborationId} released lease for issue #${issueNumber} with outcome ${outcome}.`;
  await client.postIssueComment(issueNumber, receiptBody).catch(() => {});

  const refName = `refs/tags/claims/issue-${issueNumber}`;
  await client.deleteRef(refName).catch(() => {});

  if (["merged", "completed", "cancelled", "obsolete", "rolled_back", "taken_over"].includes(outcome)) {
    const remainingClaims = (await parseClaims(client, issueNumber)).filter(
      c => c.data.collaboration !== collaborationId && !["merged", "completed", "cancelled", "obsolete", "rolled_back", "taken_over"].includes(c.data.phase)
    );
    if (remainingClaims.length === 0) {
      await client.removeIssueLabel(issueNumber, "agent:in-progress").catch(() => {});
    }
  }
}

export async function reconcileClaimsAndPortfolios(workspaceRoot, fetchImpl = fetch, clientOverride = null) {
  const portfolios = await listPortfolios(resolve(workspaceRoot, ".bridge/portfolios")).catch(() => []);
  for (const p of portfolios) {
    let portfolioState = await readPortfolio(resolve(workspaceRoot, ".bridge/portfolios"), p.id);
    for (const item of portfolioState.items) {
      if (item.collaborationId) {
        let collab = null;
        try {
          collab = await readCollaboration(workspaceRoot, item.collaborationId);
        } catch {}

        const issueNum = item.issueNumber || collab?.issueClaim?.issueNumber;
        if (!issueNum) continue;

        let client = clientOverride || await getBuilderClientForWorkspace(portfolioState.workspace || workspaceRoot, issueNum, fetchImpl).catch(() => null);
        if (!client) continue;

        if (collab) {
          const terminal = ["completed", "cancelled", "obsolete"].includes(collab.status);
          const outcome = collab.status === "completed" ? "completed" : collab.status;
          if (terminal) {
            await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome });
          } else {
            if (collab.status === "indeterminate" || collab.status === "failed") {
              await updatePortfolio(resolve(workspaceRoot, ".bridge/portfolios"), p.id, portfolioState.revision, async (current) => {
                const targetItem = current.items.find(i => i.id === item.id);
                if (targetItem) {
                  targetItem.status = collab.status;
                  targetItem.summary = collab.error || "Reconciled after restart";
                }
                return current;
              }).catch(() => {});
              await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome: collab.status });
            }
          }
        } else {
          await updatePortfolio(resolve(workspaceRoot, ".bridge/portfolios"), p.id, portfolioState.revision, async (current) => {
            const targetItem = current.items.find(i => i.id === item.id);
            if (targetItem) {
              targetItem.status = "failed";
              targetItem.summary = "No local collaboration found for this claim lease.";
            }
            return current;
          }).catch(() => {});
          await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome: "failed" });
        }
      }
    }
  }
}

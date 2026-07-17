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
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  throw new Error(`Unable to retrieve HEAD SHA from workspace: ${workspacePath}`);
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
    allowedOperations: ["get_issue", "add_issue_label", "remove_issue_label", "get_issue_comments", "post_issue_comment", "update_issue_comment", "delete_issue_comment", "acquire_tag_lock", "release_tag_lock"],
    workspace,
    fetchImpl,
  });
}

function generateCommentBody(payload) {
  const historyLines = (payload.history || []).map(h => {
    return `- [${h.at}] Event: **${h.event}** | Collab: \`${h.collaboration}\` | Writer: \`${h.writer}\` | Phase: \`${h.phase || ""}\``;
  }).join("\n");

  return `### Agent Bridge Issue Claim Lease\n` +
    `This issue is managed by Agent Bridge.\n\n` +
    `**Current Status:**\n` +
    `- Collaboration: \`${payload.collaboration}\`\n` +
    `- Writer: \`${payload.writer}\`\n` +
    `- Phase: \`${payload.phase}\`\n` +
    `- Updated: \`${payload.timestamps.updated}\`\n\n` +
    `**History (last 10 events):**\n${historyLines}\n\n` +
    `<!-- agent-bridge-issue-claim\n${JSON.stringify(payload, null, 2)}\n-->`;
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
        return !["completed", "cancelled", "obsolete"].includes(collab.status);
      }
    } catch {}
  }
  const updated = claim.data.timestamps?.updated || claim.data.timestamps?.created;
  if (updated) {
    const ageMs = Date.now() - Date.parse(updated);
    return ageMs <= ttlMs;
  }
  return false;
}

export async function parseClaims(client, issueNumber) {
  const comments = await client.getIssueComments(issueNumber);
  const claims = [];
  for (const c of comments) {
    const authorLogin = c.user?.login || c.author?.login;
    if (authorLogin !== client.expectedLogin) {
      continue;
    }
    const match = c.body.match(/<!-- (agent-bridge-issue-claim|agent-claim:v1)\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        claims.push({ commentId: c.id, data: JSON.parse(match[2]), author: authorLogin });
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

  const refSha = headSha || baseSha || getHeadShaFromWorkspace(workspaceRoot);
  let mutexAcquired = false;
  try {
    await client.acquireTagLock(refSha);
    mutexAcquired = true;
  } catch (err) {
    if (err.status !== 422) {
      throw err; // Throw 403, 500, etc. immediately!
    }

    // Tag already exists. Let's wait 2 seconds to see if another provider is in the middle of comment publication.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));

    const reClaims = await parseClaims(client, issueNumber);
    let reActive = null;
    for (const claim of reClaims) {
      if (await isClaimActive(claim, workspaceRoot, ttlMs)) {
        reActive = claim;
        break;
      }
    }

    if (reActive) {
      if (reActive.data.collaboration !== collaborationId) {
        throw new Error(`Issue #${issueNumber} is already claimed by active collaboration ${reActive.data.collaboration} (writer: ${reActive.data.writer}).`);
      }
      await refreshClaimLease({ client, issueNumber, collaborationId, phase: "claiming", headSha });
      return;
    }

    // If still no active comment exists, the tag ref is stale/orphaned. Let's delete and recreate it.
    await client.releaseTagLock().catch(() => {});
    await client.acquireTagLock(refSha);
    mutexAcquired = true;
  }

  if (!mutexAcquired) {
    throw new Error(`Failed to acquire atomic tag lock for issue #${issueNumber}.`);
  }

  try {
    const staleClaims = claims.filter(c => c.data.collaboration !== collaborationId);
    let canonicalCommentId = null;
    let oldHistory = [];

    if (staleClaims.length > 0) {
      canonicalCommentId = staleClaims[0].commentId;
      const oldPayload = staleClaims[0].data;
      oldHistory = oldPayload.history || [];

      // Update stale comments that are not the canonical one to taken_over, or delete them to avoid pile-up.
      for (let i = 1; i < staleClaims.length; i++) {
        await client.deleteIssueComment(staleClaims[i].commentId).catch(() => {});
      }
    }

    const newHistory = [
      { event: "claimed", collaboration: collaborationId, writer, phase: "claiming", at: new Date().toISOString() },
      ...oldHistory
    ].slice(0, 10);

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
      history: newHistory,
    };

    const commentBody = generateCommentBody(payload);
    if (canonicalCommentId) {
      await client.updateIssueComment(canonicalCommentId, commentBody);
    } else {
      const newComment = await client.postIssueComment(issueNumber, commentBody);
      canonicalCommentId = newComment.id;
    }

    await client.addIssueLabel(issueNumber, "agent:in-progress");
  } catch (mutationError) {
    await client.releaseTagLock().catch(() => {});
    throw mutationError;
  }
}

export async function refreshClaimLease({ client, issueNumber, collaborationId, phase, headSha }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) {
    throw new Error(`No active claim lease found on GitHub for collaboration ${collaborationId}.`);
  }

  // Clean up duplicate claim comments if any
  const duplicates = claims.filter(c => c.data.collaboration === collaborationId && c.commentId !== ours.commentId);
  for (const dup of duplicates) {
    await client.deleteIssueComment(dup.commentId).catch(() => {});
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

  if (ours.data.phase !== targetPhase) {
    ours.data.history = [
      { event: "transition", collaboration: collaborationId, writer: ours.data.writer, phase: targetPhase, at: new Date().toISOString() },
      ...(ours.data.history || [])
    ].slice(0, 10);
  }

  ours.data.phase = targetPhase;
  if (headSha) {
    ours.data.head = headSha;
  }
  ours.data.timestamps.updated = new Date().toISOString();

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);
}

export async function releaseClaimLease({ client, issueNumber, collaborationId, outcome }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) return;

  // Clean up duplicates if any
  const duplicates = claims.filter(c => c.data.collaboration === collaborationId && c.commentId !== ours.commentId);
  for (const dup of duplicates) {
    await client.deleteIssueComment(dup.commentId).catch(() => {});
  }

  ours.data.phase = outcome;
  ours.data.timestamps.updated = new Date().toISOString();
  ours.data.history = [
    { event: "release", collaboration: collaborationId, writer: ours.data.writer, phase: outcome, at: new Date().toISOString() },
    ...(ours.data.history || [])
  ].slice(0, 10);

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);

  const terminal = ["completed", "merged", "cancelled", "obsolete", "rolled_back"].includes(outcome);

  if (terminal) {
    await client.releaseTagLock();

    const remainingClaims = (await parseClaims(client, issueNumber)).filter(
      c => c.data.collaboration !== collaborationId && !["completed", "merged", "cancelled", "obsolete", "rolled_back", "taken_over"].includes(c.data.phase)
    );
    if (remainingClaims.length === 0) {
      await client.removeIssueLabel(issueNumber, "agent:in-progress").catch(() => {});
    }
  }
}

export async function reconcileClaimsAndPortfolios(workspaceRoot, fetchImpl = fetch, clientOverride = null) {
  const portfoliosPath = resolve(workspaceRoot, ".bridge/portfolios");
  const portfolios = await listPortfolios(portfoliosPath).catch(() => []);
  for (const p of portfolios) {
    let portfolioState = await readPortfolio(portfoliosPath, p.id);
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
          if (terminal) {
            const outcome = collab.status === "completed" ? "completed" : collab.status;
            await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome });
          } else if (collab.status === "indeterminate" || collab.status === "failed") {
            const currentPortfolio = await readPortfolio(portfoliosPath, p.id);
            await updatePortfolio(portfoliosPath, p.id, currentPortfolio.revision, async (current) => {
              const targetItem = current.items.find(i => i.id === item.id);
              if (targetItem) {
                targetItem.status = collab.status;
                targetItem.summary = collab.error || "Reconciled after restart";
              }
              return current;
            }).catch(() => {});
          }
        } else {
          const currentPortfolio = await readPortfolio(portfoliosPath, p.id);
          await updatePortfolio(portfoliosPath, p.id, currentPortfolio.revision, async (current) => {
            const targetItem = current.items.find(i => i.id === item.id);
            if (targetItem) {
              targetItem.status = "failed";
              targetItem.summary = "No local collaboration found for this claim lease.";
            }
            return current;
          }).catch(() => {});
        }
      }
    }
  }
}

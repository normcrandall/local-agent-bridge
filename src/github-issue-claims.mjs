import { readCollaboration } from "./collaboration-store.mjs";
import { listPortfolios, readPortfolio, updatePortfolio } from "./portfolio-store.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { inspectGitHubAppRoles, createInstallationToken } from "./github-app-auth.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CANONICAL_PHASES = [
  "claiming",
  "preflight",
  "waiting_capacity",
  "working",
  "reviewing",
  "verifying",
  "completed",
  "merged",
  "failed",
  "cancelled",
  "obsolete",
  "rolled_back",
  "taken_over"
];

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function normalizeLogin(login) {
  if (!login) return "";
  let clean = login.toLowerCase();
  if (clean.endsWith("[bot]")) {
    clean = clean.slice(0, -5);
  }
  return clean;
}

function normalizePhase(phase) {
  if (!phase) return "working";
  const p = String(phase).toLowerCase();
  if (p === "claiming") return "claiming";
  if (p === "preflight") return "preflight";
  if (p === "waiting_capacity") return "waiting_capacity";
  if (p === "running" || p === "working" || p === "provider_progress" || p === "turn") return "working";
  if (p === "review" || p === "reviewing") return "reviewing";
  if (p === "verification" || p === "verifying") return "verifying";
  if (p === "completed") return "completed";
  if (p === "merged") return "merged";
  if (p === "failed") return "failed";
  if (p === "cancelled") return "cancelled";
  if (p === "obsolete") return "obsolete";
  if (p === "rolled_back") return "rolled_back";
  if (p === "taken_over") return "taken_over";
  return "working";
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
    allowedOperations: ["get_issue", "add_issue_label", "remove_issue_label", "get_issue_comments", "post_issue_comment", "update_issue_comment", "delete_issue_comment", "list_tag_locks", "acquire_tag_lock", "release_tag_lock"],
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
    `- Generation: \`${payload.generation || 1}\`\n` +
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
    if (normalizeLogin(authorLogin) !== normalizeLogin(client.expectedLogin)) {
      continue;
    }

    // Support real two-block legacy format: <!-- agent-claim:v1 issue=51 --> followed by <!-- {json} -->
    const v1MarkerMatch = c.body.match(/<!--\s*agent-claim:v1\s+issue=(\d+)\s*-->/);
    if (v1MarkerMatch && Number(v1MarkerMatch[1]) === Number(issueNumber)) {
      const jsonMatch = c.body.match(/<!--\s*(\{[\s\S]*?\})\s*-->/);
      if (jsonMatch) {
        try {
          const parsedData = JSON.parse(jsonMatch[1]);
          const mappedData = {
            portfolio: parsedData.portfolio || null,
            item: parsedData.item || null,
            writer: parsedData.writer || null,
            collaboration: parsedData.collaboration || parsedData.collaborationId || null,
            branch: parsedData.branch || null,
            worktree: parsedData.worktree || null,
            base: parsedData.base || null,
            head: parsedData.head || null,
            phase: parsedData.phase || "working",
            generation: parsedData.generation || 1,
            timestamps: {
              created: parsedData.timestamps?.created || parsedData.claimedAt || new Date().toISOString(),
              updated: parsedData.timestamps?.updated || parsedData.updatedAt || new Date().toISOString(),
            },
            history: parsedData.history || [],
          };
          claims.push({ commentId: c.id, data: mappedData, author: authorLogin, isLegacyV1: true });
          continue;
        } catch {}
      }
    }

    // Canonical format
    const match = c.body.match(/<!-- agent-bridge-issue-claim\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        claims.push({ commentId: c.id, data: JSON.parse(match[1]), author: authorLogin });
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
  // 1. List existing tag locks to find current generation
  const existingRefs = await client.listTagLocks();
  let maxGen = 0;
  for (const refObj of existingRefs) {
    const match = refObj.ref.match(/-generation-(\d+)$/);
    if (match) {
      const g = parseInt(match[1], 10);
      if (g > maxGen) {
        maxGen = g;
      }
    }
  }

  // 2. Check for active comments
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

  // 3. Contender publication window delay
  if (maxGen > 0) {
    const latestGenClaim = claims.find(c => c.data.generation === maxGen);
    if (!latestGenClaim) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
      const reClaims = await parseClaims(client, issueNumber);
      const reLatestGenClaim = reClaims.find(c => c.data.generation === maxGen);
      if (reLatestGenClaim && await isClaimActive(reLatestGenClaim, workspaceRoot, ttlMs)) {
        if (reLatestGenClaim.data.collaboration !== collaborationId) {
          throw new Error(`Issue #${issueNumber} is already claimed by active collaboration ${reLatestGenClaim.data.collaboration} (writer: ${reLatestGenClaim.data.writer}).`);
        }
        await refreshClaimLease({ client, issueNumber, collaborationId, phase: "claiming", headSha });
        return;
      }
    }
  }

  // 4. Try next generation
  const nextGen = maxGen + 1;
  const refSha = headSha || baseSha || getHeadShaFromWorkspace(workspaceRoot);

  let mutexAcquired = false;
  try {
    await client.acquireTagLock(nextGen, refSha);
    mutexAcquired = true;
  } catch (err) {
    if (err.status !== 422) {
      throw err; // Propagate 403, 500, etc. immediately
    }
    throw new Error(`Lock conflict: generation ${nextGen} lock for issue #${issueNumber} already exists.`);
  }

  if (!mutexAcquired) {
    throw new Error(`Failed to acquire atomic tag lock for issue #${issueNumber}.`);
  }

  try {
    const staleClaims = claims.filter(c => c.data.collaboration !== collaborationId);
    let canonicalCommentId = null;
    let oldHistory = [];

    if (staleClaims.length > 0) {
      staleClaims.sort((a, b) => (b.data.generation || 0) - (a.data.generation || 0));
      canonicalCommentId = staleClaims[0].commentId;
      const oldPayload = staleClaims[0].data;
      oldHistory = oldPayload.history || [];

      // Record takeover in history
      oldHistory = [
        { event: "takeover", collaboration: collaborationId, writer, phase: "claiming", at: new Date().toISOString(), previousCollaboration: oldPayload.collaboration },
        ...oldHistory
      ];

      // Delete other comments to avoid pile-up
      for (let i = 1; i < staleClaims.length; i++) {
        await client.deleteIssueComment(staleClaims[i].commentId).catch(() => {});
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
      generation: nextGen,
      timestamps: {
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
      history: oldHistory.slice(0, 10),
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
    await client.releaseTagLock(nextGen).catch(() => {});
    throw mutationError;
  }
}

export async function refreshClaimLease({ client, issueNumber, collaborationId, phase, headSha }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) {
    throw new Error(`No active claim lease found on GitHub for collaboration ${collaborationId}.`);
  }

  // Clean up duplicate comments
  const duplicates = claims.filter(c => c.data.collaboration === collaborationId && c.commentId !== ours.commentId);
  for (const dup of duplicates) {
    await client.deleteIssueComment(dup.commentId).catch(() => {});
  }

  const currentIdx = CANONICAL_PHASES.indexOf(normalizePhase(ours.data.phase));
  const newIdx = CANONICAL_PHASES.indexOf(normalizePhase(phase));
  let targetPhase = normalizePhase(phase);
  if (newIdx < currentIdx) {
    targetPhase = normalizePhase(ours.data.phase);
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
  const allowedOutcomes = ["merged", "cancelled", "obsolete", "rolled_back", "taken_over", "failed", "indeterminate"];
  if (!allowedOutcomes.includes(outcome)) {
    throw new Error(`Invalid claim lease release outcome: ${outcome}.`);
  }

  const claims = await parseClaims(client, issueNumber);
  const ours = claims.find(c => c.data.collaboration === collaborationId);
  if (!ours) return;

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

  const terminal = ["merged", "cancelled", "obsolete", "rolled_back", "taken_over"].includes(outcome);

  if (terminal) {
    const generation = ours.data.generation || 1;
    await client.releaseTagLock(generation);

    const remainingClaims = (await parseClaims(client, issueNumber)).filter(
      c => c.data.collaboration !== collaborationId && !["completed", "merged", "cancelled", "obsolete", "rolled_back", "taken_over"].includes(c.data.phase)
    );
    if (remainingClaims.length === 0) {
      await client.removeIssueLabel(issueNumber, "agent:in-progress").catch(() => {});
    }
  }
}

async function updatePortfolioWithRetry(portfoliosPath, pId, updater, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const currentPortfolio = await readPortfolio(portfoliosPath, pId);
      await updatePortfolio(portfoliosPath, pId, currentPortfolio.revision, updater);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

export async function reconcileClaimsAndPortfolios(workspaceRoot, fetchImpl = fetch, clientOverride = null) {
  const portfoliosPath = resolve(workspaceRoot, ".bridge/portfolios");
  const portfolios = await listPortfolios(portfoliosPath);
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

        let client = clientOverride || await getBuilderClientForWorkspace(portfolioState.workspace || workspaceRoot, issueNum, fetchImpl);
        if (!client) continue;

        if (collab) {
          const terminal = ["cancelled", "obsolete"].includes(collab.status);
          if (terminal) {
            await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome: collab.status });
          } else if (collab.status === "indeterminate" || collab.status === "failed") {
            await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
              const targetItem = current.items.find(i => i.id === item.id);
              if (targetItem) {
                targetItem.status = collab.status;
                targetItem.summary = collab.error || "Reconciled after restart";
              }
              return current;
            });
          }
        } else {
          await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
            const targetItem = current.items.find(i => i.id === item.id);
            if (targetItem) {
              targetItem.status = "failed";
              targetItem.summary = "No local collaboration found for this claim lease.";
            }
            return current;
          });
        }
      }
    }
  }
}

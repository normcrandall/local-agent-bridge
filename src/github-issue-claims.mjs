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
  "taken_over",
  "recovered"
];

const RELEASED_PHASES = new Set(["merged", "cancelled", "obsolete", "rolled_back", "taken_over", "recovered"]);
const CLAIM_REF_PATTERN = /-generation-(\d+)$/;

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
  if (p === "recovered") return "recovered";
  return "working";
}

function generationFromRef(refObject) {
  const match = String(refObject?.ref || "").match(CLAIM_REF_PATTERN);
  if (!match) return null;
  const generation = Number.parseInt(match[1], 10);
  return Number.isInteger(generation) && generation > 0 ? generation : null;
}

function canonicalClaim(claims) {
  return [...claims].sort((left, right) => {
    const generationDelta = (right.data.generation || 1) - (left.data.generation || 1);
    if (generationDelta !== 0) return generationDelta;
    return Number(right.commentId) - Number(left.commentId);
  })[0] || null;
}

async function deleteGenerationIfPresent(client, generation) {
  try {
    await client.releaseTagLock(generation);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function deleteGenerations(client, generations) {
  for (const generation of [...new Set(generations)].sort((left, right) => right - left)) {
    await deleteGenerationIfPresent(client, generation);
  }
}

function aggregateFailure(message, primary, rollback) {
  return new AggregateError([primary, rollback], `${message}: ${primary.message}; rollback failed: ${rollback.message}`);
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

export function getHeadShaFromWorkspace(workspacePath) {
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
    (payload.summary ? `- Summary: ${payload.summary}\n` : "") +
    `- Generation: \`${payload.generation || 1}\`\n` +
    `- Updated: \`${payload.timestamps.updated}\`\n\n` +
    `**History (last 10 events):**\n${historyLines}\n\n` +
    `<!-- agent-bridge-issue-claim\n${JSON.stringify(payload, null, 2)}\n-->`;
}

function claimSummary(value) {
  if (value === undefined) return undefined;
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

async function isClaimActive(claim, workspaceRoot, ttlMs) {
  const phase = normalizePhase(claim.data.phase);
  if (RELEASED_PHASES.has(phase)) return false;
  if (claim.data.collaboration) {
    let collab = null;
    try {
      collab = await readCollaboration(workspaceRoot, claim.data.collaboration);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (collab) return !["cancelled", "obsolete"].includes(collab.status);
  }
  const leaseExpiresAt = Date.parse(claim.data.leaseExpiresAt || "");
  if (Number.isFinite(leaseExpiresAt)) {
    return Date.now() <= leaseExpiresAt;
  }
  const updated = claim.data.timestamps?.updated || claim.data.timestamps?.created;
  if (updated) {
    const updatedAt = Date.parse(updated);
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ttlMs;
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
      const afterMarker = c.body.slice((v1MarkerMatch.index || 0) + v1MarkerMatch[0].length);
      const jsonMatch = afterMarker.match(/<!--\s*(\{[\s\S]*?\})\s*-->/);
      if (jsonMatch) {
        try {
          const parsedData = JSON.parse(jsonMatch[1]);
          const mappedData = {
            portfolio: parsedData.portfolioId || parsedData.portfolio || null,
            item: parsedData.itemId || parsedData.item || null,
            writer: parsedData.writer || null,
            collaboration: parsedData.collaborationId || parsedData.collaboration || null,
            branch: parsedData.branch || null,
            worktree: parsedData.worktree || null,
            base: parsedData.baseSha || parsedData.base || null,
            head: parsedData.headSha || parsedData.head || null,
            phase: parsedData.phase || "working",
            generation: parsedData.generation || 1,
            timestamps: {
              created: parsedData.claimedAt || parsedData.timestamps?.created || new Date().toISOString(),
              updated: parsedData.updatedAt || parsedData.timestamps?.updated || new Date().toISOString(),
            },
            leaseExpiresAt: parsedData.leaseExpiresAt || null,
            history: parsedData.history || [],
          };
          claims.push({ commentId: c.id, data: mappedData, author: authorLogin, isLegacyV1: true });
          continue;
        } catch (error) {
          throw new Error(`Malformed trusted legacy claim comment ${c.id}: ${error.message}`);
        }
      }
      throw new Error(`Malformed trusted legacy claim comment ${c.id}: missing JSON payload.`);
    }

    // Canonical format
    const match = c.body.match(/<!-- agent-bridge-issue-claim\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        claims.push({ commentId: c.id, data: JSON.parse(match[1]), author: authorLogin });
      } catch (error) {
        throw new Error(`Malformed trusted canonical claim comment ${c.id}: ${error.message}`);
      }
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
  // The canonical comment determines the current generation. A ref newer
  // than that comment is an in-flight or orphaned publication and blocks.
  const claims = await parseClaims(client, issueNumber);
  const canonical = canonicalClaim(claims);
  const canonicalIsActive = canonical ? await isClaimActive(canonical, workspaceRoot, ttlMs) : false;
  if (canonicalIsActive && canonical.data.collaboration !== collaborationId) {
    throw new Error(`Issue #${issueNumber} is already claimed by active collaboration ${canonical.data.collaboration} (writer: ${canonical.data.writer}).`);
  }
  if (canonicalIsActive && canonical.data.collaboration === collaborationId) {
    await refreshClaimLease({ client, issueNumber, collaborationId, phase: "claiming", headSha, branch, worktree });
    await client.addIssueLabel(issueNumber, "agent:in-progress");
    const refs = await client.listTagLocks();
    const currentGeneration = canonical.data.generation || 1;
    if (!refs.map(generationFromRef).includes(currentGeneration)) {
      try {
        await client.acquireTagLock(currentGeneration, headSha || baseSha || canonical.data.head || getHeadShaFromWorkspace(workspaceRoot));
      } catch (error) {
        if (error.status !== 422) throw error;
      }
    }
    for (const duplicate of claims.filter((claim) => claim.commentId !== canonical.commentId)) {
      await client.deleteIssueComment(duplicate.commentId);
    }
    await deleteGenerations(client, refs.map(generationFromRef).filter((generation) => generation && generation < currentGeneration));
    return;
  }

  const existingRefs = await client.listTagLocks();
  const generations = existingRefs.map(generationFromRef).filter(Boolean);
  const canonicalGeneration = canonical?.data.generation || 0;
  if (!canonical && generations.length > 0) {
    throw new Error(`Interrupted claim lease lock: generation ${Math.max(...generations)} exists without a canonical comment. Inspected recovery required.`);
  }
  const newerGeneration = generations.find((generation) => generation > canonicalGeneration);
  if (canonical && newerGeneration) {
    throw new Error(`Interrupted claim lease publication: generation ${newerGeneration} is newer than canonical generation ${canonicalGeneration}. Inspected recovery required.`);
  }

  const nextGen = canonicalGeneration + 1;
  const refSha = headSha || baseSha || getHeadShaFromWorkspace(workspaceRoot);
  try {
    await client.acquireTagLock(nextGen, refSha);
  } catch (err) {
    if (err.status !== 422) throw err;
    throw new Error(`Lock conflict: generation ${nextGen} lock for issue #${issueNumber} already exists.`);
  }

  let canonicalPublished = false;
  try {
    const now = new Date().toISOString();
    const event = canonical ? "takeover" : "claimed";
    const history = [{
      event,
      collaboration: collaborationId,
      writer,
      phase: "claiming",
      at: now,
      ...(canonical?.data.collaboration ? { previousCollaboration: canonical.data.collaboration } : {}),
    }, ...(canonical?.data.history || [])].slice(0, 10);

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
      summary: "Claim acquired before provider work starts.",
      generation: nextGen,
      timestamps: {
        created: now,
        updated: now,
      },
      leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      history,
    };

    const commentBody = generateCommentBody(payload);
    let canonicalCommentId = canonical?.commentId || null;
    if (canonicalCommentId) {
      await client.updateIssueComment(canonicalCommentId, commentBody);
    } else {
      const newComment = await client.postIssueComment(issueNumber, commentBody);
      canonicalCommentId = newComment.id;
    }
    canonicalPublished = true;

    await client.addIssueLabel(issueNumber, "agent:in-progress");
    for (const duplicate of claims.filter((claim) => claim.commentId !== canonicalCommentId)) {
      await client.deleteIssueComment(duplicate.commentId);
    }
    await deleteGenerations(client, generations.filter((generation) => generation < nextGen));
  } catch (mutationError) {
    if (canonicalPublished) {
      try {
        await releaseClaimLease({ client, issueNumber, collaborationId, outcome: "rolled_back" });
      } catch (rollbackError) {
        throw aggregateFailure("Claim publication cleanup failed", mutationError, rollbackError);
      }
    } else {
      try {
        await deleteGenerationIfPresent(client, nextGen);
      } catch (rollbackError) {
        throw aggregateFailure("Claim publication failed", mutationError, rollbackError);
      }
    }
    throw mutationError;
  }
}

export async function refreshClaimLease({ client, issueNumber, collaborationId, phase, headSha, branch, worktree, summary, ttlMs = 300_000 }) {
  const claims = await parseClaims(client, issueNumber);
  const ours = canonicalClaim(claims.filter(c => c.data.collaboration === collaborationId));
  if (!ours) {
    throw new Error(`No active claim lease found on GitHub for collaboration ${collaborationId}.`);
  }

  // Clean up duplicate comments
  const duplicates = claims.filter(c => c.data.collaboration === collaborationId && c.commentId !== ours.commentId);
  for (const dup of duplicates) {
    await client.deleteIssueComment(dup.commentId);
  }

  const currentIdx = CANONICAL_PHASES.indexOf(normalizePhase(ours.data.phase));
  const newIdx = CANONICAL_PHASES.indexOf(normalizePhase(phase));
  let targetPhase = normalizePhase(phase);
  if (newIdx < currentIdx) {
    targetPhase = normalizePhase(ours.data.phase);
  }

  const samePhase = ours.data.phase === targetPhase;
  const sameHead = ours.data.head === headSha || !headSha;
  const sameBranch = ours.data.branch === branch || !branch;
  const sameWorktree = ours.data.worktree === worktree || !worktree;
  const normalizedSummary = claimSummary(summary);
  const sameSummary = normalizedSummary === undefined || ours.data.summary === normalizedSummary;
  const lastUpdated = ours.data.timestamps?.updated;
  const ageMs = lastUpdated ? Date.now() - Date.parse(lastUpdated) : Infinity;

  if (samePhase && sameHead && sameBranch && sameWorktree && sameSummary && ageMs < 60_000) {
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
  if (branch) ours.data.branch = branch;
  if (worktree) ours.data.worktree = worktree;
  if (normalizedSummary !== undefined) ours.data.summary = normalizedSummary;
  ours.data.timestamps.updated = new Date().toISOString();
  ours.data.leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);
}

export async function releaseClaimLease({ client, issueNumber, collaborationId, outcome }) {
  const allowedOutcomes = ["merged", "cancelled", "obsolete", "rolled_back", "taken_over", "recovered"];
  if (!allowedOutcomes.includes(outcome)) {
    throw new Error(`Invalid claim lease release outcome: ${outcome}.`);
  }

  const claims = await parseClaims(client, issueNumber);
  const ours = canonicalClaim(claims.filter(c => c.data.collaboration === collaborationId));
  if (!ours) throw new Error(`No claim lease found for collaboration ${collaborationId} on issue #${issueNumber}.`);

  const duplicates = claims.filter(c => c.data.collaboration === collaborationId && c.commentId !== ours.commentId);
  for (const dup of duplicates) {
    await client.deleteIssueComment(dup.commentId);
  }

  ours.data.phase = outcome;
  ours.data.summary = `Claim released after ${outcome}.`;
  ours.data.timestamps.updated = new Date().toISOString();
  ours.data.history = [
    { event: "release", collaboration: collaborationId, writer: ours.data.writer, phase: outcome, at: new Date().toISOString() },
    ...(ours.data.history || [])
  ].slice(0, 10);

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);

  const generation = ours.data.generation || 1;
  const refs = await client.listTagLocks();
  await deleteGenerations(client, refs.map(generationFromRef).filter((candidate) => candidate && candidate <= generation));

  const remainingClaims = (await parseClaims(client, issueNumber)).filter(
    c => c.data.collaboration !== collaborationId && !RELEASED_PHASES.has(normalizePhase(c.data.phase))
  );
  if (remainingClaims.length === 0) {
    try {
      await client.removeIssueLabel(issueNumber, "agent:in-progress");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

export async function recoverIssueClaim({ client, issueNumber, collaborationId, generation }) {
  const claims = await parseClaims(client, issueNumber);
  const canonical = canonicalClaim(claims);
  const ours = canonicalClaim(claims.filter((claim) => claim.data.collaboration === collaborationId));
  if (ours) {
    if (canonical?.commentId !== ours.commentId) {
      throw new Error(`Refusing recovery for non-canonical collaboration ${collaborationId}.`);
    }
    await releaseClaimLease({ client, issueNumber, collaborationId, outcome: "recovered" });
    return { recovered: true, generation: ours.data.generation || 1, canonical: true };
  }
  if (canonical) {
    throw new Error(`Refusing orphan recovery while canonical collaboration ${canonical.data.collaboration} exists.`);
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("Inspected recovery without a canonical claim requires the exact positive generation.");
  }
  const refs = await client.listTagLocks();
  const generations = refs.map(generationFromRef).filter(Boolean);
  if (!generations.includes(generation)) {
    throw new Error(`Generation ${generation} does not exist for issue #${issueNumber}.`);
  }
  if (generations.some((candidate) => candidate > generation)) {
    throw new Error(`Refusing recovery of generation ${generation}: a newer issue generation exists.`);
  }
  await deleteGenerationIfPresent(client, generation);
  if (claims.every((claim) => RELEASED_PHASES.has(normalizePhase(claim.data.phase)))) {
    try {
      await client.removeIssueLabel(issueNumber, "agent:in-progress");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return { recovered: true, generation, canonical: false };
}

async function updatePortfolioWithRetry(portfoliosPath, pId, updater, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const currentPortfolio = await readPortfolio(portfoliosPath, pId);
      await updatePortfolio(portfoliosPath, pId, currentPortfolio.revision, updater);
      return;
    } catch (err) {
      if (err.message && err.message.includes("Portfolio revision changed")) {
        if (attempt === maxAttempts) throw err;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        continue;
      }
      throw err;
    }
  }
}

export async function reconcileClaimsAndPortfolios(workspaceRoot, fetchImpl = fetch, clientOverride = null) {
  const portfoliosPath = resolve(workspaceRoot, ".bridge/portfolios");
  const portfolios = await listPortfolios(portfoliosPath);
  for (const p of portfolios) {
    let portfolioState = await readPortfolio(portfoliosPath, p.id);
    for (const item of portfolioState.items) {
      let collab = null;
      if (item.collaborationId) {
        try {
          collab = await readCollaboration(workspaceRoot, item.collaborationId);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }

      const issueNum = item.issueNumber || collab?.issueClaim?.issueNumber;
      if (!issueNum) continue;
      const client = clientOverride || await getBuilderClientForWorkspace(portfolioState.workspace || workspaceRoot, issueNum, fetchImpl);
      if (!client) throw new Error(`No builder App client is configured for claimed issue #${issueNum}.`);
      const claim = canonicalClaim(await parseClaims(client, issueNum));
      const claimIsHeld = claim && !RELEASED_PHASES.has(normalizePhase(claim.data.phase));

      if (["cancelled", "obsolete"].includes(collab?.status)) {
        if (claimIsHeld && claim.data.collaboration === item.collaborationId) {
          await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome: collab.status });
        }
        continue;
      }

      if (!item.collaborationId && claimIsHeld) {
        let recoveredCollaboration = null;
        try {
          recoveredCollaboration = await readCollaboration(workspaceRoot, claim.data.collaboration);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.collaborationId = claim.data.collaboration;
            targetItem.status = recoveredCollaboration
              ? (["failed", "indeterminate"].includes(recoveredCollaboration.status) ? recoveredCollaboration.status : "claimed")
              : "failed";
            targetItem.summary = recoveredCollaboration
              ? `Recovered trusted GitHub claim generation ${claim.data.generation || 1} after restart.`
              : `GitHub claim ${claim.data.collaboration} has no local collaboration; inspected recovery is required.`;
          }
          return current;
        });
        continue;
      }

      if (!item.collaborationId) continue;
      if (!claimIsHeld || claim.data.collaboration !== item.collaborationId) {
        const detail = !claimIsHeld
          ? "no active trusted GitHub claim exists"
          : `GitHub is held by ${claim.data.collaboration}`;
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.status = "indeterminate";
            targetItem.summary = `Claim reconciliation mismatch: local collaboration ${item.collaborationId}, but ${detail}.`;
          }
          return current;
        });
        continue;
      }

      if (!collab) {
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.status = "failed";
            targetItem.summary = "No local collaboration found for this retained GitHub claim lease; inspected recovery is required.";
          }
          return current;
        });
        continue;
      }

      if (["indeterminate", "failed"].includes(collab.status)) {
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.status = collab.status;
            targetItem.summary = collab.error || "Reconciled after restart; GitHub claim remains held.";
          }
          return current;
        });
        continue;
      }

      await refreshClaimLease({
        client,
        issueNumber: issueNum,
        collaborationId: item.collaborationId,
        phase: collab.status,
        headSha: collab.issueClaim?.headSha,
        branch: collab.issueClaim?.branch,
        worktree: collab.issueClaim?.worktree || collab.workspace,
        summary: `Reconciled local collaboration status ${collab.status} after broker restart.`,
      });
    }
  }
}

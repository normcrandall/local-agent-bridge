import { readCollaboration, updateCollaboration } from "./collaboration-store.mjs";
import { readPortfolio, updatePortfolio } from "./portfolio-store.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { createInstallationToken, sameGitHubAppLogin } from "./github-app-auth.mjs";
import {
  createProductionGitHubLifecycleAdapter,
  loadRepositoryLifecyclePolicy,
  normalizeLifecyclePolicy,
  portfolioStatusForSemanticState,
  reconcileGitHubLifecycle,
  semanticStateForPhase,
  handleLifecycleWebhook,
  transitionSemanticLifecycle,
} from "./github-lifecycle.mjs";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
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

async function removeClaimLabelAndRepairRace(client, issueNumber) {
  try {
    await client.removeIssueLabel(issueNumber, "agent:in-progress");
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
  }
  const current = canonicalClaim(await parseClaims(client, issueNumber));
  if (current && !RELEASED_PHASES.has(normalizePhase(current.data.phase))) {
    try {
      await client.addIssueLabel(issueNumber, "agent:in-progress");
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
    }
  }
}

async function addClaimLabel(client, issueNumber) {
  try {
    await client.addIssueLabel(issueNumber, "agent:in-progress");
    return { applied: true };
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
    return { applied: false, reason: "permission_unavailable", status: error.status };
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

const ISSUE_CLAIM_HYDRATION_OPERATIONS = Object.freeze([
  "get_issue",
  "get_issue_comments",
  "get_issue_timeline",
  "get_issue_dependencies",
  "get_issue_project_items",
]);

const ISSUE_CLAIM_MUTATION_OPERATIONS = Object.freeze([
  "update_issue_project_single_select",
  "add_issue_label",
  "remove_issue_label",
  "post_issue_comment",
  "update_issue_comment",
  "delete_issue_comment",
  "list_tag_locks",
  "acquire_tag_lock",
  "release_tag_lock",
]);

const ISSUE_CLAIM_OPERATIONS = Object.freeze([
  ...ISSUE_CLAIM_HYDRATION_OPERATIONS,
  ...ISSUE_CLAIM_MUTATION_OPERATIONS,
]);

function createCredentialBoundIssueClient({
  credential,
  repository,
  expectedLogin = credential?.expectedLogin,
  headSha,
  issueNumber,
  workspace,
  apiUrl = process.env.GITHUB_BUILDER_API_URL || "https://api.github.com",
  fetchImpl = fetch,
  allowedOperations,
  clientLabel,
}) {
  if (!credential?.verifiedLogin) {
    throw new Error(`${clientLabel} requires a credential-verified GitHub App login.`);
  }
  if (!expectedLogin) {
    throw new Error(`${clientLabel} requires an expected GitHub App login.`);
  }
  if (!sameGitHubAppLogin(credential.verifiedLogin, expectedLogin)) {
    throw new Error(
      `${clientLabel} identity mismatch: expected ${expectedLogin}, credential verified ${credential.verifiedLogin}.`,
    );
  }
  return createBoundBuilderClient({
    apiUrl,
    token: credential.token,
    verifiedLogin: credential.verifiedLogin,
    repository,
    expectedLogin,
    authority: {
      login: credential.verifiedLogin,
      appId: credential.appId,
      installationId: credential.installationId,
      repository,
      permissions: credential.permissions,
    },
    headSha,
    issueNumber,
    allowedOperations,
    workspace,
    fetchImpl,
  });
}

export function createIssueClaimClient({
  credential,
  repository,
  expectedLogin = credential?.expectedLogin,
  headSha,
  issueNumber,
  workspace,
  apiUrl = process.env.GITHUB_BUILDER_API_URL || "https://api.github.com",
  fetchImpl = fetch,
}) {
  return createCredentialBoundIssueClient({
    credential,
    apiUrl,
    repository,
    expectedLogin,
    headSha,
    issueNumber,
    allowedOperations: ISSUE_CLAIM_OPERATIONS,
    clientLabel: "Issue-claim client",
    workspace,
    fetchImpl,
  });
}

export function createIssueClaimHydrationClient({
  credential,
  repository,
  expectedLogin = credential?.expectedLogin,
  headSha,
  issueNumber,
  workspace,
  apiUrl = process.env.GITHUB_BUILDER_API_URL || "https://api.github.com",
  fetchImpl = fetch,
}) {
  return createCredentialBoundIssueClient({
    credential,
    apiUrl,
    repository,
    expectedLogin,
    headSha,
    issueNumber,
    allowedOperations: ISSUE_CLAIM_HYDRATION_OPERATIONS,
    clientLabel: "Issue-claim hydration client",
    workspace,
    fetchImpl,
  });
}

export async function getBuilderClientForWorkspace(workspace, issueNum, fetchImpl = fetch) {
  const repository = getRepositoryFromWorkspace(workspace);
  if (!repository) return null;
  const credential = await createInstallationToken({ role: "builder", repository });
  const headSha = getHeadShaFromWorkspace(workspace);
  return createIssueClaimClient({
    credential,
    repository,
    expectedLogin: credential.expectedLogin,
    headSha,
    issueNumber: issueNum,
    workspace,
    fetchImpl,
  });
}

function requireBoundAuthority(client) {
  const authority = client.authority;
  if (!authority) {
    throw new Error("Claim mutation requires a verified GitHub App authority binding.");
  }
  return authority;
}

function authorityMismatch(existing, expected) {
  if (!existing) return "claim has no stable authority metadata";
  if (String(existing.appId || "") !== String(expected.appId)) return "GitHub App ID changed";
  if (Number(existing.installationId) !== Number(expected.installationId)) return "GitHub App installation changed";
  if (existing.repository !== expected.repository) return "repository changed";
  if (normalizeLogin(existing.login) !== normalizeLogin(expected.login)) return "GitHub App login changed";
  return null;
}

function canonicalAuthority(authority) {
  return {
    login: authority.login,
    appId: String(authority.appId),
    installationId: Number(authority.installationId),
    repository: authority.repository,
  };
}

function repairableAuthorityError(issueNumber, collaborationId, reason) {
  const error = new Error(
    `Issue #${issueNumber} claim identity cannot be safely rebound for collaboration ${collaborationId}: ${reason}. `
    + "Release the inspected claim before mutation, then reacquire it with the verified builder App.",
  );
  error.code = "CLAIM_AUTHORITY_MISMATCH";
  return error;
}

function trustedClaimParseError(message) {
  const error = new Error(message);
  error.code = "CLAIM_PARSE_INVALID";
  return error;
}

export async function rebindIssueClaim({ client, issueNumber, collaborationId, workspaceRoot, ttlMs = 300_000 }) {
  const authority = requireBoundAuthority(client);
  const claims = await parseClaims(client, issueNumber);
  const canonical = canonicalClaim(claims);
  const ours = canonicalClaim(claims.filter((claim) => claim.data.collaboration === collaborationId));
  if (!ours || canonical?.commentId !== ours.commentId) {
    throw repairableAuthorityError(issueNumber, collaborationId, "the active collaboration does not own the canonical claim");
  }
  if (!await isClaimActive(ours, workspaceRoot, ttlMs)) {
    throw repairableAuthorityError(issueNumber, collaborationId, "the canonical claim is no longer active");
  }
  const mismatch = authorityMismatch(ours.data.authority, authority);
  if (mismatch) throw repairableAuthorityError(issueNumber, collaborationId, mismatch);

  const resolvedAuthority = canonicalAuthority(authority);
  if (JSON.stringify(canonicalAuthority(ours.data.authority)) === JSON.stringify(resolvedAuthority)) {
    return { rebound: false, authority: resolvedAuthority };
  }
  const now = new Date().toISOString();
  ours.data.authority = resolvedAuthority;
  ours.data.timestamps.updated = now;
  ours.data.history = [
    { event: "identity_rebound", collaboration: collaborationId, writer: ours.data.writer, phase: ours.data.phase, at: now },
    ...(ours.data.history || []),
  ].slice(0, 10);
  await client.updateIssueComment(ours.commentId, generateCommentBody(ours.data));
  return { rebound: true, authority: resolvedAuthority };
}

function generateCommentBody(payload) {
  const historyLines = (payload.history || []).map(h => {
    const failover = h.event === "writer_failover"
      ? ` | Transfer: \`${h.previousWriter}\` → \`${h.writer}\` | Cause: \`${h.failureClass || "provider_failure"}\`${h.reason ? ` — ${claimSummary(h.reason)}` : ""}`
      : ` | Writer: \`${h.writer}\``;
    return `- [${h.at}] Event: **${h.event}** | Collab: \`${h.collaboration}\`${failover} | Phase: \`${h.phase || ""}\``;
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
  if (claim.data.collaboration && workspaceRoot) {
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
    const authorType = c.user?.type || c.author?.type || c.author?.__typename;
    if (authorType !== "Bot" || normalizeLogin(authorLogin) !== normalizeLogin(client.expectedLogin)) {
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
              created: parsedData.claimedAt || parsedData.timestamps?.created || null,
              updated: parsedData.updatedAt || parsedData.timestamps?.updated || null,
            },
            leaseExpiresAt: parsedData.leaseExpiresAt || null,
            history: parsedData.history || [],
          };
          claims.push({ commentId: c.id, data: mappedData, author: authorLogin, isLegacyV1: true });
          continue;
        } catch (error) {
          throw trustedClaimParseError(`Malformed trusted legacy claim comment ${c.id}: ${error.message}`);
        }
      }
      throw trustedClaimParseError(`Malformed trusted legacy claim comment ${c.id}: missing JSON payload.`);
    }

    // Canonical format
    const match = c.body.match(/<!-- agent-bridge-issue-claim\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        claims.push({ commentId: c.id, data: JSON.parse(match[1]), author: authorLogin });
      } catch (error) {
        throw trustedClaimParseError(`Malformed trusted canonical claim comment ${c.id}: ${error.message}`);
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
  lifecyclePolicy = null,
}) {
  const authority = requireBoundAuthority(client);
  // The canonical comment determines the current generation. A ref newer
  // than that comment is an in-flight or orphaned publication and blocks.
  const claims = await parseClaims(client, issueNumber);
  const canonical = canonicalClaim(claims);
  const canonicalIsActive = canonical ? await isClaimActive(canonical, workspaceRoot, ttlMs) : false;
  if (canonicalIsActive && canonical.data.collaboration !== collaborationId) {
    throw new Error(`Issue #${issueNumber} is already claimed by active collaboration ${canonical.data.collaboration} (writer: ${canonical.data.writer}).`);
  }
  if (canonicalIsActive && canonical.data.collaboration === collaborationId) {
    await rebindIssueClaim({ client, issueNumber, collaborationId, workspaceRoot, ttlMs });
    await refreshClaimLease({ client, issueNumber, collaborationId, phase: "claiming", headSha, branch, worktree });
    const claimLabel = await addClaimLabel(client, issueNumber);
    const refreshed = canonicalClaim((await parseClaims(client, issueNumber)).filter(
      (claim) => claim.data.collaboration === collaborationId,
    ));
    if (refreshed) {
      refreshed.data.claimLabel = claimLabel;
      await client.updateIssueComment(refreshed.commentId, generateCommentBody(refreshed.data));
    }
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
    const publicationClaims = await parseClaims(client, issueNumber);
    const publicationCanonical = canonicalClaim(publicationClaims);
    const publicationGeneration = publicationCanonical?.data.generation || 0;
    if (publicationGeneration !== canonicalGeneration) {
      throw new Error(`Claim changed while generation ${nextGen} was being acquired; retry from the new canonical generation.`);
    }
    if (publicationCanonical
      && await isClaimActive(publicationCanonical, workspaceRoot, ttlMs)
      && publicationCanonical.data.collaboration !== collaborationId) {
      throw new Error(`Issue #${issueNumber} became active for collaboration ${publicationCanonical.data.collaboration} while generation ${nextGen} was being acquired.`);
    }
    const now = new Date().toISOString();
    const event = publicationCanonical ? "takeover" : "claimed";
    const history = [{
      event,
      collaboration: collaborationId,
      writer,
      phase: "claiming",
      at: now,
      ...(publicationCanonical?.data.collaboration ? { previousCollaboration: publicationCanonical.data.collaboration } : {}),
    }, ...(publicationCanonical?.data.history || [])].slice(0, 10);

    const resolvedLifecyclePolicy = normalizeLifecyclePolicy(
      lifecyclePolicy || canonical?.data.lifecyclePolicy || loadRepositoryLifecyclePolicy(workspaceRoot),
    );
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
      authority: canonicalAuthority(authority),
      lifecyclePolicy: resolvedLifecyclePolicy,
      history,
    };
    const lifecycle = await transitionSemanticLifecycle({
      adapter: createProductionGitHubLifecycleAdapter(client),
      issueNumber,
      policy: resolvedLifecyclePolicy,
      record: payload.lifecycle,
      history: payload.history,
      state: "queued",
      collaborationId,
      writer,
      writerReason: event,
      at: now,
    });
    payload.lifecycle = lifecycle.record;
    payload.history = lifecycle.history;
    const commentBody = generateCommentBody(payload);
    let canonicalCommentId = publicationCanonical?.commentId || null;
    if (canonicalCommentId) {
      await client.updateIssueComment(canonicalCommentId, commentBody);
    } else {
      const newComment = await client.postIssueComment(issueNumber, commentBody);
      canonicalCommentId = newComment.id;
    }
    canonicalPublished = true;
    payload.claimLabel = await addClaimLabel(client, issueNumber);
    await client.updateIssueComment(canonicalCommentId, generateCommentBody(payload));
    for (const duplicate of publicationClaims.filter((claim) => claim.commentId !== canonicalCommentId)) {
      await client.deleteIssueComment(duplicate.commentId);
    }
    const publishedRefs = await client.listTagLocks();
    await deleteGenerations(client, publishedRefs.map(generationFromRef).filter((generation) => generation && generation < nextGen));
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

export async function refreshClaimLease({
  client,
  issueNumber,
  collaborationId,
  phase,
  headSha,
  branch,
  worktree,
  writer,
  writerFailover,
  summary,
  ttlMs = 300_000,
  workspaceRoot = null,
  lifecyclePolicy = null,
  semanticState = null,
  transitionId = null,
  deliveryId = null,
}) {
  const claims = await parseClaims(client, issueNumber);
  const ours = canonicalClaim(claims.filter(c => c.data.collaboration === collaborationId));
  if (!ours) {
    throw new Error(`No active claim lease found on GitHub for collaboration ${collaborationId}.`);
  }
  const authority = requireBoundAuthority(client);
  const mismatch = authorityMismatch(ours.data.authority, authority);
  if (mismatch) throw repairableAuthorityError(issueNumber, collaborationId, mismatch);

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
  const sameWriter = ours.data.writer === writer || !writer;
  const normalizedSummary = claimSummary(summary);
  const sameSummary = normalizedSummary === undefined || ours.data.summary === normalizedSummary;
  const lastUpdated = ours.data.timestamps?.updated;
  const ageMs = lastUpdated ? Date.now() - Date.parse(lastUpdated) : Infinity;
  // Keep the durable lifecycle projection aligned with the monotonic phase.
  // A delayed heartbeat may request an older phase, but it must not move the
  // semantic state (or its GitHub label) backwards after the phase is clamped.
  const requestedSemanticState = semanticStateForPhase(phase);
  const targetSemanticState = semanticState
    || (requestedSemanticState ? semanticStateForPhase(targetPhase) : null);
  const sameSemanticState = !targetSemanticState || ours.data.lifecycle?.state === targetSemanticState;
  const sameLifecycleWriter = !writer || ours.data.lifecycle?.activeWriter === writer;

  if (samePhase && sameHead && sameBranch && sameWorktree && sameWriter && sameSummary
    && sameSemanticState && sameLifecycleWriter && !transitionId && !deliveryId && ageMs < 60_000) {
    return;
  }

  if (ours.data.phase !== targetPhase) {
    ours.data.history = [
      { event: "transition", collaboration: collaborationId, writer: ours.data.writer, phase: targetPhase, at: new Date().toISOString() },
      ...(ours.data.history || [])
    ].slice(0, 10);
  }
  if (writer && ours.data.writer !== writer && writerFailover) {
    ours.data.history = [
      {
        event: "writer_failover",
        collaboration: collaborationId,
        previousWriter: writerFailover?.from || ours.data.writer,
        writer,
        failureClass: writerFailover?.failureClass || null,
        reason: writerFailover?.reason || null,
        phase: targetPhase,
        at: new Date().toISOString(),
      },
      ...(ours.data.history || []),
    ].slice(0, 10);
  }

  ours.data.phase = targetPhase;
  if (writer) ours.data.writer = writer;
  if (headSha) {
    ours.data.head = headSha;
  }
  if (branch) ours.data.branch = branch;
  if (worktree) ours.data.worktree = worktree;
  if (normalizedSummary !== undefined) ours.data.summary = normalizedSummary;
  ours.data.timestamps.updated = new Date().toISOString();
  ours.data.leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
  const resolvedLifecyclePolicy = normalizeLifecyclePolicy(
    lifecyclePolicy
      || ours.data.lifecyclePolicy
      || loadRepositoryLifecyclePolicy(workspaceRoot || worktree || process.cwd()),
  );
  ours.data.lifecyclePolicy = resolvedLifecyclePolicy;
  const lifecycle = targetSemanticState
    ? await transitionSemanticLifecycle({
      adapter: createProductionGitHubLifecycleAdapter(client),
      issueNumber,
      policy: resolvedLifecyclePolicy,
      record: ours.data.lifecycle,
      history: ours.data.history,
      state: targetSemanticState,
      collaborationId,
      writer: writer || ours.data.writer,
      writerReason: writerFailover ? "provider_failover" : "assigned",
      transitionId,
      deliveryId,
    })
    : { record: ours.data.lifecycle || {}, history: ours.data.history || [], applied: false, skipped: true };
  ours.data.lifecycle = lifecycle.record;
  ours.data.history = lifecycle.history;

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);
  if (workspaceRoot) {
    try {
      await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
        ...current,
        semanticLifecycle: lifecycle.record,
      }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function releaseClaimLease({
  client,
  issueNumber,
  collaborationId,
  outcome,
  workspaceRoot = process.cwd(),
  lifecyclePolicy = null,
}) {
  const allowedOutcomes = ["merged", "cancelled", "obsolete", "rolled_back", "taken_over", "recovered"];
  if (!allowedOutcomes.includes(outcome)) {
    throw new Error(`Invalid claim lease release outcome: ${outcome}.`);
  }

  // Presence only: inspected cleanup must remain possible after builder-App rotation.
  requireBoundAuthority(client);
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
  const lifecycle = await transitionSemanticLifecycle({
    adapter: createProductionGitHubLifecycleAdapter(client),
    issueNumber,
    policy: lifecyclePolicy || ours.data.lifecyclePolicy || loadRepositoryLifecyclePolicy(workspaceRoot),
    record: ours.data.lifecycle,
    history: ours.data.history,
    state: outcome === "rolled_back" || outcome === "taken_over" || outcome === "recovered" ? "obsolete" : outcome,
    collaborationId,
    writer: ours.data.writer,
    transitionId: `claim-release:${collaborationId}:${outcome}`,
  });
  ours.data.lifecycle = lifecycle.record;
  ours.data.history = lifecycle.history;

  const commentBody = generateCommentBody(ours.data);
  await client.updateIssueComment(ours.commentId, commentBody);

  const generation = ours.data.generation || 1;
  const refs = await client.listTagLocks();
  await deleteGenerations(client, refs.map(generationFromRef).filter((candidate) => candidate && candidate <= generation));

  const remainingClaims = (await parseClaims(client, issueNumber)).filter(
    c => c.data.collaboration !== collaborationId && !RELEASED_PHASES.has(normalizePhase(c.data.phase))
  );
  if (remainingClaims.length === 0) {
    await removeClaimLabelAndRepairRace(client, issueNumber);
  }
}

export async function recoverIssueClaim({ client, issueNumber, collaborationId, generation, workspaceRoot, ttlMs = 300_000 }) {
  // Presence only: orphan recovery must remain possible after builder-App rotation.
  requireBoundAuthority(client);
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
  if (canonical) {
    const canonicalGeneration = canonical.data.generation || 1;
    if (generation <= canonicalGeneration) {
      throw new Error(`Refusing orphan recovery of generation ${generation}: canonical generation ${canonicalGeneration} is not older.`);
    }
    if (await isClaimActive(canonical, workspaceRoot, ttlMs)) {
      throw new Error(`Refusing orphan recovery while canonical collaboration ${canonical.data.collaboration} is still active.`);
    }
  }
  await deleteGenerationIfPresent(client, generation);
  if (claims.every((claim) => RELEASED_PHASES.has(normalizePhase(claim.data.phase)))) {
    await removeClaimLabelAndRepairRace(client, issueNumber);
  }
  return { recovered: true, generation, canonical: false, previousCanonicalGeneration: canonical?.data.generation || null };
}

export async function handleIssueLifecycleWebhook({
  client,
  issueNumber,
  collaborationId,
  deliveryId,
  observedState,
  workspaceRoot = process.cwd(),
  lifecyclePolicy = null,
}) {
  const claims = await parseClaims(client, issueNumber);
  const ours = canonicalClaim(claims.filter((claim) => claim.data.collaboration === collaborationId));
  if (!ours) throw new Error(`No issue claim found for collaboration ${collaborationId}.`);
  const transition = await handleLifecycleWebhook({
    adapter: createProductionGitHubLifecycleAdapter(client),
    issueNumber,
    policy: lifecyclePolicy || ours.data.lifecyclePolicy || loadRepositoryLifecyclePolicy(workspaceRoot),
    record: ours.data.lifecycle,
    history: ours.data.history,
    collaborationId,
    writer: ours.data.writer,
    deliveryId,
    observedState,
  });
  if (!transition.applied) return transition;
  ours.data.lifecycle = transition.record;
  ours.data.history = transition.history;
  ours.data.timestamps.updated = new Date().toISOString();
  await client.updateIssueComment(ours.commentId, generateCommentBody(ours.data));
  try {
    await updateCollaboration(workspaceRoot, collaborationId, (current) => ({
      ...current,
      semanticLifecycle: transition.record,
    }));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return transition;
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

function isTransientClaimReconciliationError(error) {
  const statuses = [error?.status, error?.cause?.status].filter((status) => Number.isInteger(status));
  if (statuses.some((status) => status === 429 || status >= 500)) return true;
  const codes = [error?.code, error?.cause?.code].filter(Boolean).map(String);
  if (codes.some((code) => /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT|UND_ERR_|ABORT_ERR)/.test(code))) {
    return true;
  }
  return error instanceof TypeError && /fetch|network|socket|connection/i.test(error.message || "");
}

async function recordClaimReconciliationFailure({ portfoliosPath, portfolioId, itemId, stage, error }) {
  const detail = error?.message || String(error);
  const transient = isTransientClaimReconciliationError(error);
  try {
    await updatePortfolioWithRetry(portfoliosPath, portfolioId, async (current) => {
      const targetItem = current.items.find((candidate) => candidate.id === itemId);
      if (!targetItem) return current;
      if (transient) {
        targetItem.summary = `Claim reconciliation ${stage} was deferred after a transient GitHub failure: ${detail}. The retained claim remains held and will retry automatically.`;
        return current;
      }
      targetItem.status = "indeterminate";
      const recovery = error?.code === "CLAIM_AUTHORITY_MISMATCH"
        || error?.code === "CLAIM_PARSE_INVALID"
        ? " Inspect the retained claim, release it without mutation, then reacquire it with the verified builder App."
        : " Inspect the builder App binding and retained claim before releasing or reacquiring it.";
      targetItem.summary = `Claim reconciliation ${stage} could not establish trusted authority: ${detail}.${recovery}`;
      return current;
    });
    return { transient, recorded: true, recordError: null };
  } catch (recordError) {
    // A diagnostic write must never become a sweep-wide failure. The retained
    // GitHub claim remains the authority fence, so leave it untouched and make
    // the inability to persist the local diagnosis observable to the caller.
    console.error(`Unable to record claim reconciliation failure for ${portfolioId}/${itemId}: ${recordError.message}`);
    return { transient, recorded: false, recordError };
  }
}

async function readPortfoliosForClaimSweep(portfoliosPath) {
  const failures = [];
  const names = (await readdir(portfoliosPath).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }))
    .filter((name) => /^helm-[0-9a-f-]{36}\.json$/.test(name));
  const portfolios = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    try {
      const portfolio = await readPortfolio(portfoliosPath, id);
      if (!portfolio || portfolio.id !== id || !Array.isArray(portfolio.items)) {
        const error = new Error(`Portfolio ${id} has an invalid reconciliation shape; expected matching id and an items array.`);
        error.code = "PORTFOLIO_STATE_INVALID";
        throw error;
      }
      portfolios.push(portfolio);
    } catch (error) {
      // Corrupt/unreadable portfolio state is never guessed or overwritten:
      // skip that portfolio, report it for inspected repair, and continue with
      // every independently readable portfolio in the sweep.
      console.error(`Skipping unreadable claim-reconciliation portfolio ${id}: ${error.message}`);
      failures.push({ portfolioId: id, itemId: null, stage: "portfolio-read", error });
    }
  }
  portfolios.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return { portfolios, failures };
}

export async function reconcileClaimsAndPortfolios(workspaceRoot, fetchImpl = fetch, clientOverride = null) {
  const portfoliosPath = resolve(workspaceRoot, ".bridge/portfolios");
  const sweep = await readPortfoliosForClaimSweep(portfoliosPath);
  const failures = [...sweep.failures];
  const portfolios = sweep.portfolios;
  for (const p of portfolios) {
    const portfolioState = p;
    for (const item of portfolioState.items) {
      let reconciliationStage = "collaboration-read";
      try {
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
        let client;
        let claim;
        reconciliationStage = "preflight";
        client = typeof clientOverride === "function"
          ? await clientOverride({ issueNumber: issueNum, portfolio: portfolioState, item })
          : clientOverride || await getBuilderClientForWorkspace(portfolioState.workspace || workspaceRoot, issueNum, fetchImpl);
        if (!client) {
          const error = new Error(`No builder App client is configured for claimed issue #${issueNum}.`);
          error.code = "CLAIM_CLIENT_UNAVAILABLE";
          throw error;
        }
        claim = canonicalClaim(await parseClaims(client, issueNum));
      const claimIsHeld = claim && !RELEASED_PHASES.has(normalizePhase(claim.data.phase));
      reconciliationStage = "lifecycle-read";
      const lifecycleReconciliation = await reconcileGitHubLifecycle({
        adapter: createProductionGitHubLifecycleAdapter(client),
        issueNumber: issueNum,
        policy: claim?.data.lifecyclePolicy || loadRepositoryLifecyclePolicy(portfolioState.workspace || collab?.workspace || workspaceRoot),
        record: claim?.data.lifecycle || collab?.semanticLifecycle,
        history: claim?.data.history || [],
        collaborationId: item.collaborationId || claim?.data.collaboration || null,
        writer: collab?.writer || claim?.data.writer || item.writer || null,
      });
      if (lifecycleReconciliation.outcome) {
        const semanticState = lifecycleReconciliation.outcome;
        if (claim && lifecycleReconciliation.applied) {
          reconciliationStage = "lifecycle-comment-update";
          claim.data.lifecycle = lifecycleReconciliation.record;
          claim.data.history = lifecycleReconciliation.history;
          claim.data.phase = semanticState;
          claim.data.summary = `GitHub ${semanticState} outcome reconciled into Agent Bridge state.`;
          claim.data.timestamps.updated = new Date().toISOString();
          await client.updateIssueComment(claim.commentId, generateCommentBody(claim.data));
        }
        reconciliationStage = "lifecycle-portfolio-update";
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.status = portfolioStatusForSemanticState(semanticState);
            targetItem.semanticLifecycle = lifecycleReconciliation.record;
            targetItem.summary = `Authoritative GitHub outcome reconciled as ${semanticState}.`;
          }
          return current;
        });
        if (collab) {
          reconciliationStage = "lifecycle-collaboration-update";
          await updateCollaboration(workspaceRoot, collab.id, (current) => ({
            ...current,
            status: semanticState,
            semanticLifecycle: lifecycleReconciliation.record,
            completion: {
              ...(current.completion || {}),
              githubOutcome: semanticState,
              reconciledAt: new Date().toISOString(),
            },
          }));
        }
        if (claimIsHeld && claim.data.collaboration === item.collaborationId) {
          reconciliationStage = "lifecycle-claim-release";
          await releaseClaimLease({
            client,
            issueNumber: issueNum,
            collaborationId: item.collaborationId,
            outcome: semanticState,
            workspaceRoot: portfolioState.workspace || workspaceRoot,
          });
        }
        continue;
      }

      if (["cancelled", "obsolete"].includes(collab?.status)) {
        if (claimIsHeld && claim.data.collaboration === item.collaborationId) {
          reconciliationStage = "terminal-claim-release";
          await releaseClaimLease({ client, issueNumber: issueNum, collaborationId: item.collaborationId, outcome: collab.status });
        }
        continue;
      }

      if (!item.collaborationId && claimIsHeld) {
        reconciliationStage = "claim-collaboration-recovery-read";
        let recoveredCollaboration = null;
        try {
          recoveredCollaboration = await readCollaboration(workspaceRoot, claim.data.collaboration);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        reconciliationStage = "claim-collaboration-recovery-update";
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
        reconciliationStage = "authority-mismatch-update";
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
        reconciliationStage = "missing-collaboration-update";
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
        reconciliationStage = "stopped-collaboration-update";
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

        reconciliationStage = "refresh";
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
        reconciliationStage = "refresh-portfolio-update";
        await updatePortfolioWithRetry(portfoliosPath, p.id, async (current) => {
          const targetItem = current.items.find((candidate) => candidate.id === item.id);
          if (targetItem) {
            targetItem.summary = `Claim lease reconciled with local collaboration status ${collab.status} after broker restart.`;
          }
          return current;
        });
      } catch (error) {
        const failure = await recordClaimReconciliationFailure({
          portfoliosPath,
          portfolioId: p.id,
          itemId: item.id,
          stage: reconciliationStage,
          error,
        });
        failures.push({
          portfolioId: p.id,
          itemId: item.id,
          stage: reconciliationStage,
          error,
          recordError: failure.recordError,
        });
      }
    }
  }
  return {
    reconciled: true,
    failures: failures.map(({ portfolioId, itemId, stage, error, recordError = null }) => ({
      portfolioId,
      itemId,
      stage,
      transient: isTransientClaimReconciliationError(error),
      error: error?.message || String(error),
      recordError: recordError ? (recordError.message || String(recordError)) : null,
    })),
  };
}

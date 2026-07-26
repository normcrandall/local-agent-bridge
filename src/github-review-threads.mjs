import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const FINDING_PREFIX = "<!-- agent-bridge-finding:v1:";
const DISPOSITION_PREFIX = "<!-- agent-bridge-disposition:v1:";
const SUMMARY_PREFIX = "<!-- agent-bridge-review-summary:v1:";
const MARKER_SUFFIX = " -->";
const DISPOSITIONS = new Set(["fixed", "declined", "follow_up"]);
const CLASSIFICATIONS = new Set(["blocker", "suggestion"]);

function normalizeBotLogin(login) {
  return String(login || "").toLowerCase().replace(/\[bot\]$/, "");
}

export function assertTrustedReviewerLogins(logins = []) {
  const normalized = [...new Set(logins.map(normalizeBotLogin).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("Review-thread evaluation requires at least one trusted reviewer App login.");
  }
  return normalized;
}

export function configuredTrustedWriterLogins({ appRoles = null, builderRole = null } = {}) {
  const configuredWriters = Object.values(appRoles?.roles?.writers || {})
    .filter((role) => role?.configured && role?.expectedLoginValid)
    .map((role) => role.expectedLogin);
  return [...new Set([
    builderRole?.expectedLogin,
    ...configuredWriters,
  ].filter(Boolean))];
}

function sameBotLogin(left, right) {
  return normalizeBotLogin(left) === normalizeBotLogin(right);
}

function encodeMarker(prefix, value) {
  return `${prefix}${Buffer.from(JSON.stringify(value)).toString("base64url")}${MARKER_SUFFIX}`;
}

function decodeMarker(body, prefix) {
  const source = String(body || "");
  const start = source.lastIndexOf(prefix);
  if (start < 0) return null;
  const end = source.indexOf(MARKER_SUFFIX, start + prefix.length);
  if (end < 0) return null;
  try {
    return JSON.parse(Buffer.from(source.slice(start + prefix.length, end), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function validSha(value) {
  return /^[0-9a-f]{40}$/i.test(value || "");
}

function trustedBotComment(comment, login, trustedLogins = []) {
  return comment?.author?.__typename === "Bot"
    && sameBotLogin(comment.author?.login, login)
    && trustedLogins.some((trusted) => sameBotLogin(trusted, login));
}

function requireReviewerApp(client) {
  if (!client) {
    throw new Error("Review-thread access requires the configured reviewer GitHub App; PAT fallback is not authorized.");
  }
  return client;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function followUpIssuePattern(repository = null) {
  return repository
    ? new RegExp(`^https://github\\.com/${escapeRegExp(repository)}/issues/[1-9][0-9]*$`, "i")
    : /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/i;
}

export function reviewFindingMarker({
  headSha,
  reviewerLogin,
  classification = "blocker",
  fixRecommendation,
}) {
  if (!validSha(headSha)) throw new Error("Review finding requires a full head SHA.");
  if (!reviewerLogin) throw new Error("Review finding requires a reviewer login.");
  if (!CLASSIFICATIONS.has(classification)) throw new Error("Review finding classification must be blocker or suggestion.");
  if (classification === "blocker" && !String(fixRecommendation || "").trim()) {
    throw new Error("An actionable review finding requires a concrete fix recommendation.");
  }
  return encodeMarker(FINDING_PREFIX, {
    headSha: headSha.toLowerCase(),
    reviewerLogin,
    classification,
    actionable: classification === "blocker",
    fixRecommendation: String(fixRecommendation || "").trim() || null,
  });
}

export function parseReviewFinding(body) {
  const value = decodeMarker(body, FINDING_PREFIX);
  if (
    !value
    || !validSha(value.headSha)
    || !value.reviewerLogin
    || !CLASSIFICATIONS.has(value.classification)
    || value.actionable !== (value.classification === "blocker")
    || (value.actionable && !String(value.fixRecommendation || "").trim())
  ) return null;
  return value;
}

export function reviewSummaryMarker({ headSha, reviewerLogin, blockers, suggestions, testingSufficiency }) {
  if (!validSha(headSha)) throw new Error("Review summary requires a full head SHA.");
  return encodeMarker(SUMMARY_PREFIX, {
    headSha: headSha.toLowerCase(),
    reviewerLogin,
    blockers,
    suggestions,
    testingSufficiency: String(testingSufficiency || "not reported").trim(),
  });
}

export function writerDispositionMarker({
  headSha,
  writerLogin,
  disposition,
  rationale = "",
  followUpUrl = null,
  repository = null,
}) {
  if (!validSha(headSha)) throw new Error("Review-thread disposition requires a full head SHA.");
  if (!writerLogin) throw new Error("Review-thread disposition requires the writer App login.");
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error("Review-thread disposition must be fixed, declined, or follow_up.");
  }
  const normalizedRationale = String(rationale || "").trim();
  if (disposition === "declined" && !normalizedRationale) {
    throw new Error("A declined review finding requires a rationale.");
  }
  if (disposition === "follow_up") {
    const issuePattern = followUpIssuePattern(repository);
    if (!repository || !issuePattern.test(String(followUpUrl || ""))) {
      throw new Error(`A follow-up disposition requires a linked ${repository || "repository"} GitHub issue URL.`);
    }
  } else if (followUpUrl) {
    throw new Error("followUpUrl is valid only for a follow_up disposition.");
  }
  return encodeMarker(DISPOSITION_PREFIX, {
    headSha: headSha.toLowerCase(),
    writerLogin,
    disposition,
    rationale: normalizedRationale || null,
    followUpUrl: followUpUrl || null,
  });
}

export function parseWriterDisposition(body, { repository = null } = {}) {
  const value = decodeMarker(body, DISPOSITION_PREFIX);
  const followUpPattern = followUpIssuePattern(repository);
  if (
    !value
    || !validSha(value.headSha)
    || !value.writerLogin
    || !DISPOSITIONS.has(value.disposition)
    || (value.disposition === "declined" && !String(value.rationale || "").trim())
    || (value.disposition === "follow_up" && !followUpPattern.test(value.followUpUrl || ""))
  ) return null;
  return value;
}

function actionableFinding(thread, trustedReviewerLogins) {
  const original = thread.comments?.nodes?.[0];
  const finding = parseReviewFinding(original?.body);
  if (!finding?.actionable) return null;
  if (!trustedBotComment(original, finding.reviewerLogin, trustedReviewerLogins)) return null;
  return { original, finding };
}

function currentDispositionState(thread, headSha, trustedWriterLogins, repository = null) {
  const comments = thread.comments?.nodes || [];
  let signerNotTrusted = null;
  for (let index = comments.length - 1; index >= 1; index -= 1) {
    const comment = comments[index];
    const disposition = parseWriterDisposition(comment.body, { repository });
    if (disposition?.headSha?.toLowerCase() !== headSha.toLowerCase()) continue;
    // A marker can describe only the bot account that actually authored it.
    // Preserve an otherwise-valid exact-head disposition as diagnostic evidence
    // when that signer is absent from the active roster, but never authorize it.
    if (!trustedBotComment(comment, disposition.writerLogin, [disposition.writerLogin])) continue;
    if (trustedBotComment(comment, disposition.writerLogin, trustedWriterLogins)) {
      return { response: { comment, disposition }, signerNotTrusted: null };
    }
    signerNotTrusted ||= { comment, disposition };
  }
  return { response: null, signerNotTrusted };
}

export function evaluateReviewThreadState({
  threads = [],
  headSha,
  repository = null,
  trustedReviewerLogins = [],
  trustedWriterLogins = [],
  trustRoster = null,
  prNumber = null,
}) {
  if (!validSha(headSha)) throw new Error("Review-thread evaluation requires a full head SHA.");
  const actionable = [];
  for (const thread of threads) {
    const owned = actionableFinding(thread, trustedReviewerLogins);
    if (!owned) continue;
    const dispositionState = currentDispositionState(thread, headSha, trustedWriterLogins, repository);
    const response = dispositionState.response;
    actionable.push({
      threadId: thread.id,
      reviewerLogin: owned.finding.reviewerLogin,
      findingHeadSha: owned.finding.headSha,
      disposition: response?.disposition || null,
      answered: Boolean(response),
      resolved: thread.isResolved === true,
      responseUrl: response?.comment?.url || null,
      signerNotTrusted: dispositionState.signerNotTrusted ? {
        writerLogin: dispositionState.signerNotTrusted.disposition.writerLogin,
        disposition: dispositionState.signerNotTrusted.disposition.disposition,
        responseUrl: dispositionState.signerNotTrusted.comment?.url || null,
      } : null,
    });
  }
  const signerNotTrusted = actionable.filter((entry) => entry.signerNotTrusted);
  const unanswered = actionable.filter((entry) => !entry.answered && !entry.signerNotTrusted);
  const unresolved = actionable.filter((entry) => entry.answered && !entry.resolved);
  const normalizedReviewerLogins = [...new Set(trustedReviewerLogins.map(normalizeBotLogin).filter(Boolean))].sort();
  const normalizedWriterLogins = [...new Set(trustedWriterLogins.map(normalizeBotLogin).filter(Boolean))].sort();
  const digest = createHash("sha256").update(JSON.stringify({
    repository: String(repository || "").toLowerCase() || null,
    headSha: headSha.toLowerCase(),
    trustedReviewerLogins: normalizedReviewerLogins,
    trustedWriterLogins: normalizedWriterLogins,
    trustRoster,
    actionable,
  })).digest("hex");
  return {
    version: 2,
    repository: repository || null,
    prNumber: Number.isInteger(prNumber) ? prNumber : null,
    headSha: headSha.toLowerCase(),
    actionable,
    unanswered,
    signerNotTrusted,
    unresolved,
    trustRoster: trustRoster || {
      source: "caller-supplied",
      configuredWriterLogins: normalizedWriterLogins,
      degraded: false,
      reason: null,
    },
    ready: unanswered.length === 0 && signerNotTrusted.length === 0 && unresolved.length === 0,
    digest,
  };
}

export function constrainApprovalToReviewThreadState({
  event,
  body,
  readiness,
  statusGateEnabled = false,
}) {
  if (event !== "APPROVE") {
    return { event, body, gateReviewState: null };
  }
  if (!readiness) throw new Error("APPROVE requires an exact-head review-thread readiness receipt.");
  // An answered thread may still need the owning reviewer App to resolve it.
  // Allow the formal APPROVE so that exact-head approval can authorize that
  // resolution; the merge gate continues to require every thread resolved.
  const signerNotTrusted = readiness.signerNotTrusted || [];
  if (readiness.unanswered.length === 0 && signerNotTrusted.length === 0) {
    return {
      event,
      body,
      gateReviewState: statusGateEnabled ? (readiness.ready ? "APPROVE" : "COMMENT") : null,
    };
  }
  const scope = [
    readiness.repository,
    readiness.prNumber ? `PR #${readiness.prNumber}` : null,
    readiness.headSha ? `at ${readiness.headSha.slice(0, 12)}` : null,
  ].filter(Boolean).join(" ");
  const roster = readiness.trustRoster || {};
  const configuredWriters = roster.configuredWriterLogins?.length
    ? roster.configuredWriterLogins.join(", ")
    : "none verified";
  const rosterDetail = ` Writer trust roster: source=${roster.source || "unknown"}; degraded=${roster.degraded ? "yes" : "no"}; configured writers=${configuredWriters}.${roster.degraded ? ` Reason: ${roster.reason || "writer identities could not be verified"}.` : ""}`;
  return {
    event: "COMMENT",
    body: `${String(body || "").trim()}\n\nApproval withheld${scope ? ` for ${scope}` : ""}: ${readiness.unanswered.length} actionable thread(s) are unanswered, ${signerNotTrusted.length} exact-head disposition signer(s) are not in the active trusted writer roster, and ${readiness.unresolved.length} answered thread(s) remain unresolved.${rosterDetail}`,
    gateReviewState: statusGateEnabled ? "COMMENT" : null,
  };
}

export function assertReviewThreadReadiness(input) {
  const receipt = evaluateReviewThreadState(input);
  if (!receipt.ready) {
    const parts = [];
    if (receipt.unanswered.length) parts.push(`${receipt.unanswered.length} unanswered`);
    if (receipt.signerNotTrusted?.length) parts.push(`${receipt.signerNotTrusted.length} signed by a writer outside the active trusted roster`);
    if (receipt.unresolved.length) parts.push(`${receipt.unresolved.length} unresolved`);
    throw new Error(`Merge readiness refused on exact head ${receipt.headSha}: actionable review threads are ${parts.join(" and ")}.`);
  }
  return receipt;
}

export function reviewReadinessReceiptIsCurrent(receipt, headSha) {
  return Boolean(receipt?.ready && validSha(headSha) && receipt.headSha === headSha.toLowerCase());
}

export function approvedSubmissionEvent(reviewState) {
  return String(reviewState || "").toUpperCase() === "APPROVED" ? "APPROVE" : null;
}

export async function reconcileApprovedReviewerBlockers({
  requestedEvent,
  submittedReviewState,
  expectedLogin,
  headSha,
  readReadiness,
  resolveThread,
  assertCurrentHead = async () => {},
}) {
  if (requestedEvent !== "APPROVE" || approvedSubmissionEvent(submittedReviewState) !== "APPROVE") {
    return { attempted: false, resolved: [], readiness: null };
  }
  if (!validSha(headSha)) throw new Error("Review-thread reconciliation requires a full exact-head SHA.");
  if (!expectedLogin) throw new Error("Review-thread reconciliation requires the approving reviewer login.");
  if (typeof readReadiness !== "function" || typeof resolveThread !== "function" || typeof assertCurrentHead !== "function") {
    throw new Error("Review-thread reconciliation requires bounded readiness and resolution operations.");
  }

  const resolved = [];
  let candidates = [];
  try {
    await assertCurrentHead();
    const before = await readReadiness();
    if (before?.headSha !== headSha.toLowerCase()) {
      throw new Error(`Review-thread reconciliation refused stale authorization: expected ${headSha.toLowerCase()}, received ${before?.headSha || "unknown"}.`);
    }
    candidates = (before.unresolved || []).filter((entry) => (
      entry.answered
      && sameBotLogin(entry.reviewerLogin, expectedLogin)
      && entry.disposition?.disposition === "fixed"
    ));
    for (const candidate of candidates) {
      await assertCurrentHead();
      try {
        resolved.push(await resolveThread({ threadId: candidate.threadId }));
      } catch (error) {
      // The mutation may have reached GitHub even if the response was lost.
      // Re-read before declaring it pending so retries reconcile observed state.
      await assertCurrentHead();
      const observed = await readReadiness();
      const stillPending = (observed.unresolved || []).some((entry) => entry.threadId === candidate.threadId);
      if (!stillPending) {
        resolved.push({ threadId: candidate.threadId, idempotent: true, reconciled: true });
        continue;
      }
        return {
          attempted: true,
          complete: false,
          resolved,
          readiness: observed,
          error: {
            message: `Exact-head approval published, but reviewer-owned blocker reconciliation stopped after ${resolved.length}/${candidates.length}: ${error.message}`,
            headSha: headSha.toLowerCase(),
            expectedLogin,
            completedThreadIds: resolved.map((entry) => entry.threadId),
            pendingThreadIds: candidates.filter((entry) => (
              (observed.unresolved || []).some((pending) => pending.threadId === entry.threadId)
            )).map((entry) => entry.threadId),
          },
        };
      }
    }
    await assertCurrentHead();
    const readiness = await readReadiness();
    if (readiness?.headSha !== headSha.toLowerCase()) {
      throw new Error(`Review-thread reconciliation observed a stale final head: expected ${headSha.toLowerCase()}, received ${readiness?.headSha || "unknown"}.`);
    }
    return { attempted: true, complete: true, resolved, readiness, error: null };
  } catch (error) {
    const completedThreadIds = resolved.map((entry) => entry.threadId);
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.reviewResolution = {
      resolved: [...resolved],
      completedThreadIds,
      pendingThreadIds: candidates
        .map((entry) => entry.threadId)
        .filter((threadId) => !completedThreadIds.includes(threadId)),
    };
    throw failure;
  }
}

export function reviewThreadReceiptPath({ repository, prNumber, headSha, expectedLogin, stateRoot }) {
  const repositoryParts = String(repository || "").split("/");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")
    || repositoryParts.some((part) => part === "." || part === "..")
  ) {
    throw new Error("reviewThreadReceiptPath requires an owner/name repository.");
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error("reviewThreadReceiptPath requires a positive PR number.");
  }
  if (!validSha(headSha)) {
    throw new Error("reviewThreadReceiptPath requires a full commit SHA.");
  }
  if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(expectedLogin || "")) {
    throw new Error("reviewThreadReceiptPath requires a valid reviewer login.");
  }
  const root = stateRoot || resolve(homedir(), ".local/share/agent-bridge/review-receipts");
  return resolve(
    root,
    `${repository.replaceAll("/", "__")}--${prNumber}--${headSha}--${expectedLogin}.jsonl`,
  );
}

export function createReviewerThreadController({
  client = null,
  readerClient = client,
  resolverClient = client,
  expectedLogin,
  headSha = null,
  repository = null,
  trustedWriterLogins = [],
  getSubmittedEvent,
}) {
  if (!expectedLogin) throw new Error("expectedLogin is required.");
  if (typeof getSubmittedEvent !== "function") throw new Error("getSubmittedEvent is required.");

  return {
    async read() {
      return requireReviewerApp(readerClient).reviewThreads();
    },

    async resolve({ threadId }) {
      const appReader = requireReviewerApp(readerClient);
      if (!resolverClient) {
        throw new Error("Review-thread resolution requires the configured builder GitHub App executor.");
      }
      if (getSubmittedEvent() !== "APPROVE") {
        throw new Error("The reviewer must submit its exact-head APPROVE review before resolving satisfied threads.");
      }
      const threads = await appReader.reviewThreads();
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error("Review thread is not part of the bound pull request.");
      const originalComment = thread.comments?.nodes?.[0];
      if (
        originalComment?.author?.__typename !== "Bot"
        || !sameBotLogin(originalComment.author?.login, expectedLogin)
      ) {
        throw new Error("The reviewer App may resolve only a thread opened by that same reviewer identity.");
      }
      const finding = parseReviewFinding(originalComment.body);
      if (finding && (
        !headSha
        || !sameBotLogin(finding.reviewerLogin, expectedLogin)
        || !currentDispositionState(thread, headSha, trustedWriterLogins, repository).response
      )) {
        throw new Error("The reviewer may resolve an actionable thread only after a validated writer disposition on the refreshed exact head.");
      }
      const result = await resolverClient.resolveReviewThread({ threadId });
      return {
        ...result,
        authorizedBy: expectedLogin,
        executedBy: result.login,
        ...((headSha || result.headSha) ? { headSha: headSha || result.headSha } : {}),
      };
    },
  };
}

export function reviewTrustEvidencePath({ repository, prNumber, headSha, stateRoot }) {
  const root = stateRoot || resolve(homedir(), ".local/share/agent-bridge/review-receipts");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("reviewTrustEvidencePath requires an owner/name repository.");
  }
  if (!Number.isInteger(prNumber) || prNumber < 1 || !validSha(headSha)) {
    throw new Error("reviewTrustEvidencePath requires a positive PR number and full head SHA.");
  }
  return resolve(root, `${repository.replaceAll("/", "__")}--${prNumber}--${headSha.toLowerCase()}--trust.jsonl`);
}

export async function appendReviewTrustEvidence({ repository, prNumber, headSha, evidence, stateRoot }) {
  const path = reviewTrustEvidencePath({ repository, prNumber, headSha, stateRoot });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    type: "review_trust_roster",
    at: new Date().toISOString(),
    repository,
    prNumber,
    headSha: headSha.toLowerCase(),
    reviewerLogin: evidence.reviewerLogin || null,
    readinessDigest: evidence.readinessDigest || null,
    configuredWriterLogins: [...new Set(evidence.configuredWriterLogins || [])].sort(),
    rosterSource: evidence.rosterSource || "unknown",
    degraded: evidence.degraded === true,
    unknown: evidence.unknown === true,
    degradationReason: evidence.degradationReason || null,
    unansweredCount: evidence.unansweredCount || 0,
    signerNotTrusted: (evidence.signerNotTrusted || []).map((entry) => ({
      threadId: entry.threadId,
      writerLogin: entry.signerNotTrusted?.writerLogin || entry.writerLogin || null,
      disposition: entry.signerNotTrusted?.disposition || entry.disposition || null,
    })),
    unresolvedCount: evidence.unresolvedCount || 0,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function readLatestReviewTrustEvidence({
  repository,
  prNumber,
  headSha,
  reviewerLogin,
  notBefore = null,
  stateRoot,
}) {
  if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(reviewerLogin || "")) {
    throw new Error("readLatestReviewTrustEvidence requires a reviewer login.");
  }
  const path = reviewTrustEvidencePath({ repository, prNumber, headSha, stateRoot });
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    const records = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch {
        return { status: "unreadable", evidence: null, reason: "Durable review trust evidence is unreadable." };
      }
      if (record?.type !== "review_trust_roster") continue;
      if (!sameBotLogin(record.reviewerLogin, reviewerLogin)) continue;
      if (notBefore && Date.parse(record.at) < Date.parse(notBefore)) continue;
      records.push(record);
    }
    if (!records.length) return { status: "absent", evidence: null, reason: null };
    // Within one bounded publication attempt, a degraded observation must not
    // be hidden by a concurrently appended healthy record for the same signer.
    const conservative = records.filter((record) => record.degraded === true || record.unknown === true);
    return { status: "found", evidence: (conservative.length ? conservative : records).at(-1), reason: null };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent", evidence: null, reason: null };
    return { status: "unreadable", evidence: null, reason: "Durable review trust evidence is unreadable." };
  }
}

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

const FINDING_PREFIX = "<!-- agent-bridge-finding:v1:";
const DISPOSITION_PREFIX = "<!-- agent-bridge-disposition:v1:";
const SUMMARY_PREFIX = "<!-- agent-bridge-review-summary:v1:";
const MARKER_SUFFIX = " -->";
const DISPOSITIONS = new Set(["fixed", "declined", "follow_up"]);
const CLASSIFICATIONS = new Set(["blocker", "suggestion"]);

function normalizeBotLogin(login) {
  return String(login || "").toLowerCase().replace(/\[bot\]$/, "");
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
    const escapedRepository = String(repository || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const issuePattern = new RegExp(`^https://github\\.com/${escapedRepository}/issues/[1-9][0-9]*$`, "i");
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

export function parseWriterDisposition(body) {
  const value = decodeMarker(body, DISPOSITION_PREFIX);
  if (
    !value
    || !validSha(value.headSha)
    || !value.writerLogin
    || !DISPOSITIONS.has(value.disposition)
    || (value.disposition === "declined" && !String(value.rationale || "").trim())
    || (value.disposition === "follow_up" && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/i.test(value.followUpUrl || ""))
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

function currentDisposition(thread, headSha, trustedWriterLogins) {
  const comments = thread.comments?.nodes || [];
  for (let index = comments.length - 1; index >= 1; index -= 1) {
    const comment = comments[index];
    const disposition = parseWriterDisposition(comment.body);
    if (
      disposition?.headSha?.toLowerCase() === headSha.toLowerCase()
      && trustedBotComment(comment, disposition.writerLogin, trustedWriterLogins)
    ) return { comment, disposition };
  }
  return null;
}

export function evaluateReviewThreadState({
  threads = [],
  headSha,
  trustedReviewerLogins = [],
  trustedWriterLogins = [],
}) {
  if (!validSha(headSha)) throw new Error("Review-thread evaluation requires a full head SHA.");
  const actionable = [];
  for (const thread of threads) {
    const owned = actionableFinding(thread, trustedReviewerLogins);
    if (!owned) continue;
    const response = currentDisposition(thread, headSha, trustedWriterLogins);
    actionable.push({
      threadId: thread.id,
      reviewerLogin: owned.finding.reviewerLogin,
      findingHeadSha: owned.finding.headSha,
      disposition: response?.disposition || null,
      answered: Boolean(response),
      resolved: thread.isResolved === true,
      responseUrl: response?.comment?.url || null,
    });
  }
  const unanswered = actionable.filter((entry) => !entry.answered);
  const unresolved = actionable.filter((entry) => entry.answered && !entry.resolved);
  const digest = createHash("sha256").update(JSON.stringify(actionable)).digest("hex");
  return {
    version: 1,
    headSha: headSha.toLowerCase(),
    actionable,
    unanswered,
    unresolved,
    ready: unanswered.length === 0 && unresolved.length === 0,
    digest,
  };
}

export function assertReviewThreadReadiness(input) {
  const receipt = evaluateReviewThreadState(input);
  if (!receipt.ready) {
    const parts = [];
    if (receipt.unanswered.length) parts.push(`${receipt.unanswered.length} unanswered`);
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
        || !currentDisposition(thread, headSha, trustedWriterLogins)
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

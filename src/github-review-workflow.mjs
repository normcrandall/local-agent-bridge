import { publishBoundReviewGate } from "./github-review-client.mjs";
import {
  approvedSubmissionEvent,
  reconcileApprovedReviewerBlockers,
} from "./github-review-threads.mjs";

export async function reconcilePublishedReview({
  result,
  requestedEvent,
  expectedLogin,
  headSha,
  readReadiness,
  resolveThread,
  assertCurrentHead,
  statusGate = null,
  snapshotCache = null,
  repository = null,
  prNumber = null,
}) {
  const submittedEvent = approvedSubmissionEvent(result.state);
  let pullRequestSnapshot = null;
  let firstLiveHeadAssertion = null;
  if (snapshotCache && repository && Number.isInteger(prNumber) && prNumber > 0) {
    pullRequestSnapshot = await snapshotCache.getOrLoad({
      repository,
      kind: "pull_request",
      subject: `pr:${prNumber}`,
      headSha,
      trustClass: "github-live",
      load: async () => ({ data: await assertCurrentHead() }),
    });
    if (!["hit", "coalesced"].includes(pullRequestSnapshot.cache)) {
      firstLiveHeadAssertion = pullRequestSnapshot.value;
    } else {
      // Exact-head state is authorization evidence. A fresh cache hit can
      // describe the PR, but it cannot authorize a review-thread mutation.
      await assertCurrentHead();
    }
  }
  const authoritativeHead = async () => {
    if (firstLiveHeadAssertion) {
      const value = firstLiveHeadAssertion;
      firstLiveHeadAssertion = null;
      return value;
    }
    return assertCurrentHead();
  };
  let reviewSnapshot = null;
  let firstLiveReadiness = null;
  if (snapshotCache && repository && Number.isInteger(prNumber) && prNumber > 0) {
    reviewSnapshot = await snapshotCache.getOrLoad({
      repository,
      kind: "review_threads",
      subject: `pr:${prNumber}`,
      headSha,
      trustClass: "github-live",
      load: async () => ({ data: await readReadiness() }),
    });
    // A miss/refresh is live evidence and may satisfy the first workflow read,
    // but only after a fresh exact-head assertion. A cache hit remains context
    // only and is never used to resolve a thread or publish a merge gate.
    if (!["hit", "coalesced"].includes(reviewSnapshot.cache)) {
      firstLiveReadiness = reviewSnapshot.value;
    }
  }
  const authoritativeReadiness = async () => {
    if (firstLiveReadiness) {
      const value = firstLiveReadiness;
      firstLiveReadiness = null;
      await authoritativeHead();
      return value;
    }
    return readReadiness();
  };
  let reviewResolution;
  try {
    reviewResolution = await reconcileApprovedReviewerBlockers({
      requestedEvent,
      submittedReviewState: result.state,
      expectedLogin,
      headSha,
      readReadiness: authoritativeReadiness,
      resolveThread,
      assertCurrentHead: authoritativeHead,
    });
  } catch (error) {
    let observedReadiness = null;
    try {
      await authoritativeHead();
      observedReadiness = await authoritativeReadiness();
    } catch {}
    reviewResolution = {
      attempted: true,
      complete: false,
      resolved: error.reviewResolution?.resolved || [],
      readiness: observedReadiness,
      error: {
        message: error.message,
        headSha: headSha.toLowerCase(),
        expectedLogin,
        completedThreadIds: error.reviewResolution?.completedThreadIds || [],
        pendingThreadIds: error.reviewResolution?.pendingThreadIds || [],
      },
    };
  }

  if (statusGate && reviewResolution.complete && reviewResolution.readiness?.ready && submittedEvent === "APPROVE") {
    try {
      await authoritativeHead();
      result.gate = await publishBoundReviewGate({
        ...statusGate,
        headSha,
        expectedLogin,
        reviewState: "APPROVE",
        reviewUrl: result.url,
      });
    } catch (error) {
      reviewResolution = {
        ...reviewResolution,
        complete: false,
        error: {
          message: `Reviewer-owned blockers converged, but exact-head gate publication is incomplete: ${error.message}`,
          headSha: headSha.toLowerCase(),
          expectedLogin,
          completedThreadIds: reviewResolution.resolved.map((entry) => entry.threadId),
          pendingThreadIds: [],
          stage: "gate_publication",
        },
      };
    }
  }
  return {
    result,
    submittedEvent,
    reviewResolution,
    reviewSnapshot: reviewSnapshot ? {
      cache: reviewSnapshot.cache,
      digest: reviewSnapshot.digest,
      authoritative: false,
      usableForAuthorization: false,
      degradation: reviewSnapshot.degradation || null,
    } : null,
    pullRequestSnapshot: pullRequestSnapshot ? {
      cache: pullRequestSnapshot.cache,
      digest: pullRequestSnapshot.digest,
      authoritative: false,
      usableForAuthorization: false,
      degradation: pullRequestSnapshot.degradation || null,
    } : null,
  };
}

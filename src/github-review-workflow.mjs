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
}) {
  const submittedEvent = approvedSubmissionEvent(result.state);
  let reviewResolution;
  try {
    reviewResolution = await reconcileApprovedReviewerBlockers({
      requestedEvent,
      submittedReviewState: result.state,
      expectedLogin,
      headSha,
      readReadiness,
      resolveThread,
      assertCurrentHead,
    });
  } catch (error) {
    let observedReadiness = null;
    try {
      await assertCurrentHead();
      observedReadiness = await readReadiness();
    } catch {}
    reviewResolution = {
      attempted: true,
      complete: false,
      resolved: [],
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
      await assertCurrentHead();
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
  return { result, submittedEvent, reviewResolution };
}

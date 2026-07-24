import { homedir } from "node:os";
import { resolve } from "node:path";

function normalizeBotLogin(login) {
  const normalized = (login || "").toLowerCase();
  return normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
}

function requireReviewerApp(client) {
  if (!client) {
    throw new Error("Review-thread access requires the configured reviewer GitHub App; PAT fallback is not authorized.");
  }
  return client;
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
  if (!/^[0-9a-f]{40}$/i.test(headSha || "")) {
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

export function createReviewerThreadController({ client, expectedLogin, getSubmittedEvent }) {
  if (!expectedLogin) throw new Error("expectedLogin is required.");
  if (typeof getSubmittedEvent !== "function") throw new Error("getSubmittedEvent is required.");

  return {
    async read() {
      return requireReviewerApp(client).reviewThreads();
    },

    async resolve({ threadId }) {
      const appClient = requireReviewerApp(client);
      if (getSubmittedEvent() !== "APPROVE") {
        throw new Error("The reviewer must submit its exact-head APPROVE review before resolving satisfied threads.");
      }
      const threads = await appClient.reviewThreads();
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error("Review thread is not part of the bound pull request.");
      const originalComment = thread.comments?.nodes?.[0];
      if (
        originalComment?.author?.__typename !== "Bot"
        || normalizeBotLogin(originalComment.author?.login) !== normalizeBotLogin(expectedLogin)
      ) {
        throw new Error("The reviewer App may resolve only a thread opened by that same reviewer identity.");
      }
      return appClient.resolveReviewThread({ threadId });
    },
  };
}

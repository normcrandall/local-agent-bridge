export function assertReviewWorkspaceHead({ expectedHeadSha, observedHeadSha }) {
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha || "")) throw new Error("Review authorization requires a full expected head SHA.");
  if (!/^[0-9a-f]{40}$/i.test(observedHeadSha || "")) throw new Error("Review workspace did not produce a full Git head SHA.");
  if (expectedHeadSha.toLowerCase() !== observedHeadSha.toLowerCase()) {
    throw new Error(`Review workspace head mismatch: authorized ${expectedHeadSha}, observed ${observedHeadSha}.`);
  }
  return true;
}

export async function resolveReviewPublication({
  agent,
  githubReview,
  configuredLogin,
  createCredential,
}) {
  if (!githubReview) return { available: true, binding: null, reason: null };
  try {
    const expectedLogin = githubReview.expectedLogins?.[agent]
      || githubReview.expectedLogin
      || await configuredLogin({ provider: agent });
    const { expectedLogins: _expectedLogins, ...authorization } = githubReview;
    const binding = { ...authorization, expectedLogin };
    const credential = await createCredential({
      role: "reviewer",
      reviewerProvider: agent,
      repository: binding.repository,
      expectedLogin,
    });
    return {
      available: true,
      binding: {
        ...binding,
        publishStatusGate: canPublishReviewStatus(credential.permissions),
      },
      reason: null,
      statusGateAvailable: canPublishReviewStatus(credential.permissions),
    };
  } catch (error) {
    return { available: false, binding: null, reason: error?.message || String(error) };
  }
}

export function orderReviewProbes({ probes, requestedStartAgent = null, githubReview = null }) {
  const providerAvailable = probes.filter((probe) => probe.available);
  if (!githubReview) {
    return {
      agents: providerAvailable.map((probe) => probe.agent),
      startAgent: providerAvailable.some((probe) => probe.agent === requestedStartAgent)
        ? requestedStartAgent
        : providerAvailable[0]?.agent || null,
      publication: null,
    };
  }
  const publishable = providerAvailable.filter((probe) => probe.reviewPublication?.available);
  const localOnly = providerAvailable.filter((probe) => !probe.reviewPublication?.available);
  const ordered = [...publishable, ...localOnly];
  const preferredPublishable = publishable.some((probe) => probe.agent === requestedStartAgent)
    ? requestedStartAgent
    : publishable[0]?.agent;
  const startAgent = preferredPublishable
    || (localOnly.some((probe) => probe.agent === requestedStartAgent) ? requestedStartAgent : localOnly[0]?.agent)
    || null;
  return {
    agents: ordered.map((probe) => probe.agent),
    startAgent,
    publication: {
      status: publishable.length === providerAvailable.length
        ? "available"
        : publishable.length ? "partial" : "degraded",
      publishableAgents: publishable.map((probe) => probe.agent),
      publishedAgents: [],
      localOnlyAgents: Object.fromEntries(localOnly.map((probe) => [
        probe.agent,
        probe.reviewPublication?.reason || "review publication is unavailable",
      ])),
      humanApprovalRequired: publishable.length === 0,
    },
  };
}

export function recordReviewPublicationResult(publication, {
  agent,
  published = false,
  unavailableReason = null,
} = {}) {
  if (!publication || !agent) return publication;
  const publishableAgents = (publication.publishableAgents || []).filter((candidate) => (
    candidate !== agent || !unavailableReason
  ));
  const publishedAgents = [...new Set([
    ...(publication.publishedAgents || []),
    ...(published ? [agent] : []),
  ])];
  const unavailableAgents = { ...(publication.unavailableAgents || {}) };
  if (unavailableReason) unavailableAgents[agent] = unavailableReason;
  const localOnlyAgents = { ...(publication.localOnlyAgents || {}) };
  if (unavailableReason) delete localOnlyAgents[agent];
  const hasPublicationPath = publishedAgents.length > 0 || publishableAgents.length > 0;
  return {
    ...publication,
    status: hasPublicationPath
      ? (Object.keys(localOnlyAgents).length || Object.keys(unavailableAgents).length
        ? "partial"
        : "available")
      : "degraded",
    publishableAgents,
    publishedAgents,
    localOnlyAgents,
    unavailableAgents,
    humanApprovalRequired: !hasPublicationPath,
  };
}

// A publication failure is recoverable when it reflects a transient filesystem
// or transport condition rather than a policy, identity, or authorization
// rejection. Recoverable failures may be retried against the already-validated
// envelope; policy rejections must surface immediately.
export function isRecoverablePublicationError(error) {
  const message = error?.message || String(error);
  if (/identity|mismatch|permission|not authorized|forbidden|denied|PAT fallback|head changed|not in the pull request/i.test(message)) {
    return false;
  }
  return /ENOENT|no such file|not a directory|EEXIST|transport closed|connection closed|socket hang up|ECONNRESET|ETIMEDOUT|timed out|network/i.test(message);
}

// Publish an already-validated Antigravity review envelope, retrying the
// publication path on recoverable errors WITHOUT re-running the provider. The
// envelope is parsed and validated once by the caller; only `publish` (mkdir +
// write_handoff + submit_pr_review) is re-attempted.
export async function republishValidatedReview({ envelope, publish, attempts = 2 }) {
  if (!envelope) throw new Error("republishValidatedReview requires an already-validated review envelope.");
  if (typeof publish !== "function") throw new Error("republishValidatedReview requires a publish function.");
  const maxAttempts = Math.max(1, attempts);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await publish(envelope, attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRecoverablePublicationError(error)) throw error;
    }
  }
  throw lastError;
}

export function localReviewPrompt(prompt, reason) {
  return `${prompt}\n\nREVIEW PUBLICATION DEGRADED: ${reason} Complete the independent review and durable handoff, but do not claim that a formal GitHub review or agent-review status was published. A configured trusted human must approve the exact head before merge. Continue the review instead of stopping solely because the reviewer App is unavailable.`;
}
import { canPublishReviewStatus } from "./github-app-auth.mjs";

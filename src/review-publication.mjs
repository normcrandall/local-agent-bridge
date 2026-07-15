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
    await createCredential({
      role: "reviewer",
      reviewerProvider: agent,
      repository: binding.repository,
      expectedLogin,
    });
    return { available: true, binding, reason: null };
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
      localOnlyAgents: Object.fromEntries(localOnly.map((probe) => [
        probe.agent,
        probe.reviewPublication?.reason || "review publication is unavailable",
      ])),
      humanApprovalRequired: publishable.length === 0,
    },
  };
}

export function localReviewPrompt(prompt, reason) {
  return `${prompt}\n\nREVIEW PUBLICATION DEGRADED: ${reason} Complete the independent review and durable handoff, but do not claim that a formal GitHub review or agent-review status was published. A configured trusted human must approve the exact head before merge. Continue the review instead of stopping solely because the reviewer App is unavailable.`;
}

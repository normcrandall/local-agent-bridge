import { createInstallationToken, inspectGitHubAppRoles } from "./github-app-auth.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { resolveDeliveryPolicy } from "./delivery-policy.mjs";

export function repositoryMatchesPolicy(repository, patterns = []) {
  const normalized = repository.toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.toLowerCase();
    return candidate.endsWith("/*")
      ? normalized.startsWith(candidate.slice(0, -1))
      : normalized === candidate;
  });
}

export async function mergePullRequestWithBuilder({
  repository,
  prNumber,
  headSha,
  issueNumber = null,
  method = "squash",
  workspace = process.cwd(),
  createCredential = createInstallationToken,
  inspectRoles = inspectGitHubAppRoles,
  resolvePolicy = resolveDeliveryPolicy,
  clientFactory = createBoundBuilderClient,
}) {
  const appRoles = await inspectRoles();
  const deliveryPolicy = await resolvePolicy({ workspace });
  if (deliveryPolicy.deliveryProfile !== "github-governed") {
    throw new Error(`Autonomous GitHub merge is disabled by the ${deliveryPolicy.deliveryProfile} delivery profile.`);
  }
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("GitHub-governed merge requires the immutable issue number from the delivery lane; PR prose is not an authority source.");
  }
  const authorizedRepositories = deliveryPolicy.identities.autonomousMergeRepositories;
  if (!repositoryMatchesPolicy(repository, authorizedRepositories)) {
    throw new Error(
      `Autonomous merge is not authorized for ${repository}; add it or its owner wildcard to mergePolicy.autonomousMergeRepositories.`,
    );
  }

  const credential = await createCredential({ role: "builder", repository });
  const trustedReviewLogins = [
    appRoles.roles?.reviewer?.expectedLogin,
    ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.expectedLogin),
  ].filter(Boolean);
  const trustedReviewAppIds = [
    appRoles.roles?.reviewer?.appId,
    ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.appId),
  ].filter(Boolean).map(Number);
  const trustedWriterLogins = Object.values(appRoles.roles?.writers || {})
    .map((writer) => writer.expectedLogin)
    .filter(Boolean);
  const builder = clientFactory({
    repository,
    prNumber,
    issueNumber,
    headSha,
    expectedLogin: credential.expectedLogin,
    token: credential.token,
    verifiedLogin: credential.verifiedLogin,
    allowedOperations: ["merge"],
    requiredReviewStatusContext: "agent-review",
    trustedReviewLogins,
    trustedReviewAppIds,
    trustedWriterLogins,
    trustedHumanReviewLogins: appRoles.mergePolicy?.trustedHumanReviewers || [],
    mergeEnforcement: deliveryPolicy.decisions.configuredMergeEnforcement.value,
  });
  return builder.merge({ method });
}

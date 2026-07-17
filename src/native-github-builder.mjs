import { createInstallationToken, inspectGitHubAppRoles } from "./github-app-auth.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";

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
  method = "squash",
  createCredential = createInstallationToken,
  inspectRoles = inspectGitHubAppRoles,
  clientFactory = createBoundBuilderClient,
}) {
  const appRoles = await inspectRoles();
  const authorizedRepositories = appRoles.mergePolicy?.autonomousMergeRepositories || [];
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
  const builder = clientFactory({
    repository,
    prNumber,
    headSha,
    expectedLogin: credential.expectedLogin,
    token: credential.token,
    verifiedLogin: credential.verifiedLogin,
    allowedOperations: ["merge"],
    requiredReviewStatusContext: "agent-review",
    trustedReviewLogins,
    trustedReviewAppIds,
    trustedHumanReviewLogins: appRoles.mergePolicy?.trustedHumanReviewers || [],
    mergeEnforcement: appRoles.github?.mergeEnforcement || "broker",
  });
  return builder.merge({ method });
}

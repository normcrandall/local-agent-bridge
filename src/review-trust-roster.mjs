import { configuredTrustedWriterLogins } from "./github-review-threads.mjs";

export const REVIEW_TRUST_ROSTER_SOURCE = "github-app-roles";

// This diagnostic deliberately does not preserve the thrown error. GitHub App
// inspection errors can contain configuration or private-key paths; operators
// need the failure class, not secret-bearing filesystem details.
export function sanitizedRosterInspectionReason() {
  return "GitHub App writer-role inspection failed; configuration or installed runtime may be stale or malformed";
}

export async function inspectReviewTrustRoster({
  repository,
  configPath,
  expectedReviewerLogin,
  inspectRoles,
  loadBuilderRole,
}) {
  let appRoles;
  try {
    appRoles = await inspectRoles({ configPath });
  } catch {
    return {
      builderRole: null,
      trustedReviewerLogins: [expectedReviewerLogin].filter(Boolean),
      trustedWriterLogins: [],
      evidence: {
        source: REVIEW_TRUST_ROSTER_SOURCE,
        configuredWriterLogins: [],
        degraded: true,
        reason: sanitizedRosterInspectionReason(),
      },
    };
  }
  const trustedReviewerLogins = [...new Set([
    expectedReviewerLogin,
    appRoles.roles?.reviewer?.expectedLogin,
    ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.expectedLogin),
  ].filter(Boolean))];
  const configuredProviderWriters = configuredTrustedWriterLogins({ appRoles });
  try {
    const builderRole = await loadBuilderRole({
      role: "builder",
      repository,
      configPath,
    });
    const configuredWriterLogins = configuredTrustedWriterLogins({ appRoles, builderRole });
    return {
      builderRole,
      trustedReviewerLogins,
      trustedWriterLogins: configuredWriterLogins,
      evidence: {
        source: REVIEW_TRUST_ROSTER_SOURCE,
        configuredWriterLogins,
        degraded: false,
        reason: null,
      },
    };
  } catch {
    return {
      builderRole: null,
      trustedReviewerLogins,
      trustedWriterLogins: [],
      evidence: {
        source: REVIEW_TRUST_ROSTER_SOURCE,
        configuredWriterLogins: configuredProviderWriters,
        degraded: true,
        reason: sanitizedRosterInspectionReason(),
      },
    };
  }
}

#!/usr/bin/env node

import {
  canPublishReviewStatus,
  createInstallationToken,
  inspectGitHubAppRoles,
} from "../src/github-app-auth.mjs";
import {
  inspectGitHubMergeCapabilities,
  parseGitHubVerificationArguments,
  resolveGitHubMergeEnforcement,
} from "../src/github-merge-enforcement.mjs";

const argv = process.argv.slice(2);
let parsedArguments;
try {
  parsedArguments = parseGitHubVerificationArguments(argv);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { repository, branch: requestedBranch, json: jsonMode } = parsedArguments;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
  console.error("Usage: npm run github-app:verify -- OWNER/REPO [--branch NAME] [--json]");
  process.exit(2);
}

async function githubJson(token, path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "local-agent-bridge",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${payload.message || "GitHub request failed"}`);
  return payload;
}

const roles = [
  { label: "builder", role: "builder" },
  ...["claude", "codex", "antigravity"].map((reviewerProvider) => ({
    label: `reviewer:${reviewerProvider}`,
    role: "reviewer",
    reviewerProvider,
  })),
];
let failed = false;
const report = { version: 1, repository, roles: { reviewers: {} }, enforcement: null };
const reviewerAppIds = [];
let builderCredential = null;
for (const entry of roles) {
  try {
    const credential = await createInstallationToken({
      role: entry.role,
      reviewerProvider: entry.reviewerProvider,
      repository,
    });
    const operations = entry.role === "builder"
      ? ["create_branch", "push_branch", "ensure_pull_request", "merge"]
      : ["submit_review", ...(canPublishReviewStatus(credential.permissions) ? ["publish_status"] : [])];
    const observed = {
      repository,
      login: credential.expectedLogin,
      appId: Number(credential.appId),
      permissions: credential.permissions,
      operations,
    };
    if (entry.role === "builder") {
      builderCredential = credential;
      report.roles.builder = observed;
    } else {
      report.roles.reviewers[entry.reviewerProvider] = observed;
      reviewerAppIds.push(Number(credential.appId));
    }
    if (!jsonMode) console.log(`OK   ${entry.label} as ${credential.expectedLogin}`);
    if (entry.role === "reviewer" && !canPublishReviewStatus(credential.permissions)) {
      if (!jsonMode) console.log(`WARN ${entry.label}: formal reviews are enabled; agent-review status publication is unavailable (statuses:write).`);
    }
  } catch (error) {
    failed = true;
    if (!jsonMode) console.error(`FAIL ${entry.label}: ${error.message}`);
  }
}

try {
  const configured = await inspectGitHubAppRoles();
  let branch = requestedBranch;
  let rules = [];
  let branchProtection = null;
  const evidenceErrors = [];
  if (builderCredential) {
    if (!branch) {
      const repositoryInfo = await githubJson(builderCredential.token, `/repos/${repository}`);
      branch = repositoryInfo.default_branch;
    }
    const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
    try {
      rules = await githubJson(builderCredential.token, `/repos/${repository}/rules/branches/${encodedBranch}`);
    } catch (error) {
      evidenceErrors.push(`organization ruleset evidence unavailable: ${error.message}`);
    }
    try {
      branchProtection = await githubJson(builderCredential.token, `/repos/${repository}/branches/${encodedBranch}/protection`);
    } catch (error) {
      evidenceErrors.push(`branch protection evidence unavailable: ${error.message}`);
    }
  } else {
    evidenceErrors.push("builder App credential unavailable");
  }
  const capabilities = inspectGitHubMergeCapabilities({
    rules,
    branchProtection,
    trustedAppIds: reviewerAppIds,
    context: "agent-review",
  });
  const policy = resolveGitHubMergeEnforcement({
    configuredMode: configured.github?.mergeEnforcement || "broker",
    capabilities,
  });
  report.enforcement = { branch, ...capabilities, policy, evidenceErrors };
  if (policy.blocked) failed = true;
  if (!jsonMode) {
    const level = policy.blocked ? "FAIL" : policy.downgraded ? "WARN" : "OK  ";
    console.log(`${level} enforcement configured=${policy.configuredMode} effective=${policy.effectiveMode || "blocked"} source=${policy.verificationSource}`);
    for (const error of evidenceErrors) console.log(`WARN enforcement: ${error}`);
  }
} catch (error) {
  failed = true;
  report.enforcement = { error: error.message };
  if (!jsonMode) console.error(`FAIL enforcement: ${error.message}`);
}

if (jsonMode) console.log(JSON.stringify(report, null, 2));
if (failed) process.exit(1);

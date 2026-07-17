#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  inspectGitHubMergeCapabilities,
  parseGitHubVerificationArguments,
  resolveGitHubMergeEnforcement,
} from "../src/github-merge-enforcement.mjs";

const defaultPolicy = resolveGitHubMergeEnforcement();
assert.deepEqual(defaultPolicy, {
  configuredMode: "broker",
  effectiveMode: "broker",
  verified: true,
  blocked: false,
  downgraded: false,
  verificationSource: "local-broker-policy",
  reason: "The bridge enforces exact-head review and merge authorization locally.",
});

for (const configuredMode of ["branch-protection", "organization-ruleset"]) {
  const explicitUnavailable = resolveGitHubMergeEnforcement({ configuredMode });
  assert.equal(explicitUnavailable.configuredMode, configuredMode);
  assert.equal(explicitUnavailable.effectiveMode, null);
  assert.equal(explicitUnavailable.verified, false);
  assert.equal(explicitUnavailable.blocked, true);
  assert.equal(explicitUnavailable.downgraded, false);
  assert.equal(explicitUnavailable.verificationSource, "unverified");
  assert.match(explicitUnavailable.reason, new RegExp(`${configuredMode}.*not verified`, "i"));
}

const capabilities = {
  branchProtection: { verified: true, source: "github-api:branch-protection" },
  organizationRuleset: { verified: true, source: "github-api:organization-ruleset" },
};
const explicitRuleset = resolveGitHubMergeEnforcement({
  configuredMode: "organization-ruleset",
  capabilities,
});
assert.equal(explicitRuleset.effectiveMode, "organization-ruleset");
assert.equal(explicitRuleset.verificationSource, "github-api:organization-ruleset");
assert.equal(explicitRuleset.blocked, false);

const autoRuleset = resolveGitHubMergeEnforcement({ configuredMode: "auto", capabilities });
assert.equal(autoRuleset.effectiveMode, "organization-ruleset");
assert.equal(autoRuleset.downgraded, false);

const autoBranchProtection = resolveGitHubMergeEnforcement({
  configuredMode: "auto",
  capabilities: { branchProtection: capabilities.branchProtection },
});
assert.equal(autoBranchProtection.effectiveMode, "branch-protection");
assert.equal(autoBranchProtection.downgraded, true);
assert.match(autoBranchProtection.reason, /strongest verified/i);

const autoBroker = resolveGitHubMergeEnforcement({ configuredMode: "auto" });
assert.equal(autoBroker.effectiveMode, "broker");
assert.equal(autoBroker.blocked, false);
assert.equal(autoBroker.downgraded, true);
assert.match(autoBroker.reason, /no GitHub-enforced merge gate was verified/i);

assert.throws(
  () => resolveGitHubMergeEnforcement({ configuredMode: "paid" }),
  /github\.mergeEnforcement must be one of/,
);

const detected = inspectGitHubMergeCapabilities({
  context: "agent-review",
  trustedAppIds: [101, "202"],
  rules: [
    {
      type: "required_status_checks",
      ruleset_source_type: "Organization",
      ruleset_source: "example-org",
      ruleset_id: 77,
      parameters: {
        required_status_checks: [{ context: "agent-review", integration_id: 202 }],
      },
    },
  ],
  branchProtection: {
    required_status_checks: {
      checks: [{ context: "agent-review", app_id: 101 }],
    },
  },
});
assert.deepEqual(detected.organizationRuleset, {
  verified: true,
  source: "github-api:organization-ruleset/77",
  reason: "Organization ruleset 77 requires agent-review from trusted GitHub App 202.",
});
assert.deepEqual(detected.branchProtection, {
  verified: true,
  source: "github-api:branch-protection",
  reason: "Branch protection requires agent-review from trusted GitHub App 101.",
});

const unbound = inspectGitHubMergeCapabilities({
  context: "agent-review",
  trustedAppIds: [101],
  rules: [{
    type: "required_status_checks",
    ruleset_source_type: "Organization",
    ruleset_id: 88,
    parameters: { required_status_checks: [{ context: "agent-review", integration_id: 999 }] },
  }],
  branchProtection: {
    required_status_checks: { checks: [{ context: "agent-review", app_id: -1 }] },
  },
});
assert.equal(unbound.organizationRuleset.verified, false);
assert.equal(unbound.branchProtection.verified, false);
assert.match(unbound.organizationRuleset.reason, /trusted reviewer App/i);

assert.deepEqual(
  parseGitHubVerificationArguments(["owner/repo", "--json"]),
  { repository: "owner/repo", branch: null, json: true },
);
assert.deepEqual(
  parseGitHubVerificationArguments(["--json", "owner/repo", "--branch", "release/next"]),
  { repository: "owner/repo", branch: "release/next", json: true },
);
assert.throws(
  () => parseGitHubVerificationArguments(["owner/repo", "--branch"]),
  /--branch requires a branch name/,
);

console.log("GitHub merge enforcement tests passed.");

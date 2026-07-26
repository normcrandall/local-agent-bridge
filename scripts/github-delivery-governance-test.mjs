import assert from "node:assert/strict";
import {
  assertGithubGovernedWorkStart,
  deliveryIssueSummary,
  governedContinuationBuilder,
  mergedDeliverySummary,
  validateGithubGovernedPullRequest,
} from "../src/github-delivery-governance.mjs";

const sha = "a".repeat(40);
const mergedSha = "b".repeat(40);
const governedPolicy = {
  deliveryProfile: "github-governed",
  decisions: { deliveryProfile: { source: "machine_default" } },
};
const localPolicy = {
  deliveryProfile: "local-only",
  decisions: { deliveryProfile: { source: "per_run_narrowing" } },
};

assert.throws(
  () => assertGithubGovernedWorkStart({ policy: governedPolicy, mode: "work" }),
  /hydrated GitHub issueTarget or issueClaim/,
);
assert.throws(
  () => assertGithubGovernedWorkStart({
    policy: governedPolicy,
    mode: "work",
    issueTarget: { repository: "owner/repo", issueNumber: 152 },
    issueContext: { issue: { number: 152 } },
  }),
  /bound githubBuilder/,
);
const contract = assertGithubGovernedWorkStart({
  policy: governedPolicy,
  mode: "work",
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
  issueContext: { issue: { number: 152 } },
  githubBuilder: { repository: "owner/repo", headSha: sha },
  worktree: { strategy: "self-contained" },
});
assert.equal(contract.prOnly, true);
assert.equal(contract.issueUrl, "https://github.com/owner/repo/issues/152");
assert.throws(() => assertGithubGovernedWorkStart({
  policy: governedPolicy,
  mode: "work",
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
  issueContext: { issue: { number: 152 } },
  githubBuilder: { repository: "owner/repo", headSha: sha },
}), /self-contained/);

const continuedBuilder = governedContinuationBuilder({
  deliveryPolicy: { profile: "github-governed" },
  currentBuilder: { repository: "owner/repo", issueNumber: 152, headRef: "codex/152", baseRef: "main", headSha: sha },
  replacementBuilder: { repository: "owner/repo", headRef: "codex/152", baseRef: "main", headSha: mergedSha, prNumber: 175 },
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
});
assert.equal(continuedBuilder.issueNumber, 152);
assert.equal(continuedBuilder.headSha, mergedSha);
assert.throws(() => governedContinuationBuilder({
  deliveryPolicy: { profile: "github-governed" },
  currentBuilder: { repository: "owner/repo", headRef: "codex/152", baseRef: "main" },
  replacementBuilder: { repository: "other/repo", headRef: "codex/152", baseRef: "main" },
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
}), /cannot change/);
assert.throws(() => governedContinuationBuilder({
  deliveryPolicy: { profile: "github-governed" },
  currentBuilder: { repository: "owner/repo", issueNumber: 152, headRef: "codex/152", baseRef: "main" },
  replacementBuilder: { repository: "owner/repo", issueNumber: 153, headRef: "codex/152", baseRef: "main" },
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
}), /issue target/);
assert.throws(() => governedContinuationBuilder({
  deliveryPolicy: { profile: "github-governed" },
  currentBuilder: { repository: "owner/repo", issueNumber: 152, prNumber: 175, headRef: "codex/152", baseRef: "main" },
  replacementBuilder: { repository: "owner/repo", issueNumber: 152, prNumber: 176, headRef: "codex/152", baseRef: "main" },
  issueTarget: { repository: "owner/repo", issueNumber: 152 },
}), /bound pull request/);
assert.throws(() => governedContinuationBuilder({
  deliveryPolicy: { profile: "local-only" },
  replacementBuilder: { repository: "owner/repo", issueNumber: 152 },
}), /Local-only continuation/);

assert.throws(
  () => assertGithubGovernedWorkStart({ policy: localPolicy, mode: "work" }),
  /explicit deliveryProfile=local-only/,
);
assert.deepEqual(
  assertGithubGovernedWorkStart({ policy: localPolicy, requestedProfile: "local-only", mode: "work" }),
  { profile: "local-only", governed: false, explicit: true },
);

const body = `Closes #152

## Outcome
The delivery profile is enforced by runtime code.

## Scope
Collaboration start, publication, merge receipts, and portfolio receipts.

## Verification
\`npm run test:delivery-policy\` and \`npm run test:collaboration\` passed.

## Follow-ups
https://github.com/owner/repo/issues/154
`;
const receipt = validateGithubGovernedPullRequest({ repository: "owner/repo", issueNumber: 152, body, headSha: sha });
assert.equal(receipt.issueNumber, 152);
assert.deepEqual(receipt.followUpIssues, ["https://github.com/owner/repo/issues/154"]);
assert.match(deliveryIssueSummary(receipt, { prNumber: 175, prUrl: "https://github.com/owner/repo/pull/175" }), /Exact published head/);
assert.match(mergedDeliverySummary({ prNumber: 175, prUrl: "https://github.com/owner/repo/pull/175", headSha: sha, mergedSha }), new RegExp(mergedSha));

for (const invalid of [
  body.replace("Closes #152", "Relates to a ticket"),
  body.replace("Closes #152", "https://github.com/owner/repo/issues/152"),
  body.replace("## Scope", "## Details"),
  body.replace("`npm run test:delivery-policy` and `npm run test:collaboration` passed.", "Not run"),
  body.replace("https://github.com/owner/repo/issues/154", "Refactor this later"),
]) {
  assert.throws(() => validateGithubGovernedPullRequest({ repository: "owner/repo", issueNumber: 152, body: invalid, headSha: sha }));
}

console.log("GitHub-governed delivery contract tests passed.");

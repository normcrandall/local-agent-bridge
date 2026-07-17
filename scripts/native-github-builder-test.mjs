import assert from "node:assert/strict";
import { mergePullRequestWithBuilder, repositoryMatchesPolicy } from "../src/native-github-builder.mjs";

assert.equal(repositoryMatchesPolicy("normcrandall/thriftybite", ["normcrandall/*"]), true);
assert.equal(repositoryMatchesPolicy("veliqon/product", ["veliqon/product"]), true);
assert.equal(repositoryMatchesPolicy("other/product", ["veliqon/*"]), false);

const calls = [];
const receipt = await mergePullRequestWithBuilder({
  repository: "normcrandall/thriftybite",
  prNumber: 220,
  headSha: "a".repeat(40),
  method: "squash",
  inspectRoles: async () => ({
    mergePolicy: {
      autonomousMergeRepositories: ["normcrandall/*"],
      trustedHumanReviewers: ["owner"],
    },
    github: { mergeEnforcement: "auto" },
    roles: {
      reviewers: {
        claude: { appId: "654321", expectedLogin: "claude-reviewer[bot]" },
      },
    },
  }),
  createCredential: async (input) => {
    calls.push(input);
    return { token: "token", expectedLogin: "builder[bot]", verifiedLogin: "builder[bot]" };
  },
  clientFactory: (input) => {
    calls.push(input);
    return { merge: async (mergeInput) => ({ operation: "merge", ...mergeInput }) };
  },
});
assert.equal(receipt.operation, "merge");
assert.equal(receipt.method, "squash");
assert.deepEqual(calls[0], { role: "builder", repository: "normcrandall/thriftybite" });
assert.deepEqual(calls[1].allowedOperations, ["merge"]);
assert.deepEqual(calls[1].trustedReviewLogins, ["claude-reviewer[bot]"]);
assert.deepEqual(calls[1].trustedReviewAppIds, [654321]);
assert.equal(calls[1].mergeEnforcement, "auto");

await assert.rejects(
  mergePullRequestWithBuilder({
    repository: "other/product",
    prNumber: 1,
    headSha: "b".repeat(40),
    inspectRoles: async () => ({ mergePolicy: { autonomousMergeRepositories: ["veliqon/*"] } }),
  }),
  /Autonomous merge is not authorized/,
);

console.log("Native GitHub builder tests passed: machine-local policy and exact-head App merge routing.");

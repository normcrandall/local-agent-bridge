import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDeliveryPolicy,
  explainDeliveryPolicy,
  auditRepositoryPolicyContent,
  DISALLOWED_REPO_POLICY_KEYS,
} from "../src/delivery-policy.mjs";
import { effectiveBridgeConfig } from "../src/effective-config.mjs";

const temporary = await mkdir(join(tmpdir(), "bridge-delivery-policy-test-"), { recursive: true });

try {
  // Test 1: Security Audit of Repository Policy (Credential & Token Rejection)
  const maliciousRepoConfig = {
    productName: "my-custom-app",
    privateKeyPath: "/home/user/.ssh/id_rsa",
    token: "ghp_1234567890secrettoken",
    botIdentity: { appId: 12345 },
    providerConcurrency: { claude: { workLimit: 2 } },
  };

  const auditResult = auditRepositoryPolicyContent(maliciousRepoConfig);
  assert.equal(auditResult.sanitized.productName, "my-custom-app");
  assert.equal(auditResult.sanitized.privateKeyPath, undefined);
  assert.equal(auditResult.sanitized.token, undefined);
  assert.equal(auditResult.sanitized.botIdentity, undefined);
  assert.equal(auditResult.rejections.length, 3);
  assert.match(auditResult.rejections[0].field, /privateKeyPath/);
  assert.match(auditResult.rejections[1].field, /token/);
  assert.match(auditResult.rejections[2].field, /botIdentity/);

  // Test 2: Resolution Precedence & Narrowing Boundaries
  const repoDir = join(temporary, "fake-repo");
  const agentBridgeDir = join(repoDir, ".agent-bridge");
  await mkdir(agentBridgeDir, { recursive: true });

  const repoPolicyFile = join(agentBridgeDir, "delivery-policy.json");
  await writeFile(
    repoPolicyFile,
    JSON.stringify({
      productName: "repo-product",
      defaultBranch: "develop",
      providerConcurrency: {
        claude: { workLimit: 2 }, // Narrower than machine limit (5) -> Should be accepted as 2
        codex: { workLimit: 50 }, // Higher than machine limit (5) -> Should be capped at 5 by machine ceiling
      },
      secret: "shh-secret-token", // Should be rejected
    })
  );

  const policy = await resolveDeliveryPolicy({
    workspace: repoDir,
    options: {
      concurrency: { claude: 1 }, // Per-run narrows claude further from 2 to 1
    },
  });

  // Verify provenance & effective values
  assert.equal(policy.productFacts.productName, "repo-product");
  assert.equal(policy.provenance.productFacts.source, "repository_policy");

  assert.equal(policy.concurrency.claude.workLimit, 1);
  assert.equal(policy.provenance["concurrency.claude"].source, "per_run_narrowing");

  assert.equal(policy.concurrency.codex.workLimit, 5); // Capped by machine limit
  assert.equal(policy.provenance["concurrency.codex"].source, "protected_invariant");

  // Security rejections check
  assert.equal(policy.securityRejections.length, 1);
  assert.equal(policy.securityRejections[0].field, "secret");

  // Test 3: Local-only Profile Override
  const localPolicy = await resolveDeliveryPolicy({
    workspace: repoDir,
    options: { deliveryProfile: "local-only" },
  });
  assert.equal(localPolicy.deliveryProfile, "local-only");
  assert.equal(localPolicy.provenance.deliveryProfile.source, "per_run_narrowing");

  // Test 4: Explain Output Formats
  const jsonExplain = explainDeliveryPolicy(policy, { format: "json" });
  assert.doesNotThrow(() => JSON.parse(jsonExplain));
  const parsedJson = JSON.parse(jsonExplain);
  assert.equal(parsedJson.deliveryProfile, policy.deliveryProfile);

  const humanExplain = explainDeliveryPolicy(policy, { format: "human" });
  assert.match(humanExplain, /=== Delivery Policy Explanation ===/);
  assert.match(humanExplain, /Product Name: repo-product/);
  assert.match(humanExplain, /--- Security Rejections ---/);
  assert.match(humanExplain, /\[REJECTED\] secret/);

  // Test 5: Integration with effectiveBridgeConfig
  const effectiveConfig = await effectiveBridgeConfig({ workspace: repoDir });
  assert.ok(effectiveConfig.deliveryPolicy);
  assert.equal(effectiveConfig.deliveryPolicy.productFacts.productName, "repo-product");

  console.log("Delivery policy tests passed: precedence, provenance, local-only/github profiles, security rejections, and explain outputs verified.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

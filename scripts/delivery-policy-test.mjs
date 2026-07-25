import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PRECEDENCE_LEVELS,
  auditRepositoryPolicyContent,
  deliveryPolicyExplainDocument,
  deliveryPolicyForSurface,
  explainDeliveryPolicy,
  resolveDeliveryPolicy,
  sensitiveKeyReason,
} from "../src/delivery-policy.mjs";
import { effectiveBridgeConfig } from "../src/effective-config.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(resolve(tmpdir(), "bridge-delivery-policy-"));

/** Build an isolated machine layer so the suite never reads the developer's own config. */
async function machineLayer(name, { apps = true, concurrency = {}, disabledModels = {} } = {}) {
  const home = resolve(temporary, name, "home");
  const configDir = resolve(home, ".config/local-agent-bridge");
  await mkdir(configDir, { recursive: true });

  const modelPolicyPath = resolve(configDir, "model-policy.json");
  await writeFile(modelPolicyPath, JSON.stringify({
    version: 1,
    providers: Object.fromEntries(Object.entries(disabledModels).map(([provider, models]) => [provider, { disabledModels: models }])),
  }));

  const concurrencyPath = resolve(configDir, "provider-concurrency.json");
  await writeFile(concurrencyPath, JSON.stringify({ version: 1, providers: concurrency }));

  const appsPath = resolve(configDir, "github-apps.json");
  if (apps) {
    const keyPath = resolve(configDir, "builder.pem");
    await writeFile(keyPath, "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n");
    await chmod(keyPath, 0o600);
    await writeFile(appsPath, JSON.stringify({
      version: 1,
      mergePolicy: { trustedHumanReviewers: ["a-human"], autonomousMergeRepositories: ["owner/*"] },
      roles: {
        builder: { appId: "1", expectedLogin: "test-builder[bot]", privateKeyPath: keyPath, installations: { owner: 1 } },
        reviewers: {
          claude: { appId: "2", expectedLogin: "test-reviewer[bot]", privateKeyPath: keyPath, installations: { owner: 2 } },
        },
      },
    }));
  }

  return {
    home,
    environment: {
      AGENT_BRIDGE_MODEL_POLICY_CONFIG: modelPolicyPath,
      AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG: concurrencyPath,
      AGENT_BRIDGE_GITHUB_APPS_CONFIG: appsPath,
    },
  };
}

async function repositoryWorkspace(name, policy, recipe) {
  const workspace = resolve(temporary, name, "repo");
  await mkdir(resolve(workspace, ".agent-bridge"), { recursive: true });
  if (policy) {
    await writeFile(resolve(workspace, ".agent-bridge/delivery-policy.json"), JSON.stringify(policy, null, 2));
  }
  if (recipe) {
    await writeFile(resolve(workspace, ".agent-bridge/workspace-recipes.json"), JSON.stringify(recipe, null, 2));
  }
  return workspace;
}

const rejectionFor = (policy, field) => policy.rejections.find((entry) => entry.field === field);

try {
  // --- Credential, token, and bot-identity rejection ------------------------
  assert.ok(sensitiveKeyReason("privateKeyPath"));
  assert.ok(sensitiveKeyReason("GITHUB_TOKEN"));
  assert.ok(sensitiveKeyReason("client_secret"));
  assert.ok(sensitiveKeyReason("appId"));
  assert.ok(sensitiveKeyReason("installationId"));
  assert.ok(sensitiveKeyReason("expectedLogin"));
  // Domain terms that merely read as sensitive must survive.
  assert.equal(sensitiveKeyReason("tokenBudget"), null);
  assert.equal(sensitiveKeyReason("defaultBranch"), null);

  const audit = auditRepositoryPolicyContent({
    productFacts: { productName: "widget", defaultBranch: "trunk" },
    privateKeyPath: "~/keys/app.pem",
    token: "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
    roles: { builder: { appId: "1" } },
    reviewerHint: "someone-else-builder[bot]",
    inlineKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  });
  assert.equal(audit.sanitized.productFacts.productName, "widget");
  assert.equal(audit.sanitized.privateKeyPath, undefined);
  assert.equal(audit.sanitized.token, undefined);
  assert.equal(audit.sanitized.roles.builder.appId, undefined);
  // A maintainer-specific bot login is rejected even under an innocuous key name.
  assert.equal(audit.sanitized.reviewerHint, undefined);
  assert.equal(audit.sanitized.inlineKey, undefined);
  assert.equal(audit.rejections.length, 5);

  // --- Precedence, narrowing, and provenance --------------------------------
  const governed = await machineLayer("governed", {
    concurrency: { claude: { work: 4, review: 8 }, codex: { work: 5, review: 10 } },
    disabledModels: { claude: ["claude-fable-5"] },
  });
  const workspace = await repositoryWorkspace("governed", {
    version: 1,
    productFacts: { productName: "repo-product", defaultBranch: "develop", labels: ["autonomously-built"] },
    lifecycleMappings: { claimLabel: "in-progress", prTitlePrefixes: { feat: "feat:" } },
    verificationRoles: { requiredGates: ["npm run smoke"], reviewerRoles: ["codex"] },
    pathRules: { protectedPaths: ["docs/generated/**"] },
    resourceRules: { maxParallelLanes: 3 },
    providerConcurrency: {
      claude: { work: 2 },   // narrower than the machine ceiling of 4
      codex: { work: 50 },   // broadening attempt: must be ignored
    },
    deniedModels: { claude: ["claude-haiku-4-5-20251001"] },
    // Machine-owned domains a repository may never author.
    identities: { builder: "someone" },
    privateKeyPath: "/tmp/app.pem",
  }, {
    version: 1,
    phases: { preRetire: ["echo retire"] },
  });

  const policy = await resolveDeliveryPolicy({
    workspace,
    home: governed.home,
    environment: governed.environment,
    options: { providerConcurrency: { claude: 1 } },
  });

  assert.equal(policy.deliveryProfile, "github-governed");
  assert.equal(policy.decisions.deliveryProfile.source, "machine_default");

  // Repository owns product facts and lifecycle mappings, with provenance.
  assert.equal(policy.productFacts.productName, "repo-product");
  assert.equal(policy.productFacts.defaultBranch, "develop");
  assert.equal(policy.decisions.productFacts.source, "repository_policy");
  assert.equal(policy.lifecycleMappings.claimLabel, "in-progress");
  // An unmentioned field keeps its default rather than being blanked out.
  assert.equal(policy.lifecycleMappings.branchPrefix, null);
  assert.equal(policy.verificationRoles.requiredGates[0], "npm run smoke");
  assert.equal(policy.resourceRules.maxParallelLanes, 3);

  // Concurrency narrows through repository then per-run, and never broadens.
  assert.equal(policy.concurrency.claude.work, 1);
  assert.equal(policy.decisions["concurrency.claude.work"].source, "per_run_narrowing");
  assert.equal(policy.concurrency.claude.review, 8);
  assert.equal(policy.concurrency.codex.work, 5);
  assert.equal(policy.decisions["concurrency.codex.work"].source, "machine_default");
  const ignoredCodex = policy.decisions["concurrency.codex.work"].considered
    .find((entry) => entry.level === "repository_policy");
  assert.equal(ignoredCodex.value, 50);
  assert.equal(ignoredCodex.applied, false);

  // Model denials union: the repository may add one but never remove the machine's.
  assert.ok(policy.deniedModels.claude.includes("claude-fable-5"));
  assert.ok(policy.deniedModels.claude.includes("claude-haiku-4-5-20251001"));
  assert.equal(policy.decisions["deniedModels.claude"].source, "repository_policy");

  // Machine-owned domains are rejected, not merged.
  assert.ok(rejectionFor(policy, "identities"));
  assert.ok(rejectionFor(policy, "privateKeyPath"));
  assert.equal(policy.identities.builder.login, "test-builder[bot]");

  // Protected path floor survives repository additions.
  assert.ok(policy.pathRules.protectedPaths.includes("**/*.pem"));
  assert.ok(policy.pathRules.protectedPaths.includes("docs/generated/**"));

  // Review-only providers are never writers.
  assert.deepEqual(policy.writerProviders, ["claude", "codex", "antigravity"]);

  // Workspace recipes stay preview-only until the machine approves the exact list.
  assert.equal(policy.workspaceRecipe.phases.preRetire.commandCount, 1);
  assert.equal(policy.workspaceRecipe.phases.preRetire.approved, false);

  // --- Per-run narrowing may not broaden delivery authority ----------------
  const narrowed = await resolveDeliveryPolicy({
    workspace,
    home: governed.home,
    environment: governed.environment,
    options: { deliveryProfile: "local-only" },
  });
  assert.equal(narrowed.deliveryProfile, "local-only");
  assert.equal(narrowed.decisions.deliveryProfile.source, "per_run_narrowing");
  assert.equal(narrowed.surfaces.publication.enabled, false);
  assert.equal(narrowed.surfaces.merge.enabled, false);
  assert.equal(narrowed.surfaces.review.publishStatus, false);

  const localMachine = await machineLayer("local", { apps: false });
  const localWorkspace = await repositoryWorkspace("local", { version: 1, deliveryProfile: "github-governed" });
  const local = await resolveDeliveryPolicy({
    workspace: localWorkspace,
    home: localMachine.home,
    environment: localMachine.environment,
    options: { deliveryProfile: "github-governed" },
  });
  assert.equal(local.deliveryProfile, "local-only");
  assert.equal(local.rejections.filter((entry) => entry.field === "deliveryProfile").length, 2);
  assert.equal(local.surfaces.publication.enabled, false);
  assert.match(local.surfaces.publication.reason, /local-only/);

  // --- Surfaces -------------------------------------------------------------
  const surface = await deliveryPolicyForSurface("scheduling", {
    workspace,
    home: governed.home,
    environment: governed.environment,
  });
  assert.equal(surface.policy.maxParallelLanes, 3);
  assert.equal(surface.policy.concurrency.claude.work, 2);
  await assert.rejects(
    () => deliveryPolicyForSurface("nope", { workspace, home: governed.home, environment: governed.environment }),
    /Unknown delivery surface/,
  );
  assert.deepEqual(
    Object.keys(policy.surfaces),
    ["collaboration", "scheduling", "publication", "review", "merge", "cleanup", "missionControl"],
  );

  // --- Explain output -------------------------------------------------------
  const document = deliveryPolicyExplainDocument(policy);
  assert.deepEqual(document.precedence, PRECEDENCE_LEVELS);
  const codexDecision = document.decisions.find((entry) => entry.key === "concurrency.codex.work");
  assert.equal(codexDecision.source, "machine_default");
  assert.ok(JSON.parse(explainDeliveryPolicy(policy, { format: "json" })).decisions.length > 0);
  assert.throws(() => explainDeliveryPolicy(policy, { format: "yaml" }), /Unsupported explain format/);

  const human = explainDeliveryPolicy(policy, { format: "human" });
  assert.match(human, /Delivery profile: github-governed/);
  assert.match(human, /ignored: repository_policy proposed 50/);
  assert.match(human, /\[rejected\] privateKeyPath/);
  // The explain report must never echo rejected credential material.
  assert.doesNotMatch(human, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(explainDeliveryPolicy(policy, { format: "json" }), /BEGIN RSA PRIVATE KEY/);

  // --- Consumers ------------------------------------------------------------
  const config = await effectiveBridgeConfig({ workspace, home: governed.home, environment: governed.environment });
  assert.equal(config.deliveryPolicy.productFacts.productName, "repo-product");

  const cli = execFileSync(process.execPath, [
    resolve(root, "scripts/bridge-ops.mjs"), "policy", "explain", "--workspace", workspace, "--json",
  ], { encoding: "utf8", env: { ...process.env, ...governed.environment, HOME: governed.home } });
  const cliDocument = JSON.parse(cli);
  assert.equal(cliDocument.workspace, workspace);
  assert.equal(cliDocument.deliveryProfile, "github-governed");

  const cliHuman = execFileSync(process.execPath, [
    resolve(root, "scripts/explain-delivery-policy.mjs"), "--workspace", workspace,
  ], { encoding: "utf8", env: { ...process.env, ...governed.environment, HOME: governed.home } });
  assert.match(cliHuman, /Precedence \(weakest to strongest authority\)/);

  console.log("Delivery policy tests passed: precedence, provenance, profiles, narrowing limits, credential rejection, surfaces, and explain output verified.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

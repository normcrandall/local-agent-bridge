import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadModelPolicy, resolveModelRoute } from "./model-policy.mjs";
import { loadProviderConcurrency, DEFAULT_PROVIDER_CONCURRENCY_CONFIG } from "./provider-concurrency.mjs";
import { inspectGitHubAppRoles, DEFAULT_GITHUB_APPS_CONFIG } from "./github-app-auth.mjs";
import { decisionDisposition } from "./decision-policy.mjs";
import { resolveGitHubMergeEnforcement } from "./github-merge-enforcement.mjs";

export const DELIVERY_PROFILES = ["github-governed", "local-only"];

export const PRECEDENCE_LEVELS = [
  "protected_invariant",
  "machine_default",
  "repository_policy",
  "workspace_recipe",
  "per_run_narrowing",
];

export const DISALLOWED_REPO_POLICY_KEYS = [
  "privateKeyPath",
  "privateKey",
  "token",
  "secret",
  "password",
  "appId",
  "installationId",
  "pem",
  "botIdentity",
  "credentials",
];

export const PROTECTED_HUMAN_CATEGORIES = [
  "external_authorization",
  "money",
  "legal_compliance",
  "destructive_irreversible",
  "user_preference",
];

export function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse JSON file at ${path}: ${error.message}`);
  }
}

function containsDisallowedKey(key) {
  const lower = key.toLowerCase();
  return DISALLOWED_REPO_POLICY_KEYS.some((disallowed) => lower.includes(disallowed.toLowerCase()));
}

export function auditRepositoryPolicyContent(rawConfig) {
  const sanitized = {};
  const rejections = [];

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return { sanitized: {}, rejections };
  }

  function scan(obj, currentPath = "") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = currentPath ? `${currentPath}.${key}` : key;
      if (containsDisallowedKey(key)) {
        rejections.push({
          field: fullPath,
          reason: `Repository policy cannot specify security-sensitive key '${key}'. Machine policy retains ownership of credentials, keys, tokens, and bot identities.`,
        });
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = scan(value, fullPath);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return { sanitized: scan(rawConfig), rejections };
}

export function loadRepositoryDeliveryPolicy(workspace) {
  const repoPolicyPath = resolve(workspace, ".agent-bridge/delivery-policy.json");
  const fallbackConfigPath = resolve(workspace, ".agent-bridge/config.json");

  let pathUsed = null;
  let rawData = null;

  if (existsSync(repoPolicyPath)) {
    pathUsed = repoPolicyPath;
    rawData = readJsonFile(repoPolicyPath);
  } else if (existsSync(fallbackConfigPath)) {
    pathUsed = fallbackConfigPath;
    rawData = readJsonFile(fallbackConfigPath);
  }

  if (!rawData) {
    return { path: null, policy: {}, rejections: [] };
  }

  const { sanitized, rejections } = auditRepositoryPolicyContent(rawData);
  return { path: pathUsed, policy: sanitized, rejections };
}

export function loadWorkspaceRecipesPolicy(workspace) {
  const recipePath = resolve(workspace, ".agent-bridge/workspace-recipes.json");
  if (!existsSync(recipePath)) {
    return { path: null, recipes: {} };
  }
  const raw = readJsonFile(recipePath);
  return { path: recipePath, recipes: raw || {} };
}

export async function resolveDeliveryPolicy({
  workspace = process.cwd(),
  home = homedir(),
  environment = process.env,
  options = {},
} = {}) {
  const absWorkspace = resolve(workspace);
  const provenance = {};
  const securityRejections = [];

  // 1. Protected Invariants
  const protectedInvariants = {
    fableDeniedByDefault: true,
    humanEscalationCategories: PROTECTED_HUMAN_CATEGORIES,
    maxGlobalConcurrencyCeiling: 20,
    maxProviderConcurrencyCeiling: 10,
    machineCredentialOwnership: true,
  };
  provenance.protectedInvariants = {
    value: protectedInvariants,
    source: "protected_invariant",
    detail: "Core safety rules, decision boundaries, and machine ownership constraints.",
  };

  // 2. Machine Defaults
  const machineModelPolicy = loadModelPolicy({
    path: environment.AGENT_BRIDGE_MODEL_POLICY_CONFIG,
  });
  const machineConcurrency = await loadProviderConcurrency({
    configPath: environment.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG,
  });
  const machineGitHubApps = await inspectGitHubAppRoles({
    configPath: environment.AGENT_BRIDGE_GITHUB_APPS_CONFIG || DEFAULT_GITHUB_APPS_CONFIG,
  });

  const hasConfiguredApps = Boolean(
    machineGitHubApps.builderApp?.state === "configured" ||
    machineGitHubApps.reviewerApps?.claude?.state === "configured"
  );
  const machineDeliveryProfile = hasConfiguredApps ? "github-governed" : "local-only";

  provenance.deliveryProfile = {
    value: machineDeliveryProfile,
    source: "machine_default",
    detail: hasConfiguredApps ? "GitHub Apps detected, defaulting to github-governed profile." : "No GitHub Apps configured, defaulting to local-only profile.",
  };

  // 3. Repository Policy
  const repoData = loadRepositoryDeliveryPolicy(absWorkspace);
  if (repoData.rejections.length > 0) {
    securityRejections.push(...repoData.rejections);
  }

  const repoPolicy = repoData.policy || {};
  const repoPath = repoData.path;

  const productFacts = {
    productName: repoPolicy.productName || "local-agent-bridge",
    defaultBranch: repoPolicy.defaultBranch || "main",
    labelConventions: repoPolicy.labelConventions || ["autonomously-built", "agent-reviewed"],
  };
  provenance.productFacts = {
    value: productFacts,
    source: repoPath ? "repository_policy" : "machine_default",
    detail: repoPath ? `Loaded from ${repoPath}` : "Default product facts.",
  };

  const lifecycleMappings = {
    issueStateTransitions: repoPolicy.issueStateTransitions || { claim: "in_progress", PR: "review_requested" },
    prTitlePrefixes: repoPolicy.prTitlePrefixes || { fix: "fix:", feat: "feat:" },
  };
  provenance.lifecycleMappings = {
    value: lifecycleMappings,
    source: repoPath ? "repository_policy" : "machine_default",
    detail: repoPath ? `Loaded from ${repoPath}` : "Default lifecycle mappings.",
  };

  const verificationRoles = {
    requiredGates: repoPolicy.requiredGates || [],
    allowedVerificationCommands: repoPolicy.allowedVerificationCommands || null,
  };
  provenance.verificationRoles = {
    value: verificationRoles,
    source: repoPath ? "repository_policy" : "machine_default",
    detail: repoPath ? `Loaded from ${repoPath}` : "Default verification rules.",
  };

  const pathRules = {
    disallowedPathPatterns: repoPolicy.disallowedPathPatterns || [".env*", "*.pem", "secrets/*"],
    readOnlyRoots: repoPolicy.readOnlyRoots || [".git"],
  };
  provenance.pathRules = {
    value: pathRules,
    source: repoPath ? "repository_policy" : "machine_default",
    detail: repoPath ? `Loaded from ${repoPath}` : "Default path rules.",
  };

  // Calculate Concurrency Precedence: per_run <= repo <= machine <= protected ceiling
  const effectiveConcurrency = {};
  const repoConcurrency = repoPolicy.providerConcurrency || {};

  for (const [provider, machineLimits] of Object.entries(machineConcurrency)) {
    const machineLimit = machineLimits.workLimit || 5;
    let effectiveLimit = machineLimit;
    let source = "machine_default";
    let detail = `Machine concurrency limit is ${machineLimit}.`;

    if (repoConcurrency[provider]?.workLimit !== undefined) {
      const repoLimit = Number(repoConcurrency[provider].workLimit);
      if (repoLimit < machineLimit) {
        effectiveLimit = repoLimit;
        source = "repository_policy";
        detail = `Repository narrowed concurrency to ${repoLimit}.`;
      } else if (repoLimit > machineLimit) {
        source = "protected_invariant";
        detail = `Repository attempted to increase concurrency to ${repoLimit}, but machine ceiling of ${machineLimit} enforced.`;
      }
    }

    if (options.concurrency?.[provider] !== undefined) {
      const perRunLimit = Number(options.concurrency[provider]);
      if (perRunLimit < effectiveLimit) {
        effectiveLimit = perRunLimit;
        source = "per_run_narrowing";
        detail = `Per-run option narrowed concurrency to ${perRunLimit}.`;
      } else if (perRunLimit > effectiveLimit) {
        detail = `Per-run option requested ${perRunLimit}, but effective ceiling of ${effectiveLimit} enforced.`;
      }
    }

    effectiveConcurrency[provider] = {
      workLimit: effectiveLimit,
      reviewLimit: machineLimits.reviewLimit || 10,
    };
    provenance[`concurrency.${provider}`] = {
      value: effectiveConcurrency[provider],
      source,
      detail,
    };
  }

  // 4. Workspace Recipe Layer
  const recipeData = loadWorkspaceRecipesPolicy(absWorkspace);
  const workspaceRecipes = recipeData.recipes || {};
  provenance.workspaceRecipes = {
    value: { path: recipeData.path, hasRecipes: Object.keys(workspaceRecipes).length > 0 },
    source: recipeData.path ? "workspace_recipe" : "machine_default",
    detail: recipeData.path ? `Workspace recipe loaded from ${recipeData.path}` : "No workspace recipe found.",
  };

  // 5. Per-Run Narrowing & Profile Overrides
  let effectiveProfile = provenance.deliveryProfile.value;
  if (options.deliveryProfile && DELIVERY_PROFILES.includes(options.deliveryProfile)) {
    if (options.deliveryProfile === "local-only" || provenance.deliveryProfile.value === "local-only") {
      effectiveProfile = options.deliveryProfile;
      provenance.deliveryProfile = {
        value: effectiveProfile,
        source: "per_run_narrowing",
        detail: `Per-run option narrowed profile to ${effectiveProfile}.`,
      };
    } else if (options.deliveryProfile === "github-governed" && !hasConfiguredApps) {
      provenance.deliveryProfile = {
        value: "local-only",
        source: "protected_invariant",
        detail: "github-governed requested per-run, but machine lacks configured GitHub Apps; falling back to local-only.",
      };
      effectiveProfile = "local-only";
    }
  }

  // Merge enforcement
  const mergeEnforcement = resolveGitHubMergeEnforcement({
    configuredMode: options.githubMergeMode || repoPolicy.githubMergeMode || "broker",
  });
  provenance.mergeEnforcement = {
    value: mergeEnforcement,
    source: options.githubMergeMode ? "per_run_narrowing" : repoPolicy.githubMergeMode ? "repository_policy" : "machine_default",
    detail: mergeEnforcement.reason,
  };

  const effectivePolicy = {
    version: 1,
    deliveryProfile: effectiveProfile,
    workspace: absWorkspace,
    productFacts,
    lifecycleMappings,
    verificationRoles,
    pathRules,
    concurrency: effectiveConcurrency,
    protectedInvariants,
    githubApps: machineGitHubApps,
    workspaceRecipes,
    mergeEnforcement,
    securityRejections,
    provenance,
  };

  return effectivePolicy;
}

export function explainDeliveryPolicy(effectivePolicy, { format = "human" } = {}) {
  if (format === "json") {
    return JSON.stringify(effectivePolicy, null, 2);
  }

  const lines = [];
  lines.push("=== Delivery Policy Explanation ===");
  lines.push(`Workspace: ${effectivePolicy.workspace}`);
  lines.push(`Effective Delivery Profile: ${effectivePolicy.deliveryProfile} (Source: ${effectivePolicy.provenance.deliveryProfile.source})`);
  lines.push(`  Detail: ${effectivePolicy.provenance.deliveryProfile.detail}`);
  lines.push("");

  lines.push("--- Precedence & Ownership ---");
  lines.push("1. Protected Invariants: Safety limits & machine credential ownership enforced.");
  lines.push("2. Machine Defaults: Provider models & concurrency ceilings.");
  lines.push(`3. Repository Policy: ${effectivePolicy.provenance.productFacts.source === "repository_policy" ? "Active" : "None"}`);
  lines.push(`4. Workspace Recipes: ${effectivePolicy.workspaceRecipes.hasRecipes ? "Active" : "None"}`);
  lines.push("5. Per-Run Inputs: Allowed narrowing applied.");
  lines.push("");

  lines.push("--- Provider Concurrency Limits ---");
  for (const [provider, info] of Object.entries(effectivePolicy.concurrency)) {
    const prov = effectivePolicy.provenance[`concurrency.${provider}`];
    lines.push(`  ${provider}: workLimit = ${info.workLimit}, reviewLimit = ${info.reviewLimit} [Source: ${prov.source}] (${prov.detail})`);
  }
  lines.push("");

  lines.push("--- Product Facts ---");
  lines.push(`  Product Name: ${effectivePolicy.productFacts.productName}`);
  lines.push(`  Default Branch: ${effectivePolicy.productFacts.defaultBranch}`);
  lines.push(`  Labels: ${effectivePolicy.productFacts.labelConventions.join(", ")}`);
  lines.push("");

  if (effectivePolicy.securityRejections.length > 0) {
    lines.push("--- Security Rejections ---");
    for (const rej of effectivePolicy.securityRejections) {
      lines.push(`  [REJECTED] ${rej.field}: ${rej.reason}`);
    }
    lines.push("");
  }

  lines.push("--- Merge Enforcement ---");
  lines.push(`  Effective Mode: ${effectivePolicy.mergeEnforcement.effectiveMode}`);
  lines.push(`  Reason: ${effectivePolicy.mergeEnforcement.reason}`);

  return lines.join("\n");
}

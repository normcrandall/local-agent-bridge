import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadModelPolicy, MODEL_PROVIDERS, normalizeModelName } from "./model-policy.mjs";
import {
  DEFAULT_PROVIDER_CONCURRENCY_CONFIG,
  PROVIDER_NAMES,
  loadProviderConcurrency,
} from "./provider-concurrency.mjs";
import { DEFAULT_GITHUB_APPS_CONFIG, inspectGitHubAppRoles } from "./github-app-auth.mjs";
import { GITHUB_MERGE_ENFORCEMENT_MODES, resolveGitHubMergeEnforcement } from "./github-merge-enforcement.mjs";
import { DECISION_CATEGORIES } from "./decision-policy.mjs";
import { loadWorkspaceRecipe } from "./workspace-operations.mjs";

// One delivery policy resolver. Collaboration, scheduling, publication, review, merge,
// cleanup, and Mission Control read the same effective values through `surfaces`, so a
// policy question is answered once here instead of once per subsystem.

export const DELIVERY_POLICY_VERSION = 1;

/** Ordered weakest-to-strongest authority. Lower layers may only narrow. */
export const PRECEDENCE_LEVELS = Object.freeze([
  "protected_invariant",
  "machine_default",
  "repository_policy",
  "workspace_recipe",
  "per_run_narrowing",
]);

export const DELIVERY_PROFILES = Object.freeze(["local-only", "github-governed"]);

/** Delivery authority rank. Narrowing moves down this ladder; nothing may move up. */
const PROFILE_AUTHORITY = Object.freeze({ "local-only": 0, "github-governed": 1 });

/** Stronger merge enforcement removes local merge authority, so lower layers may only move up. */
const MERGE_ENFORCEMENT_STRENGTH = Object.freeze({
  broker: 0,
  auto: 1,
  "branch-protection": 2,
  "organization-ruleset": 3,
});

export const REPOSITORY_POLICY_FILE = ".agent-bridge/delivery-policy.json";

/** Rules no configuration layer may relax. */
export const PROTECTED_INVARIANTS = Object.freeze({
  machineOwnsCredentials: true,
  claudeFableRequiresExplicitRequest: true,
  exactHeadReviewGateRequired: true,
  botApprovalNeverSatisfiesHumanApproval: true,
  localOnlyProvidersAreReviewOnly: Object.freeze(["ollama", "docker"]),
  humanEscalationCategories: Object.freeze(DECISION_CATEGORIES.filter((value) => value !== "reversible_technical")),
  maxProviderWorkConcurrency: 20,
  maxProviderReviewConcurrency: 20,
  alwaysProtectedPaths: Object.freeze([".git/config", ".git/hooks/**", "**/*.pem", "**/id_rsa*", ".env", ".env.*"]),
});

/** Machine-owned domains. A repository, recipe, or per-run input may never author these. */
export const MACHINE_OWNED_DOMAINS = Object.freeze([
  "providerAllowlist",
  "modelAllowlist",
  "concurrencyCeilings",
  "identities",
  "installations",
  "secrets",
]);

/** Repository-owned domains. */
export const REPOSITORY_OWNED_DOMAINS = Object.freeze([
  "productFacts",
  "lifecycleMappings",
  "verificationRoles",
  "pathRules",
  "resourceRules",
  "concurrencyNarrowing",
]);

// ---------------------------------------------------------------------------
// Credential and identity rejection
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_WORDS = new Set([
  "credential", "credentials", "secret", "secrets", "token", "tokens", "password",
  "passphrase", "privatekey", "pem", "pkcs8", "apikey", "authorization", "bearer",
]);

/** Multi-word key shapes that identify machine-owned identity configuration. */
const SENSITIVE_KEY_PHRASES = [
  ["private", "key"],
  ["client", "secret"],
  ["app", "id"],
  ["installation", "id"],
  ["installation", "ids"],
  ["bot", "identity"],
  ["bot", "login"],
  ["expected", "login"],
  ["reviewer", "login"],
  ["builder", "login"],
  ["github", "app"],
  ["github", "apps"],
];

/** Domain terms that read as sensitive but carry no authority. */
const SAFE_KEY_NAMES = new Set(["tokenbudget", "tokenbudgets", "maxtokens", "tokenlimit"]);

const SENSITIVE_VALUE_PATTERNS = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "inline private key material" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/, reason: "GitHub access token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, reason: "GitHub fine-grained token" },
  { pattern: /\.pem$|(^|\/)id_rsa|(^|\/)id_ed25519/, reason: "private-key file path" },
  { pattern: /^[A-Za-z0-9-]+\[bot\]$/, reason: "maintainer-specific bot identity" },
];

function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** Why this key may not appear in repository-authored policy, or null when it may. */
export function sensitiveKeyReason(key) {
  const normalized = String(key).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (SAFE_KEY_NAMES.has(normalized)) return null;
  const words = keyWords(key);
  for (const word of words) {
    if (SENSITIVE_KEY_WORDS.has(word)) return `'${key}' names credential material (${word}).`;
  }
  for (const phrase of SENSITIVE_KEY_PHRASES) {
    for (let index = 0; index + phrase.length <= words.length; index += 1) {
      if (phrase.every((part, offset) => words[index + offset] === part)) {
        return `'${key}' configures a machine-owned GitHub App identity (${phrase.join(" ")}).`;
      }
    }
  }
  return null;
}

function sensitiveValueReason(value) {
  if (typeof value !== "string") return null;
  const match = SENSITIVE_VALUE_PATTERNS.find((entry) => entry.pattern.test(value.trim()));
  return match ? `value looks like ${match.reason}` : null;
}

/**
 * Strip every credential, private-key path, token, and maintainer-specific bot identity
 * from repository-authored content. Rejected fields are dropped, never merged.
 */
export function auditRepositoryPolicyContent(rawConfig, { origin = REPOSITORY_POLICY_FILE } = {}) {
  const rejections = [];
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return { sanitized: {}, rejections };
  }

  const reject = (field, reason) => rejections.push({
    origin,
    field,
    reason: `${reason} Machine policy retains ownership of credentials, keys, tokens, identities, and installations.`,
  });

  function scan(node, path) {
    if (Array.isArray(node)) {
      return node
        .map((entry, index) => {
          const field = `${path}[${index}]`;
          const valueReason = sensitiveValueReason(entry);
          if (valueReason) {
            reject(field, `Repository policy cannot supply ${valueReason}.`);
            return undefined;
          }
          return entry && typeof entry === "object" ? scan(entry, field) : entry;
        })
        .filter((entry) => entry !== undefined);
    }
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      const field = path ? `${path}.${key}` : key;
      const keyReason = sensitiveKeyReason(key);
      if (keyReason) {
        reject(field, `Repository policy cannot specify ${keyReason}`);
        continue;
      }
      const valueReason = sensitiveValueReason(value);
      if (valueReason) {
        reject(field, `Repository policy cannot supply ${valueReason}.`);
        continue;
      }
      result[key] = value && typeof value === "object" ? scan(value, field) : value;
    }
    return result;
  }

  return { sanitized: scan(rawConfig, ""), rejections };
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse JSON file at ${path}: ${error.message}`);
  }
}

/** Load and sanitize `.agent-bridge/delivery-policy.json` for one workspace. */
export function loadRepositoryDeliveryPolicy(workspace, { diagnostic = false } = {}) {
  const path = resolve(workspace, REPOSITORY_POLICY_FILE);
  let raw;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    if (!diagnostic) throw error;
    return {
      path,
      policy: {},
      rejections: [{ origin: path, field: "$", reason: error.message }],
    };
  }
  if (!raw) return { path: null, policy: {}, rejections: [] };
  if (raw.version !== undefined && raw.version !== DELIVERY_POLICY_VERSION) {
    const message = `Unsupported repository delivery policy version in ${path}.`;
    if (!diagnostic) throw new Error(message);
    return { path, policy: {}, rejections: [{ origin: path, field: "version", reason: message }] };
  }
  const { sanitized, rejections } = auditRepositoryPolicyContent(raw, { origin: path });
  delete sanitized.version;
  return { path, policy: sanitized, rejections };
}

// ---------------------------------------------------------------------------
// Provenance ledger and precedence primitives
// ---------------------------------------------------------------------------

function createLedger() {
  const decisions = {};
  return {
    decisions,
    record(key, entry) {
      decisions[key] = { key, ...entry };
      return entry.value;
    },
  };
}

function definedLayers(layers) {
  return layers.filter((layer) => layer && layer.value !== undefined && layer.value !== null);
}

/**
 * Numeric ceiling that lower layers may only lower. Records every considered candidate so
 * an ignored broadening attempt stays visible instead of disappearing silently.
 */
function resolveNarrowedNumber(ledger, key, { label, ceiling, machine, layers = [], rejections }) {
  const considered = [];
  let value = machine;
  let source = "machine_default";
  let detail = `Machine policy sets ${label} to ${machine}.`;

  if (Number.isFinite(ceiling) && value > ceiling) {
    value = ceiling;
    source = "protected_invariant";
    detail = `Protected ceiling clamped ${label} from ${machine} to ${ceiling}.`;
  }
  considered.push({ level: "machine_default", value: machine, applied: source === "machine_default" });

  for (const layer of definedLayers(layers)) {
    const candidate = Number(layer.value);
    if (!Number.isInteger(candidate) || candidate < 1) {
      rejections.push({
        origin: layer.origin || layer.level,
        field: key,
        reason: `${label} must be a positive integer; ignored ${JSON.stringify(layer.value)}.`,
      });
      continue;
    }
    const applied = candidate < value;
    considered.push({ level: layer.level, value: candidate, applied });
    if (applied) {
      value = candidate;
      source = layer.level;
      detail = `${layer.level} narrowed ${label} to ${candidate}.`;
    } else if (candidate > value) {
      detail = `${layer.level} requested ${candidate}; the effective ${label} stays ${value} because lower layers may only narrow.`;
    }
  }

  return ledger.record(key, { value, source, detail, considered });
}

/** Deny-list union: lower layers may add denials but may never remove one. */
function resolveWidenedDenyList(ledger, key, { label, machine, layers = [], normalize = (v) => v }) {
  const considered = [{ level: "machine_default", value: machine, applied: true }];
  const value = [...machine];
  let source = "machine_default";
  let detail = `Machine policy denies ${machine.length} ${label}.`;

  for (const layer of definedLayers(layers)) {
    const added = [];
    for (const entry of [].concat(layer.value)) {
      const normalized = normalize(entry);
      if (!normalized || value.includes(normalized)) continue;
      value.push(normalized);
      added.push(normalized);
    }
    considered.push({ level: layer.level, value: [].concat(layer.value), applied: added.length > 0 });
    if (added.length) {
      source = layer.level;
      detail = `${layer.level} added ${added.length} additional denied ${label}: ${added.join(", ")}.`;
    }
  }

  return ledger.record(key, { value, source, detail, considered });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Repository-owned value. Later layers override supplied fields; unmentioned fields keep
 * the bridge default so a partial repository block never blanks out the rest.
 */
function resolveOwnedValue(ledger, key, { machineDefault, layers = [], detailFor }) {
  const considered = [{ level: "machine_default", value: machineDefault, applied: true }];
  let value = machineDefault;
  let source = "machine_default";
  let detail = "No repository value supplied; using the bridge default.";

  for (const layer of definedLayers(layers)) {
    considered.push({ level: layer.level, value: layer.value, applied: true });
    value = isPlainObject(machineDefault) && isPlainObject(layer.value)
      ? { ...value, ...layer.value }
      : layer.value;
    source = layer.level;
    detail = detailFor ? detailFor(layer) : `${layer.level} set this value.`;
  }

  return ledger.record(key, { value, source, detail, considered });
}

function normalizedStringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((entry) => String(entry).trim()).filter(Boolean))];
}

/** Verification gates accumulate; a per-run request may narrow reviewers but never erase repository gates. */
function resolveVerificationRoles(ledger, { repositoryValue, perRunValue, repositoryOrigin, rejections }) {
  const repository = isPlainObject(repositoryValue) ? repositoryValue : {};
  const run = isPlainObject(perRunValue) ? perRunValue : {};
  const requiredGates = normalizedStringList([
    ...normalizedStringList(repository.requiredGates),
    ...normalizedStringList(run.requiredGates),
  ]);
  const verificationCommands = normalizedStringList([
    ...normalizedStringList(repository.verificationCommands),
    ...normalizedStringList(run.verificationCommands),
  ]);
  const repositoryReviewers = normalizedStringList(repository.reviewerRoles);
  const requestedReviewers = normalizedStringList(run.reviewerRoles);
  const reviewerRoles = repositoryReviewers.length && requestedReviewers.length
    ? repositoryReviewers.filter((role) => requestedReviewers.includes(role))
    : repositoryReviewers.length ? repositoryReviewers : requestedReviewers;

  if (repositoryReviewers.length && requestedReviewers.length && !reviewerRoles.length) {
    rejections.push({
      origin: "per_run_narrowing",
      field: "verificationRoles.reviewerRoles",
      reason: `Per-run reviewer roles do not intersect the repository-authorized roles from ${repositoryOrigin}; no reviewer role is eligible.`,
    });
  }

  const considered = [
    { level: "machine_default", value: { requiredGates: [], reviewerRoles: [], verificationCommands: [] }, applied: true },
    ...(repositoryValue === undefined ? [] : [{ level: "repository_policy", value: repositoryValue, applied: true }]),
    ...(perRunValue === undefined ? [] : [{ level: "per_run_narrowing", value: perRunValue, applied: true }]),
  ];
  const source = perRunValue !== undefined ? "per_run_narrowing" : repositoryValue !== undefined ? "repository_policy" : "machine_default";
  return ledger.record("verificationRoles", {
    value: { requiredGates, reviewerRoles, verificationCommands },
    source,
    detail: perRunValue !== undefined
      ? "Per-run verification gates were added and reviewer roles were intersected with the repository policy."
      : repositoryValue !== undefined
        ? `Verification roles and required gates come from ${repositoryOrigin}.`
        : "No repository verification policy supplied; using the bridge default.",
    considered,
  });
}

function resolveResourceRules(ledger, { repositoryValue, perRunValue, repositoryOrigin, rejections }) {
  const repository = isPlainObject(repositoryValue) ? repositoryValue : {};
  const run = isPlainObject(perRunValue) ? perRunValue : {};
  const considered = [{ level: "machine_default", value: { maxParallelLanes: null, timeouts: {} }, applied: true }];
  let maxParallelLanes = null;
  let source = repositoryValue === undefined ? "machine_default" : "repository_policy";
  let detail = repositoryValue === undefined
    ? "No repository resource rules supplied; parallel lanes are not additionally limited."
    : `Repository resource rules come from ${repositoryOrigin}.`;

  if (repositoryValue !== undefined) {
    considered.push({ level: "repository_policy", value: repositoryValue, applied: true });
  }

  const candidates = [
    { level: "repository_policy", origin: repositoryOrigin, value: repository.maxParallelLanes },
    { level: "per_run_narrowing", origin: "per_run_narrowing", value: run.maxParallelLanes },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null) continue;
    const parsed = Number(candidate.value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      considered.push({ level: candidate.level, value: candidate.value, applied: false });
      rejections.push({
        origin: candidate.origin,
        field: "resourceRules.maxParallelLanes",
        reason: `Maximum parallel lanes must be a positive integer; ignored ${JSON.stringify(candidate.value)}.`,
      });
      continue;
    }
    const applied = maxParallelLanes === null || parsed < maxParallelLanes;
    if (candidate.level !== "repository_policy") {
      considered.push({ level: candidate.level, value: parsed, applied });
    }
    if (applied) {
      maxParallelLanes = parsed;
      source = candidate.level;
      detail = `${candidate.level} narrowed maximum parallel lanes to ${parsed}.`;
    } else if (parsed > maxParallelLanes) {
      detail = `${candidate.level} requested ${parsed}; maximum parallel lanes stays ${maxParallelLanes} because per-run input may only narrow.`;
    }
  }

  if (run.timeouts !== undefined) {
    considered.push({ level: "per_run_narrowing", value: { timeouts: run.timeouts }, applied: false });
    rejections.push({
      origin: "per_run_narrowing",
      field: "resourceRules.timeouts",
      reason: "Resource timeout definitions are repository-owned; per-run input cannot replace them.",
    });
  }
  return ledger.record("resourceRules", {
    value: { maxParallelLanes, timeouts: isPlainObject(repository.timeouts) ? repository.timeouts : {} },
    source,
    detail,
    considered,
  });
}

function resolveMergeEnforcementMode(ledger, { machineValue, machineOrigin, repositoryValue, perRunValue, repositoryOrigin, rejections }) {
  const considered = [];
  let value = "broker";
  let source = "machine_default";
  let origin = machineOrigin;

  for (const candidate of [
    { level: "machine_default", origin: machineOrigin, value: machineValue || "broker" },
    { level: "repository_policy", origin: repositoryOrigin, value: repositoryValue },
    { level: "per_run_narrowing", origin: "per_run_narrowing", value: perRunValue },
  ]) {
    if (candidate.value === undefined || candidate.value === null || candidate.value === "") continue;
    const mode = typeof candidate.value === "string" ? candidate.value.trim() : candidate.value;
    if (!GITHUB_MERGE_ENFORCEMENT_MODES.includes(mode)) {
      considered.push({ level: candidate.level, value: candidate.value, applied: false });
      rejections.push({
        origin: candidate.origin,
        field: "mergeEnforcement",
        reason: `Unknown merge enforcement mode ${JSON.stringify(candidate.value)}; keeping ${value}.`,
      });
      continue;
    }
    const applied = considered.length === 0 || MERGE_ENFORCEMENT_STRENGTH[mode] > MERGE_ENFORCEMENT_STRENGTH[value];
    considered.push({ level: candidate.level, value: mode, applied });
    if (applied) {
      value = mode;
      source = candidate.level;
      origin = candidate.origin;
    } else if (MERGE_ENFORCEMENT_STRENGTH[mode] < MERGE_ENFORCEMENT_STRENGTH[value]) {
      rejections.push({
        origin: candidate.origin,
        field: "mergeEnforcement",
        reason: `${candidate.level} requested ${mode}, which would weaken the ${value} enforcement floor from ${origin}; ignored.`,
      });
    }
  }

  ledger.record("configuredMergeEnforcement", {
    value,
    source,
    detail: `${source} selected the strongest configured merge-enforcement floor: ${value}.`,
    considered,
  });
  return { value, source };
}

/** Record an attempt to author a machine-owned domain from a lower layer. */
function rejectMachineOwnedAttempts({ policy, origin, keys, rejections }) {
  for (const key of keys) {
    if (policy && policy[key] !== undefined) {
      rejections.push({
        origin,
        field: key,
        reason: `'${key}' is machine-owned. Repository and per-run layers may narrow authority but never broaden it.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function normalizeConcurrencyEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  return {
    work: entry.work ?? entry.workLimit,
    review: entry.review ?? entry.reviewLimit,
  };
}

function githubIdentities(apps) {
  const roles = apps?.roles || {};
  const reviewers = roles.reviewers || {};
  return {
    configPath: apps?.configPath || null,
    configured: Boolean(apps?.configured),
    builder: roles.builder?.configured
      ? { login: roles.builder.expectedLogin, installations: roles.builder.installations, privateKeySecure: roles.builder.privateKeySecure }
      : { login: null, installations: [], privateKeySecure: false },
    reviewers: Object.fromEntries(Object.entries(reviewers).map(([provider, role]) => [provider, {
      login: role.expectedLogin,
      installations: role.installations,
      privateKeySecure: role.privateKeySecure,
    }])),
    allowPatFallback: apps?.allowPatFallback ?? true,
    autonomousMergeRepositories: apps?.mergePolicy?.autonomousMergeRepositories || [],
    trustedHumanReviewers: apps?.mergePolicy?.trustedHumanReviewers || [],
  };
}

function githubDeliveryAvailable(identities) {
  if (!identities.configured) return false;
  const reviewerConfigured = Object.values(identities.reviewers).some((reviewer) => Boolean(reviewer.login));
  return Boolean(identities.builder.login) && reviewerConfigured;
}

function resolveDeliveryProfile(ledger, { available, layers, rejections }) {
  const machine = available ? "github-governed" : "local-only";
  const considered = [{ level: "machine_default", value: machine, applied: true }];
  let value = machine;
  let source = "machine_default";
  let detail = available
    ? "Builder and reviewer GitHub Apps are configured, so GitHub-governed delivery is available."
    : "No complete builder and reviewer GitHub App pair is configured, so delivery stays local-only.";

  for (const layer of definedLayers(layers)) {
    const candidate = String(layer.value);
    if (!DELIVERY_PROFILES.includes(candidate)) {
      rejections.push({
        origin: layer.origin || layer.level,
        field: "deliveryProfile",
        reason: `Unknown delivery profile ${JSON.stringify(layer.value)}; expected one of ${DELIVERY_PROFILES.join(", ")}.`,
      });
      continue;
    }
    const narrows = PROFILE_AUTHORITY[candidate] < PROFILE_AUTHORITY[value];
    considered.push({ level: layer.level, value: candidate, applied: narrows });
    if (narrows) {
      value = candidate;
      source = layer.level;
      detail = `${layer.level} narrowed delivery to the ${candidate} profile.`;
    } else if (candidate !== value) {
      detail = `${layer.level} requested ${candidate}; delivery stays ${value} because GitHub authority is machine-owned and cannot be broadened.`;
      rejections.push({
        origin: layer.origin || layer.level,
        field: "deliveryProfile",
        reason: `Requested ${candidate} but the machine layer only grants ${value}. Lower layers may narrow delivery authority, never broaden it.`,
      });
    }
  }

  return ledger.record("deliveryProfile", { value, source, detail, considered });
}

/**
 * Resolve one workspace's effective delivery policy.
 *
 * @param {object} input
 * @param {string} [input.workspace] Exact repository worktree.
 * @param {object} [input.options] Per-run narrowing (alias: `input.run`).
 * @param {object} [input.mergeCapabilities] Observed GitHub enforcement capabilities.
 * @param {boolean} [input.diagnostic] Report malformed repository policy instead of granting from it.
 * @returns {Promise<object>} Effective values, provenance, rejections, and per-surface views.
 */
export async function resolveDeliveryPolicy({
  workspace = process.cwd(),
  home = homedir(),
  environment = process.env,
  options,
  run,
  mergeCapabilities,
  diagnostic = false,
} = {}) {
  const absWorkspace = resolve(workspace);
  const perRun = options || run || {};
  const ledger = createLedger();
  const rejections = [];

  ledger.record("protectedInvariants", {
    value: PROTECTED_INVARIANTS,
    source: "protected_invariant",
    detail: "Bridge safety rules that no configuration layer may relax.",
  });

  // --- Machine layer -------------------------------------------------------
  const modelPolicyPath = environment.AGENT_BRIDGE_MODEL_POLICY_CONFIG;
  const machineModelPolicy = loadModelPolicy({ path: modelPolicyPath });
  const concurrencyPath = environment.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG || DEFAULT_PROVIDER_CONCURRENCY_CONFIG;
  const machineConcurrency = await loadProviderConcurrency({ configPath: concurrencyPath });
  const apps = await inspectGitHubAppRoles({
    configPath: environment.AGENT_BRIDGE_GITHUB_APPS_CONFIG || DEFAULT_GITHUB_APPS_CONFIG,
  });
  const identities = githubIdentities(apps);

  ledger.record("identities", {
    value: identities,
    source: "machine_default",
    detail: `GitHub App identities, installations, and private keys are read only from ${identities.configPath}.`,
  });

  // --- Repository layer ----------------------------------------------------
  const repository = loadRepositoryDeliveryPolicy(absWorkspace, { diagnostic });
  rejections.push(...repository.rejections);
  const repoPolicy = repository.policy;
  const repoOrigin = repository.path || REPOSITORY_POLICY_FILE;
  rejectMachineOwnedAttempts({
    policy: repoPolicy,
    origin: repoOrigin,
    keys: ["providerAllowlist", "enabledModels", "identities", "installations", "githubApps", "allowPatFallback", "trustedHumanReviewers", "autonomousMergeRepositories"],
    rejections,
  });

  // --- Workspace recipe layer ---------------------------------------------
  // The recipe layer governs approval-gated phase commands only. It deliberately authors no
  // policy values: the recipes file is not passed through the credential sanitizer, so letting
  // it set delivery authority would open an unaudited path around the repository layer.
  const recipe = loadWorkspaceRecipe(absWorkspace, { home });
  ledger.record("workspaceRecipe", {
    value: {
      projectPath: recipe.projectPath,
      approvalsPath: recipe.approvalsPath,
      phases: Object.fromEntries(Object.entries(recipe.phases).map(([phase, entry]) => [phase, {
        commandCount: entry.commands.length,
        approved: entry.approved,
      }])),
    },
    source: "workspace_recipe",
    detail: "Workspace recipe commands execute only when they match the machine-local approval exactly.",
  });

  // --- Delivery profile ----------------------------------------------------
  const available = githubDeliveryAvailable(identities);
  const deliveryProfile = resolveDeliveryProfile(ledger, {
    available,
    layers: [
      { level: "repository_policy", origin: repoOrigin, value: repoPolicy.deliveryProfile },
      { level: "per_run_narrowing", value: perRun.deliveryProfile },
    ],
    rejections,
  });

  // --- Provider and model allowlists --------------------------------------
  // The machine owns the roster itself. `providerAllowlist` and `enabledModels` are therefore
  // hard-rejected above: a repository may not name who is allowed to write or which models are
  // permitted. What a repository may author is the deny direction — `deniedProviders` and
  // `deniedModels` only ever remove candidates from the machine roster, so widening those lists
  // narrows effective authority and can never restore something the machine denied.
  const machineProviders = PROVIDER_NAMES.filter((provider) => provider !== "ollama" && provider !== "docker");
  const providerLayers = definedLayers([
    { level: "repository_policy", value: repoPolicy.deniedProviders },
    { level: "per_run_narrowing", value: perRun.deniedProviders },
  ]);
  const deniedProviders = resolveWidenedDenyList(ledger, "deniedWriterProviders", {
    label: "writer providers",
    machine: [...PROTECTED_INVARIANTS.localOnlyProvidersAreReviewOnly],
    layers: providerLayers,
    normalize: (value) => (typeof value === "string" ? value.trim().toLowerCase() : null),
  });
  const writerProviders = machineProviders.filter((provider) => !deniedProviders.includes(provider));
  ledger.record("writerProviders", {
    value: writerProviders,
    source: ledger.decisions.deniedWriterProviders.source === "machine_default"
      ? "protected_invariant"
      : ledger.decisions.deniedWriterProviders.source,
    detail: "Ollama and Docker Model Runner are review-only; remaining providers come from the machine roster minus narrowing.",
  });

  const deniedModels = {};
  for (const provider of MODEL_PROVIDERS) {
    deniedModels[provider] = resolveWidenedDenyList(ledger, `deniedModels.${provider}`, {
      label: `${provider} models`,
      machine: machineModelPolicy.providers[provider].disabledModels,
      layers: [
        { level: "repository_policy", value: repoPolicy.deniedModels?.[provider] },
        { level: "per_run_narrowing", value: perRun.deniedModels?.[provider] },
      ],
      normalize: (value) => {
        try { return normalizeModelName(value); } catch { return null; }
      },
    });
  }
  ledger.record("claudeFable", {
    value: "denied-unless-explicitly-requested",
    source: "protected_invariant",
    detail: "Claude may resolve to Fable only when the current request names it; no saved layer can pre-authorize it.",
  });

  // --- Concurrency (machine ceiling, repository and per-run narrowing) -----
  const repoConcurrency = repoPolicy.providerConcurrency || {};
  const runConcurrency = perRun.providerConcurrency || perRun.concurrency || {};
  const concurrency = {};
  for (const provider of PROVIDER_NAMES) {
    const repoEntry = normalizeConcurrencyEntry(repoConcurrency[provider]);
    const runValue = runConcurrency[provider];
    const runEntry = typeof runValue === "number"
      ? { work: runValue }
      : normalizeConcurrencyEntry(runValue);
    concurrency[provider] = {
      work: resolveNarrowedNumber(ledger, `concurrency.${provider}.work`, {
        label: `${provider} work concurrency`,
        ceiling: PROTECTED_INVARIANTS.maxProviderWorkConcurrency,
        machine: machineConcurrency[provider].work,
        layers: [
          { level: "repository_policy", origin: repoOrigin, value: repoEntry.work },
          { level: "per_run_narrowing", value: runEntry.work },
        ],
        rejections,
      }),
      review: resolveNarrowedNumber(ledger, `concurrency.${provider}.review`, {
        label: `${provider} review concurrency`,
        ceiling: PROTECTED_INVARIANTS.maxProviderReviewConcurrency,
        machine: machineConcurrency[provider].review,
        layers: [
          { level: "repository_policy", origin: repoOrigin, value: repoEntry.review },
          { level: "per_run_narrowing", value: runEntry.review },
        ],
        rejections,
      }),
    };
  }

  // --- Repository-owned product and lifecycle facts ------------------------
  const productFacts = resolveOwnedValue(ledger, "productFacts", {
    machineDefault: { productName: null, defaultBranch: "main", labels: [] },
    layers: [{ level: "repository_policy", value: repoPolicy.productFacts }],
    detailFor: () => `Product facts come from ${repoOrigin}.`,
  });
  if (perRun.productFacts !== undefined) {
    rejections.push({
      origin: "per_run_narrowing",
      field: "productFacts",
      reason: "Product facts, including the publication base branch, are repository-owned; per-run input cannot replace them.",
    });
  }

  const lifecycleMappings = resolveOwnedValue(ledger, "lifecycleMappings", {
    machineDefault: {
      claimLabel: null,
      readyLabel: null,
      prTitlePrefixes: {},
      branchPrefix: null,
    },
    layers: [{ level: "repository_policy", value: repoPolicy.lifecycleMappings }],
    detailFor: () => `Issue and pull-request lifecycle mappings come from ${repoOrigin}.`,
  });

  const verificationRoles = resolveVerificationRoles(ledger, {
    repositoryValue: repoPolicy.verificationRoles,
    perRunValue: perRun.verificationRoles,
    repositoryOrigin: repoOrigin,
    rejections,
  });

  const repoPaths = Array.isArray(repoPolicy.pathRules?.protectedPaths) ? repoPolicy.pathRules.protectedPaths : [];
  const pathRules = ledger.record("pathRules", {
    value: {
      protectedPaths: [...new Set([...PROTECTED_INVARIANTS.alwaysProtectedPaths, ...repoPaths])],
      writableRoots: repoPolicy.pathRules?.writableRoots || null,
    },
    source: repoPaths.length ? "repository_policy" : "protected_invariant",
    detail: repoPaths.length
      ? `Repository added ${repoPaths.length} protected path rules on top of the bridge floor.`
      : "Only the protected path floor applies; a repository may add rules but never remove one.",
  });

  const resourceRules = resolveResourceRules(ledger, {
    repositoryValue: repoPolicy.resourceRules,
    perRunValue: perRun.resourceRules,
    repositoryOrigin: repoOrigin,
    rejections,
  });

  // --- Merge enforcement ---------------------------------------------------
  const configuredMerge = resolveMergeEnforcementMode(ledger, {
    machineValue: apps?.github?.mergeEnforcement,
    machineOrigin: identities.configPath || "machine GitHub App configuration",
    repositoryValue: repoPolicy.mergeEnforcement,
    perRunValue: perRun.mergeEnforcement,
    repositoryOrigin: repoOrigin,
    rejections,
  });
  const merge = configuredMerge.value !== "broker" && mergeCapabilities == null
    ? {
        configuredMode: configuredMerge.value,
        effectiveMode: null,
        verified: false,
        blocked: true,
        downgraded: false,
        verificationSource: "not-inspected",
        reason: `GitHub ${configuredMerge.value} enforcement is configured but repository capabilities were not inspected.`,
      }
    : resolveGitHubMergeEnforcement({ configuredMode: configuredMerge.value, capabilities: mergeCapabilities || {} });
  ledger.record("mergeEnforcement", {
    value: merge,
    source: configuredMerge.source,
    detail: merge.reason,
  });

  const policy = {
    version: DELIVERY_POLICY_VERSION,
    workspace: absWorkspace,
    deliveryProfile,
    sources: {
      repositoryPolicy: repository.path,
      modelPolicy: modelPolicyPath || null,
      providerConcurrency: concurrencyPath,
      githubApps: identities.configPath,
      workspaceRecipe: recipe.projectPath,
      workspaceRecipeApprovals: recipe.approvalsPath,
    },
    protectedInvariants: PROTECTED_INVARIANTS,
    ownership: { machine: MACHINE_OWNED_DOMAINS, repository: REPOSITORY_OWNED_DOMAINS, perRun: ["narrowing"] },
    identities,
    writerProviders,
    deniedModels,
    concurrency,
    productFacts,
    lifecycleMappings,
    verificationRoles,
    pathRules,
    resourceRules,
    workspaceRecipe: ledger.decisions.workspaceRecipe.value,
    merge,
    rejections,
    decisions: ledger.decisions,
  };
  policy.surfaces = deliverySurfaces(policy);
  // Retained alias: earlier consumers read `provenance` and `securityRejections`.
  policy.provenance = ledger.decisions;
  policy.securityRejections = rejections;
  return policy;
}

// ---------------------------------------------------------------------------
// Per-surface views
// ---------------------------------------------------------------------------

/** The exact slice each consuming subsystem reads. */
export function deliverySurfaces(policy) {
  const githubGoverned = policy.deliveryProfile === "github-governed";
  return {
    collaboration: {
      deliveryProfile: policy.deliveryProfile,
      writerProviders: policy.writerProviders,
      deniedModels: policy.deniedModels,
      humanEscalationCategories: policy.protectedInvariants.humanEscalationCategories,
      claudeFableRequiresExplicitRequest: true,
    },
    scheduling: {
      concurrency: policy.concurrency,
      maxParallelLanes: policy.resourceRules.maxParallelLanes,
      writerProviders: policy.writerProviders,
    },
    publication: {
      enabled: githubGoverned,
      defaultBranch: policy.productFacts.defaultBranch,
      branchPrefix: policy.lifecycleMappings.branchPrefix,
      prTitlePrefixes: policy.lifecycleMappings.prTitlePrefixes,
      labels: policy.productFacts.labels,
      builderLogin: policy.identities.builder.login,
      reason: githubGoverned ? null : "local-only delivery: publish handoffs locally and leave GitHub untouched.",
    },
    review: {
      publishStatus: githubGoverned,
      requiredStatusContext: "agent-review",
      exactHeadRequired: policy.protectedInvariants.exactHeadReviewGateRequired,
      reviewerLogins: Object.fromEntries(Object.entries(policy.identities.reviewers).map(([provider, entry]) => [provider, entry.login])),
      verificationRoles: policy.verificationRoles,
    },
    merge: {
      enabled: githubGoverned,
      enforcement: policy.merge,
      autonomousMergeRepositories: policy.identities.autonomousMergeRepositories,
      trustedHumanReviewers: policy.identities.trustedHumanReviewers,
      botApprovalNeverSatisfiesHumanApproval: policy.protectedInvariants.botApprovalNeverSatisfiesHumanApproval,
    },
    cleanup: {
      preRetireRecipe: policy.workspaceRecipe.phases.preRetire,
      protectedPaths: policy.pathRules.protectedPaths,
      requiresGitHubRetirementCheck: githubGoverned,
    },
    missionControl: {
      deliveryProfile: policy.deliveryProfile,
      deliveryProfileSource: policy.decisions.deliveryProfile.source,
      concurrency: policy.concurrency,
      rejectionCount: policy.rejections.length,
      repositoryPolicyPath: policy.sources.repositoryPolicy,
    },
  };
}

/** One consuming subsystem's slice, resolved on demand. */
export async function deliveryPolicyForSurface(surface, input = {}) {
  const policy = await resolveDeliveryPolicy(input);
  const selected = policy.surfaces[surface];
  if (!selected) throw new Error(`Unknown delivery surface: ${surface}. Expected one of ${Object.keys(policy.surfaces).join(", ")}.`);
  return { surface, deliveryProfile: policy.deliveryProfile, workspace: policy.workspace, policy: selected, decisions: policy.decisions };
}

// ---------------------------------------------------------------------------
// Explain output
// ---------------------------------------------------------------------------

/** Stable machine-readable explain document. */
export function deliveryPolicyExplainDocument(policy) {
  return {
    version: policy.version,
    workspace: policy.workspace,
    deliveryProfile: policy.deliveryProfile,
    precedence: PRECEDENCE_LEVELS,
    ownership: policy.ownership,
    sources: policy.sources,
    decisions: Object.values(policy.decisions).map((decision) => ({
      key: decision.key,
      value: decision.value,
      source: decision.source,
      detail: decision.detail,
      considered: decision.considered || [],
    })),
    rejections: policy.rejections,
    surfaces: policy.surfaces,
  };
}

function formatValue(value) {
  if (value === null || value === undefined) return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Human-readable or JSON explain output for `bridge policy explain`. */
export function explainDeliveryPolicy(policy, { format = "human" } = {}) {
  const document = deliveryPolicyExplainDocument(policy);
  if (format === "json") return JSON.stringify(document, null, 2);
  if (format !== "human") throw new Error(`Unsupported explain format: ${format}. Expected human or json.`);

  const lines = [];
  lines.push("Delivery policy");
  lines.push(`  Workspace:        ${document.workspace}`);
  lines.push(`  Delivery profile: ${document.deliveryProfile} [${policy.decisions.deliveryProfile.source}]`);
  lines.push(`                    ${policy.decisions.deliveryProfile.detail}`);
  lines.push("");
  lines.push(`Precedence (weakest to strongest authority): ${PRECEDENCE_LEVELS.join(" > ")}`);
  lines.push(`  Machine owns:    ${document.ownership.machine.join(", ")}`);
  lines.push(`  Repository owns: ${document.ownership.repository.join(", ")}`);
  lines.push("  Per-run input may narrow these values and may never broaden them.");
  lines.push("");
  lines.push("Sources");
  for (const [name, path] of Object.entries(document.sources)) {
    lines.push(`  ${name.padEnd(24)} ${path || "(absent)"}`);
  }
  lines.push("");
  lines.push("Effective decisions");
  for (const decision of document.decisions) {
    if (decision.key === "protectedInvariants") continue;
    lines.push(`  ${decision.key} = ${formatValue(decision.value)}`);
    lines.push(`    source: ${decision.source} — ${decision.detail}`);
    const ignored = (decision.considered || []).filter((entry) => entry.applied === false);
    for (const entry of ignored) {
      lines.push(`    ignored: ${entry.level} proposed ${formatValue(entry.value)}`);
    }
  }
  lines.push("");
  if (document.rejections.length) {
    lines.push(`Rejected configuration (${document.rejections.length})`);
    for (const rejection of document.rejections) {
      lines.push(`  [rejected] ${rejection.field} (${rejection.origin})`);
      lines.push(`    ${rejection.reason}`);
    }
  } else {
    lines.push("Rejected configuration: none");
  }
  lines.push("");
  lines.push("Consuming surfaces");
  for (const [surface, view] of Object.entries(document.surfaces)) {
    const enabled = view.enabled === undefined ? "" : view.enabled ? " (enabled)" : " (disabled)";
    lines.push(`  ${surface}${enabled}`);
  }
  return lines.join("\n");
}

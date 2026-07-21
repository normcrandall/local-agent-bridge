import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const MODEL_PROVIDERS = ["claude", "codex", "antigravity", "ollama"];
export const DEFAULT_MODEL_POLICY_CONFIG = resolve(
  homedir(),
  ".config/local-agent-bridge/model-policy.json",
);

function configPath(path) {
  return path || process.env.AGENT_BRIDGE_MODEL_POLICY_CONFIG || DEFAULT_MODEL_POLICY_CONFIG;
}

export function normalizeModelProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!MODEL_PROVIDERS.includes(provider)) {
    throw new Error(`Provider must be one of ${MODEL_PROVIDERS.join(", ")}.`);
  }
  return provider;
}

export function normalizeModelName(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Model must be a non-empty name.");
  return value.trim();
}

function sameModel(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function disabledMatch(provider, candidate, disabledModel) {
  if (provider === "claude" && disabledModel.toLowerCase() === "fable") {
    return candidate.toLowerCase().includes("fable");
  }
  return sameModel(candidate, disabledModel);
}

function emptyProviders() {
  return Object.fromEntries(MODEL_PROVIDERS.map((provider) => [provider, { disabledModels: [] }]));
}

export function loadModelPolicy({ path } = {}) {
  const resolvedPath = configPath(path);
  if (!existsSync(resolvedPath)) {
    return { version: 1, providers: emptyProviders() };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse model policy ${resolvedPath}: ${error.message}`);
  }
  if (parsed.version !== 1) throw new Error(`Unsupported model policy version in ${resolvedPath}.`);
  const providers = emptyProviders();
  for (const provider of MODEL_PROVIDERS) {
    const disabledModels = parsed.providers?.[provider]?.disabledModels || [];
    if (!Array.isArray(disabledModels)) {
      throw new Error(`providers.${provider}.disabledModels in ${resolvedPath} must be an array.`);
    }
    for (const value of disabledModels) {
      const model = normalizeModelName(value);
      if (!providers[provider].disabledModels.some((entry) => sameModel(entry, model))) {
        providers[provider].disabledModels.push(model);
      }
    }
  }
  return { version: 1, providers };
}

export function writeModelPolicy(policy, { path } = {}) {
  const resolvedPath = configPath(path);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const temporary = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, resolvedPath);
    chmodSync(resolvedPath, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return resolvedPath;
}

export function updateModelPolicy(action, providerValue, modelValue, { path } = {}) {
  if (!["disable", "enable"].includes(action)) throw new Error("Model policy action must be disable or enable.");
  const provider = normalizeModelProvider(providerValue);
  const model = normalizeModelName(modelValue);
  const policy = loadModelPolicy({ path });
  const current = policy.providers[provider].disabledModels;
  const index = current.findIndex((entry) => sameModel(entry, model));
  const changed = action === "disable" ? index === -1 : index !== -1;
  if (action === "disable" && index === -1) current.push(model);
  if (action === "enable" && index !== -1) current.splice(index, 1);
  writeModelPolicy(policy, { path });
  return { changed, provider, model, ...modelPolicyStatus({ path }) };
}

export function modelPolicyStatus({ path } = {}) {
  const resolvedPath = configPath(path);
  const policy = loadModelPolicy({ path: resolvedPath });
  return {
    configPath: resolvedPath,
    providers: policy.providers,
    builtInGuards: {
      claude: ["fable requires explicit per-request authorization"],
      codex: [],
      antigravity: [],
      ollama: [],
    },
  };
}

export function resolveModelRoute({
  provider: providerValue,
  model,
  configuredModel,
  fallbackModels = [],
  policyPath,
} = {}) {
  const provider = normalizeModelProvider(providerValue);
  if (!Array.isArray(fallbackModels)) throw new Error("fallbackModels must be an array of model names.");
  const requested = typeof model === "string" && model.trim() ? model.trim() : null;
  const configured = typeof configuredModel === "string" && configuredModel.trim()
    ? configuredModel.trim()
    : null;
  const disabledModels = loadModelPolicy({ path: policyPath }).providers[provider].disabledModels;
  // Preserve the provider's normal default-selection behavior until this provider
  // actually has a machine deny rule. Once a deny exists, materialize a discoverable
  // configured model so the bridge can enforce the rule before process launch.
  const effectiveConfigured = disabledModels.length ? configured : null;
  const primary = requested || effectiveConfigured;
  const normalizedFallbacks = [];
  for (const value of fallbackModels) {
    const candidate = normalizeModelName(value);
    if (primary && sameModel(primary, candidate)) continue;
    if (!normalizedFallbacks.some((entry) => sameModel(entry, candidate))) normalizedFallbacks.push(candidate);
  }
  const isDisabled = (candidate) => disabledModels.some((entry) => disabledMatch(provider, candidate, entry));
  const blockedModels = [];
  let selected = primary;
  if (selected && isDisabled(selected)) {
    blockedModels.push(selected);
    selected = null;
  }
  const allowedFallbacks = normalizedFallbacks.filter((candidate) => {
    if (!isDisabled(candidate)) return true;
    blockedModels.push(candidate);
    return false;
  });
  let source = requested ? "requested" : effectiveConfigured ? "configured" : "provider-default";
  if (!selected && primary) {
    selected = allowedFallbacks.shift() || null;
    source = "fallback";
    if (!selected) {
      throw new Error(
        `Machine model policy disables every requested ${provider} model: ${blockedModels.join(", ")}. Run bridge models status or enable an allowed model.`,
      );
    }
  }
  return {
    model: selected,
    fallbackModels: allowedFallbacks,
    blockedModels: [...new Set(blockedModels)],
    disabledModels,
    source,
  };
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_MODEL_FALLBACKS_CONFIG = resolve(
  homedir(),
  ".config/local-agent-bridge/model-fallbacks.json",
);

export function normalizeFallbackModels(values, source = "fallbackModels") {
  if (!Array.isArray(values)) throw new Error(`${source} must be an array of model names.`);
  if (values.length > 5) throw new Error(`${source} supports at most five fallback models.`);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${source} entries must be non-empty model names.`);
    }
    return value.trim();
  });
  return [...new Set(normalized)];
}

export function loadConfiguredFallbackModels(provider, {
  configPath = process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG || DEFAULT_MODEL_FALLBACKS_CONFIG,
} = {}) {
  if (!existsSync(configPath)) return [];
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse model fallback config ${configPath}: ${error.message}`);
  }
  if (config.version !== 1) throw new Error(`Unsupported model fallback config version in ${configPath}.`);
  return normalizeFallbackModels(
    config.providers?.[provider]?.fallbackModels || [],
    `providers.${provider}.fallbackModels in ${configPath}`,
  );
}

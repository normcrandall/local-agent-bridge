import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_NON_FABLE_CLAUDE_MODEL = "claude-opus-4-8[1m]";

export function isFableModel(value) {
  return typeof value === "string" && value.toLowerCase().includes("fable");
}

function modelFromSettings(path) {
  if (!existsSync(path)) return null;
  try {
    const model = JSON.parse(readFileSync(path, "utf8"))?.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

export function loadConfiguredClaudeModel({
  cwd = process.cwd(),
  home = homedir(),
  environment = process.env,
} = {}) {
  for (const name of ["ANTHROPIC_MODEL", "CLAUDE_MODEL", "CLAUDE_CODE_MODEL"]) {
    const value = environment[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const path of [
    resolve(cwd, ".claude/settings.local.json"),
    resolve(cwd, ".claude/settings.json"),
    resolve(home, ".claude/settings.json"),
  ]) {
    const model = modelFromSettings(path);
    if (model) return model;
  }
  return null;
}

export function resolveClaudeModelPolicy({
  model,
  fallbackModels = [],
  allowFable = false,
  configuredModel = null,
  replacementModel = process.env.AGENT_BRIDGE_CLAUDE_NON_FABLE_MODEL || DEFAULT_NON_FABLE_CLAUDE_MODEL,
} = {}) {
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : null;
  const savedModel = typeof configuredModel === "string" && configuredModel.trim() ? configuredModel.trim() : null;
  const normalizedFallbacks = [...new Set(fallbackModels.map((value) => value.trim()))];
  if (allowFable) {
    return {
      model: requestedModel || savedModel || null,
      fallbackModels: normalizedFallbacks,
      allowFable: true,
      blockedModels: [],
      source: requestedModel ? "requested" : savedModel ? "configured" : "provider-default",
    };
  }

  const candidate = requestedModel || savedModel;
  const blockedModels = [];
  let selectedModel = candidate || replacementModel;
  if (isFableModel(selectedModel)) {
    blockedModels.push(selectedModel);
    selectedModel = replacementModel;
  }
  const filteredFallbacks = normalizedFallbacks.filter((value) => {
    if (!isFableModel(value)) return true;
    blockedModels.push(value);
    return false;
  });
  if (isFableModel(selectedModel)) {
    throw new Error("AGENT_BRIDGE_CLAUDE_NON_FABLE_MODEL must not resolve to Fable.");
  }
  return {
    model: selectedModel,
    fallbackModels: filteredFallbacks,
    allowFable: false,
    blockedModels: [...new Set(blockedModels)],
    source: requestedModel ? "requested" : savedModel ? "configured" : "bridge-default",
  };
}

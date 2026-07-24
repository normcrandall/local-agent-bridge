import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfiguredCodexModel, loadConfiguredAntigravityModel } from "./provider-model-settings.mjs";
import { configuredModelFallbacksPath, loadConfiguredFallbackModels } from "./model-fallbacks.mjs";
import { DEFAULT_PROVIDER_CONCURRENCY_CONFIG, loadProviderConcurrency } from "./provider-concurrency.mjs";
import { DEFAULT_GITHUB_APPS_CONFIG, inspectGitHubAppRoles } from "./github-app-auth.mjs";

export async function effectiveBridgeConfig({ workspace = process.cwd(), home = homedir(), environment = process.env } = {}) {
  const fallbackPath = configuredModelFallbacksPath();
  const fallbacks = {};
  for (const provider of ["claude", "codex", "antigravity", "docker", "ollama"]) {
    try { fallbacks[provider] = loadConfiguredFallbackModels(provider, { configPath: fallbackPath }); }
    catch (error) { fallbacks[provider] = { error: error.message }; }
  }
  return {
    version: 1,
    workspace: resolve(workspace),
    models: {
      codex: { value: loadConfiguredCodexModel({ home, environment }), source: environment.CODEX_MODEL ? "CODEX_MODEL" : resolve(environment.CODEX_HOME || resolve(home, ".codex"), "config.toml") },
      antigravity: { value: loadConfiguredAntigravityModel({ environment }), source: ["AGY_MODEL", "ANTIGRAVITY_MODEL", "GEMINI_MODEL"].find((name) => environment[name]) || "provider default" },
      claude: { value: null, source: "provider configured; Fable denied unless explicitly requested" },
    },
    modelFallbacks: { path: fallbackPath, providers: fallbacks },
    providerConcurrency: { path: environment.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG || DEFAULT_PROVIDER_CONCURRENCY_CONFIG, providers: await loadProviderConcurrency() },
    githubApps: await inspectGitHubAppRoles({ configPath: environment.AGENT_BRIDGE_GITHUB_APPS_CONFIG || DEFAULT_GITHUB_APPS_CONFIG }),
    workspaceRecipes: {
      project: resolve(workspace, ".agent-bridge/workspace-recipes.json"),
      approvals: resolve(home, ".config/local-agent-bridge/workspace-recipe-approvals.json"),
    },
  };
}

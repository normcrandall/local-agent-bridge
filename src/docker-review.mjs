import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runLocalReview } from "./ollama-review.mjs";

export const DEFAULT_DOCKER_MODEL_RUNNER_CONFIG = resolve(
  homedir(),
  ".config/local-agent-bridge/docker-model-runner.json",
);
export const DEFAULT_DOCKER_MODEL_RUNNER_MODEL = "ai/qwen2.5-coder";
export const DEFAULT_DOCKER_MODEL_RUNNER_BASE_URL = "http://127.0.0.1:12434";

function normalizedBaseUrl(value) {
  const raw = String(value || DEFAULT_DOCKER_MODEL_RUNNER_BASE_URL).trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Docker Model Runner must use a loopback address because its local API is unauthenticated.");
  }
  return url.toString().replace(/\/$/, "");
}

export async function loadDockerModelRunnerConfig({
  configPath = process.env.AGENT_BRIDGE_DOCKER_MODEL_RUNNER_CONFIG || DEFAULT_DOCKER_MODEL_RUNNER_CONFIG,
  environment = process.env,
} = {}) {
  let configured = {};
  try {
    configured = JSON.parse(await readFile(configPath, "utf8"));
    if (configured.version !== 1) throw new Error("Unsupported Docker Model Runner config version.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Unable to read Docker Model Runner config at ${configPath}: ${error.message}`);
    }
  }
  const model = String(
    environment.DOCKER_MODEL_RUNNER_MODEL
      || configured.model
      || DEFAULT_DOCKER_MODEL_RUNNER_MODEL,
  ).trim();
  if (!model) throw new Error("Docker Model Runner model must not be empty.");
  return {
    model,
    baseUrl: normalizedBaseUrl(
      environment.DOCKER_MODEL_RUNNER_HOST
        || configured.baseUrl
        || DEFAULT_DOCKER_MODEL_RUNNER_BASE_URL,
    ),
    configPath,
    configured: Boolean(configured.version),
  };
}

function equivalentModelName(left, right) {
  const normalize = (value) => String(value || "")
    .replace(/^docker\.io\//, "")
    .replace(/:latest$/, "")
    .toLowerCase();
  return normalize(left) === normalize(right);
}

export async function probeDockerModelRunner({ model, baseUrl, fetchImpl = fetch } = {}) {
  const configuration = await loadDockerModelRunnerConfig();
  const selectedModel = model || configuration.model;
  const selectedBaseUrl = normalizedBaseUrl(baseUrl || configuration.baseUrl);
  const response = await fetchImpl(`${selectedBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Docker Model Runner health check returned HTTP ${response.status}.`);
  const payload = await response.json();
  const models = (payload.models || []).map((entry) => entry.name || entry.model).filter(Boolean);
  if (!models.some((installed) => equivalentModelName(installed, selectedModel))) {
    throw new Error(
      `Docker Model Runner model ${selectedModel} is not installed. Run: docker model pull ${selectedModel}`,
    );
  }
  return { available: true, model: selectedModel, baseUrl: selectedBaseUrl, installedModels: models };
}

export async function runDockerModelReview(options = {}) {
  const configuration = await loadDockerModelRunnerConfig();
  return runLocalReview({
    ...options,
    provider: "docker",
    providerLabel: "Docker Model Runner",
    configuration,
    think: options.think ?? false,
  });
}

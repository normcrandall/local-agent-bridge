import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runLocalReview } from "./ollama-review.mjs";

export const DEFAULT_DOCKER_MODEL_RUNNER_CONFIG = resolve(
  homedir(),
  ".config/local-agent-bridge/docker-model-runner.json",
);
export const DEFAULT_DOCKER_MODEL_RUNNER_MODEL = "ai/qwen3.6";
export const DEFAULT_DOCKER_MODEL_RUNNER_BASE_URL = "http://127.0.0.1:12434";

const DOCKER_CONTRACT_PROBE_TOOL = {
  type: "function",
  function: {
    name: "bridge_contract_probe",
    description: "Confirm that Docker Model Runner preserves tool calls in its Ollama-compatible chat response.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

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

export async function probeDockerModelRunner({ model, baseUrl, fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const configuration = await loadDockerModelRunnerConfig();
  const selectedModel = model || configuration.model;
  const selectedBaseUrl = normalizedBaseUrl(baseUrl || configuration.baseUrl);
  const response = await fetchImpl(`${selectedBaseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
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

export async function probeDockerModelRunnerContract({
  model,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  const health = await probeDockerModelRunner({ model, baseUrl, fetchImpl, timeoutMs });
  const response = await fetchImpl(`${health.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: health.model,
      messages: [{ role: "user", content: "Call bridge_contract_probe exactly once. Do not answer in text." }],
      tools: [DOCKER_CONTRACT_PROBE_TOOL],
      stream: false,
      think: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Docker Model Runner chat contract probe returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!payload?.message) {
    throw new Error("Docker Model Runner chat contract probe returned no assistant message.");
  }
  const calls = payload.message.tool_calls;
  if (!Array.isArray(calls) || !calls.some((call) => call?.function?.name === "bridge_contract_probe")) {
    throw new Error("Docker Model Runner chat contract probe did not preserve the requested tool call.");
  }
  return { ...health, chatCompatible: true, toolCallingCompatible: true };
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

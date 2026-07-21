import { probeDockerModelRunner } from "./docker-review.mjs";

export const OLLAMA_DOCKER_PRIORITY_MESSAGE =
  "Ollama is disabled while Docker Model Runner is available. Use the Docker local reviewer instead.";

export const OLLAMA_DOCKER_PROBE_TIMEOUT_MS = 1_500;

export async function availableDockerReviewer({ probeDocker = probeDockerModelRunner } = {}) {
  try {
    return await probeDocker({ timeoutMs: OLLAMA_DOCKER_PROBE_TIMEOUT_MS });
  } catch (error) {
    return {
      available: false,
      reason: error?.message || String(error),
    };
  }
}

export async function assertOllamaFallbackAllowed(options = {}) {
  const docker = await availableDockerReviewer(options);
  if (docker?.available) {
    throw new Error(OLLAMA_DOCKER_PRIORITY_MESSAGE);
  }
  return {
    allowed: true,
    dockerUnavailableReason: docker?.reason || "Docker Model Runner did not report an available reviewer.",
  };
}

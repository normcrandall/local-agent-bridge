import { probeDockerModelRunner } from "./docker-review.mjs";

export const OLLAMA_DOCKER_PRIORITY_MESSAGE =
  "Ollama is disabled while Docker Model Runner is available. Use the Docker local reviewer instead.";

export async function availableDockerReviewer({ probeDocker = probeDockerModelRunner } = {}) {
  try {
    return await probeDocker();
  } catch {
    return null;
  }
}

export async function assertOllamaFallbackAllowed(options = {}) {
  const docker = await availableDockerReviewer(options);
  if (docker?.available) {
    throw new Error(OLLAMA_DOCKER_PRIORITY_MESSAGE);
  }
  return true;
}

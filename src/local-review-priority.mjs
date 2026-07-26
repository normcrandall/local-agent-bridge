import { probeDockerModelRunner } from "./docker-review.mjs";
import { OLLAMA_PROBE_TIMEOUT_MS } from "./ollama-review.mjs";

export const OLLAMA_DOCKER_PRIORITY_MESSAGE =
  "Ollama is disabled while Docker Model Runner is available. Use the Docker local reviewer instead.";

export const OLLAMA_DOCKER_PROBE_TIMEOUT_MS = 1_500;
export const LOCAL_REVIEW_PREFLIGHT_BUDGET_MS = 7_000;
export const OLLAMA_FALLBACK_PREFLIGHT_MAX_MS =
  OLLAMA_DOCKER_PROBE_TIMEOUT_MS + OLLAMA_PROBE_TIMEOUT_MS;

export function classifyDockerProbeFailure(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "").toLowerCase();
  const causeName = String(error?.cause?.name || "").toLowerCase();

  if (name.includes("timeout") || causeName.includes("timeout") || name === "aborterror" || causeName === "aborterror"
    || code === "ETIMEDOUT" || /timed?\s*out/.test(message)) {
    return "probe_timeout";
  }
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND"].includes(code)
    || /econnrefused|connection refused|fetch failed|socket hang up/.test(message)) {
    return "service_unreachable";
  }
  if (/model .*not installed|docker model pull/.test(message)) return "model_unavailable";
  if (/health check returned http/.test(message)) return "health_check_failed";
  if (/unable to read docker model runner config at|loopback address|model must not be empty|unsupported .* version/.test(message)) {
    return "configuration_error";
  }
  return "probe_failed";
}

export async function availableDockerReviewer({ probeDocker = probeDockerModelRunner } = {}) {
  try {
    return await probeDocker({ timeoutMs: OLLAMA_DOCKER_PROBE_TIMEOUT_MS });
  } catch (error) {
    return {
      available: false,
      reason: classifyDockerProbeFailure(error),
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

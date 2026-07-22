import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDockerModelRunnerConfig, probeDockerModelRunner } from "./docker-review.mjs";
import { DEFAULT_LOCAL_MODEL_KEEP_ALIVE, loadOllamaConfig, probeOllama } from "./ollama-review.mjs";

const run = promisify(execFile);
export const DEFAULT_MODEL_WARM_INTERVAL_MS = 4 * 60 * 1000;

async function warmDockerModel(model) {
  await run(process.env.DOCKER_BIN || "docker", ["model", "run", "--detach", model], { timeout: 120_000 });
}

async function warmOllamaModel(model, baseUrl, keepAlive) {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: keepAlive }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama warm request returned HTTP ${response.status}.`);
  await response.text();
}

export function createLocalModelWarmer({
  enabled = process.env.AGENT_BRIDGE_KEEP_MODELS_WARM === "1"
    || (process.env.AGENT_BRIDGE_KEEP_MODELS_WARM !== "0" && process.env.AGENT_BRIDGE_TEST_MODE !== "1"),
  intervalMs = Number(process.env.AGENT_BRIDGE_MODEL_WARM_INTERVAL_MS || DEFAULT_MODEL_WARM_INTERVAL_MS),
  keepAlive = process.env.AGENT_BRIDGE_LOCAL_MODEL_KEEP_ALIVE || DEFAULT_LOCAL_MODEL_KEEP_ALIVE,
  dockerProbe = async () => {
    const configuration = await loadDockerModelRunnerConfig();
    return probeDockerModelRunner(configuration);
  },
  dockerWarm = warmDockerModel,
  ollamaProbe = async () => {
    const configuration = await loadOllamaConfig();
    return probeOllama(configuration);
  },
  ollamaWarm = warmOllamaModel,
  onStatus = () => {},
} = {}) {
  let timer = null;
  let inFlight = null;
  let latest = { status: enabled ? "idle" : "disabled", provider: null, at: new Date().toISOString() };

  const publish = (status) => {
    latest = { ...status, at: new Date().toISOString() };
    onStatus(latest);
    return latest;
  };

  async function runTick() {
    if (!enabled) return publish({ status: "disabled", provider: null });
    let docker;
    try {
      docker = await dockerProbe();
    } catch (dockerError) {
      try {
        const ollama = await ollamaProbe();
        await ollamaWarm(ollama.model, ollama.baseUrl, keepAlive);
        return publish({ status: "warm", provider: "ollama", model: ollama.model, keepAlive, dockerUnavailable: dockerError.message });
      } catch (ollamaError) {
        return publish({ status: "unavailable", provider: null, dockerError: dockerError.message, ollamaError: ollamaError.message });
      }
    }
    try {
      await dockerWarm(docker.model);
      return publish({ status: "warm", provider: "docker", model: docker.model, keepAlive });
    } catch (error) {
      // Docker remains the selected route when its API preflight succeeded. Do not
      // warm Ollama merely because the optional preload command failed.
      return publish({ status: "degraded", provider: "docker", model: docker.model, keepAlive, error: error.message });
    }
  }

  function tick() {
    if (!inFlight) {
      inFlight = runTick().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function start() {
    void tick();
    if (enabled && Number.isFinite(intervalMs) && intervalMs > 0 && !timer) {
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    }
    return { stop, tick, status: () => ({ ...latest }) };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, status: () => ({ ...latest }) };
}

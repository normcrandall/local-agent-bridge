import assert from "node:assert/strict";
import { createLocalModelWarmer } from "../src/local-model-warmth.mjs";

const dockerCalls = [];
const dockerFirst = createLocalModelWarmer({
  dockerProbe: async () => ({ available: true, model: "ai/qwen3.6" }),
  dockerWarm: async (model) => dockerCalls.push(model),
  ollamaProbe: async () => { throw new Error("must not probe Ollama"); },
  ollamaWarm: async () => { throw new Error("must not warm Ollama"); },
});
assert.equal((await dockerFirst.tick()).provider, "docker");
assert.deepEqual(dockerCalls, ["ai/qwen3.6"]);

const ollamaCalls = [];
const fallback = createLocalModelWarmer({
  dockerProbe: async () => { throw new Error("Docker unavailable"); },
  dockerWarm: async () => { throw new Error("must not warm unavailable Docker"); },
  ollamaProbe: async () => ({ available: true, model: "qwen3.6:latest", baseUrl: "http://127.0.0.1:11434" }),
  ollamaWarm: async (model, baseUrl, keepAlive) => ollamaCalls.push({ model, baseUrl, keepAlive }),
  keepAlive: "30m",
});
assert.equal((await fallback.tick()).provider, "ollama");
assert.deepEqual(ollamaCalls, [{ model: "qwen3.6:latest", baseUrl: "http://127.0.0.1:11434", keepAlive: "30m" }]);

const disabled = createLocalModelWarmer({ enabled: false });
assert.equal((await disabled.tick()).status, "disabled");

console.log("Local model warmth tests passed.");

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveModelRoute, updateModelPolicy } from "../src/model-policy.mjs";
import { explainDeliveryPolicy, resolveDeliveryPolicy } from "../src/delivery-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "bridge-model-policy-test-"));
const configPath = join(temporary, "nested", "model-policy.json");
const environment = {
  ...process.env,
  AGENT_BRIDGE_MODEL_POLICY_CONFIG: configPath,
};

function bridge(...args) {
  return execFileSync(resolve(root, "bridge"), args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
}

try {
  const empty = JSON.parse(bridge("models", "status"));
  assert.equal(empty.configPath, configPath);
  assert.deepEqual(empty.providers, {
    claude: { disabledModels: [] },
    codex: { disabledModels: [] },
    antigravity: { disabledModels: [] },
    ollama: { disabledModels: [] },
    docker: { disabledModels: [] },
  });
  assert.deepEqual(empty.builtInGuards.claude, ["fable requires explicit per-request authorization"]);

  const disabled = JSON.parse(bridge("models", "disable", "claude", "fable"));
  assert.equal(disabled.changed, true);
  assert.deepEqual(disabled.providers.claude.disabledModels, ["fable"]);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const duplicate = JSON.parse(bridge("models", "disable", "CLAUDE", " FABLE "));
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.providers.claude.disabledModels, ["fable"]);

  bridge("models", "disable", "codex", "gpt-5.6-sol");
  const status = JSON.parse(bridge("models", "status"));
  assert.deepEqual(status.providers.codex.disabledModels, ["gpt-5.6-sol"]);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).version, 1);

  const enabled = JSON.parse(bridge("models", "enable", "claude", "Fable"));
  assert.equal(enabled.changed, true);
  assert.deepEqual(enabled.providers.claude.disabledModels, []);

  const invalid = spawnSync(resolve(root, "bridge"), ["models", "disable", "other", "model"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /provider must be one of claude, codex, antigravity, docker, ollama/i);

  updateModelPolicy("disable", "claude", "fable", { path: configPath });
  const claudeRoute = resolveModelRoute({
    provider: "claude",
    model: "claude-fable-5",
    fallbackModels: ["claude-opus-4-8[1m]", "FABLE"],
    policyPath: configPath,
  });
  assert.equal(claudeRoute.model, "claude-opus-4-8[1m]");
  assert.deepEqual(claudeRoute.fallbackModels, []);
  assert.deepEqual(claudeRoute.blockedModels, ["claude-fable-5", "FABLE"]);

  const codexRoute = resolveModelRoute({
    provider: "codex",
    configuredModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-terra", "GPT-5.6-SOL"],
    policyPath: configPath,
  });
  assert.equal(codexRoute.model, "gpt-5.6-terra");
  assert.deepEqual(codexRoute.fallbackModels, []);
  assert.equal(codexRoute.source, "fallback");

  updateModelPolicy("disable", "antigravity", "Gemini 3.1 Pro (High)", { path: configPath });
  assert.throws(() => resolveModelRoute({
    provider: "antigravity",
    model: "Gemini 3.1 Pro (High)",
    fallbackModels: ["gemini 3.1 pro (high)"],
    policyPath: configPath,
  }), /disables every requested antigravity model/i);

  updateModelPolicy("disable", "ollama", "gemma4:latest", { path: configPath });
  const ollamaRoute = resolveModelRoute({
    provider: "ollama",
    configuredModel: "gemma4:latest",
    fallbackModels: ["gemma4:31b"],
    policyPath: configPath,
  });
  assert.equal(ollamaRoute.model, "gemma4:31b");
  updateModelPolicy("disable", "docker", "ai/qwen2.5-coder", { path: configPath });
  const dockerRoute = resolveModelRoute({
    provider: "docker",
    configuredModel: "ai/qwen2.5-coder",
    fallbackModels: ["ai/qwen3-coder"],
    policyPath: configPath,
  });
  assert.equal(dockerRoute.model, "ai/qwen3-coder");

  // The delivery policy resolver is the composition layer over this machine model policy.
  // Verify here that machine denials reach it intact and that a repository can only narrow.
  const workspace = join(temporary, "repo");
  mkdirSync(join(workspace, ".agent-bridge"), { recursive: true });
  writeFileSync(join(workspace, ".agent-bridge/delivery-policy.json"), JSON.stringify({
    version: 1,
    deniedModels: { docker: ["ai/qwen3-coder"] },
    providerConcurrency: { claude: { work: 99 } },
    privateKeyPath: "/tmp/builder.pem",
  }));
  const deliveryEnvironment = {
    AGENT_BRIDGE_MODEL_POLICY_CONFIG: configPath,
    AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG: join(temporary, "absent-concurrency.json"),
    AGENT_BRIDGE_GITHUB_APPS_CONFIG: join(temporary, "absent-apps.json"),
  };
  const delivery = await resolveDeliveryPolicy({
    workspace,
    home: join(temporary, "home"),
    environment: deliveryEnvironment,
  });
  assert.ok(delivery.deniedModels.ollama.includes("gemma4:latest"));
  assert.ok(delivery.deniedModels.docker.includes("ai/qwen2.5-coder"));
  assert.ok(delivery.deniedModels.docker.includes("ai/qwen3-coder"));
  assert.equal(delivery.deliveryProfile, "local-only");
  assert.equal(delivery.concurrency.claude.work, 5);
  assert.equal(delivery.decisions["concurrency.claude.work"].source, "machine_default");
  assert.ok(delivery.rejections.some((entry) => entry.field === "privateKeyPath"));
  assert.equal(JSON.parse(explainDeliveryPolicy(delivery, { format: "json" })).deliveryProfile, "local-only");
  const explained = explainDeliveryPolicy(delivery, { format: "human" });
  assert.match(explained, /Delivery profile: local-only \[machine_default\]/);
  assert.match(explained, /ignored: repository_policy proposed 99/);
  assert.match(explained, /\[rejected\] privateKeyPath/);
  assert.match(explained, /deniedModels\.docker = ai\/qwen2\.5-coder, ai\/qwen3-coder/);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Model policy CLI tests passed: machine-wide disable, enable, status, validation, and owner-only persistence.");

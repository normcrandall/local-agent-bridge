import { createHash } from "node:crypto";
import { join } from "node:path";
import process from "node:process";

const WORKER_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY", "BROWSER", "CI", "COLORTERM", "EDITOR", "FORCE_COLOR",
  "HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LANGUAGE", "LOGNAME",
  "NO_COLOR", "NO_PROXY", "PATH", "SHELL", "SSH_AUTH_SOCK", "TEMP", "TERM",
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TMP", "TMPDIR", "USER", "VISUAL",
  "CLOUD_ML_REGION",
  "all_proxy", "http_proxy", "https_proxy", "no_proxy",
]);

const WORKER_ENVIRONMENT_PREFIXES = [
  "AGENT_BRIDGE_", "AGY_", "ANTHROPIC_", "ANTIGRAVITY_", "ASDF_", "AWS_", "BRIDGE_",
  "CLAUDE_", "CLOUDSDK_", "CODEX_", "CURL_CA_", "GEMINI_", "GH_", "GITHUB_",
  "GIT_", "GOOGLE_", "LC_", "MCP_", "NODE_", "NPM_", "NVM_", "OPENAI_",
  "PNPM_", "SSL_CERT_", "VERTEX_", "XDG_", "npm_",
];

function workerEnvironmentKeyAllowed(key, environment) {
  if (WORKER_ENVIRONMENT_KEYS.has(key)) return true;
  if (WORKER_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return environment.AGENT_BRIDGE_TEST_MODE === "1" && key.startsWith("FAKE_");
}

export function sanitizeWorkerEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker environment must be a string map.");
  }
  let bytes = 0;
  const sanitized = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!key || key.includes("\0") || typeof entryValue !== "string" || entryValue.includes("\0")) {
      throw new Error("Worker environment contains an invalid entry.");
    }
    if (!workerEnvironmentKeyAllowed(key, value)) continue;
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entryValue);
    if (bytes > 128_000) throw new Error("Worker environment exceeded the size limit.");
    sanitized[key] = entryValue;
  }
  return sanitized;
}

export function supervisorEndpoint(stateDirectory) {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\agent-bridge-${digest}`;
  }
  return join(stateDirectory, "supervisor.sock");
}

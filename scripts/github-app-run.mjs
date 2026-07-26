#!/usr/bin/env node

import { createInstallationToken, loadPatFallbackToken } from "../src/github-app-auth.mjs";
import {
  executeWithPermissionFallback,
  isGitHubAppPermissionError,
  patFallbackPolicy,
  runCredentialCommand,
} from "../src/github-command-fallback.mjs";

const separator = process.argv.indexOf("--");
const roleArgument = process.argv[2];
const repository = process.argv[3];
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!roleArgument || !repository || !command.length) {
  console.error("Usage: npm run github-app:run -- ROLE[:PROVIDER] OWNER/REPO -- COMMAND [ARGS...]");
  process.exit(2);
}

const [role, provider, ...extraRoleParts] = roleArgument.split(":");
if (!["builder", "reviewer"].includes(role)
  || extraRoleParts.length
  || (provider && !["claude", "codex", "antigravity", "docker", "ollama"].includes(provider))
  || (role === "builder" && ["docker", "ollama"].includes(provider))) {
  console.error("ROLE must be builder, builder:claude, builder:codex, builder:antigravity, reviewer, or reviewer:PROVIDER.");
  process.exit(2);
}

let credential;
try {
  credential = await createInstallationToken({
    role,
    reviewerProvider: role === "reviewer" ? provider : undefined,
    writerProvider: role === "builder" ? provider : undefined,
    repository,
  });
} catch (error) {
  if (!isGitHubAppPermissionError(error.message)) throw error;
  const policy = patFallbackPolicy(command);
  if (!policy.allowed) {
    throw new Error(`GitHub App permission check failed; PAT fallback blocked: ${policy.reason}`);
  }
  const fallback = await loadPatFallbackToken();
  console.error("GitHub App permission check failed; running the same command with the configured PAT fallback.");
  const result = await runCredentialCommand({ command, token: fallback.token });
  process.exitCode = result.code;
}

if (credential) {
  const result = await executeWithPermissionFallback({
    command,
    appToken: credential.token,
    loadFallbackToken: () => loadPatFallbackToken(),
  });
  process.exitCode = result.code;
}

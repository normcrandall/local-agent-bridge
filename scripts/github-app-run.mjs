#!/usr/bin/env node

import { createInstallationToken, loadPatFallbackToken } from "../src/github-app-auth.mjs";
import { executeWithPermissionFallback, isGitHubAppPermissionError, runCredentialCommand } from "../src/github-command-fallback.mjs";

const separator = process.argv.indexOf("--");
const roleArgument = process.argv[2];
const repository = process.argv[3];
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!roleArgument || !repository || !command.length) {
  console.error("Usage: npm run github-app:run -- ROLE[:PROVIDER] OWNER/REPO -- COMMAND [ARGS...]");
  process.exit(2);
}

const [role, reviewerProvider, ...extraRoleParts] = roleArgument.split(":");
if (!["builder", "reviewer"].includes(role)
  || extraRoleParts.length
  || (role === "builder" && reviewerProvider)
  || (role === "reviewer" && reviewerProvider && !["claude", "codex", "antigravity"].includes(reviewerProvider))) {
  console.error("ROLE must be builder, reviewer, reviewer:claude, reviewer:codex, or reviewer:antigravity.");
  process.exit(2);
}

let credential;
try {
  credential = await createInstallationToken({ role, reviewerProvider, repository });
} catch (error) {
  if (!isGitHubAppPermissionError(error.message)) throw error;
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

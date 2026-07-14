#!/usr/bin/env node

import { createInstallationToken, loadPatFallbackToken } from "../src/github-app-auth.mjs";
import { executeWithPermissionFallback, isGitHubAppPermissionError, runCredentialCommand } from "../src/github-command-fallback.mjs";

const separator = process.argv.indexOf("--");
const role = process.argv[2];
const repository = process.argv[3];
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!role || !repository || !command.length) {
  console.error("Usage: npm run github-app:run -- ROLE OWNER/REPO -- COMMAND [ARGS...]");
  process.exit(2);
}

let credential;
try {
  credential = await createInstallationToken({ role, repository });
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

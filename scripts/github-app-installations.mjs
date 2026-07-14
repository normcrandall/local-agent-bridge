#!/usr/bin/env node

import { listGitHubAppInstallations } from "../src/github-app-auth.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const appId = option("--app-id");
const privateKeyPath = option("--private-key");
if (!appId || !privateKeyPath) {
  console.error("Usage: npm run github-app:installations -- --app-id APP_ID --private-key PATH");
  process.exit(2);
}

const installations = await listGitHubAppInstallations({ appId, privateKeyPath });
for (const installation of installations) {
  console.log(`${installation.account}\t${installation.installationId}\t${installation.repositorySelection}`);
}

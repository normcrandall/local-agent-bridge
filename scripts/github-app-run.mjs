#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInstallationToken } from "../src/github-app-auth.mjs";

const separator = process.argv.indexOf("--");
const role = process.argv[2];
const repository = process.argv[3];
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!role || !repository || !command.length) {
  console.error("Usage: npm run github-app:run -- ROLE OWNER/REPO -- COMMAND [ARGS...]");
  process.exit(2);
}

const credential = await createInstallationToken({ role, repository });
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...process.env, GH_TOKEN: credential.token, GITHUB_TOKEN: credential.token },
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

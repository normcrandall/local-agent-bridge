#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const failureFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
if (failureFile && existsSync(failureFile)) {
  rmSync(failureFile, { force: true });
  process.exit(75);
}

const result = spawnSync("/bin/ps", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);

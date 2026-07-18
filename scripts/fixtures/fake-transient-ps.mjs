#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const failureFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
const logFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG;
if (logFile) appendFileSync(logFile, `${process.argv.slice(2).join(" ")}\n`);
if (failureFile && existsSync(failureFile)) {
  const raw = readFileSync(failureFile, "utf8").trim();
  let failure = null;
  try {
    failure = JSON.parse(raw);
  } catch {}
  const pidIndex = process.argv.indexOf("-p");
  const requestedPid = pidIndex >= 0 ? Number.parseInt(process.argv[pidIndex + 1], 10) : null;
  if (!failure || typeof failure !== "object") {
    rmSync(failureFile, { force: true });
    process.exit(75);
  }
  if ((!failure.pid || failure.pid === requestedPid) && failure.remaining > 0) {
    failure.remaining -= 1;
    if (failure.remaining > 0) writeFileSync(failureFile, `${JSON.stringify(failure)}\n`);
    else rmSync(failureFile, { force: true });
    process.exit(75);
  }
}

const result = spawnSync("/bin/ps", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);

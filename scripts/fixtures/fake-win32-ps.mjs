#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const failureFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
const logFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG;
const changeTitleMs = process.env.BRIDGE_SUPERVISOR_TEST_CHANGE_TITLE_MS;

if (logFile) appendFileSync(logFile, `${process.argv.slice(2).join(" ")}\n`);

if (failureFile && existsSync(failureFile)) {
  const raw = readFileSync(failureFile, "utf8").trim();
  let failure = null;
  try { failure = JSON.parse(raw); } catch {}
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

const pidIndex = process.argv.indexOf("-p");
const requestedPid = pidIndex >= 0 ? Number.parseInt(process.argv[pidIndex + 1], 10) : null;
const fieldIndex = process.argv.indexOf("-o");
const fieldSpec = fieldIndex >= 0 ? process.argv[fieldIndex + 1] : "";

if (fieldSpec.includes("command")) {
  if (changeTitleMs && requestedPid) {
    // Return mismatched command after delay simulation
    process.stdout.write("C:\\Windows\\System32\\cmd.exe\n");
    process.exit(0);
  }
  const workerScript = process.env.BRIDGE_SUPERVISOR_WORKER_PATH
    ? process.env.BRIDGE_SUPERVISOR_WORKER_PATH.split("/").pop().split("\\").pop()
    : "collaboration-worker.mjs";
  process.stdout.write(`node.exe C:\\bridge\\scripts\\${workerScript} bridge-00000000-0000-4000-8000-000000000072\n`);
  process.exit(0);
}

if (fieldSpec.includes("lstart")) {
  process.stdout.write("2026-07-26T05:00:00.000Z\n");
  process.exit(0);
}

process.exit(1);

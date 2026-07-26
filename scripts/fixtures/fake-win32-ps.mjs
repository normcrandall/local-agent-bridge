#!/usr/bin/env node

// Stands in for Windows process identity probing in two shapes:
//   ps form:         -p <pid> -o <field>=            (BRIDGE_SUPERVISOR_PS_BIN)
//   PowerShell form: -Command <Win32_Process script> (BRIDGE_SUPERVISOR_POWERSHELL_BIN)
// The PowerShell form lets the win32 branch of processProbe run on POSIX so its argv,
// ConvertTo-Json parsing, caching, and retry behaviour are covered off Windows.

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const failureFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_FAILURE_FILE;
const logFile = process.env.BRIDGE_SUPERVISOR_TEST_PS_LOG;
const mismatchFile = process.env.BRIDGE_SUPERVISOR_TEST_MISMATCH_FILE;
const malformedFile = process.env.BRIDGE_SUPERVISOR_TEST_MALFORMED_FILE;

const argv = process.argv.slice(2);
if (logFile) appendFileSync(logFile, `${argv.join(" ")}\n`);

const commandIndex = argv.indexOf("-Command");
const powershellForm = commandIndex >= 0;
const script = powershellForm ? argv[commandIndex + 1] || "" : "";

const pidIndex = argv.indexOf("-p");
const requestedPid = powershellForm
  ? Number.parseInt(script.match(/ProcessId\s*=\s*(\d+)/)?.[1] ?? "", 10)
  : (pidIndex >= 0 ? Number.parseInt(argv[pidIndex + 1], 10) : null);

const fieldIndex = argv.indexOf("-o");
const fieldSpec = fieldIndex >= 0 ? argv[fieldIndex + 1] : "";

if (failureFile && existsSync(failureFile)) {
  const raw = readFileSync(failureFile, "utf8").trim();
  let failure = null;
  try { failure = JSON.parse(raw); } catch {}
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

const workerScript = process.env.BRIDGE_SUPERVISOR_WORKER_PATH
  ? process.env.BRIDGE_SUPERVISOR_WORKER_PATH.split("/").pop().split("\\").pop()
  : "collaboration-worker.mjs";
const mismatched = Boolean(mismatchFile && existsSync(mismatchFile));
const commandValue = mismatched
  ? "C:\\Windows\\System32\\cmd.exe"
  : `node.exe C:\\bridge\\scripts\\${workerScript} bridge-00000000-0000-4000-8000-000000000072`;
const creationDate = "2026-07-26T05:00:00.0000000-04:00";

if (powershellForm) {
  // A PID with no matching process yields empty stdout at exit 0, exactly as PowerShell does.
  if (!Number.isInteger(requestedPid)) process.exit(0);
  if (malformedFile && existsSync(malformedFile)) {
    process.stdout.write("{ this is not json\n");
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ CommandLine: commandValue, CreationDate: creationDate })}\n`);
  process.exit(0);
}

if (fieldSpec.includes("command")) {
  process.stdout.write(`${commandValue}\n`);
  process.exit(0);
}

if (fieldSpec.includes("lstart")) {
  process.stdout.write(`${creationDate}\n`);
  process.exit(0);
}

process.exit(1);

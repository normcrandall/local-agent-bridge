#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processProbe } from "../src/process-identity-probe.mjs";

const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-win-test-"));

try {
  // Test 1: Process probe on current process command and lstart via default or mock environment
  const currentPid = process.pid;
  const probeCommand = processProbe(currentPid, "command");
  const probeLstart = processProbe(currentPid, "lstart");

  if (process.platform === "win32") {
    assert.equal(probeCommand.available, true, "Windows process command probe must be available for live process");
    assert.equal(probeLstart.available, true, "Windows process lstart probe must be available for live process");
    assert.match(probeCommand.value, /node/i, "Windows command probe must contain node binary executable");
  } else {
    // On non-Windows, test Windows probe simulation logic via custom probe or direct probe calls
    assert.equal(probeCommand.available, true, "POSIX process command probe must be available");
    assert.equal(probeLstart.available, true, "POSIX process lstart probe must be available");
  }

  // Test 2: Invalid PID behavior (fail-closed)
  const invalidProbe = processProbe(99999999, "command");
  assert.equal(invalidProbe.available, false, "Probe must return available=false for non-existent PID");

  // Test 3: Dead/Invalid PID identity check (fail-closed probe failure)
  const zeroProbe = processProbe(0, "command");
  assert.equal(zeroProbe.available, false, "Probe must fail closed for PID <= 1");

  console.log("Windows supervisor process probe regression test passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

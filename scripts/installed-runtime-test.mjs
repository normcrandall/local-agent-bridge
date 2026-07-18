#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const sourceRoot = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-installed-runtime-"));
const runtimeRoot = join(temporary, "runtime");

try {
  for (const name of ["src", "scripts", "package.json", "package-lock.json"]) {
    await cp(resolve(sourceRoot, name), resolve(runtimeRoot, name), { recursive: true });
  }
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: runtimeRoot,
    stdio: "ignore",
  });
  execFileSync(process.execPath, [resolve(runtimeRoot, "scripts/smoke-test.mjs")], {
    cwd: runtimeRoot,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot },
    stdio: "inherit",
  });
  console.log("Installed runtime smoke test passed without relying on source-control metadata.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

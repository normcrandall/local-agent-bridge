#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  buildProvenance,
  computeRuntimeDigest,
  inspectSource,
  writeInstalledProvenance,
} from "../src/runtime-provenance.mjs";

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
  const nestedCaller = resolve(sourceRoot, "src");
  await mkdir(nestedCaller, { recursive: true });
  const source = await inspectSource({ sourceRoot });
  const provenanceSource = {
    ...source,
    root: resolve(temporary, "installer-workspace-that-moved"),
    commit: execFileSync("git", ["rev-parse", "origin/main"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    dirty: false,
    dirtyEntries: [],
  };
  await writeInstalledProvenance(runtimeRoot, buildProvenance({
    source: provenanceSource,
    installedAt: new Date().toISOString(),
    digest: await computeRuntimeDigest(runtimeRoot),
    entries: ["src", "scripts", "package.json", "package-lock.json"],
  }));
  execFileSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: {
      ...process.env,
      AGENT_BRIDGE_INSTALLED_RUNTIME_ROOT: runtimeRoot,
      AGENT_BRIDGE_DOCTOR_CHECKS: [
        "Codex project config",
        "Claude project config",
        "Global runtime provenance",
        "Global runtime integrity",
        "Global runtime drift from main",
      ].join(","),
    },
    stdio: "inherit",
  });
  console.log("Installed runtime smoke test passed without relying on source-control metadata.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

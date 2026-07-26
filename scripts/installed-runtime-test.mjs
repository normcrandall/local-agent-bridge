#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const checkoutRoot = join(temporary, "fetchless-checkout");
const isolatedGitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args) {
  return execFileSync("git", args, {
    cwd: checkoutRoot,
    encoding: "utf8",
    env: isolatedGitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

  await mkdir(resolve(checkoutRoot, "src"), { recursive: true });
  await cp(resolve(sourceRoot, ".codex"), resolve(checkoutRoot, ".codex"), { recursive: true });
  await cp(resolve(sourceRoot, ".mcp.json"), resolve(checkoutRoot, ".mcp.json"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Installed Runtime Test"]);
  git(["config", "user.email", "installed-runtime-test@example.invalid"]);
  await writeFile(resolve(checkoutRoot, "src/base.txt"), "installed\n");
  git(["add", "."]);
  git(["commit", "-m", "installed runtime source"]);
  const installedCommit = git(["rev-parse", "HEAD"]);
  await writeFile(resolve(checkoutRoot, "src/main.txt"), "main advanced\n");
  git(["add", "."]);
  git(["commit", "-m", "advance main"]);

  const missingRemoteMain = spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], {
    cwd: checkoutRoot,
    encoding: "utf8",
    env: isolatedGitEnvironment,
  });
  assert.notEqual(missingRemoteMain.status, 0,
    "the portability fixture must not accidentally gain an origin/main ref");

  // Keep a second commit reachable only by object id so the negative assertion
  // proves local main ancestry, rather than merely proving that a ref exists.
  git(["switch", "--detach", installedCommit]);
  await writeFile(resolve(checkoutRoot, "src/diverged.txt"), "not on main\n");
  git(["add", "."]);
  git(["commit", "-m", "diverge from main"]);
  const divergedCommit = git(["rev-parse", "HEAD"]);
  git(["switch", "main"]);

  const nestedCaller = resolve(checkoutRoot, "src");
  const source = await inspectSource({ sourceRoot: checkoutRoot });
  const provenanceSource = {
    ...source,
    commit: installedCommit,
    dirty: false,
    dirtyEntries: [],
  };
  await writeInstalledProvenance(runtimeRoot, buildProvenance({
    source: provenanceSource,
    installedAt: new Date().toISOString(),
    digest: await computeRuntimeDigest(runtimeRoot),
    entries: ["src", "scripts", "package.json", "package-lock.json"],
  }));
  const doctorEnvironment = {
    ...process.env,
    AGENT_BRIDGE_INSTALLED_RUNTIME_ROOT: runtimeRoot,
    AGENT_BRIDGE_DOCTOR_CHECKS: [
      "Codex project config",
      "Claude project config",
      "Global runtime provenance",
      "Global runtime integrity",
      "Global runtime drift from main",
    ].join(","),
  };
  delete doctorEnvironment.AGENT_BRIDGE_WORKSPACE;
  execFileSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: doctorEnvironment,
    stdio: "inherit",
  });

  await writeInstalledProvenance(runtimeRoot, buildProvenance({
    source: { ...provenanceSource, commit: divergedCommit },
    installedAt: new Date().toISOString(),
    digest: await computeRuntimeDigest(runtimeRoot),
    entries: ["src", "scripts", "package.json", "package-lock.json"],
  }));
  const driftedRuntime = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: { ...doctorEnvironment, AGENT_BRIDGE_DOCTOR_CHECKS: "Global runtime drift from main" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(driftedRuntime.status, 1,
    "a remote-free checkout must still reject an installed commit that is not contained in local main");
  assert.match(driftedRuntime.stderr, /not contained in main/,
    "the failure should retain the concrete unmerged-runtime diagnosis");

  await writeInstalledProvenance(runtimeRoot, buildProvenance({
    source: provenanceSource,
    installedAt: new Date().toISOString(),
    digest: await computeRuntimeDigest(runtimeRoot),
    entries: ["src", "scripts", "package.json", "package-lock.json"],
  }));
  const explicitWorkspaceEnvironment = {
    ...doctorEnvironment,
    AGENT_BRIDGE_WORKSPACE: nestedCaller,
    AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
  };
  const explicitWorkspace = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: checkoutRoot,
    env: explicitWorkspaceEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(explicitWorkspace.status, 1,
    `an explicit nested workspace must fail closed instead of silently adopting its parent repository: ${explicitWorkspace.stdout}`);
  assert.match(explicitWorkspace.stderr, /\.codex\/config\.toml|\.mcp\.json/,
    "the failure should identify a missing project-scoped configuration");
  console.log("Installed runtime smoke test passed with a fetch-less checkout and retained drift rejection.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

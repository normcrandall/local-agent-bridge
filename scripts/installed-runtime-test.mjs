#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
for (const inherited of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
]) {
  delete isolatedGitEnvironment[inherited];
}

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
  assert.equal(missingRemoteMain.error, undefined,
    "the portability fixture must be able to run git before checking for origin/main");
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
    root: resolve(temporary, "installer-workspace-that-moved"),
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
    ...isolatedGitEnvironment,
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
  assert.match(driftedRuntime.stderr, new RegExp(divergedCommit),
    "the failure should identify the exact unmerged installed commit");

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
  const outsideRepository = resolve(temporary, "outside-repository");
  await mkdir(resolve(outsideRepository, ".codex"), { recursive: true });
  await writeFile(resolve(outsideRepository, ".codex/config.toml"), "# test\n");
  await writeFile(resolve(outsideRepository, ".mcp.json"), "{}\n");
  const outsideRun = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: outsideRepository,
    env: {
      ...doctorEnvironment,
      PWD: outsideRepository,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(outsideRun.status, 0, outsideRun.stderr);
  assert.match(outsideRun.stdout, new RegExp(`Workspace: implicit cwd ${outsideRepository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; no enclosing Git worktree found`),
    "doctor should disclose that an outside-repository cwd remains the effective workspace");

  const fakeHome = resolve(temporary, "home-repository");
  const nestedHomeCaller = resolve(fakeHome, "projects/application");
  await mkdir(resolve(fakeHome, ".codex"), { recursive: true });
  await mkdir(nestedHomeCaller, { recursive: true });
  await writeFile(resolve(fakeHome, ".codex/config.toml"), "# dotfiles\n");
  await writeFile(resolve(fakeHome, ".mcp.json"), "{}\n");
  execFileSync("git", ["init", "-q"], { cwd: fakeHome });
  const homeBoundaryRun = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedHomeCaller,
    env: {
      ...doctorEnvironment,
      HOME: fakeHome,
      PWD: nestedHomeCaller,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(homeBoundaryRun.status, 1,
    "a dotfiles repository rooted at HOME must not silently become a nested caller's workspace");
  assert.match(homeBoundaryRun.stdout, /home-directory repository boundary/,
    "doctor should disclose why it refused the home-root rewrite");
  assert.match(homeBoundaryRun.stderr, /projects\/application\/\.codex\/config\.toml|projects\/application\/\.mcp\.json/,
    "project checks should remain bound to the nested caller");

  const missingHome = resolve(temporary, "missing-home");
  const missingHomeRun = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: {
      ...doctorEnvironment,
      HOME: missingHome,
      PWD: nestedCaller,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(missingHomeRun.signal, null, "an unresolvable HOME must not crash doctor during module initialization");
  assert.equal(missingHomeRun.status, 1,
    "doctor must retain the nested caller when it cannot verify the home-directory repository boundary");
  assert.match(missingHomeRun.stdout, /home-directory repository boundary could not be verified/,
    "doctor should disclose why an unresolvable HOME prevented normalization");
  assert.doesNotMatch(missingHomeRun.stderr, /ENOENT|uncaught/i,
    "an unresolvable HOME should produce normal failed checks rather than an import-time exception");

  const redirectedGitRun = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: {
      ...doctorEnvironment,
      PWD: nestedCaller,
      GIT_DIR: resolve(fakeHome, ".git"),
      GIT_WORK_TREE: fakeHome,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(redirectedGitRun.status, 0, redirectedGitRun.stderr);
  assert.match(redirectedGitRun.stdout, /normalized to Git top-level/,
    "doctor should ignore inherited Git repository-location variables during implicit discovery");
  assert.match(redirectedGitRun.stdout, new RegExp(checkoutRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "doctor should normalize to the caller's repository rather than the inherited GIT_WORK_TREE");

  const symlinkCaller = resolve(temporary, "logical-workspace");
  await symlink(nestedCaller, symlinkCaller);
  const symlinkBoundaryRun = spawnSync(process.execPath, [resolve(runtimeRoot, "scripts/doctor.mjs")], {
    cwd: nestedCaller,
    env: {
      ...doctorEnvironment,
      PWD: symlinkCaller,
      AGENT_BRIDGE_DOCTOR_CHECKS: "Codex project config,Claude project config",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(symlinkBoundaryRun.status, 0, symlinkBoundaryRun.stderr);
  assert.match(symlinkBoundaryRun.stdout, /normalized to Git top-level/,
    "a safe logical symlink cwd should normalize after resolved-path containment succeeds");
  console.log("Installed runtime smoke test passed with a fetch-less checkout, retained drift rejection, and bounded implicit workspace discovery.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

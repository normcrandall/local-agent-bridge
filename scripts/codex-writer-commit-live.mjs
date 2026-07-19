#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWriterCheckout } from "../src/writer-checkout.mjs";

if (process.env.AGENT_BRIDGE_LIVE_CODEX_WRITER !== "1") {
  console.log("Skipped live Codex writer commit probe; set AGENT_BRIDGE_LIVE_CODEX_WRITER=1 to run it.");
  process.exit(0);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function findCodex() {
  const candidates = [
    process.env.CODEX_BRIDGE_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".codex/plugins/.plugin-appserver/codex"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("A Codex binary is required for the live writer commit probe.");
  return executable;
}

const temporary = mkdtempSync(join(tmpdir(), "bridge-live-codex-writer-"));
const repository = join(temporary, "repository");
const remote = join(temporary, "remote.git");
mkdirSync(repository);

try {
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Bridge Live Test");
  git(repository, "config", "user.email", "bridge-live@example.invalid");
  writeFileSync(join(repository, "README.md"), "live writer probe\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial live probe");
  git(temporary, "init", "--bare", remote);
  git(repository, "remote", "add", "origin", remote);
  const sourceHead = git(repository, "rev-parse", "HEAD");

  const checkout = prepareWriterCheckout({
    workspace: repository,
    taskId: "live-codex-writer",
    branch: "codex/live-writer-commit",
    base: sourceHead,
    checkoutRoot: join(temporary, "writer-checkouts"),
  });
  const writableRoots = JSON.stringify([checkout.gitMetadataRoot]);
  const prompt = [
    "This is a deterministic bridge acceptance probe.",
    "Create a file named .bridge-live-writer containing exactly: delegated commit succeeded",
    "Then run git add .bridge-live-writer and git commit -m 'Verify delegated writer commit'.",
    "Do not modify any other file and do not push.",
  ].join("\n");
  const result = spawnSync(findCodex(), [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "--cd", checkout.path,
    "--config", 'approval_policy="never"',
    "--config", `sandbox_workspace_write.writable_roots=${writableRoots}`,
    prompt,
  ], {
    cwd: checkout.path,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Codex exited with ${result.status}`);
  }

  const writerHead = git(checkout.path, "rev-parse", "HEAD");
  assert.notEqual(writerHead, sourceHead);
  assert.equal(git(checkout.path, "show", `${writerHead}:.bridge-live-writer`), "delegated commit succeeded");
  assert.equal(git(repository, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(checkout.path, "rev-parse", "--git-common-dir"), ".git");
  console.log(`Live Codex writer commit probe passed at ${writerHead}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

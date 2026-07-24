#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspaceSweep, runWorkspaceRecipe, sanitizedRecipeEnvironment, workspaceRecipePlan } from "../src/workspace-operations.mjs";
import { createPortfolio } from "../src/portfolio-store.mjs";
import { inspectPortfolioConflict } from "../src/conflict-inspection.mjs";

const root = await mkdtemp(join(tmpdir(), "bridge-workspace-ops-"));
const repository = join(root, "repo");
const home = join(root, "home");
const stateRoot = join(root, "state");
const portfolioRoot = join(stateRoot, "portfolios");

try {
  await mkdir(repository);
  await mkdir(join(repository, ".agent-bridge"), { recursive: true });
  await mkdir(join(home, ".config/local-agent-bridge"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Bridge Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "bridge@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });

  const command = `node -e "require('node:fs').writeFileSync('recipe-ran','ok')"`;
  await writeFile(join(repository, ".agent-bridge/workspace-recipes.json"), `${JSON.stringify({ version: 1, phases: { postCreate: [command] } }, null, 2)}\n`);
  const approvalsPath = join(home, ".config/local-agent-bridge/workspace-recipe-approvals.json");
  await writeFile(approvalsPath, `${JSON.stringify({ version: 1, workspaces: { [repository]: { postCreate: [command] } } }, null, 2)}\n`);
  const plan = workspaceRecipePlan(repository, "postCreate", { home, approvalsPath });
  assert.equal(plan.executable, true);
  const receipt = runWorkspaceRecipe(repository, "postCreate", { home, approvalsPath });
  assert.equal(receipt.ok, true);
  assert.equal(await readFile(join(repository, "recipe-ran"), "utf8"), "ok");
  await rm(join(repository, "recipe-ran"));
  const recipeEnvironment = sanitizedRecipeEnvironment({ PATH: process.env.PATH, HOME: home, GITHUB_TOKEN: "must-not-leak", BRIDGE_GITHUB_APP_PRIVATE_KEY: "/secret/key.pem" });
  assert.equal(recipeEnvironment.GITHUB_TOKEN, undefined);
  assert.equal(recipeEnvironment.BRIDGE_GITHUB_APP_PRIVATE_KEY, undefined);

  const worktree = join(root, "feature-worktree");
  execFileSync("git", ["worktree", "add", "-qb", "feature", worktree], { cwd: repository });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/feature", head], { cwd: repository });
  const unverifiedSweep = await auditWorkspaceSweep(repository, { stateRoot });
  assert.equal(unverifiedSweep.worktrees[0].safeToQuarantine, false);
  assert.equal(unverifiedSweep.worktrees[0].reason, "github_retirement_unverified");
  const sweep = await auditWorkspaceSweep(repository, { stateRoot, retiredHeads: [head] });
  assert.equal(sweep.dryRun, true);
  assert.equal(sweep.worktrees[0].safeToQuarantine, true);
  assert.equal(sweep.worktrees[0].reason, "retirement_and_recoverability_proven");

  await mkdir(portfolioRoot, { recursive: true });
  const dossier = { itemId: "issue-1", classification: "semantic", files: ["src/example.mjs"], currentIntent: "Preserve A", incomingIntent: "Add B", acceptanceCriteria: ["Both behaviors remain"] };
  const portfolio = await createPortfolio(portfolioRoot, {
    workspace: repository,
    items: [{ id: "issue-1", status: "arbitrating", worktree, branch: "feature", headSha: head }],
    mergeTrain: { targetBranch: "main", targetSha: head, queue: [{ itemId: "issue-1", headSha: head, status: "arbitrating", dossier }] },
  });
  const conflict = await inspectPortfolioConflict(portfolioRoot, portfolio.id, "issue-1");
  assert.equal(conflict.dossier.classification, "semantic");
  assert.match(conflict.nextAction, /exactly one authorized resolution writer/);

  console.log("Workspace operation tests passed: approved recipes, dry-run recoverability sweep, and conflict dossiers are verified.");
} finally {
  await rm(root, { recursive: true, force: true });
}

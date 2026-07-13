import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isTransportLivenessSummary,
  isSafeWorkerPid,
  createWorktree,
  exportPortableManifest,
  preflight,
  reconcileReviews,
  selectRoles,
  usageDecision,
} from "../src/operations.mjs";

assert.equal(isTransportLivenessSummary("Claude Code is still working (30s heartbeat)."), true);
assert.equal(isTransportLivenessSummary("Inspecting files; tests come next."), false);
assert.equal(isSafeWorkerPid(123), true);
assert.equal(isSafeWorkerPid(1), false);
assert.equal(isSafeWorkerPid(-1), false);

assert.deepEqual(selectRoles({ taskNumber: 0, agents: ["claude", "codex"] }), { writer: "claude", reviewers: ["codex"] });
assert.deepEqual(selectRoles({ taskNumber: 1, agents: ["claude", "codex"] }), { writer: "codex", reviewers: ["claude"] });
assert.deepEqual(selectRoles({ taskNumber: 2, agents: ["claude", "codex"] }), { writer: "claude", reviewers: ["codex"] });

const reconciled = reconcileReviews([
  { agent: "claude", findings: [{ path: "src/a.js", line: 1, title: "Validate", verdict: "accept" }] },
  { agent: "codex", findings: [{ path: "src/a.js", line: 1, title: "Validate", verdict: "reject" }] },
  { agent: "antigravity", findings: [{ path: "src/b.js", line: 2, title: "Boundary", verdict: "accept" }] },
]);
assert.equal(reconciled.disputed.length, 1);
assert.equal(reconciled.accepted.length, 1);

assert.equal(usageDecision({ usage: { claude: { costUsd: 2, tokens: 100 } }, budget: { maxCostUsd: 2 } }).exceeded, true);
assert.equal(usageDecision({ usage: { codex: { tokens: 99 } }, budget: { maxTokens: 100 } }).exceeded, false);

const temporary = mkdtempSync(join(tmpdir(), "bridge-operations-test-"));
const repo = join(temporary, "repo");
mkdirSync(repo);
try {
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Bridge Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "bridge@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "test"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: repo });
  const ready = preflight({ workspace: repo, agents: ["claude", "codex"], mode: "work", workProfile: "implement" });
  assert.equal(ready.ok, true);
  const unsafeReview = preflight({ workspace: repo, agents: [], mode: "review", permissionProfile: "yolo" });
  assert.equal(unsafeReview.checks.find((check) => check.name === "permission-profile").ok, false);
  const worktree = createWorktree({ workspace: repo, taskId: "task-12", branch: "task-12", worktreeRoot: join(temporary, "worktrees") });
  assert.equal(resolve(worktree.path), resolve(temporary, "worktrees/task-12"));
  assert.match(execFileSync("git", ["branch", "--show-current"], { cwd: worktree.path, encoding: "utf8" }), /task-12/);
  assert.throws(() => createWorktree({ workspace: repo, taskId: "--lock", branch: "task-13", worktreeRoot: join(temporary, "worktrees") }), /Unsafe/);
  const manifestPath = join(temporary, "manifest.json");
  exportPortableManifest({ destination: manifestPath, sourceRoot: repo });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.excludes.includes("provider credentials"));
  assert.deepEqual(manifest.install, ["npm ci", "npm run install:global", "npm run doctor"]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Operations suite tests passed: rotation, preflight, worktrees, reconciliation, budgets, and portability.");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  plannedIssueClaimWorktree,
  resolveClaimedWorktreeHead,
  resolveIssueClaimRevisions,
  workspaceHeadBuilderBinding,
} from "../src/collaboration-start-preflight.mjs";

const directory = await mkdtemp(join(tmpdir(), "bridge-claim-start-"));

try {
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(join(directory, "fixture.txt"), "claim preflight\n");
  assert.equal(spawnSync("git", ["add", "fixture.txt"], { cwd: directory }).status, 0);
  assert.equal(spawnSync("git", [
    "-c", "user.name=Bridge Test",
    "-c", "user.email=bridge-test@example.invalid",
    "commit", "-qm", "claim fixture",
  ], { cwd: directory }).status, 0);

  const expectedHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout.trim();
  assert.deepEqual(
    resolveIssueClaimRevisions({ workspace: directory, headSha: null, baseRef: "HEAD" }),
    { headSha: expectedHead, baseSha: expectedHead },
  );
  assert.equal(resolveClaimedWorktreeHead(directory), expectedHead);
  assert.equal(
    plannedIssueClaimWorktree({ workspace: directory, worktree: { taskId: "issue-61" }, mode: "review" }),
    resolve(directory, ".bridge/worktrees/issue-61"),
  );
  assert.equal(
    plannedIssueClaimWorktree({ workspace: directory, worktree: { taskId: "issue-61" }, mode: "work" }),
    resolve(directory, ".bridge/writer-checkouts/issue-61"),
  );
  assert.equal(
    plannedIssueClaimWorktree({
      workspace: directory,
      worktree: { taskId: "issue-61", root: join(directory, "custom") },
    }),
    resolve(directory, "custom/issue-61"),
  );
  assert.equal(plannedIssueClaimWorktree({ workspace: directory, worktree: null }), null);
  const builder = { repository: "owner/repo", headSha: expectedHead };
  assert.equal(
    workspaceHeadBuilderBinding({ githubBuilder: builder, mode: "review", worktree: { strategy: "self-contained" } }),
    builder,
  );
  assert.deepEqual(
    workspaceHeadBuilderBinding({ githubBuilder: builder, mode: "work", worktree: { strategy: "self-contained" } }),
    { ...builder, allowWorkspaceHead: true },
  );

  assert.throws(
    () => resolveIssueClaimRevisions({ workspace: directory, headSha: expectedHead, baseRef: "missing-ref" }),
    /Unable to resolve claim base revision missing-ref/,
  );

  console.log("Claimed collaboration startup preflight resolves Git revisions and worktree paths.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

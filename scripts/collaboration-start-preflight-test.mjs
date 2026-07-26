import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  plannedIssueClaimWorktree,
  resolveClaimedWorktreeHead,
  resolveContinuationIssueClaim,
  resolveIssueClaimAfterPreflight,
  resolveIssueClaimRevisions,
  workspaceHeadBuilderBinding,
} from "../src/collaboration-start-preflight.mjs";
import { collaborationIdentity } from "../src/collaboration-identity.mjs";
import {
  createCollaboration,
  findCollaborationByIdentity,
  readCollaboration,
} from "../src/collaboration-store.mjs";

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
    workspaceHeadBuilderBinding({ githubBuilder: { ...builder, allowWorkspaceHead: true }, mode: "review", worktree: { strategy: "self-contained" } }).allowWorkspaceHead,
    false,
  );
  assert.deepEqual(
    workspaceHeadBuilderBinding({ githubBuilder: builder, mode: "work", worktree: { strategy: "self-contained" } }),
    { ...builder, allowWorkspaceHead: true },
  );
  assert.equal(
    workspaceHeadBuilderBinding({ githubBuilder: { ...builder, allowWorkspaceHead: true }, mode: "work", worktree: { strategy: "linked" } }).allowWorkspaceHead,
    false,
    "caller input cannot retain workspace-head authority outside a self-contained writer checkout",
  );

  assert.throws(
    () => resolveIssueClaimRevisions({ workspace: directory, headSha: expectedHead, baseRef: "missing-ref" }),
    /Unable to resolve claim base revision missing-ref/,
  );

  const authority = {
    login: "veliqon-codex-writer[bot]",
    appId: 123,
    installationId: 456,
    repository: "owner/repo",
    permissions: { contents: "write", issues: "write" },
  };
  const resolvedClaim = resolveIssueClaimAfterPreflight({
    issueClaim: {
      repository: "owner/repo",
      issueNumber: 157,
      expectedLogin: "Veliqon-Codex-Writer",
      authority,
    },
    writer: "codex",
    branch: "codex/issue-157-canonical-claim",
    worktree: directory,
    baseSha: expectedHead,
    headSha: expectedHead,
  });
  assert.deepEqual(resolvedClaim, {
    repository: "owner/repo",
    issueNumber: 157,
    expectedLogin: "veliqon-codex-writer[bot]",
    authority,
    writer: "codex",
    branch: "codex/issue-157-canonical-claim",
    worktree: directory,
    baseSha: expectedHead,
    headSha: expectedHead,
  }, "preflight must retain verified authority while canonicalizing a bare App login");

  const identityKey = collaborationIdentity({
    workspace: directory,
    mode: "work",
    writer: "codex",
    issueClaim: resolvedClaim,
  });
  const collaborationRoot = join(directory, "state-root");
  const created = await createCollaboration(collaborationRoot, {
    identityKey,
    workspace: directory,
    mode: "work",
    writer: "codex",
    agents: ["codex"],
    issueClaim: resolvedClaim,
  });
  const restarted = await readCollaboration(collaborationRoot, created.id);
  assert.deepEqual(restarted.issueClaim, resolvedClaim,
    "initial collaboration persistence must keep the exact claim used for identity construction");
  assert.equal(collaborationIdentity({
    workspace: restarted.workspace,
    mode: restarted.mode,
    writer: restarted.writer,
    issueClaim: restarted.issueClaim,
  }), identityKey, "persisted collaboration state must reproduce the initial identity key");
  assert.equal((await findCollaborationByIdentity(collaborationRoot, identityKey)).id, created.id,
    "a restarted broker must recover the persisted collaboration by its original identity key");

  const continuedClaim = resolveContinuationIssueClaim({
    currentIssueClaim: resolvedClaim,
    issueClaim: {
      ...resolvedClaim,
      expectedLogin: "VELIQON-CODEX-WRITER[bot]",
      headSha: "b".repeat(40),
    },
  });
  assert.equal(continuedClaim.expectedLogin, "veliqon-codex-writer[bot]",
    "continuation must accept and canonicalize the suffixed App login form");
  assert.deepEqual(continuedClaim.authority, authority,
    "continuation must retain the verified claim authority");
  assert.equal(continuedClaim.headSha, "b".repeat(40),
    "continuation may refresh mutable lease coordinates");

  console.log("Claimed collaboration startup preflight resolves Git revisions and worktree paths.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

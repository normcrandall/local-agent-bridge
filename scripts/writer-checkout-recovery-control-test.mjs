import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const runtimeRoot = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "bridge-writer-recovery-control-"));
const repository = join(temporary, "repository");
const linkedWorktree = join(temporary, "linked-worktree");
const stateDirectory = join(temporary, "state");
await mkdir(repository);
await mkdir(stateDirectory);
const collaborationId = "bridge-00000000-0000-4000-8000-000000000082";

let client;
try {
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Bridge Test");
  git(repository, "config", "user.email", "bridge@example.invalid");
  await writeFile(join(repository, "tracked.txt"), "before\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "Recovery control base");
  const baseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "remote", "add", "origin", "https://example.invalid/owner/recovery-control.git");
  git(repository, "worktree", "add", "-b", "codex/recovery-control", linkedWorktree, "HEAD");
  await writeFile(join(linkedWorktree, "committed.txt"), "committed after recorded base\n");
  git(linkedWorktree, "add", "committed.txt");
  git(linkedWorktree, "commit", "-m", "Stranded writer commit");
  await writeFile(join(linkedWorktree, "tracked.txt"), "after\n");
  await writeFile(join(linkedWorktree, "untracked.txt"), "preserve me\n");
  const headSha = git(linkedWorktree, "rev-parse", "HEAD");
  const actualLinkedWorktree = await realpath(linkedWorktree);
  await writeFile(join(stateDirectory, `${collaborationId}.json`), `${JSON.stringify({
    id: collaborationId,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:01.000Z",
    status: "needs_user",
    task: "Recover a stranded writer",
    workspace: actualLinkedWorktree,
    agents: ["codex"],
    participants: ["codex"],
    startAgent: "codex",
    mode: "work",
    writer: "codex",
    worktree: { path: actualLinkedWorktree, branch: "codex/recovery-control", base: baseSha },
    runtime: { turnCount: 1, activeCall: null },
    workerPid: null,
    issueClaim: null,
  }, null, 2)}\n`);

  client = new Client({ name: "writer-recovery-control-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "/bin/zsh",
    args: [join(runtimeRoot, "scripts/collaboration-bridge-mcp.sh")],
    cwd: runtimeRoot,
    env: {
      ...process.env,
      BRIDGE_RUNTIME_ROOT: runtimeRoot,
      BRIDGE_WORKSPACE_ROOT: repository,
      BRIDGE_COLLABORATION_DIR: stateDirectory,
    },
  }));

  const stale = await client.callTool({
    name: "recover_writer_checkout",
    arguments: {
      collaborationId,
      expectedWorkspace: actualLinkedWorktree,
      expectedHeadSha: "f".repeat(40),
    },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /HEAD changed after inspection/);

  const recovered = await client.callTool({
    name: "recover_writer_checkout",
    arguments: { collaborationId, expectedWorkspace: actualLinkedWorktree, expectedHeadSha: headSha },
  });
  assert.notEqual(recovered.isError, true);
  assert.equal(recovered.structuredContent.nextAction, "continue_collaboration");
  assert.equal(recovered.structuredContent.workspaceOperation, null);
  assert.equal(recovered.structuredContent.worktree.strategy, "self-contained");
  assert.equal(recovered.structuredContent.recoveryReceipt.from, actualLinkedWorktree);
  assert.equal(git(recovered.structuredContent.workspace, "rev-parse", "--git-common-dir"), ".git");
  assert.equal(git(recovered.structuredContent.workspace, "rev-parse", "HEAD"), baseSha);
  assert.equal(recovered.structuredContent.recoveryReceipt.recordedBaseSha, baseSha);
  assert.equal(recovered.structuredContent.recoveryReceipt.sourceHeadSha, headSha);
  assert.equal(await readFile(join(recovered.structuredContent.workspace, "tracked.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(recovered.structuredContent.workspace, "committed.txt"), "utf8"), "committed after recorded base\n");
  assert.equal(await readFile(join(recovered.structuredContent.workspace, "untracked.txt"), "utf8"), "preserve me\n");
  assert.equal(await readFile(join(actualLinkedWorktree, "untracked.txt"), "utf8"), "preserve me\n");

  const reservedState = JSON.parse(await readFile(join(stateDirectory, `${collaborationId}.json`), "utf8"));
  reservedState.status = "indeterminate";
  reservedState.workspaceOperation = {
    id: "writer-cleanup-reservation-test",
    type: "cleanup_writer_checkout",
    status: "reserved",
    workspace: recovered.structuredContent.workspace,
  };
  await writeFile(join(stateDirectory, `${collaborationId}.json`), `${JSON.stringify(reservedState, null, 2)}\n`);
  const cancelledDuringReservation = await client.callTool({
    name: "cancel_collaboration",
    arguments: { collaborationId },
  });
  assert.equal(cancelledDuringReservation.isError, true);
  assert.match(cancelledDuringReservation.content[0].text, /owns the collaboration workspace/);
  const afterRefusedCancel = JSON.parse(await readFile(join(stateDirectory, `${collaborationId}.json`), "utf8"));
  assert.equal(afterRefusedCancel.status, "indeterminate");
  assert.equal(afterRefusedCancel.workspaceOperation.id, "writer-cleanup-reservation-test");
  afterRefusedCancel.status = "needs_user";
  afterRefusedCancel.workspaceOperation = null;
  await writeFile(join(stateDirectory, `${collaborationId}.json`), `${JSON.stringify(afterRefusedCancel, null, 2)}\n`);

  const dirtyCleanup = await client.callTool({
    name: "cleanup_writer_checkout",
    arguments: {
      collaborationId,
      expectedWorkspace: recovered.structuredContent.workspace,
      expectedHeadSha: baseSha,
    },
  });
  assert.equal(dirtyCleanup.isError, true);
  assert.match(dirtyCleanup.content[0].text, /uncommitted changes/);
  const afterRefusedCleanup = JSON.parse(await readFile(join(stateDirectory, `${collaborationId}.json`), "utf8"));
  assert.equal(afterRefusedCleanup.status, "needs_user");
  assert.equal(afterRefusedCleanup.workspaceOperation, null);
  assert.equal(afterRefusedCleanup.workspaceOperationFailure.operationId.startsWith("writer-cleanup-"), true);

  const cleanup = await client.callTool({
    name: "cleanup_writer_checkout",
    arguments: {
      collaborationId,
      expectedWorkspace: recovered.structuredContent.workspace,
      expectedHeadSha: baseSha,
      discardChanges: true,
    },
  });
  assert.notEqual(cleanup.isError, true);
  assert.equal(cleanup.structuredContent.cleanupReceipt.discardedChanges, true);
  await assert.rejects(access(recovered.structuredContent.workspace));
} finally {
  await client?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

console.log("Writer recovery control test passed: exact inspection gates migration and cleanup preserves dirty changes by default.");

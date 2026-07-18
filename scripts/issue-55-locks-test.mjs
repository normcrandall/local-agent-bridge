// Issue #55 fixture: deterministic release of the reaped worker's owned worker/
// workspace locks on cancel, preserving ownership guards.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releaseOwnedCollaborationLocks,
  workspaceLockPath,
} from "../src/collaboration-store.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-issue-55-locks-"));
const previousDir = process.env.BRIDGE_COLLABORATION_DIR;
process.env.BRIDGE_COLLABORATION_DIR = root;
const id = "bridge-00000000-0000-4000-8000-000000000001";
const workspace = "/tmp/issue-55-workspace";
const workerLock = join(root, `${id}.worker.lock`);
const updateLock = join(root, `${id}.update.lock`);
const workspaceLock = workspaceLockPath(root, workspace);

try {
  // Owned locks (recorded owner PID == reaped worker) are removed deterministically.
  const ownerPid = 424242;
  await writeFile(workerLock, `${ownerPid}\n`, { mode: 0o600 });
  await writeFile(updateLock, `${ownerPid}\n`, { mode: 0o600 });
  await writeFile(workspaceLock, `${ownerPid}\n`, { mode: 0o600 });
  const result = await releaseOwnedCollaborationLocks(root, {
    id,
    workspace,
    ownerPid,
    isAlive: () => false,
  });
  assert.equal(result.released.length, 3);
  assert.deepEqual(result.preserved, []);
  await assert.rejects(readFile(workerLock, "utf8"), /ENOENT/);
  await assert.rejects(readFile(updateLock, "utf8"), /ENOENT/);
  await assert.rejects(readFile(workspaceLock, "utf8"), /ENOENT/);

  // Ownership guard: a lock held by a *different live* process is preserved.
  const foreignPid = 515151;
  await writeFile(workerLock, `${foreignPid}\n`, { mode: 0o600 });
  const guarded = await releaseOwnedCollaborationLocks(root, {
    id,
    workspace,
    ownerPid: 999999,
    isAlive: (pid) => pid === foreignPid,
  });
  assert.deepEqual(guarded.released, []);
  assert.equal(guarded.preserved.length, 1);
  assert.equal(await readFile(workerLock, "utf8"), `${foreignPid}\n`);

  // A stale lock owned by a *dead* foreign process is reclaimed.
  const stale = await releaseOwnedCollaborationLocks(root, {
    id,
    workspace,
    ownerPid: 999999,
    isAlive: () => false,
  });
  assert.equal(stale.released.length, 1);
  await assert.rejects(readFile(workerLock, "utf8"), /ENOENT/);

  // Missing lock files are a no-op.
  const empty = await releaseOwnedCollaborationLocks(root, { id, workspace, ownerPid, isAlive: () => false });
  assert.deepEqual(empty.released, []);
  assert.deepEqual(empty.preserved, []);
} finally {
  if (previousDir === undefined) delete process.env.BRIDGE_COLLABORATION_DIR;
  else process.env.BRIDGE_COLLABORATION_DIR = previousDir;
  await rm(root, { recursive: true, force: true });
}

console.log("Issue #55 deterministic owned-lock release tests passed.");

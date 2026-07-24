#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collaborationAlias, collaborationIdentity } from "../src/collaboration-identity.mjs";
import { acquireIdentityLock, createCollaboration, findCollaborationByIdentity, queryControlPlane, updateCollaboration } from "../src/collaboration-store.mjs";
import { classifyWaitLane, waitForControlPlane } from "../src/control-plane-wait.mjs";

const root = await mkdtemp(join(tmpdir(), "bridge-coordination-"));
const workspace = join(root, "workspace");
const originalStateRoot = process.env.BRIDGE_COLLABORATION_DIR;
process.env.BRIDGE_COLLABORATION_DIR = root;

try {
  const binding = { repository: "veliqon/nolvaren-next", prNumber: 183, headSha: "a".repeat(40) };
  const identity = collaborationIdentity({ workspace, mode: "review", githubReview: binding });
  assert.equal(identity, collaborationIdentity({ workspace, mode: "review", githubReview: binding }));
  assert.notEqual(identity, collaborationIdentity({ workspace, mode: "review", githubReview: { ...binding, headSha: "b".repeat(40) } }));

  const id = "bridge-11111111-1111-4111-8111-111111111111";
  const state = await createCollaboration(root, {
    id,
    identityKey: identity,
    workspace,
    status: "running",
    githubReview: binding,
    agents: ["claude"],
    startAgent: "claude",
    runtime: { activeCall: { agent: "claude", heartbeatAt: new Date().toISOString() } },
  });
  assert.equal(collaborationAlias(state), "veliqon/nolvaren-next:PR-183:claude-review");
  assert.equal((await findCollaborationByIdentity(root, identity)).id, id);
  const releaseIdentity = await acquireIdentityLock(root, identity);
  let secondAcquired = false;
  const secondLock = acquireIdentityLock(root, identity).then((release) => { secondAcquired = true; return release; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  assert.equal(secondAcquired, false, "same-target starts must serialize behind the identity lock");
  await releaseIdentity();
  const releaseSecondIdentity = await secondLock;
  await releaseSecondIdentity();
  const plane = await queryControlPlane(root);
  assert.equal(plane.lanes[0].alias, "veliqon/nolvaren-next:PR-183:claude-review");

  const completion = waitForControlPlane(root, {
    handles: [plane.lanes[0].alias],
    timeoutMs: 2_000,
    intervalMs: 20,
  });
  setTimeout(() => updateCollaboration(root, id, (current) => ({ ...current, status: "agreed" })), 50);
  const completed = await completion;
  assert.equal(completed.reached, true);
  assert.deepEqual(completed.classifications, ["terminal"]);
  assert.equal(completed.changed[0], true);
  assert.equal(completed.cursor, completed.lanes[0].updatedAt);

  const unchanged = await waitForControlPlane(root, {
    handles: [plane.lanes[0].alias],
    afterUpdatedAt: completed.cursor,
    timeoutMs: 0,
  });
  assert.equal(unchanged.reached, false);
  assert.equal(unchanged.timedOut, true);
  assert.deepEqual(unchanged.changed, [false]);

  const missing = await waitForControlPlane(root, { handles: ["missing-lane"], timeoutMs: 0 });
  assert.deepEqual(missing.classifications, ["missing"]);
  await createCollaboration(root, {
    id: "bridge-11111111-2222-4222-8222-222222222222",
    workspace,
    status: "running",
    alias: plane.lanes[0].alias,
    agents: ["claude"],
  });
  await assert.rejects(() => waitForControlPlane(root, { handles: [plane.lanes[0].alias], timeoutMs: 0 }), /Ambiguous collaboration alias/);
  await assert.rejects(() => waitForControlPlane(root, { handles: ["bridge-11111111"], timeoutMs: 0 }), /Ambiguous collaboration ID prefix/);
  assert.equal(classifyWaitLane({ lifecyclePhase: "running", recovery: { processAlive: false }, heartbeat: { heartbeatAt: "2026-07-24T00:00:00.000Z" } }, { now: Date.parse("2026-07-24T00:02:00.000Z") }), "crashed");
  await assert.rejects(() => waitForControlPlane(root, { handles: [id], timeoutMs: Number.NaN }), /timeoutMs/);

  console.log("Control-plane coordination tests passed: stable identity, readable aliases, compatible lookup, and cursor-aware terminal waits are verified.");
} finally {
  if (originalStateRoot === undefined) delete process.env.BRIDGE_COLLABORATION_DIR;
  else process.env.BRIDGE_COLLABORATION_DIR = originalStateRoot;
  await rm(root, { recursive: true, force: true });
}

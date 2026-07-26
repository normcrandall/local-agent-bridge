#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLABORATION_REUSE_DIMENSIONS,
  collaborationAlias,
  collaborationIdentity,
  collaborationReuseCompatibility,
} from "../src/collaboration-identity.mjs";
import { acquireIdentityLock, archiveCollaboration, collaborationDirectory, createCollaboration, findCollaborationByIdentity, queryControlPlane, updateCollaboration } from "../src/collaboration-store.mjs";
import { classifyWaitLane, waitExitCode, waitForControlPlane } from "../src/control-plane-wait.mjs";

const root = await mkdtemp(join(tmpdir(), "bridge-coordination-"));
const workspace = join(root, "workspace");
const originalStateRoot = process.env.BRIDGE_COLLABORATION_DIR;
process.env.BRIDGE_COLLABORATION_DIR = root;

try {
  const binding = { repository: "veliqon/nolvaren-next", prNumber: 183, headSha: "a".repeat(40) };
  const reviewRequest = {
    workspace,
    mode: "review",
    agents: ["claude"],
    startAgent: "claude",
    models: { claude: "claude-opus-5" },
    modelFallbacks: { claude: ["claude-opus-4.6"] },
    handoffPath: "docs/handoffs/pr-183-claude.md",
    githubReview: { ...binding, expectedLogins: { claude: "veliqon-claude-reviewer" } },
  };
  const identity = collaborationIdentity(reviewRequest);
  assert.equal(identity, collaborationIdentity(reviewRequest));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, githubReview: { ...reviewRequest.githubReview, headSha: "b".repeat(40) } }));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, agents: ["antigravity"], startAgent: "antigravity" }), "a different requested provider must not reuse the same exact-head review");
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, agents: ["claude", "antigravity"] }), "the ordered provider roster is a compatibility dimension");
  assert.notEqual(
    collaborationIdentity({ ...reviewRequest, agents: ["claude", "antigravity"] }),
    collaborationIdentity({ ...reviewRequest, agents: ["antigravity", "claude"] }),
    "provider-roster order must remain significant",
  );
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, startAgent: "antigravity" }));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, models: { claude: "claude-opus-4.6" } }));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, modelFallbacks: { claude: [] } }));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, allowClaudeFable: true }));
  assert.notEqual(identity, collaborationIdentity({ ...reviewRequest, handoffPath: "docs/handoffs/pr-183-other.md" }));
  assert.notEqual(identity, collaborationIdentity({
    ...reviewRequest,
    githubReview: { ...reviewRequest.githubReview, expectedLogins: { claude: "other-reviewer" } },
  }));
  assert.equal(identity, collaborationIdentity({
    ...reviewRequest,
    githubReview: { ...reviewRequest.githubReview, expectedLogins: { claude: "VELIQON-CLAUDE-REVIEWER[bot]" } },
  }), "equivalent reviewer App login spellings must remain compatible");
  const claimedReviewRequest = {
    ...reviewRequest,
    issueClaim: {
      repository: "veliqon/nolvaren-next",
      issueNumber: 248,
      headSha: "c".repeat(40),
    },
  };
  const claimedReviewIdentity = collaborationIdentity(claimedReviewRequest);
  assert.notEqual(claimedReviewIdentity, collaborationIdentity({
    ...claimedReviewRequest,
    githubReview: { ...claimedReviewRequest.githubReview, headSha: "d".repeat(40) },
  }), "the exact review head must constrain reuse even when issueClaim owns the primary target identity");
  assert.notEqual(claimedReviewIdentity, collaborationIdentity({
    ...claimedReviewRequest,
    githubReview: { ...claimedReviewRequest.githubReview, prNumber: 184 },
  }), "the review PR number must constrain reuse independently of the issue claim");
  assert.notEqual(claimedReviewIdentity, collaborationIdentity({
    ...claimedReviewRequest,
    githubReview: { ...claimedReviewRequest.githubReview, repository: "veliqon/other" },
  }), "the review repository must constrain reuse independently of the issue claim");
  assert.notEqual(identity, collaborationIdentity({
    ...reviewRequest,
    agents: ["claude"],
    requestedAgents: ["codex", "claude"],
  }), "the requested roster remains distinct from the post-chair effective roster");
  assert.notEqual(identity, collaborationIdentity({
    ...reviewRequest,
    chair: { provider: "codex", sessionId: "thread-one", workspace, allowSameProviderDelegation: false },
  }), "native-chair routing identity must constrain reuse");
  const builderRequest = {
    workspace,
    mode: "work",
    writer: "claude",
    agents: ["claude"],
    startAgent: "claude",
    githubBuilder: {
      repository: "veliqon/nolvaren-next",
      issueNumber: 248,
      prNumber: 251,
      headSha: "a".repeat(40),
      expectedLogin: "veliqon-builder",
      allowedOperations: ["push_branch", "ensure_pull_request"],
    },
  };
  const builderIdentity = collaborationIdentity(builderRequest);
  assert.notEqual(builderIdentity, collaborationIdentity({
    ...builderRequest,
    githubBuilder: { ...builderRequest.githubBuilder, expectedLogin: "other-builder" },
  }), "builder App authority must constrain reuse");
  assert.notEqual(builderIdentity, collaborationIdentity({
    ...builderRequest,
    githubBuilder: { ...builderRequest.githubBuilder, allowedOperations: ["push_branch"] },
  }), "builder operation authority must constrain reuse");
  assert.equal(builderIdentity, collaborationIdentity({
    ...builderRequest,
    githubBuilder: {
      ...builderRequest.githubBuilder,
      expectedLogin: "VELIQON-BUILDER[bot]",
      allowedOperations: ["ensure_pull_request", "push_branch"],
    },
  }), "equivalent builder login and operation-set spellings must remain compatible");
  assert.deepEqual(
    Object.keys(collaborationReuseCompatibility(reviewRequest)),
    [...COLLABORATION_REUSE_DIMENSIONS],
    "the reuse receipt dimensions and identity payload must stay aligned",
  );

  const id = "bridge-11111111-1111-4111-8111-111111111111";
  const state = await createCollaboration(root, {
    id,
    identityKey: identity,
    workspace,
    status: "running",
    githubReview: reviewRequest.githubReview,
    agents: reviewRequest.agents,
    startAgent: reviewRequest.startAgent,
    models: reviewRequest.models,
    modelFallbacks: reviewRequest.modelFallbacks,
    handoffPath: reviewRequest.handoffPath,
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
  assert.equal(missing.missing, true);
  assert.equal(missing.timedOut, undefined);

  const futureId = "bridge-33333333-3333-4333-8333-333333333333";
  const waitsBeforeCreation = waitForControlPlane(root, { handles: [futureId], timeoutMs: 2_000, intervalMs: 20 });
  setTimeout(async () => {
    await createCollaboration(root, { id: futureId, workspace, status: "running", agents: ["claude"] });
    await updateCollaboration(root, futureId, (current) => ({ ...current, status: "completed" }));
  }, 50);
  assert.equal((await waitsBeforeCreation).reached, true, "a waiter started before lane creation must observe the later terminal lane");

  const anyReached = await waitForControlPlane(root, { handles: [futureId, "absent-sibling"], any: true, timeoutMs: 0 });
  assert.equal(anyReached.reached, true);
  assert.ok(anyReached.classifications.includes("missing"), "the absent sibling must still be classified as missing");
  assert.equal(anyReached.missing, undefined, "a reached --any wait must not carry the structured missing outcome");
  assert.equal(waitExitCode(anyReached), 0, "a reached sibling must not be converted into exit code 2");
  const anyMissing = await waitForControlPlane(root, { handles: ["absent-sibling", "absent-other"], any: true, timeoutMs: 0 });
  assert.equal(anyMissing.missing, true);
  assert.equal(waitExitCode(anyMissing), 2);
  assert.equal(waitExitCode({ classifications: [], timedOut: true }), 1);
  assert.equal(waitExitCode({ classifications: ["crashed"] }), 3);
  assert.equal(waitExitCode({ classifications: ["terminal"], reached: true }), 0);

  const untargetedId = "bridge-44444444-4444-4444-8444-444444444444";
  const targetedId = "bridge-55555555-5555-4555-8555-555555555555";
  const workIdentity = collaborationIdentity({ workspace, mode: "work", resumeKey: "issue-117-work" });
  const unusedIdentity = collaborationIdentity({ workspace, mode: "work", resumeKey: "issue-117-unused" });
  assert.notEqual(workIdentity, identity);
  assert.notEqual(workIdentity, unusedIdentity);
  await createCollaboration(root, { id: untargetedId, workspace, status: "running", agents: ["claude"] });
  await createCollaboration(root, { id: targetedId, identityKey: workIdentity, workspace, status: "running", agents: ["claude"] });
  await rm(join(collaborationDirectory(root), `identity-${workIdentity}.json`), { force: true });
  assert.equal((await findCollaborationByIdentity(root, workIdentity)).id, targetedId, "the fallback scan must still recover the targeted lane after the identity index is lost");
  assert.equal(await findCollaborationByIdentity(root, unusedIdentity), null, "neither an untargeted lane nor a differently targeted lane may satisfy an identity lookup");

  await createCollaboration(root, {
    id: "bridge-11111111-2222-4222-8222-222222222222",
    workspace,
    status: "running",
    alias: plane.lanes[0].alias,
    agents: ["claude"],
  });
  await assert.rejects(() => waitForControlPlane(root, { handles: [plane.lanes[0].alias], timeoutMs: 0 }), /Ambiguous collaboration alias/);
  await assert.rejects(() => waitForControlPlane(root, { handles: ["bridge-11111111"], timeoutMs: 0 }), /Ambiguous collaboration ID prefix/);
  await updateCollaboration(root, id, (current) => ({ ...current, status: "completed" }));
  const indexPath = join(collaborationDirectory(root), `identity-${identity}.json`);
  const identityLockPath = join(collaborationDirectory(root), `identity-${identity}.lock`);
  await access(indexPath);
  await writeFile(identityLockPath, "999999999\n");
  await archiveCollaboration(root, id);
  await assert.rejects(() => access(indexPath), { code: "ENOENT" });
  await assert.rejects(() => access(identityLockPath), { code: "ENOENT" });
  assert.equal(classifyWaitLane({ lifecyclePhase: "running", recovery: { processAlive: false }, heartbeat: { heartbeatAt: "2026-07-24T00:00:00.000Z" } }, { now: Date.parse("2026-07-24T00:02:00.000Z") }), "crashed");
  await assert.rejects(() => waitForControlPlane(root, { handles: [id], timeoutMs: Number.NaN }), /timeoutMs/);

  console.log("Control-plane coordination tests passed: stable identity, readable aliases, compatible lookup, and cursor-aware terminal waits are verified.");
} finally {
  if (originalStateRoot === undefined) delete process.env.BRIDGE_COLLABORATION_DIR;
  else process.env.BRIDGE_COLLABORATION_DIR = originalStateRoot;
  await rm(root, { recursive: true, force: true });
}

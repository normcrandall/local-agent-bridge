#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCollaboration } from "../src/collaboration-store.mjs";
import { archivePortfolio } from "../src/portfolio-store.mjs";
import {
  applyBridgeCleanup,
  archiveVerifiedCollaboration,
  auditBridgeCleanup,
  formatCleanupReport,
  verifyPortfolioRetirement,
} from "../src/state-cleanup.mjs";
import {
  inspectCollaborationWorkspace,
  verifyCollaborationGitHubOutcome,
} from "../src/cleanup-retirement-verifier.mjs";
import { hostActivityId, recordHostActivity } from "../src/host-activity-store.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "bridge-state-cleanup-"));
const priorStateRoot = process.env.BRIDGE_COLLABORATION_DIR;
const priorPortfolioRoot = process.env.BRIDGE_PORTFOLIO_DIR;
process.env.BRIDGE_COLLABORATION_DIR = stateRoot;
process.env.BRIDGE_PORTFOLIO_DIR = join(stateRoot, "portfolios");
await mkdir(process.env.BRIDGE_PORTFOLIO_DIR, { recursive: true });
const old = "2026-07-01T00:00:00.000Z";
const now = Date.parse("2026-07-23T12:00:00.000Z");
const ids = {
  completed: "bridge-11111111-1111-4111-8111-111111111111",
  running: "bridge-22222222-2222-4222-8222-222222222222",
  needsUser: "bridge-33333333-3333-4333-8333-333333333333",
  pendingWake: "bridge-44444444-4444-4444-8444-444444444444",
  workspaceOperation: "bridge-77777777-7777-4777-8777-777777777777",
  mergedWork: "bridge-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  openPr: "bridge-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  dirtyWork: "bridge-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  unpublishedWork: "bridge-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  unavailableGitHub: "bridge-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  missingBinding: "bridge-12121212-1212-4212-8212-121212121212",
  missingUpdatedAt: "bridge-14141414-1414-4414-8414-141414141414",
};

async function writeCollaboration(id, state) {
  await writeFile(join(stateRoot, `${id}.json`), `${JSON.stringify({ id, createdAt: old, updatedAt: old, task: id, ...state })}\n`);
  await writeFile(join(stateRoot, `${id}.jsonl`), `${JSON.stringify({ type: "created", at: old })}\n`);
}

try {
  const makeRepository = async (name) => {
    const path = join(stateRoot, name);
    await mkdir(path);
    execFileSync("git", ["init", "-q"], { cwd: path });
    execFileSync("git", ["config", "user.email", "cleanup@example.invalid"], { cwd: path });
    execFileSync("git", ["config", "user.name", "Cleanup Test"], { cwd: path });
    await writeFile(join(path, "README.md"), `${name}\n`);
    execFileSync("git", ["add", "README.md"], { cwd: path });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: path });
    return { path, headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim() };
  };
  const mergedWorkspace = await makeRepository("merged-workspace");
  const dirtyWorkspace = await makeRepository("dirty-workspace");
  await writeFile(join(dirtyWorkspace.path, "unpublished.txt"), "preserve me\n");
  const unpublishedWorkspace = await makeRepository("unpublished-workspace");

  await writeCollaboration(ids.completed, {
    status: "completed",
    githubReview: { repository: "norm/example", prNumber: 1, headSha: "1".repeat(40) },
  });
  await writeCollaboration(ids.running, { status: "running", workerPid: process.pid, runtime: { activeCall: { agent: "codex" } } });
  await writeCollaboration(ids.needsUser, { status: "needs_user" });
  await writeCollaboration(ids.pendingWake, { status: "agreed", coordinatorWake: { status: "pending" } });
  await writeCollaboration(ids.workspaceOperation, { status: "completed", workspaceOperation: { id: "cleanup-reservation", status: "reserved" } });
  await writeCollaboration(ids.mergedWork, {
    status: "completed", mode: "work", writer: "codex", writerCheckout: { path: mergedWorkspace.path },
    githubReview: { repository: "norm/example", prNumber: 2, headSha: mergedWorkspace.headSha },
  });
  await writeCollaboration(ids.openPr, {
    status: "completed",
    githubReview: { repository: "norm/example", prNumber: 3, headSha: "3".repeat(40) },
  });
  await writeCollaboration(ids.dirtyWork, {
    status: "completed", mode: "work", writer: "claude", writerCheckout: { path: dirtyWorkspace.path },
    githubReview: { repository: "norm/example", prNumber: 4, headSha: dirtyWorkspace.headSha },
  });
  await writeCollaboration(ids.unpublishedWork, {
    status: "completed", mode: "work", writer: "codex", writerCheckout: { path: unpublishedWorkspace.path },
    githubReview: { repository: "norm/example", prNumber: 5, headSha: unpublishedWorkspace.headSha },
  });
  await writeCollaboration(ids.unavailableGitHub, {
    status: "completed",
    githubReview: { repository: "norm/example", prNumber: 6, headSha: "6".repeat(40) },
  });
  await writeCollaboration(ids.missingBinding, { status: "completed" });
  await writeCollaboration(ids.missingUpdatedAt, { status: "completed", updatedAt: "not-a-date" });
  const oldHostSession = "expired-native-host-session";
  await recordHostActivity(stateRoot, {
    provider: "codex",
    sessionId: oldHostSession,
    workspace: stateRoot,
    hostPid: process.pid,
    action: "start",
    now: Date.parse(old),
  });
  await recordHostActivity(stateRoot, {
    provider: "codex",
    sessionId: oldHostSession,
    workspace: stateRoot,
    action: "stop",
    now: Date.parse(old) + 1_000,
  });
  const oldHostPath = join(stateRoot, "host-activity", `${hostActivityId({ provider: "codex", sessionId: oldHostSession })}.json`);

  const completePortfolio = "helm-55555555-5555-4555-8555-555555555555";
  const blockedPortfolio = "helm-66666666-6666-4666-8666-666666666666";
  await writeFile(join(process.env.BRIDGE_PORTFOLIO_DIR, `${completePortfolio}.json`), `${JSON.stringify({
    id: completePortfolio,
    status: "complete",
    revision: 1,
    repository: "norm/example",
    createdAt: old,
    updatedAt: old,
    items: [{ id: "1", status: "merged", prNumber: 20, headSha: "2".repeat(40) }],
  })}\n`);
  await writeFile(join(process.env.BRIDGE_PORTFOLIO_DIR, `${blockedPortfolio}.json`), `${JSON.stringify({
    id: blockedPortfolio,
    status: "blocked",
    createdAt: old,
    updatedAt: old,
    items: [{ id: "2", status: "blocked" }],
  })}\n`);

  const verifyGithubOutcome = async (state) => {
    if (state.id === ids.missingBinding) return { safe: false, reason: "github_binding_missing" };
    if (state.id === ids.unavailableGitHub) throw new Error("GitHub is unavailable");
    if (state.id === ids.openPr) return { safe: false, reason: "pull_request_open", outcome: "open" };
    const headSha = state.githubReview?.headSha || null;
    if (state.id === ids.unpublishedWork) {
      return { safe: true, reason: "pull_request_closed", outcome: "closed", githubHeadSha: headSha, remoteHeadSha: null };
    }
    return { safe: true, reason: "pull_request_merged", outcome: "merged", githubHeadSha: headSha, remoteHeadSha: null };
  };
  const options = { workspaceRoot: stateRoot, stateRoot, olderThanDays: 7, now, verifyGithubOutcome };
  const audit = await auditBridgeCleanup(options);
  assert.deepEqual(new Set(audit.collaborationArchiveCandidates.map((entry) => entry.id)), new Set([ids.completed, ids.mergedWork]));
  assert.deepEqual(audit.portfolioArchiveCandidates.map((entry) => entry.id), [completePortfolio]);
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.running && entry.reasons.includes("live_worker")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.needsUser && entry.reasons.includes("needs_user")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.pendingWake && entry.reasons.includes("pending_coordinator_wake")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.workspaceOperation && entry.reasons.includes("workspace_operation")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.openPr && entry.reasons.includes("pull_request_open")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.dirtyWork && entry.reasons.includes("workspace_dirty")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.unpublishedWork && entry.reasons.includes("workspace_head_unpublished")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.unavailableGitHub && entry.reasons.includes("github_outcome_unavailable")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.missingBinding && entry.reasons.includes("github_binding_missing")));
  assert.ok(audit.staleCollaborations.some((entry) => entry.id === ids.missingUpdatedAt && entry.reasons.includes("missing_updated_at")));
  assert.deepEqual(audit.stalePortfolios.map((entry) => entry.id), [blockedPortfolio]);
  assert.equal(audit.hostActivityCleanupCandidates.length, 1);
  assert.equal(audit.hostActivityCleanupCandidates[0].type, "state");
  assert.match(formatCleanupReport(audit), /dry-run/);
  assert.match(formatCleanupReport(audit), /never auto-cancelled/);
  assert.match(formatCleanupReport(audit), /pull_request_open/);
  assert.doesNotThrow(() => formatCleanupReport({ ...audit, protectedCollaborations: undefined }));
  await assert.rejects(
    () => archiveVerifiedCollaboration(stateRoot, ids.needsUser, { expectedUpdatedAt: old }),
    /status needs_user is not archive-ready/,
  );
  const localTerminal = "bridge-13131313-1313-4313-8313-131313131313";
  await writeCollaboration(localTerminal, { status: "agreed" });
  const localArchived = await archiveVerifiedCollaboration(stateRoot, localTerminal, { expectedUpdatedAt: old });
  assert.equal(localArchived.retirement.reason, "local_terminal_record");
  const localArchivedState = JSON.parse(await readFile(join(stateRoot, "archive", `${localTerminal}.json`), "utf8"));
  assert.equal(localArchivedState.status, "agreed");
  assert.equal(localArchivedState.archiveMetadata.retirement.reason, "local_terminal_record");

  const applied = await applyBridgeCleanup(options);
  assert.equal(applied.archivedCollaborations.length, 2);
  assert.equal(applied.archivedPortfolios.length, 1);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "archive", `${ids.completed}.json`), "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "archive", `${ids.mergedWork}.json`), "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "portfolios", "archive", `${completePortfolio}.json`), "utf8")).status, "complete");
  assert.equal(JSON.parse(await readFile(join(stateRoot, `${ids.needsUser}.json`), "utf8")).status, "needs_user");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "portfolios", `${blockedPortfolio}.json`), "utf8")).status, "blocked");
  assert.equal(applied.removedHostActivityArtifacts.length, 1);
  await assert.rejects(() => readFile(oldHostPath), (error) => error.code === "ENOENT");

  const directMerged = await inspectCollaborationWorkspace({
    mode: "work", writer: "codex", writerCheckout: { path: mergedWorkspace.path },
    githubReview: { headSha: mergedWorkspace.headSha },
  }, { outcome: "merged", githubHeadSha: mergedWorkspace.headSha, remoteHeadSha: null });
  assert.equal(directMerged.reason, "workspace_head_merged");
  const directRemote = await inspectCollaborationWorkspace({
    mode: "work", writer: "codex", writerCheckout: { path: unpublishedWorkspace.path },
    githubReview: { headSha: unpublishedWorkspace.headSha },
  }, { outcome: "closed", githubHeadSha: unpublishedWorkspace.headSha, remoteHeadSha: unpublishedWorkspace.headSha });
  assert.equal(directRemote.reason, "workspace_head_remote");
  const nestedWorkspace = join(mergedWorkspace.path, "nested");
  await mkdir(nestedWorkspace);
  const wrongRepository = await inspectCollaborationWorkspace({
    mode: "work", writer: "codex", writerCheckout: { path: nestedWorkspace },
    githubReview: { headSha: mergedWorkspace.headSha },
  }, { outcome: "merged", githubHeadSha: mergedWorkspace.headSha, remoteHeadSha: null });
  assert.equal(wrongRepository.reason, "workspace_repository_mismatch");

  const apiHead = "8".repeat(40);
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/repos/norm/example/pulls/8") {
      return new Response(JSON.stringify({
        state: "closed", merged: true, merged_at: old, html_url: "https://github.com/norm/example/pull/8",
        head: { sha: apiHead, ref: "codex/cleanup", repo: { full_name: "norm/example" } },
      }), { status: 200 });
    }
    if (path === "/repos/norm/example/pulls/9") {
      return new Response(JSON.stringify({ state: "open", head: { sha: "9".repeat(40) } }), { status: 200 });
    }
    if (path === "/repos/norm/example/pulls/10") {
      return new Response(JSON.stringify({
        state: "closed", merged: false,
        head: { sha: "a".repeat(40), ref: "codex/gone", repo: { full_name: "norm/example" } },
      }), { status: 200 });
    }
    if (path === "/repos/norm/example/pulls/12") {
      return new Response(JSON.stringify({
        state: "closed", merged: false,
        head: { sha: "b".repeat(40), ref: "codex/deleted-fork", repo: null },
      }), { status: 200 });
    }
    if (path === "/repos/norm/example/issues/11") {
      return new Response(JSON.stringify({
        state: "closed", html_url: "https://github.com/norm/example/issues/11",
      }), { status: 200 });
    }
    if (path === "/repos/norm/example/git/ref/heads/codex/cleanup") {
      return new Response(JSON.stringify({ object: { sha: apiHead } }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  const tokenRequests = [];
  const fakeToken = async (request) => {
    tokenRequests.push(request);
    return { token: "ghs_cleanup_test" };
  };
  const verifiedMerged = await verifyCollaborationGitHubOutcome({
    githubReview: { repository: "norm/example", prNumber: 8, headSha: apiHead },
  }, { fetchImpl: fakeFetch, getInstallationToken: fakeToken });
  assert.equal(verifiedMerged.reason, "pull_request_merged");
  assert.equal(verifiedMerged.remoteHeadSha, apiHead);
  assert.deepEqual(tokenRequests[0].tokenPermissions, {
    contents: "read", issues: "read", metadata: "read", pull_requests: "read",
  });
  const verifiedOpen = await verifyCollaborationGitHubOutcome({
    githubReview: { repository: "norm/example", prNumber: 9, headSha: "9".repeat(40) },
  }, { fetchImpl: fakeFetch, getInstallationToken: fakeToken });
  assert.equal(verifiedOpen.reason, "pull_request_open");
  const verifiedClosedUnrecoverable = await verifyCollaborationGitHubOutcome({
    githubReview: { repository: "norm/example", prNumber: 10, headSha: "a".repeat(40) },
  }, { fetchImpl: fakeFetch, getInstallationToken: fakeToken });
  assert.equal(verifiedClosedUnrecoverable.safe, false);
  assert.equal(verifiedClosedUnrecoverable.reason, "pull_request_closed_head_unrecoverable");
  const verifiedDeletedFork = await verifyCollaborationGitHubOutcome({
    githubReview: { repository: "norm/example", prNumber: 12, headSha: "b".repeat(40) },
  }, { fetchImpl: fakeFetch, getInstallationToken: fakeToken });
  assert.equal(verifiedDeletedFork.safe, false);
  assert.equal(verifiedDeletedFork.reason, "pull_request_closed_head_unrecoverable");
  assert.equal(verifiedDeletedFork.remoteHeadSha, null);
  const verifiedClosedIssue = await verifyCollaborationGitHubOutcome({
    issueClaim: { repository: "norm/example", issueNumber: 11 },
  }, { fetchImpl: fakeFetch, getInstallationToken: fakeToken });
  assert.equal(verifiedClosedIssue.safe, true);
  assert.equal(verifiedClosedIssue.reason, "issue_closed");

  const issueOnlyChecks = [];
  const issueOnlyPortfolio = {
    id: "helm-issue-only",
    repository: "norm/example",
    items: [{ id: "issue-11", status: "completed", issueNumber: 11 }],
  };
  const issueOnlyRetirement = await verifyPortfolioRetirement(issueOnlyPortfolio, {
    verifyGithubOutcome: async (state) => {
      issueOnlyChecks.push(state);
      return { safe: true, reason: "issue_closed", outcome: "closed" };
    },
    inspectWorkspace: async () => ({ safe: true, reason: "workspace_proof_not_required" }),
  });
  assert.equal(issueOnlyRetirement.safe, true);
  assert.equal(issueOnlyChecks.length, 1);
  assert.equal(issueOnlyChecks[0].issueClaim.repository, "norm/example");
  assert.equal(issueOnlyChecks[0].issueClaim.issueNumber, 11);
  const openIssueRetirement = await verifyPortfolioRetirement(issueOnlyPortfolio, {
    verifyGithubOutcome: async () => ({ safe: false, reason: "issue_open", outcome: "open" }),
    inspectWorkspace: async () => ({ safe: true, reason: "workspace_proof_not_required" }),
  });
  assert.equal(openIssueRetirement.safe, false);
  assert.deepEqual(openIssueRetirement.reasons, ["item:issue-11:issue_open"]);

  const changedOutcomeId = "bridge-fafafafa-fafa-4afa-8afa-fafafafafafa";
  await writeCollaboration(changedOutcomeId, {
    status: "completed",
    githubReview: { repository: "norm/example", prNumber: 7, headSha: "7".repeat(40) },
  });
  let outcomeChecks = 0;
  const changedOutcome = await applyBridgeCleanup({
    workspaceRoot: stateRoot,
    stateRoot,
    olderThanDays: 7,
    now,
    verifyGithubOutcome: async (state) => {
      if (state.id !== changedOutcomeId) return { safe: false, reason: "not_this_fixture" };
      outcomeChecks += 1;
      return outcomeChecks === 1
        ? { safe: true, reason: "pull_request_merged", outcome: "merged", githubHeadSha: "7".repeat(40), remoteHeadSha: null }
        : { safe: false, reason: "pull_request_reopened", outcome: "open" };
    },
  });
  assert.ok(changedOutcome.failedCollaborations.some((entry) => entry.id === changedOutcomeId && /pull_request_reopened/.test(entry.error)));
  assert.equal(JSON.parse(await readFile(join(stateRoot, `${changedOutcomeId}.json`), "utf8")).status, "completed");

  const changedDuringApplyId = "bridge-fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb";
  await writeCollaboration(changedDuringApplyId, {
    status: "completed",
    githubReview: { repository: "norm/example", prNumber: 8, headSha: "8".repeat(40) },
  });
  let stateChecks = 0;
  const changedDuringApply = await applyBridgeCleanup({
    workspaceRoot: stateRoot,
    stateRoot,
    olderThanDays: 7,
    now,
    verifyGithubOutcome: async (state) => {
      if (state.id !== changedDuringApplyId) return { safe: false, reason: "not_this_fixture" };
      stateChecks += 1;
      if (stateChecks === 2) {
        await writeFile(join(stateRoot, `${changedDuringApplyId}.json`), `${JSON.stringify({
          ...state,
          updatedAt: "2026-07-23T11:59:59.000Z",
        })}\n`);
      }
      return { safe: true, reason: "pull_request_merged", outcome: "merged", githubHeadSha: "8".repeat(40), remoteHeadSha: null };
    },
  });
  assert.ok(changedDuringApply.failedCollaborations.some((entry) => entry.id === changedDuringApplyId && /changed after cleanup audit/.test(entry.error)));
  assert.equal(JSON.parse(await readFile(join(stateRoot, `${changedDuringApplyId}.json`), "utf8")).updatedAt, "2026-07-23T11:59:59.000Z");

  const changedCollaboration = "bridge-88888888-8888-4888-8888-888888888888";
  await writeCollaboration(changedCollaboration, { status: "completed" });
  await assert.rejects(
    () => archiveCollaboration(stateRoot, changedCollaboration, { expectedUpdatedAt: "2026-06-01T00:00:00.000Z" }),
    /changed after cleanup audit/,
  );
  const changedPortfolio = "helm-99999999-9999-4999-8999-999999999999";
  await writeFile(join(process.env.BRIDGE_PORTFOLIO_DIR, `${changedPortfolio}.json`), `${JSON.stringify({
    id: changedPortfolio,
    status: "complete",
    revision: 2,
    createdAt: old,
    updatedAt: old,
    items: [{ id: "3", status: "merged" }],
  })}\n`);
  await assert.rejects(
    () => archivePortfolio(process.env.BRIDGE_PORTFOLIO_DIR, changedPortfolio, { expectedRevision: 1 }),
    /revision changed after cleanup audit/,
  );
  await assert.rejects(
    () => archivePortfolio(process.env.BRIDGE_PORTFOLIO_DIR, changedPortfolio),
    /audited revision is required/,
  );

  console.log("Bridge cleanup tests passed: dry-run classification is fail-closed and apply archives only safe terminal records.");
} finally {
  if (priorStateRoot === undefined) delete process.env.BRIDGE_COLLABORATION_DIR;
  else process.env.BRIDGE_COLLABORATION_DIR = priorStateRoot;
  if (priorPortfolioRoot === undefined) delete process.env.BRIDGE_PORTFOLIO_DIR;
  else process.env.BRIDGE_PORTFOLIO_DIR = priorPortfolioRoot;
  await rm(stateRoot, { recursive: true, force: true });
}

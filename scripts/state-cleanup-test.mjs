#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCollaboration } from "../src/collaboration-store.mjs";
import { archivePortfolio } from "../src/portfolio-store.mjs";
import { applyBridgeCleanup, auditBridgeCleanup, formatCleanupReport } from "../src/state-cleanup.mjs";

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
};

async function writeCollaboration(id, state) {
  await writeFile(join(stateRoot, `${id}.json`), `${JSON.stringify({ id, createdAt: old, updatedAt: old, task: id, ...state })}\n`);
  await writeFile(join(stateRoot, `${id}.jsonl`), `${JSON.stringify({ type: "created", at: old })}\n`);
}

try {
  await writeCollaboration(ids.completed, { status: "completed" });
  await writeCollaboration(ids.running, { status: "running", workerPid: process.pid, runtime: { activeCall: { agent: "codex" } } });
  await writeCollaboration(ids.needsUser, { status: "needs_user" });
  await writeCollaboration(ids.pendingWake, { status: "agreed", coordinatorWake: { status: "pending" } });
  await writeCollaboration(ids.workspaceOperation, { status: "completed", workspaceOperation: { id: "cleanup-reservation", status: "reserved" } });

  const completePortfolio = "helm-55555555-5555-4555-8555-555555555555";
  const blockedPortfolio = "helm-66666666-6666-4666-8666-666666666666";
  await writeFile(join(process.env.BRIDGE_PORTFOLIO_DIR, `${completePortfolio}.json`), `${JSON.stringify({
    id: completePortfolio,
    status: "complete",
    revision: 1,
    createdAt: old,
    updatedAt: old,
    items: [{ id: "1", status: "merged" }],
  })}\n`);
  await writeFile(join(process.env.BRIDGE_PORTFOLIO_DIR, `${blockedPortfolio}.json`), `${JSON.stringify({
    id: blockedPortfolio,
    status: "blocked",
    createdAt: old,
    updatedAt: old,
    items: [{ id: "2", status: "blocked" }],
  })}\n`);

  const options = { workspaceRoot: stateRoot, stateRoot, olderThanDays: 7, now };
  const audit = await auditBridgeCleanup(options);
  assert.deepEqual(audit.collaborationArchiveCandidates.map((entry) => entry.id), [ids.completed]);
  assert.deepEqual(audit.portfolioArchiveCandidates.map((entry) => entry.id), [completePortfolio]);
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.running && entry.reasons.includes("live_worker")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.needsUser && entry.reasons.includes("needs_user")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.pendingWake && entry.reasons.includes("pending_coordinator_wake")));
  assert.ok(audit.protectedCollaborations.some((entry) => entry.id === ids.workspaceOperation && entry.reasons.includes("workspace_operation")));
  assert.deepEqual(audit.stalePortfolios.map((entry) => entry.id), [blockedPortfolio]);
  assert.match(formatCleanupReport(audit), /dry-run/);
  assert.match(formatCleanupReport(audit), /never auto-cancelled/);

  const applied = await applyBridgeCleanup(options);
  assert.equal(applied.archivedCollaborations.length, 1);
  assert.equal(applied.archivedPortfolios.length, 1);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "archive", `${ids.completed}.json`), "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "portfolios", "archive", `${completePortfolio}.json`), "utf8")).status, "complete");
  assert.equal(JSON.parse(await readFile(join(stateRoot, `${ids.needsUser}.json`), "utf8")).status, "needs_user");
  assert.equal(JSON.parse(await readFile(join(stateRoot, "portfolios", `${blockedPortfolio}.json`), "utf8")).status, "blocked");

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

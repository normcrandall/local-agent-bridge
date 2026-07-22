import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceStore } from "../src/evidence-store.mjs";
import { persistObservedVerificationResults, resolveVerificationPlan } from "../src/verification-receipts.mjs";

const directory = await mkdtemp(join(tmpdir(), "agent-bridge-verification-plan-"));
const headSha = "a".repeat(40);
try {
  const store = createEvidenceStore({ directory });
  await store.recordVerificationReceipt({
    repository: "veliqon/example",
    headSha,
    command: "npm test",
    cwd: ".",
    environmentFingerprint: "environment-1",
    exitCode: 0,
    startedAt: "2026-07-22T12:00:00.000Z",
    completedAt: "2026-07-22T12:02:00.000Z",
    source: "chair",
    attestation: "authoritative",
    outputDigest: "b".repeat(64),
  });
  const plan = await resolveVerificationPlan({
    store,
    repositoryEvidence: { repository: "veliqon/example", headSha, environmentFingerprint: "environment-1", clean: true },
    commands: ["npm test", "npm run lint"],
  });
  assert.deepEqual(plan.pendingCommands, ["npm run lint"]);
  assert.deepEqual(plan.reusable.map((receipt) => receipt.command), ["npm test"]);
  assert.equal(plan.avoidedCommands, 1);
  assert.equal(plan.estimatedAvoidedMs, 120_000);

  const dirty = await resolveVerificationPlan({
    store,
    repositoryEvidence: { repository: "veliqon/example", headSha, environmentFingerprint: "environment-1", clean: false },
    commands: ["npm test"],
  });
  assert.deepEqual(dirty.pendingCommands, ["npm test"]);
  assert.equal(dirty.reusable.length, 0);

  const observed = await persistObservedVerificationResults({
    store,
    repositoryEvidence: { repository: "veliqon/example", headSha, environmentFingerprint: "environment-2", clean: true },
    authorizedCommands: ["npm run ci", "npm run lint"],
    provider: "claude",
    results: [
      {
        command: "npm run ci",
        exitCode: 0,
        startedAt: "2026-07-22T13:00:00.000Z",
        completedAt: "2026-07-22T13:01:00.000Z",
        outputDigest: "c".repeat(64),
        outputSummary: "All gates passed.",
      },
      {
        command: "npm run lint",
        exitCode: 1,
        startedAt: "2026-07-22T13:00:00.000Z",
        completedAt: "2026-07-22T13:00:10.000Z",
        outputDigest: "d".repeat(64),
      },
      {
        command: "npm run secret",
        exitCode: 0,
        startedAt: "2026-07-22T13:00:00.000Z",
        completedAt: "2026-07-22T13:00:10.000Z",
        outputDigest: "e".repeat(64),
      },
    ],
  });
  assert.deepEqual(observed.recorded.map((receipt) => receipt.command), ["npm run ci"]);
  assert.deepEqual(observed.skipped, [
    { command: "npm run lint", reason: "command_failed" },
    { command: "npm run secret", reason: "command_not_authorized" },
  ]);
  assert.equal(observed.recorded[0].attestation, "observed");
  assert.equal(observed.recorded[0].provider, "claude");
  const observedPlan = await resolveVerificationPlan({
    store,
    repositoryEvidence: { repository: "veliqon/example", headSha, environmentFingerprint: "environment-2", clean: true },
    commands: ["npm run ci"],
  });
  assert.equal(observedPlan.avoidedCommands, 1);
  assert.equal(observedPlan.reusable[0].source, "claude");

  const rejectedDirtyObservation = await persistObservedVerificationResults({
    store,
    repositoryEvidence: { repository: "veliqon/example", headSha, environmentFingerprint: "environment-3", clean: false },
    authorizedCommands: ["npm run ci"],
    provider: "codex",
    results: observed.recorded,
  });
  assert.equal(rejectedDirtyObservation.recorded.length, 0);
  assert.equal(rejectedDirtyObservation.skipped[0].reason, "workspace_not_clean");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Verification receipt reuse tests passed.");

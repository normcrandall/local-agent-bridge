import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceStore } from "../src/evidence-store.mjs";
import { resolveVerificationPlan } from "../src/verification-receipts.mjs";

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
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Verification receipt reuse tests passed.");

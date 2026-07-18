import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayIncident, redactSensitiveData } from "../src/incident-replay.mjs";

const stateDir = await mkdtemp(join(tmpdir(), "agent-replay-test-"));
process.env.BRIDGE_COLLABORATION_DIR = stateDir;

try {
  // Helper to write mock files
  const writeFixture = async (id, stateObj, transcriptLines) => {
    await writeFile(join(stateDir, `${id}.json`), JSON.stringify(stateObj, null, 2));
    await writeFile(join(stateDir, `${id}.jsonl`), transcriptLines.map(JSON.stringify).join("\n") + "\n");
  };

  // 1. Clean completion
  const id1 = "bridge-00000000-0000-4000-8000-000000000001";
  await writeFixture(id1, {
    id: id1,
    status: "completed",
    updatedAt: "2026-07-17T12:00:00.000Z",
    cleanup: { workerLeaseReleased: true, workspaceLeaseReleased: true }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "turn", at: "2026-07-17T11:05:00.000Z", agent: "claude", handoff: { outcome: "completed", summary: "done", nextAction: "chair_verify" } },
    { type: "handoff_acknowledged", at: "2026-07-17T11:10:00.000Z" },
    { type: "run_finished", at: "2026-07-17T11:15:00.000Z", reason: "completed" }
  ]);

  // 2. Stale narrative with live heartbeat
  const id2 = "bridge-00000000-0000-4000-8000-000000000002";
  await writeFixture(id2, {
    id: id2,
    status: "running",
    workerPid: process.pid,
    updatedAt: "2026-07-17T12:00:00.000Z",
    runtime: {
      activeCall: {
        agent: "claude",
        status: "running",
        summary: "Old progress summary",
        summarySource: "broker",
        heartbeatAt: new Date().toISOString()
      }
    }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 }
  ]);

  // 3. Lost completion wake
  const id3 = "bridge-00000000-0000-4000-8000-000000000003";
  await writeFixture(id3, {
    id: id3,
    status: "completed",
    updatedAt: "2026-07-17T12:00:00.000Z",
    coordinatorWake: { sequence: 1, status: "pending", actionable: true }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "run_finished", at: "2026-07-17T11:15:00.000Z", reason: "completed" },
    { type: "coordinator_wake_queued", at: "2026-07-17T11:16:00.000Z", wake: { sequence: 1 } }
  ]);

  // 4. Overload fallback
  const id4 = "bridge-00000000-0000-4000-8000-000000000004";
  await writeFixture(id4, {
    id: id4,
    status: "recovering",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "provider_recovery_scheduled", at: "2026-07-17T11:05:00.000Z", attempt: 1, error: "high demand" }
  ]);

  // 5. Permission denial
  const id5 = "bridge-00000000-0000-4000-8000-000000000005";
  await writeFixture(id5, {
    id: id5,
    status: "failed",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "run_failed", at: "2026-07-17T11:05:00.000Z", error: "EPERM: operation not permitted" }
  ]);

  // 6. Indeterminate mutation
  const id6 = "bridge-00000000-0000-4000-8000-000000000006";
  await writeFixture(id6, {
    id: id6,
    status: "indeterminate",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "agent_indeterminate", at: "2026-07-17T11:05:00.000Z", agent: "claude", error: "Indeterminate write" }
  ]);

  // 7. Orphan cleanup
  const id7 = "bridge-00000000-0000-4000-8000-000000000007";
  await writeFixture(id7, {
    id: id7,
    status: "failed",
    updatedAt: "2026-07-17T12:00:00.000Z",
    cleanup: { workerLeaseReleased: false, workspaceLeaseReleased: true }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "run_finished", at: "2026-07-17T11:05:00.000Z", reason: "failed" }
  ]);

  // 8. Truncated history (abrupt ending)
  const id8 = "bridge-00000000-0000-4000-8000-000000000008";
  await writeFixture(id8, {
    id: id8,
    status: "running",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" }
  ]);
  // Abruptly append malformed JSON line
  await writeFile(join(stateDir, `${id8}.jsonl`), JSON.stringify({ type: "collaboration_started" }) + "\n" + '{"type": "run_started", "at": "2026-07-17T11:01:00.000Z", "p\n');

  // Redact test
  const dirtyData = {
    pat: "github_pat_" + "12345abcdeABCDE12345",
    key: "-----BEGIN " + "PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END " + "PRIVATE KEY-----",
    url: "https://myuser:mypass@github.com/repo.git",
    safe: "hello world"
  };
  const cleanData = redactSensitiveData(dirtyData);
  assert.equal(cleanData.pat, "[REDACTED]");
  assert.equal(cleanData.key, "[REDACTED]");
  assert.equal(cleanData.url, "https://[REDACTED_CREDENTIALS]@github.com/repo.git");
  assert.equal(cleanData.safe, "hello world");
  console.log("Credential redaction tests: passed");

  // Run replay tests on fixtures
  const r1 = await replayIncident(stateDir, id1);
  assert.equal(r1.classification, "clean_completion");
  assert.equal(r1.remediation.nextSafeAction, "none");
  console.log("Fixture 1 (Clean completion): passed");

  const r2 = await replayIncident(stateDir, id2);
  assert.equal(r2.classification, "stale_narrative");
  assert.equal(r2.remediation.unresolvedOwnership, "provider");
  console.log("Fixture 2 (Stale narrative): passed");

  const r3 = await replayIncident(stateDir, id3);
  assert.equal(r3.classification, "lost_completion_wake");
  assert.equal(r3.remediation.nextSafeAction, "acknowledge_wake");
  console.log("Fixture 3 (Lost completion wake): passed");

  const r4 = await replayIncident(stateDir, id4);
  assert.equal(r4.classification, "overload_fallback");
  assert.equal(r4.remediation.nextSafeAction, "requeue");
  console.log("Fixture 4 (Overload fallback): passed");

  const r5 = await replayIncident(stateDir, id5);
  assert.equal(r5.classification, "permission_denial");
  assert.equal(r5.remediation.nextSafeAction, "doctor");
  console.log("Fixture 5 (Permission denial): passed");

  const r6 = await replayIncident(stateDir, id6);
  assert.equal(r6.classification, "indeterminate_mutation");
  assert.equal(r6.remediation.nextSafeAction, "inspect_recovery");
  console.log("Fixture 6 (Indeterminate mutation): passed");

  const r7 = await replayIncident(stateDir, id7);
  assert.equal(r7.classification, "orphan_cleanup");
  assert.equal(r7.remediation.nextSafeAction, "recover_cancel");
  console.log("Fixture 7 (Orphan cleanup): passed");

  const r8 = await replayIncident(stateDir, id8);
  assert.equal(r8.classification, "truncated_history");
  assert.equal(r8.remediation.nextSafeAction, "inspect_recovery");
  console.log("Fixture 8 (Truncated history): passed");

  console.log("All incident replay test assertions passed successfully!");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

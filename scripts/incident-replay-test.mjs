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

  // Direct string-regex tests (excluding key-name redaction checks)
  const freeTextTokens = "This is classic: " + "ghp_" + "12345abcdeABCDE1234512345abcdeABCDE1" + ", OAuth: " + "gho_" + "12345abcdeABCDE1234512345abcdeABCDE1" + ", App: " + "ghs_" + "12345abcdeABCDE1234512345abcdeABCDE1" + ", runner: " + "ghr_" + "12345abcdeABCDE1234512345abcdeABCDE1" + ", user-to-server: " + "ghu_" + "12345abcdeABCDE1234512345abcdeABCDE1" + ", and pat: " + "github_pat_" + "12345abcdeABCDE12345" + ".";
  const cleanFreeText = redactSensitiveData(freeTextTokens);
  assert.equal(cleanFreeText, "This is classic: [REDACTED_GITHUB_TOKEN], OAuth: [REDACTED_GITHUB_TOKEN], App: [REDACTED_GITHUB_TOKEN], runner: [REDACTED_GITHUB_TOKEN], user-to-server: [REDACTED_GITHUB_TOKEN], and pat: [REDACTED_GITHUB_PAT].");

  const freeTextKey = "This is key:\n-----BEGIN " + "PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END " + "PRIVATE KEY-----";
  const cleanFreeTextKey = redactSensitiveData(freeTextKey);
  assert.equal(cleanFreeTextKey, "This is key:\n[REDACTED_PRIVATE_KEY]");

  console.log("Credential redaction tests: passed");

  // 9. Failed/cancelled clean branch
  const id9 = "bridge-00000000-0000-4000-8000-000000000009";
  await writeFixture(id9, {
    id: id9,
    status: "failed",
    updatedAt: "2026-07-17T12:00:00.000Z",
    cleanup: { workerLeaseReleased: true, workspaceLeaseReleased: true }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "run_finished", at: "2026-07-17T11:05:00.000Z", reason: "failed" }
  ]);

  // 10. Archived collaborations
  const id10 = "bridge-00000000-0000-4000-8000-000000000010";
  await mkdir(join(stateDir, "archive"), { recursive: true });
  await writeFile(join(stateDir, "archive", `${id10}.json`), JSON.stringify({
    id: id10,
    status: "completed",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, null, 2));
  await writeFile(join(stateDir, "archive", `${id10}.jsonl`), [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "run_finished", at: "2026-07-17T11:05:00.000Z", reason: "completed" }
  ].map(JSON.stringify).join("\n") + "\n");

  // 11. Builder receipt matching
  const id11 = "bridge-00000000-0000-4000-8000-000000000011";
  const workspacePath = join(stateDir, "mock-workspace");
  await mkdir(join(workspacePath, ".bridge"), { recursive: true });
  await writeFile(join(workspacePath, ".bridge", "github-builder-receipts.jsonl"), JSON.stringify({
    repository: "owner/repo",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    recordedAt: "2026-07-17T11:15:00.000Z",
    status: "success"
  }) + "\n");

  await writeFixture(id11, {
    id: id11,
    status: "completed",
    workspace: workspacePath,
    githubReview: {
      repository: "owner/repo",
      headSha: "abcdef1234567890abcdef1234567890abcdef12"
    }
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" }
  ]);

  // 12. Zero-timestamp sorting order preservation
  const id12 = "bridge-00000000-0000-4000-8000-000000000012";
  const transcriptLines = [];
  for (let i = 1; i <= 15; i++) {
    transcriptLines.push({ type: "step_" + i }); // no timestamp
  }
  await writeFixture(id12, {
    id: id12,
    status: "completed",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, transcriptLines);

  // 13. Bare token false-positive permission check
  const id13 = "bridge-00000000-0000-4000-8000-000000000013";
  await writeFixture(id13, {
    id: id13,
    status: "completed",
    updatedAt: "2026-07-17T12:00:00.000Z"
  }, [
    { type: "collaboration_started", at: "2026-07-17T11:00:00.000Z" },
    { type: "run_started", at: "2026-07-17T11:01:00.000Z", pid: 1234 },
    { type: "token_refresh", at: "2026-07-17T11:02:00.000Z", message: "Token refreshed successfully" },
    { type: "run_finished", at: "2026-07-17T11:05:00.000Z", reason: "completed" }
  ]);

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

  const r9 = await replayIncident(stateDir, id9);
  assert.equal(r9.classification, "failed_or_cancelled");
  assert.equal(r9.remediation.nextSafeAction, "none");
  console.log("Fixture 9 (Failed/cancelled clean branch): passed");

  const r10 = await replayIncident(stateDir, id10);
  assert.equal(r10.classification, "clean_completion");
  assert.equal(r10.archived, true);
  console.log("Fixture 10 (Archived collaborations): passed");

  const r11 = await replayIncident(stateDir, id11);
  const hasReceipt = r11.timeline.some(e => e.type === "github_receipt" && e.status === "success");
  assert.ok(hasReceipt, "Timeline should include the matched github builder receipt");
  console.log("Fixture 11 (Builder receipt matching): passed");

  const r12 = await replayIncident(stateDir, id12);
  const steps = r12.timeline.filter(e => e.type?.startsWith("step_")).map(e => e.type);
  assert.equal(steps.length, 15);
  for (let i = 1; i <= 15; i++) {
    assert.equal(steps[i - 1], "step_" + i);
  }
  console.log("Fixture 12 (Zero-timestamp ordering): passed");

  const r13 = await replayIncident(stateDir, id13);
  assert.notEqual(r13.classification, "permission_denial");
  assert.equal(r13.classification, "clean_completion");
  console.log("Fixture 13 (Bare token permission false-positive): passed");

  console.log("All incident replay test assertions passed successfully!");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

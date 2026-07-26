import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryRuntimeJournal } from "../src/repository-runtime-journal.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-runtime-journal-"));
const head = "a".repeat(40);
let clockMs = Date.UTC(2026, 6, 26, 20, 0, 0);
const now = () => new Date(clockMs).toISOString();
const advance = (milliseconds) => { clockMs += milliseconds; };

function runtime() {
  return createRepositoryRuntimeJournal({
    workspace: root,
    directory: join(root, "journal"),
    repository: "Veliqon/Example",
    issueNumber: 231,
    pullRequestNumber: 42,
    now,
    leaseMs: 100,
    maxAttempts: 4,
    baseBackoffMs: 50,
    maxBackoffMs: 200,
    terminalHorizonMs: 86_400_000,
  });
}

try {
  let adapter = runtime();
  const first = await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "provider_progress",
    writer: "codex",
    headSha: head,
    branch: "codex/issue-231",
    summary: "A verbose heartbeat that must not reach GitHub.",
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.checkpoint.phase, "working");
  assert.equal(first.checkpoint.summary, "codex collaboration checkpoint: working.");

  const duplicate = await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "running",
    writer: "codex",
    headSha: head,
    branch: "codex/issue-231",
    summary: "A different heartbeat still collapses to the same checkpoint.",
  });
  assert.equal(duplicate.idempotent, true, "active heartbeats must collapse to one durable checkpoint");

  let attempts = 0;
  let result = await adapter.publishPending({
    workerId: "worker-before-network-loss",
    async publish() {
      attempts += 1;
      const error = new Error("network unavailable");
      error.code = "ENETUNREACH";
      throw error;
    },
  });
  assert.equal(result[0].status, "retry_scheduled");
  assert.equal((await adapter.inspect()).pending.length, 1, "offline publication must remain durable");

  advance(50);
  adapter = runtime();
  const published = [];
  result = await adapter.publishPending({
    workerId: "worker-after-restart",
    async publish(checkpoint, entry) {
      published.push({ checkpoint, entry });
      return { commentId: 7 };
    },
  });
  assert.equal(result[0].status, "published");
  assert.equal(published.length, 1);
  assert.equal(published[0].entry.binding.issueNumber, 231);
  assert.equal((await adapter.inspect()).acknowledged.length, 1);

  assert.equal((await adapter.publishPending({ workerId: "duplicate-drain", publish: async () => { throw new Error("must not replay"); } })).length, 0,
    "acknowledged checkpoints must not be published twice");

  await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "reviewing",
    writer: "claude",
    headSha: head,
  });
  const [crashedLease] = await adapter.outbox.claim({ workerId: "crashed-worker", leaseDurationMs: 25 });
  assert.equal(crashedLease.status, "leased");
  advance(26);
  adapter = runtime();
  result = await adapter.publishPending({ workerId: "replacement-worker", publish: async () => ({ recovered: true }) });
  assert.equal(result[0].status, "published", "an expired crash lease must be recovered after restart");

  await adapter.enqueue({
    collaborationId: "bridge-11111111-2222-4333-8444-555555555555",
    phase: "completed",
    writer: "codex",
    headSha: head,
    terminal: true,
    summary: "Implementation and focused verification completed.   Ready for review.",
  });
  result = await adapter.publishPending({ workerId: "terminal-worker", publish: async (checkpoint) => {
    assert.equal(checkpoint.summary, "Implementation and focused verification completed. Ready for review.");
  } });
  assert.equal(result[0].status, "published");

  const retention = await adapter.retain({ maxRecords: 3 });
  assert.ok(retention.checkpointedItems >= 3);
  adapter = runtime();
  const retained = await adapter.inspect();
  assert.equal(retained.pending.length, 0);
  assert.equal(retained.acknowledged.length, 3, "terminal and prior delivery evidence must survive retention and restart");

  console.log("repository runtime journal integration tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

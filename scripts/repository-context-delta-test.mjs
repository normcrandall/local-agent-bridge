import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import {
  createRepositoryContextCursor,
  createRepositoryContextDeltaKernel,
  inspectRepositoryContextCursor,
  readRepositoryContextDelta,
} from "../src/repository-context-delta.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-context-delta-"));
const repository = "veliqon/example";
const collaborationId = "bridge-11111111-2222-4333-8444-555555555555";
const laneId = "issue-222";

try {
  const journal = createRepositoryJournal({ directory: join(root, "journal") });
  await journal.append({
    identity: "event-1",
    repository,
    issueNumber: 222,
    payload: {
      summary: "implementation started",
      token: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      reasoning: "private chain of thought",
      "private-reasoning": "also private",
      nested: { password: "this-must-never-leak", result: "safe" },
      transcript: [{ role: "assistant", content: "full dump" }],
      events: [{ type: "reasoning", content: "hidden typed reasoning" }],
    },
  });
  await journal.append({ identity: "event-2", repository, issueNumber: 222, payload: { summary: "tests passed" } });
  await journal.append({ identity: "event-3", repository, issueNumber: 222, payload: { summary: "ready for review" } });

  const kernel = createRepositoryContextDeltaKernel({ journal, repository, collaborationId, laneId, maxEvents: 2, maxBytes: 8_000 });
  const first = await kernel.read();
  assert.equal(first.authority, "none");
  assert.equal(first.eventCount, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.records.map((record) => record.sequence), [1, 2]);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("private chain of thought"), false);
  assert.equal(serialized.includes("this-must-never-leak"), false);
  assert.equal(serialized.includes("full dump"), false);
  assert.equal(serialized.includes("hidden typed reasoning"), false);
  assert.equal(serialized.includes("github_pat_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(first.records[0].payload.nested.result, "safe");

  const unsafeMetadataJournal = {
    export: async () => ({
      repository,
      records: [{
        sequence: 1,
        identity: "deploy-ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        recordedAt: new Date().toISOString(),
        binding: { repository, credentialData: "short-secret" },
        payload: {
          tokenValue: "short-secret",
          apiKeyPayload: "short-key",
          assistantMessages: ["private transcript"],
          summary: "safe",
        },
      }],
      hasMore: false,
      cursorGap: null,
    }),
    read: async () => [],
  };
  const unsafeMetadata = await readRepositoryContextDelta({ journal: unsafeMetadataJournal, repository, collaborationId, laneId });
  assert.equal(JSON.stringify(unsafeMetadata).includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), false, "identity must be sanitized");
  assert.equal(JSON.stringify(unsafeMetadata).includes("short-secret"), false, "substring secret fields must be removed");
  assert.equal(JSON.stringify(unsafeMetadata).includes("short-key"), false, "embedded api-key field names must be removed");
  assert.equal(JSON.stringify(unsafeMetadata).includes("private transcript"), false, "embedded private field names must be removed");

  const second = await kernel.read({ cursor: first.cursor });
  assert.deepEqual(second.records.map((record) => record.sequence), [3]);
  assert.equal(second.hasMore, false);
  const noOp = await kernel.read({ cursor: second.cursor });
  assert.equal(noOp.eventCount, 0);
  assert.deepEqual(noOp.cursor, second.cursor, "a no-op resume must preserve the exact cursor");

  const restarted = createRepositoryContextDeltaKernel({ journal, repository, collaborationId, laneId });
  assert.equal((await restarted.read({ cursor: second.cursor })).eventCount, 0, "cursor advancement must survive kernel restart");

  const limited = await readRepositoryContextDelta({ journal, repository, collaborationId, laneId, maxEvents: 1, maxBytes: 8_000 });
  assert.equal(limited.eventCount, 1);
  assert.equal(limited.hasMore, true);
  assert.ok(limited.byteCount <= limited.bounds.maxBytes);

  const corrupted = { ...first.cursor, afterSequence: 999 };
  assert.equal(inspectRepositoryContextCursor(corrupted, { repository, collaborationId, laneId }).resync.reason, "corrupt_cursor");
  const rejected = await kernel.read({ cursor: corrupted });
  assert.equal(rejected.cursor, null, "a rejected cursor must never be echoed back for persistence");
  const unsupported = await kernel.read({ cursor: { ...first.cursor, version: 999 } });
  assert.equal(unsupported.resyncRequired.reason, "unsupported_cursor_version");
  assert.equal(unsupported.cursor, null);
  const foreignRepo = await kernel.read({ cursor: createRepositoryContextCursor({ repository: "veliqon/other", collaborationId, laneId, afterSequence: 1 }) });
  assert.equal(foreignRepo.resyncRequired.reason, "foreign_repository");
  const foreignLane = await kernel.read({ cursor: createRepositoryContextCursor({ repository, collaborationId, laneId: "issue-999", afterSequence: 1 }) });
  assert.equal(foreignLane.resyncRequired.reason, "foreign_lane");
  const stale = await kernel.read({ cursor: createRepositoryContextCursor({ repository, collaborationId, laneId, afterSequence: 99 }) });
  assert.equal(stale.resyncRequired.reason, "stale_cursor");

  await journal.retain({ maxRecords: 1 });
  const retainedOut = await kernel.read({ cursor: createRepositoryContextCursor({ repository, collaborationId, laneId, afterSequence: 0 }) });
  assert.equal(retainedOut.resyncRequired.reason, "out_of_retention");
  assert.equal(retainedOut.eventCount, 0);

  const duplicateJournal = {
    export: async () => ({ repository, records: [{ sequence: 1 }, { sequence: 1 }], hasMore: false, cursorGap: null }),
    read: async () => [],
  };
  const duplicate = await readRepositoryContextDelta({ journal: duplicateJournal, repository, collaborationId, laneId });
  assert.equal(duplicate.resyncRequired.reason, "journal_sequence_invalid");
  const outOfOrderJournal = {
    export: async () => ({ repository, records: [{ sequence: 1 }, { sequence: 3 }], hasMore: false, cursorGap: null }),
    read: async () => [],
  };
  const outOfOrder = await readRepositoryContextDelta({ journal: outOfOrderJournal, repository, collaborationId, laneId });
  assert.equal(outOfOrder.resyncRequired.reason, "journal_sequence_invalid");

  const oversizedJournal = {
    export: async () => ({
      repository,
      records: [{ sequence: 1, identity: "large", recordedAt: new Date().toISOString(), binding: { repository }, payload: { summary: "x".repeat(2_000) } }],
      hasMore: false,
      cursorGap: null,
    }),
    read: async () => [],
  };
  const oversized = await readRepositoryContextDelta({ journal: oversizedJournal, repository, collaborationId, laneId, maxBytes: 256 });
  assert.equal(oversized.resyncRequired, null);
  assert.equal(oversized.eventCount, 1);
  assert.equal(oversized.records[0].skipped, true);
  assert.equal(oversized.records[0].reason, "record_exceeds_bounds");
  assert.equal(oversized.skipped[0].sequence, 1);
  assert.equal(oversized.cursor.afterSequence, 1, "an oversized record must advance the cursor");
  assert.ok(oversized.byteCount <= oversized.bounds.maxBytes);

  const circular = { summary: "circular" };
  circular.self = circular;
  const unverifiableJournal = {
    export: async () => ({
      repository,
      records: [{ sequence: 1, identity: "bad", recordedAt: new Date().toISOString(), binding: { repository }, payload: circular }],
      hasMore: false,
      cursorGap: null,
    }),
    read: async () => [],
  };
  const unverifiable = await readRepositoryContextDelta({ journal: unverifiableJournal, repository, collaborationId, laneId, maxBytes: 256 });
  assert.equal(unverifiable.resyncRequired, null);
  assert.deepEqual(unverifiable.records[0], {
    sequence: 1,
    skipped: true,
    reason: "record_unverifiable",
    recordCode: "INVALID_RECORD",
    evidenceRetained: true,
  });
  assert.equal(unverifiable.cursor.afterSequence, 1, "an unverifiable record must advance the cursor");
  assert.ok(unverifiable.byteCount <= unverifiable.bounds.maxBytes);

  const failedJournal = {
    export: async () => { throw Object.assign(new Error("unreadable"), { code: "EIO" }); },
    read: async () => [],
  };
  const failed = await readRepositoryContextDelta({ journal: failedJournal, repository, collaborationId, laneId });
  assert.equal(failed.resyncRequired.reason, "journal_unverifiable");
  assert.equal(failed.resyncRequired.journalCode, "EIO");

  await assert.rejects(
    readRepositoryContextDelta({ journal, repository, collaborationId, laneId, maxEvents: 0 }),
    (error) => error.code === "INVALID_BOUNDS",
  );
  await assert.rejects(
    readRepositoryContextDelta({ journal, repository, collaborationId, laneId, maxBytes: 191 }),
    (error) => error.code === "INVALID_BOUNDS",
  );
  await assert.rejects(
    readRepositoryContextDelta({ journal, repository, collaborationId, laneId, maxBytes: 256 * 1024 + 1 }),
    (error) => error.code === "INVALID_BOUNDS",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository context delta tests passed: binding, bounds, redaction, cursor restart, and typed resync are verified.");

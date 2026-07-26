import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryJournal } from "../src/repository-journal.mjs";
import { createRepositorySnapshotCache, REPOSITORY_SNAPSHOT_CACHE_VERSION } from "../src/repository-snapshot-cache.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-snapshot-cache-"));
const repository = "veliqon/example";
const headA = "a".repeat(40);
const headB = "b".repeat(40);
let nowMs = Date.parse("2026-07-26T12:00:00.000Z");
const now = () => new Date(nowMs).toISOString();

try {
  const directory = join(root, "cache");
  const journal = createRepositoryJournal({ directory, now });
  let cache = createRepositorySnapshotCache({ journal, now, defaultFreshnessMs: 1_000, maxFreshnessMs: 5_000, maxEntryAgeMs: 10_000, maxEntryBytes: 1_024, maxEntries: 3 });

  const first = await cache.put({
    repository: "Veliqon/Example",
    kind: "pull-request",
    subject: "pr:42",
    headSha: headA.toUpperCase(),
    sourceRevision: 1,
    sourceEtag: 'W/"safe-etag"',
    sourceUpdatedAt: "2026-07-26T11:59:00Z",
    trustClass: "github-live",
    data: { title: "Fix the bridge", labels: ["bug"], nested: { z: 2, a: 1 } },
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.authoritative, false);
  assert.equal(first.usableForAuthorization, false);
  assert.match(first.dataDigest, /^[0-9a-f]{64}$/);

  const duplicate = await cache.put({
    repository,
    kind: "pull_request",
    subject: "pr:42",
    headSha: headA,
    sourceRevision: 1,
    sourceEtag: 'W/"safe-etag"',
    sourceUpdatedAt: "2026-07-26T11:59:00.000Z",
    fetchedAt: "2026-07-26T12:00:00.000Z",
    trustClass: "github-live",
    data: { nested: { a: 1, z: 2 }, labels: ["bug"], title: "Fix the bridge" },
  });
  assert.equal(duplicate.idempotent, true, "equivalent duplicate delivery must not append");
  assert.equal((await journal.read()).length, 1);

  nowMs += 50;
  const implicitTimestampRetry = await cache.put({
    repository,
    kind: "pull_request",
    subject: "pr:42",
    headSha: headA,
    sourceRevision: 1,
    sourceEtag: 'W/"safe-etag"',
    sourceUpdatedAt: "2026-07-26T11:59:00Z",
    trustClass: "github-live",
    data: { title: "Fix the bridge", labels: ["bug"], nested: { z: 2, a: 1 } },
  });
  assert.equal(implicitTimestampRetry.idempotent, true, "an omitted fetchedAt must not make an equivalent retry conflict");

  let read = await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA });
  assert.equal(read.status, "fresh");
  assert.equal(read.entry.version, REPOSITORY_SNAPSHOT_CACHE_VERSION);
  assert.equal(read.entry.sourceRevision, 1);
  assert.equal(read.entry.sourceEtag, 'W/"safe-etag"');
  assert.equal(read.entry.sourceUpdatedAt, "2026-07-26T11:59:00.000Z");

  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headB })).status, "missing", "one exact head must never satisfy another");
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42" })).status, "missing", "a head-bound entry must not satisfy an unbound lookup");

  await assert.rejects(cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, sourceRevision: 1, data: { title: "conflict" } }), (error) => error.code === "REVISION_CONFLICT");
  await cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, sourceRevision: 2, data: { title: "newer" } });
  await assert.rejects(cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, sourceRevision: 1, data: { title: "late" } }), (error) => error.code === "OUT_OF_ORDER");
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA })).entry.data.title, "newer");

  await assert.rejects(
    cache.put({ repository, kind: "issue", subject: "future-write", sourceRevision: 1, fetchedAt: new Date(nowMs + 60_001).toISOString(), data: {} }),
    (error) => error.code === "INVALID_PROVENANCE",
    "writes must reject provenance beyond the configured clock-skew allowance",
  );
  await assert.rejects(
    cache.put({ repository, kind: "issue", subject: "bad-time", sourceRevision: 1, sourceUpdatedAt: "5", data: {} }),
    (error) => error.code === "INVALID_PROVENANCE",
    "provenance timestamps must be RFC 3339 rather than merely Date.parse-compatible",
  );

  nowMs += 1_500;
  read = await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA });
  assert.equal(read.status, "stale");
  assert.equal(read.reason, "freshness_expired");
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, offline: true })).reason, "offline_unverified");

  cache = createRepositorySnapshotCache({ journal: createRepositoryJournal({ directory, now }), now, defaultFreshnessMs: 1_000, maxFreshnessMs: 5_000, maxEntryAgeMs: 10_000, maxEntryBytes: 1_024, maxEntries: 3 });
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA })).entry.sourceRevision, 2, "cache state must survive restart");

  const invalidation = await cache.invalidate({ repository, kind: "pull_request", subject: "pr:42", headSha: headA });
  assert.equal(invalidation.invalidatedThroughRevision, 2);
  assert.equal((await cache.invalidate({ repository, kind: "pull_request", subject: "pr:42", headSha: headA })).idempotent, true);
  read = await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA });
  assert.equal(read.status, "invalidated");
  await assert.rejects(cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, sourceRevision: 2, data: { title: "resurrect" } }), (error) => error.code === "OUT_OF_ORDER");
  await cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headA, sourceRevision: 3, data: { title: "post-invalidation" } });
  await cache.put({ repository, kind: "pull_request", subject: "pr:42", headSha: headB, sourceRevision: 4, data: { title: "other-head" } });
  const subjectInvalidation = await cache.invalidate({ repository, kind: "pull_request", subject: "pr:42" });
  assert.equal(subjectInvalidation.invalidatedThroughRevision, 4);
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headA })).status, "invalidated");
  assert.equal((await cache.get({ repository, kind: "pull_request", subject: "pr:42", headSha: headB })).status, "invalidated");

  await cache.put({ repository, kind: "issue", subject: "issue:7", sourceRevision: 1, data: { state: "open" } });
  await cache.put({ repository, kind: "diff", subject: "pr:43", headSha: headB, sourceRevision: 1, data: { files: ["src/a.mjs"] } });
  await cache.put({ repository, kind: "repository_map", subject: "default", sourceRevision: 1, data: { files: [] } });
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:11", sourceRevision: 1, data: {} }), (error) => error.code === "CACHE_FULL");

  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, data: { accessToken: "not-even-a-real-token" } }), (error) => error.code === "FORBIDDEN_FIELD");
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, data: { "tоken": "homoglyph" } }), (error) => error.code === "FORBIDDEN_FIELD");
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, data: { privateReasoning: "hidden" } }), (error) => error.code === "FORBIDDEN_FIELD");
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, data: { rawTranscript: [] } }), (error) => error.code === "FORBIDDEN_FIELD");
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, freshnessMs: 5_001, data: {} }), (error) => error.code === "INVALID_LIMIT");
  await assert.rejects(cache.put({ repository, kind: "issue", subject: "issue:8", sourceRevision: 1, data: { text: "x".repeat(2_000) } }), (error) => error.code === "ENTRY_TOO_LARGE");

  nowMs += 10_001;
  read = await cache.get({ repository, kind: "issue", subject: "issue:7", offline: true });
  assert.equal(read.status, "missing");
  assert.equal(read.reason, "age_limit");

  const corruptDirectory = join(root, "corrupt");
  const corruptJournal = createRepositoryJournal({ directory: corruptDirectory, now });
  const corruptCache = createRepositorySnapshotCache({ journal: corruptJournal, now });
  await corruptCache.put({ repository, kind: "repository_map", subject: "default", sourceRevision: 1, data: { files: [] } });
  await appendFile(corruptJournal.path, '{"malformed":');
  const corrupt = await corruptCache.get({ repository, kind: "repository_map", subject: "default" });
  assert.equal(corrupt.status, "corrupt");
  assert.equal(corrupt.entry, null);

  const futureDirectory = join(root, "future-durable");
  const futureJournal = createRepositoryJournal({ directory: futureDirectory, now });
  const futureCache = createRepositorySnapshotCache({ journal: futureJournal, now, maxFutureSkewMs: 1_000 });
  await futureCache.put({ repository, kind: "issue", subject: "issue:future", sourceRevision: 1, data: { state: "open" } });
  nowMs -= 1_001;
  const implausible = await futureCache.get({ repository, kind: "issue", subject: "issue:future" });
  assert.equal(implausible.status, "stale", "already-durable future provenance must fail closed on read");
  assert.equal(implausible.reason, "implausible_provenance");
  nowMs += 1_001;

  const redactionDirectory = join(root, "redaction");
  const redactionJournal = createRepositoryJournal({ directory: redactionDirectory, now });
  const redactionCache = createRepositorySnapshotCache({ journal: redactionJournal, now });
  const redactedWrite = await redactionCache.put({
    repository,
    kind: "issue",
    subject: "issue:redacted",
    sourceRevision: 1,
    data: { body: "Example config: token: abc123 and password=def456", keyExample: "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----" },
  });
  assert.equal(redactedWrite.idempotent, false);
  const redactedRead = await redactionCache.get({ repository, kind: "issue", subject: "issue:redacted" });
  assert.equal(redactedRead.entry.data.body.includes("abc123"), false);
  assert.equal(redactedRead.entry.data.body.includes("def456"), false);
  assert.equal(redactedRead.entry.data.keyExample.includes("secret-key-material"), false);
  assert.equal(redactedRead.entry.redactions, 3);

  const conflictingJournal = {
    inspect: async () => ({ status: "clean", records: [], error: null }),
    append: async () => {
      const error = new Error("identity conflict");
      error.code = "IDENTITY_CONFLICT";
      throw error;
    },
  };
  const conflictCache = createRepositorySnapshotCache({ journal: conflictingJournal, now });
  await assert.rejects(
    conflictCache.put({ repository, kind: "issue", subject: "issue:conflict", sourceRevision: 1, data: {} }),
    (error) => error.name === "RepositorySnapshotCacheError" && error.code === "REVISION_CONFLICT",
    "journal races must preserve the cache error contract",
  );

  let readFaultLoads = 0;
  const readFaultCache = createRepositorySnapshotCache({
    journal: {
      inspect: async () => {
        const error = new Error("cache directory is unavailable");
        error.code = "EACCES";
        throw error;
      },
      append: async () => assert.fail("an unreadable journal cannot accept a cache write"),
    },
    now,
  });
  const readFaultResult = await readFaultCache.getOrLoad({
    repository,
    kind: "issue",
    subject: "issue:read-fault",
    load: async () => {
      readFaultLoads += 1;
      return { data: { state: "open" } };
    },
  });
  assert.equal(readFaultLoads, 1, "an optional cache read fault must not suppress the live loader");
  assert.equal(readFaultResult.cache, "live_uncached");
  assert.equal(readFaultResult.value.state, "open");
  assert.equal(readFaultResult.degradation.code, "EACCES");
  assert.match(readFaultResult.digest, /^[0-9a-f]{64}$/, "live uncached evidence retains a content digest");
  assert.deepEqual(readFaultCache.metrics(), {
    hits: 0,
    misses: 0,
    refreshes: 0,
    liveLoads: 1,
    avoidedLoads: 0,
    coalescedLoads: 0,
    writeSkips: 1,
    corruptReads: 1,
  }, "read faults are counted once as corrupt rather than also being counted as misses");

  const malformedDirectory = join(root, "malformed-cache-event");
  const malformedJournal = createRepositoryJournal({ directory: malformedDirectory, now });
  await malformedJournal.append({
    identity: "malformed-cache-event",
    repository,
    payload: {
      namespace: "repository_snapshot_cache",
      version: REPOSITORY_SNAPSHOT_CACHE_VERSION,
      operation: "put",
      key: { repository, kind: "issue", subject: "issue:9", headSha: null },
      sourceRevision: 1,
      sourceEtag: null,
      sourceUpdatedAt: null,
      fetchedAt: now(),
      freshnessMs: 1_000,
      trustClass: "github-live",
      data: { safe: true },
      dataDigest: "0".repeat(64),
    },
  });
  const malformedCache = createRepositorySnapshotCache({ journal: malformedJournal, now });
  assert.equal((await malformedCache.get({ repository, kind: "issue", subject: "issue:9" })).status, "missing");
  const degraded = await malformedCache.inspect();
  assert.equal(degraded.status, "degraded");
  assert.deepEqual(degraded.quarantined.map(({ identity }) => identity), ["malformed-cache-event"]);
  const recovered = await malformedCache.invalidate({ repository, kind: "issue", subject: "issue:9", throughRevision: 1 });
  assert.equal(recovered.invalidatedThroughRevision, 1, "a quarantined put must not prevent a durable invalidation barrier");
  assert.equal((await malformedCache.get({ repository, kind: "issue", subject: "issue:9" })).status, "invalidated");

  const mixedDirectory = join(root, "mixed-corrupt-cache-event");
  const mixedJournal = createRepositoryJournal({ directory: mixedDirectory, now });
  await mixedJournal.append({
    identity: "publication-outbox-record",
    repository,
    payload: { namespace: "repository_outbox", version: 1, operation: "enqueue", body: "preserve me" },
  });
  await mixedJournal.append({
    identity: "malformed-cache-invalidation",
    repository,
    payload: {
      namespace: "repository_snapshot_cache",
      version: REPOSITORY_SNAPSHOT_CACHE_VERSION,
      operation: "invalidate",
      key: { repository, kind: "issue", subject: "issue:10", headSha: null },
      sourceRevision: "invalid",
    },
  });
  const mixedCache = createRepositorySnapshotCache({ journal: mixedJournal, now });
  assert.equal((await mixedCache.get({ repository, kind: "issue", subject: "issue:10" })).status, "corrupt");
  await mixedCache.invalidate({ repository, kind: "issue", subject: "issue:10", throughRevision: 5 });
  assert.equal((await mixedJournal.read()).some(({ identity }) => identity === "publication-outbox-record"), true, "cache recovery must preserve unrelated outbox records");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository snapshot cache tests passed: durable provenance, freshness, exact-head isolation, invalidation, bounds, and redaction.");

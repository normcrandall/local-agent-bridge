import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryJournal, REPOSITORY_JOURNAL_VERSION } from "../src/repository-journal.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-repository-journal-"));
const head = "a".repeat(40);

try {
  let tick = 0;
  const journal = createRepositoryJournal({
    directory: join(root, "basic"),
    now: () => new Date(Date.UTC(2026, 6, 26, 12, 0, tick++)).toISOString(),
  });
  const first = await journal.append({
    identity: "issue-200:discovered",
    repository: "Veliqon/Example",
    issueNumber: 200,
    headSha: head.toUpperCase(),
    payload: { state: "discovered", nested: { z: 2, a: 1 } },
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.record.version, REPOSITORY_JOURNAL_VERSION);
  assert.equal(first.record.sequence, 1);
  assert.deepEqual(first.record.binding, {
    repository: "veliqon/example",
    issueNumber: 200,
    pullRequestNumber: null,
    headSha: head,
  });
  assert.deepEqual(first.record.payload, { nested: { a: 1, z: 2 }, state: "discovered" });

  const retry = await journal.append({
    identity: "issue-200:discovered",
    repository: "veliqon/example",
    issueNumber: 200,
    headSha: head,
    payload: { nested: { a: 1, z: 2 }, state: "discovered" },
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.record.sequence, 1);
  assert.equal((await journal.read()).length, 1, "an equivalent retry must not append another record");

  await assert.rejects(
    journal.append({
      identity: "issue-200:discovered",
      repository: "veliqon/example",
      issueNumber: 201,
      headSha: head,
      payload: { state: "discovered" },
    }),
    (error) => error.code === "IDENTITY_CONFLICT",
  );
  await assert.rejects(
    journal.append({ identity: "other-repo", repository: "veliqon/other", payload: {} }),
    (error) => error.code === "REPOSITORY_MISMATCH",
  );

  const concurrentDirectory = join(root, "concurrent");
  const concurrent = createRepositoryJournal({ directory: concurrentDirectory });
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => concurrent.append({
    identity: `event-${index}`,
    repository: "veliqon/example",
    issueNumber: 200,
    pullRequestNumber: 42,
    headSha: head,
    payload: { index },
  })));
  assert.equal(results.every((result) => result.idempotent === false), true);
  const concurrentRecords = await concurrent.read();
  assert.deepEqual(concurrentRecords.map((record) => record.sequence), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal(new Set(concurrentRecords.map((record) => record.identity)).size, 30);
  assert.equal(concurrentRecords.every((record) => record.binding.pullRequestNumber === 42), true);

  const duplicateRace = createRepositoryJournal({ directory: join(root, "duplicate-race") });
  const raced = await Promise.all(Array.from({ length: 20 }, () => duplicateRace.append({
    identity: "same-retry",
    repository: "veliqon/example",
    issueNumber: 200,
    payload: { stable: true },
  })));
  assert.equal(raced.filter((result) => result.idempotent === false).length, 1);
  assert.equal(raced.filter((result) => result.idempotent === true).length, 19);
  assert.equal((await duplicateRace.read()).length, 1, "concurrent equivalent retries must allocate one sequence");

  const pageOne = await concurrent.export({ limit: 7 });
  assert.equal(pageOne.records.length, 7);
  assert.equal(pageOne.hasMore, true);
  assert.equal(pageOne.repository, "veliqon/example");
  const pageTwo = await concurrent.export({ afterSequence: pageOne.nextSequence, limit: 7 });
  assert.deepEqual(pageTwo.records.map((record) => record.sequence), [8, 9, 10, 11, 12, 13, 14]);
  assert.equal(pageTwo.records.every((record) => record.binding.headSha === head), true, "export must preserve binding metadata");
  await assert.rejects(concurrent.export({ limit: 1_001 }), (error) => error.code === "INVALID_LIMIT");

  const orphanTemporary = join(concurrentDirectory, "repository-journal.jsonl.999.11111111-1111-4111-8111-111111111111.tmp");
  const unrelatedTemporary = join(concurrentDirectory, "repository-journal.jsonl.keep.tmp");
  await writeFile(orphanTemporary, "orphaned retention rewrite");
  await writeFile(unrelatedTemporary, "must not be removed");
  const retained = await concurrent.retain({ maxRecords: 8 });
  assert.deepEqual(retained, { removed: 22, retained: 8, firstSequence: 23 });
  await assert.rejects(stat(orphanTemporary), (error) => error.code === "ENOENT", "recognized orphan retention temps must be removed under lock");
  assert.equal((await readFile(unrelatedTemporary, "utf8")), "must not be removed", "cleanup must not remove unrelated temp files");
  assert.deepEqual((await concurrent.read()).map((record) => record.sequence), [23, 24, 25, 26, 27, 28, 29, 30]);
  const reclaimedCursor = await concurrent.export({ afterSequence: 0, limit: 8 });
  assert.equal(reclaimedCursor.earliestAvailableSequence, 23);
  assert.deepEqual(reclaimedCursor.cursorGap, {
    kind: "retention_loss",
    requestedAfterSequence: 0,
    earliestAvailableSequence: 23,
    missingFromSequence: 1,
    missingThroughSequence: 22,
  });
  const retainedCursor = await concurrent.export({ afterSequence: 22, limit: 8 });
  assert.equal(retainedCursor.cursorGap, null, "a cursor immediately before retained history has no loss gap");
  const afterRetention = await concurrent.append({
    identity: "event-after-retention",
    repository: "veliqon/example",
    payload: { retained: true },
  });
  assert.equal(afterRetention.record.sequence, 31, "retention must not reset the monotonic sequence");
  assert.equal((await concurrent.read())[0].previousDigest !== null, true, "retention must preserve the original chain anchor");

  const torn = createRepositoryJournal({ directory: join(root, "torn") });
  await torn.append({ identity: "complete", repository: "veliqon/example", payload: { ok: true } });
  await appendFile(torn.path, '{"version":1,"sequence":2');
  const tornInspection = await torn.inspect();
  assert.equal(tornInspection.status, "torn_tail");
  assert.equal(tornInspection.error.code, "TORN_TAIL");
  assert.equal(tornInspection.records.length, 1, "inspection must expose the valid prefix without accepting the torn tail");
  await assert.rejects(torn.read(), (error) => error.code === "TORN_TAIL");
  await assert.rejects(
    torn.append({ identity: "must-not-hide-tail", repository: "veliqon/example", payload: {} }),
    (error) => error.code === "TORN_TAIL",
  );

  const corrupt = createRepositoryJournal({ directory: join(root, "corrupt") });
  await corrupt.append({ identity: "one", repository: "veliqon/example", payload: { value: 1 } });
  await corrupt.append({ identity: "two", repository: "veliqon/example", payload: { value: 2 } });
  const lines = (await readFile(corrupt.path, "utf8")).trimEnd().split("\n");
  const changed = JSON.parse(lines[0]);
  changed.payload.value = 999;
  lines[0] = JSON.stringify(changed);
  await writeFile(corrupt.path, `${lines.join("\n")}\n`);
  const corruption = await corrupt.inspect();
  assert.equal(corruption.status, "corrupt");
  assert.equal(corruption.error.code, "INTEGRITY_FAILURE");
  assert.equal(corruption.error.line, 1);
  await assert.rejects(corrupt.export(), (error) => error.code === "INTEGRITY_FAILURE");

  await assert.rejects(
    journal.append({ identity: "bad-head", repository: "veliqon/example", headSha: "abc", payload: {} }),
    (error) => error.code === "INVALID_BINDING",
  );
  await assert.rejects(
    journal.append({ identity: "bad-payload", repository: "veliqon/example", payload: { nope: undefined } }),
    (error) => error.code === "INVALID_PAYLOAD",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Repository journal tests passed: versioned bindings, atomic sequencing, idempotency, integrity, export, and retention.");

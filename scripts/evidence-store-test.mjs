import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceStore } from "../src/evidence-store.mjs";

const directory = await mkdtemp(join(tmpdir(), "agent-bridge-evidence-"));
const head = "a".repeat(40);
const nextHead = "b".repeat(40);

try {
  let now = "2026-07-22T12:00:00.000Z";
  const store = createEvidenceStore({ directory, now: () => now });
  const scope = { repository: "veliqon/example", headSha: head };

  const recorded = await store.put({
    kind: "issue_snapshot",
    key: "issue:42:2026-07-22T12:00:00Z",
    scope,
    value: { title: "Evidence cache", body: "One immutable snapshot." },
    source: "github_app",
  });
  assert.match(recorded.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual((await store.get({ kind: "issue_snapshot", key: "issue:42:2026-07-22T12:00:00Z", scope })).value, {
    title: "Evidence cache",
    body: "One immutable snapshot.",
  });
  assert.equal(await store.get({
    kind: "issue_snapshot",
    key: "issue:42:2026-07-22T12:00:00Z",
    scope: { ...scope, headSha: nextHead },
  }), null, "head-bound evidence must miss after the target changes");

  let loads = 0;
  const load = async () => {
    loads += 1;
    return { files: ["src/index.mjs"] };
  };
  const firstMap = await store.getOrLoad({ kind: "repository_map", key: "tracked-files", scope, source: "git", load });
  const secondMap = await store.getOrLoad({ kind: "repository_map", key: "tracked-files", scope, source: "git", load });
  assert.equal(loads, 1);
  assert.equal(firstMap.cache, "miss");
  assert.equal(secondMap.cache, "hit");
  now = "2026-07-22T12:01:00.000Z";
  const refreshedMap = await store.getOrLoad({
    kind: "repository_map",
    key: "tracked-files",
    scope,
    source: "git",
    maxAgeMs: 30_000,
    load: async () => {
      loads += 1;
      return { files: ["README.md", "src/index.mjs"] };
    },
  });
  assert.equal(refreshedMap.cache, "refresh");
  assert.deepEqual(refreshedMap.value.files, ["README.md", "src/index.mjs"]);
  assert.equal(loads, 2);

  await store.recordVerificationReceipt({
    repository: scope.repository,
    headSha: head,
    command: "npm test",
    cwd: ".",
    environmentFingerprint: "node-24-lock-123",
    exitCode: 0,
    startedAt: "2026-07-22T12:00:00.000Z",
    completedAt: "2026-07-22T12:00:05.000Z",
    source: "github_ci",
    attestation: "authoritative",
    outputDigest: "c".repeat(64),
  });
  assert.equal((await store.findReusableVerification({
    repository: scope.repository,
    headSha: head,
    command: "npm test",
    cwd: ".",
    environmentFingerprint: "node-24-lock-123",
  })).exitCode, 0);
  assert.equal(await store.findReusableVerification({
    repository: scope.repository,
    headSha: nextHead,
    command: "npm test",
    cwd: ".",
    environmentFingerprint: "node-24-lock-123",
  }), null);
  assert.equal(await store.findReusableVerification({
    repository: scope.repository,
    headSha: head,
    command: "npm test",
    cwd: ".",
    environmentFingerprint: "different-environment",
  }), null);

  await store.recordVerificationReceipt({
    repository: scope.repository,
    headSha: head,
    command: "npm run lint",
    cwd: ".",
    environmentFingerprint: "node-24-lock-123",
    exitCode: 1,
    startedAt: "2026-07-22T12:01:00.000Z",
    completedAt: "2026-07-22T12:01:02.000Z",
    source: "provider",
    attestation: "claimed",
    outputDigest: "d".repeat(64),
  });
  assert.equal(await store.findReusableVerification({
    repository: scope.repository,
    headSha: head,
    command: "npm run lint",
    cwd: ".",
    environmentFingerprint: "node-24-lock-123",
  }), null, "failed or claimed verification must never suppress a gate");

  const concurrentStore = createEvidenceStore({ directory: join(directory, "concurrent"), now: () => now });
  await Promise.all(Array.from({ length: 20 }, () => concurrentStore.put({
    kind: "repository_map",
    key: "same-content",
    scope,
    value: { files: ["README.md"] },
    source: "git",
  })));
  assert.deepEqual((await concurrentStore.get({ kind: "repository_map", key: "same-content", scope })).value, {
    files: ["README.md"],
  }, "concurrent content-addressed writes must publish one complete JSON object");

  const singleFlightStore = createEvidenceStore({ directory: join(directory, "single-flight"), now: () => now });
  let concurrentLoads = 0;
  const concurrentMaps = await Promise.all(Array.from({ length: 20 }, () => singleFlightStore.getOrLoad({
    kind: "repository_map",
    key: "cold-start",
    scope,
    source: "git",
    load: async () => {
      concurrentLoads += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      return { files: ["README.md", "src/index.mjs"] };
    },
  })));
  assert.equal(concurrentLoads, 1, "same-process lanes must coalesce a concurrent cold cache load");
  assert.equal(concurrentMaps.filter((entry) => entry.cache === "miss").length, 1);
  assert.equal(concurrentMaps.filter((entry) => entry.cache === "coalesced").length, 19);
  assert.equal(singleFlightStore.metrics().avoidedLoads, 19);

  const manifest = await store.manifest(scope);
  assert.equal(manifest.entries.length, 4);
  assert.deepEqual(store.metrics(), { hits: 5, misses: 4, writes: 5, avoidedLoads: 1, refreshes: 1 });
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Evidence store tests passed.");

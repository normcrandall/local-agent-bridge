import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReviewBenchmarkRecord,
  readReviewBenchmarkLedger,
} from "../src/review-benchmark-ledger.mjs";
import {
  adjudicateReviewRuns,
  normalizeFinding,
  normalizeReviewEnvelope,
} from "../src/review-benchmark-model.mjs";
import { aggregateReviewBenchmarks } from "../src/review-benchmark-report.mjs";

const repository = "Veliqon/Example";
const headSha = "a".repeat(40);
const timestamp = "2026-07-26T12:00:00-04:00";
const acceptedFinding = { path: "src/a.mjs", line: 12, severity: "high", ruleId: "correctness", summary: "Value can be lost" };
const rejectedFinding = { path: "src/b.mjs", line: 3, severity: "low", summary: "False alarm" };
const base = {
  repository,
  headSha,
  provider: "Qwen",
  runId: "run-1",
  timestamp,
  latencyMs: 100,
  localProvider: true,
  findings: [rejectedFinding, acceptedFinding, acceptedFinding],
};

const normalized = normalizeReviewEnvelope(base);
assert.equal(normalized.repository, "veliqon/example");
assert.equal(normalized.authority, "non-authorizing", "local records are unconditionally non-authorizing");
assert.equal(normalized.findings.length, 2, "equivalent findings are normalized and deduplicated");
assert.deepEqual(normalized.findings.map((finding) => finding.key), [...normalized.findings.map((finding) => finding.key)].sort());
assert.throws(() => normalizeReviewEnvelope({ ...base, headSha: "abc" }), /exact 40-character/);
assert.throws(() => normalizeReviewEnvelope({ ...base, repository: "example" }), /owner\/name/);

const root = await mkdtemp(join(tmpdir(), "review-benchmark-"));
try {
  const ledgerPath = join(root, "ledger.jsonl");
  const first = await appendReviewBenchmarkRecord(ledgerPath, base);
  assert.equal(first.appended, true);
  const duplicate = await appendReviewBenchmarkRecord(ledgerPath, base);
  assert.equal(duplicate.idempotent, true);
  assert.equal((await readFile(ledgerPath, "utf8")).trim().split("\n").length, 1, "idempotent writes do not append");
  await assert.rejects(
    appendReviewBenchmarkRecord(ledgerPath, { ...base, latencyMs: 101 }),
    (error) => error.code === "BENCHMARK_RECORD_CONFLICT",
  );
  assert.equal((await readReviewBenchmarkLedger(ledgerPath))[0].schemaVersion, 1);

  const cloudRun = normalizeReviewEnvelope({
    ...base,
    provider: "Claude",
    runId: "run-2",
    localProvider: false,
    latencyMs: 300,
    findings: [acceptedFinding],
  });
  const acceptedKey = normalizeFinding(acceptedFinding).key;
  const rejectedKey = normalizeFinding(rejectedFinding).key;
  const adjudication = adjudicateReviewRuns([base, cloudRun], {
    acceptedFindings: [acceptedFinding],
    rejectedFindings: [rejectedKey],
  });
  assert.deepEqual(adjudication.results.map((entry) => entry.provider), ["claude", "qwen"]);
  assert.deepEqual(adjudication.results[0].truePositives, [acceptedKey]);
  assert.deepEqual(adjudication.results[1].falsePositives, [rejectedKey]);
  assert.throws(
    () => adjudicateReviewRuns([base, { ...cloudRun, headSha: "b".repeat(40) }]),
    /same exact repository and head SHA/,
  );

  assert.deepEqual(aggregateReviewBenchmarks([]), { providers: [], providerCount: 0, runCount: 0 });
  const report = aggregateReviewBenchmarks([adjudication]);
  assert.equal(report.providerCount, 2);
  assert.equal(report.runCount, 2);
  assert.deepEqual(report.providers[0], {
    provider: "claude",
    runs: 1,
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
    unadjudicated: 0,
    precision: 1,
    recall: 1,
    latencyMs: { min: 300, median: 300, p95: 300, max: 300, mean: 300 },
  });
  assert.equal(report.providers[1].precision, 0.5);
  assert.equal(report.providers[1].recall, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review benchmark tests passed");

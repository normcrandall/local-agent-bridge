import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  transitionFindingAdjudication,
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
  exactHeadComplete: true,
  contractDigest: "c".repeat(64),
  evidenceSurfaceDigest: "e".repeat(64),
  findings: [rejectedFinding, acceptedFinding, acceptedFinding],
};

const normalized = normalizeReviewEnvelope(base);
assert.equal(normalized.repository, "veliqon/example");
assert.equal(normalized.authority, "non-authorizing", "local records are unconditionally non-authorizing");
assert.equal(normalized.mode, "shadow-review");
assert.equal(normalizeReviewEnvelope({ ...base, exactHeadComplete: undefined }).exactHeadComplete, null, "missing exact-head completion is unknown, never success");
assert.deepEqual(normalizeReviewEnvelope({ ...base, reviewArtifact: {
  kind: "github-review", reference: "https://github.com/veliqon/example/pull/1#pullrequestreview-1", digest: "1".repeat(64),
} }).reviewArtifact, { kind: "github-review", reference: "https://github.com/veliqon/example/pull/1#pullrequestreview-1", digest: "1".repeat(64) });
assert.equal(normalized.findings.length, 2, "equivalent findings are normalized and deduplicated");
assert.deepEqual(normalized.findings.map((finding) => finding.key), [...normalized.findings.map((finding) => finding.key)].sort());
assert.throws(() => normalizeReviewEnvelope({ ...base, headSha: "abc" }), /exact 40-character/);
assert.throws(() => normalizeReviewEnvelope({ ...base, repository: "example" }), /owner\/name/);
assert.throws(() => normalizeReviewEnvelope({ ...base, localProvider: "yes" }), /must be a boolean/);
assert.throws(() => normalizeReviewEnvelope({ ...base, prompt: "retain me" }), /forbidden in the redacted benchmark ledger/);
assert.equal(normalizeReviewEnvelope({ ...base, findings: [{ ...acceptedFinding, proposedFix: "Use sk-abcdefghijklmnopqrstuvwxyz123456 safely" }] }).findings[0].proposedFix.includes("[REDACTED]"), true);
assert.throws(
  () => normalizeReviewEnvelope({ ...base, schemaVersion: 2 }),
  (error) => error.code === "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA",
);

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
  const secretLedgerPath = join(root, "redacted-ledger.jsonl");
  await appendReviewBenchmarkRecord(secretLedgerPath, { ...base, runId: "redacted", findings: [{
    ...acceptedFinding, proposedFix: "replace sk-abcdefghijklmnopqrstuvwxyz123456 before retrying",
  }] });
  const redactedContents = await readFile(secretLedgerPath, "utf8");
  assert.doesNotMatch(redactedContents, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(redactedContents, /\[REDACTED\]/);
  await assert.rejects(appendReviewBenchmarkRecord(secretLedgerPath, { ...base, runId: "unsafe", privateReasoning: "hidden" }), /forbidden/);
  const observedKey = normalizeFinding(acceptedFinding).key;
  await appendReviewBenchmarkRecord(ledgerPath, {
    schemaVersion: 1, recordType: "finding_adjudication", repository, headSha,
    adjudicationId: "decision-1", timestamp, findingKey: observedKey, status: "accepted",
    finding: acceptedFinding,
    evidence: ["chair verified with implementation and re-review evidence"],
  });
  await assert.rejects(appendReviewBenchmarkRecord(ledgerPath, {
    schemaVersion: 1, recordType: "finding_adjudication", repository, headSha,
    adjudicationId: "stale-decision", timestamp, findingKey: observedKey, previousStatus: "unresolved", status: "rejected",
    evidence: ["later evidence"],
  }), (error) => error.code === "BENCHMARK_ADJUDICATION_STALE");
  await appendReviewBenchmarkRecord(ledgerPath, {
    schemaVersion: 1, recordType: "review_outcome", repository, headSha,
    outcomeId: "post-merge-1", provider: "qwen", runId: "run-1", timestamp,
    outcomes: { postMergeDefects: 1 }, evidence: ["issue #123 linked to this review head"],
  });
  assert.deepEqual((await readReviewBenchmarkLedger(ledgerPath)).map((entry) => entry.recordType), ["review_run", "finding_adjudication", "review_outcome"]);

  const futureLedgerPath = join(root, "future-ledger.jsonl");
  await writeFile(futureLedgerPath, `${JSON.stringify({ ...base, schemaVersion: 2 })}\n`);
  await assert.rejects(
    readReviewBenchmarkLedger(futureLedgerPath),
    (error) => error.code === "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA" && /line 1/.test(error.message),
    "future ledger records must fail closed instead of being rewritten as v1",
  );
  await assert.rejects(
    appendReviewBenchmarkRecord(futureLedgerPath, base),
    (error) => error.code === "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA",
    "an unsupported same-identity record cannot be treated as an idempotent v1 write",
  );
  const unversionedLedgerPath = join(root, "unversioned-ledger.jsonl");
  await writeFile(unversionedLedgerPath, `${JSON.stringify(base)}\n`);
  await assert.rejects(
    readReviewBenchmarkLedger(unversionedLedgerPath),
    (error) => error.code === "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA",
    "persisted records without an explicit schema version fail closed",
  );

  const contendedLedgerPath = join(root, "contended-ledger.jsonl");
  await mkdir(`${contendedLedgerPath}.lock`);
  const releaseContention = setTimeout(() => rm(`${contendedLedgerPath}.lock`, { recursive: true, force: true }), 40);
  try {
    const startedAt = Date.now();
    const contended = await appendReviewBenchmarkRecord(contendedLedgerPath, { ...base, runId: "contended" });
    assert.equal(contended.appended, true);
    assert.ok(Date.now() - startedAt >= 30, "append waits for the existing lock instead of bypassing it");
  } finally {
    clearTimeout(releaseContention);
    await rm(`${contendedLedgerPath}.lock`, { recursive: true, force: true });
  }

  const cloudRun = normalizeReviewEnvelope({
    ...base,
    provider: "Claude",
    runId: "run-2",
    localProvider: false,
    latencyMs: 300,
    findings: [acceptedFinding],
    model: "opus-5",
  });
  const acceptedKey = normalizeFinding(acceptedFinding).key;
  const rejectedKey = normalizeFinding(rejectedFinding).key;
  const adjudication = adjudicateReviewRuns([base, cloudRun], { findingAdjudications: [
    { findingKey: acceptedKey, finding: acceptedFinding, status: "accepted", evidence: ["verified by implementation and re-review"] },
    { findingKey: rejectedKey, status: "rejected", evidence: ["chair disproved the claim"] },
  ] });
  assert.deepEqual(adjudication.results.map((entry) => entry.provider), ["claude", "qwen"]);
  assert.deepEqual(adjudication.results[0].truePositives, [acceptedKey]);
  assert.deepEqual(adjudication.results[1].falsePositives, [rejectedKey]);
  assert.throws(
    () => adjudicateReviewRuns([base, { ...cloudRun, headSha: "b".repeat(40) }]),
    /same exact repository and head SHA/,
  );
  assert.throws(() => adjudicateReviewRuns([base], { acceptedFindings: [acceptedFinding] }), /unsupported/);
  assert.throws(
    () => adjudicateReviewRuns([base, { ...cloudRun, contractDigest: "1".repeat(64) }]),
    /same prompt contract/,
  );
  assert.throws(() => transitionFindingAdjudication({ status: "accepted" }, { status: "unresolved" }), /back to unresolved/);
  assert.throws(() => transitionFindingAdjudication(null, { status: "accepted" }), /requires evidence/);
  assert.equal(transitionFindingAdjudication(null, { status: "accepted", evidence: ["regression test"] }).status, "accepted");

  assert.deepEqual(aggregateReviewBenchmarks([]), { providers: [], providerCount: 0, runCount: 0 });
  const report = aggregateReviewBenchmarks([adjudication]);
  assert.equal(report.providerCount, 2);
  assert.equal(report.runCount, 2);
  assert.equal(report.providers[0].provider, "claude");
  assert.equal(report.providers[0].model, "opus-5");
  assert.equal(report.providers[0].runs, 1);
  assert.equal(report.providers[0].precision, 1);
  assert.equal(report.providers[0].recall, 1);
  assert.equal(report.providers[0].blockingRecall, 1);
  assert.equal(report.providers[0].confidence, "insufficient");
  assert.deepEqual(report.providers[0].latencyMs, { min: 300, median: 300, p95: 300, max: 300, mean: 300 });
  assert.equal(report.providers[1].precision, 0.5);
  assert.equal(report.providers[1].recall, 1);

  const latencyReport = aggregateReviewBenchmarks([{
    results: [300, 100, 200].map((latencyMs, index) => ({
      provider: "qwen",
      runId: `latency-${index}`,
      latencyMs,
      truePositives: [],
      falsePositives: [],
      falseNegatives: [],
      unadjudicated: [],
    })),
  }]);
  assert.deepEqual(latencyReport.providers[0].latencyMs, {
    min: 100,
    median: 200,
    p95: 300,
    max: 300,
    mean: 200,
  }, "latency selection sorts samples and uses deterministic nearest-rank percentiles");
  assert.equal(latencyReport.providers[0].exactHeadCompletionCoverage, 0);
  assert.equal(latencyReport.providers[0].exactHeadCompletionRate, null);
  assert.equal(latencyReport.providers[0].contractBindingCoverage, 0);
  assert.equal(latencyReport.providers[0].adjudicationCoverage, 0);
  assert.equal(latencyReport.providers[0].confidence, "incomplete", "unbound or unadjudicated cohorts cannot earn confidence");

  const multiRunCohort = aggregateReviewBenchmarks([{
    repository: "veliqon/example",
    results: [
      {
        provider: "qwen", model: "qwen3.6", repositoryCohort: "node-services", runId: "cohort-1", latencyMs: 100,
        truePositives: ["tp-1"], falsePositives: ["fp-1"], falseNegatives: ["fn-1"], unadjudicated: ["open-1"],
        duplicateFindings: ["duplicate-1"], advisoryFindings: [], blockingTruePositives: ["tp-1"], blockingFalseNegatives: ["fn-1"],
        uniqueValidFindings: ["tp-1"], validCitationCount: 2, supportedCount: 1, actionableCount: 3,
        severityCalibratedCount: 1, severityEvaluatedCount: 2, exactHeadComplete: true, contractBound: true, adjudicationComplete: true,
      },
      {
        provider: "qwen", model: "qwen3.6", repositoryCohort: "node-services", runId: "cohort-2", latencyMs: 200,
        truePositives: ["tp-2"], falsePositives: [], falseNegatives: [], unadjudicated: [],
        duplicateFindings: [], advisoryFindings: ["advisory-1"], blockingTruePositives: [], blockingFalseNegatives: [],
        uniqueValidFindings: [], validCitationCount: 1, supportedCount: 2, actionableCount: 1,
        severityCalibratedCount: 1, severityEvaluatedCount: 1, exactHeadComplete: false, contractBound: true, adjudicationComplete: true,
      },
    ],
  }]).providers[0];
  assert.equal(multiRunCohort.runs, 2);
  assert.equal(multiRunCohort.precision, 2 / 3);
  assert.equal(multiRunCohort.recall, 2 / 3);
  assert.equal(multiRunCohort.blockingRecall, 1 / 2);
  assert.equal(multiRunCohort.duplicateRate, 1 / 6);
  assert.equal(multiRunCohort.citationValidity, 1 / 2);
  assert.equal(multiRunCohort.evidenceSupport, 1 / 2);
  assert.equal(multiRunCohort.actionability, 2 / 3);
  assert.equal(multiRunCohort.severityCalibration, 2 / 3);
  assert.equal(multiRunCohort.exactHeadCompletionRate, 1 / 2);
  assert.equal(multiRunCohort.exactHeadCompletionCoverage, 1);
  assert.equal(multiRunCohort.contractBindingCoverage, 1);
  assert.equal(multiRunCohort.adjudicationCoverage, 1);
  assert.equal(multiRunCohort.confidence, "incomplete", "a failed exact-head run prevents quality confidence");
  assert.equal(multiRunCohort.uniqueValidFindings, 1);
  assert.deepEqual(multiRunCohort.latencyMs, { min: 100, median: 100, p95: 200, max: 200, mean: 150 });

  const richFinding = normalizeFinding({
    path: "src/c.mjs", startLine: 10, endLine: 12, severity: "critical", claim: "Authorization can be bypassed",
    proposedFix: "Fail closed", citationValid: true, evidenceSupported: true, actionable: true,
  });
  const richRun = normalizeReviewEnvelope({ ...base, runId: "rich", model: "qwen3.6", repositoryCohort: "node-services",
    findings: [richFinding], exactHeadComplete: true,
    performance: { localWallTimeMs: 150, inputTokens: 10, outputTokens: 20, peakMemoryMb: 512 },
    reliability: { recoveryCount: 1, fallbackCount: 2 }, outcomes: { laterCiFailures: 1, postMergeDefects: 1 },
  });
  const richAdjudication = adjudicateReviewRuns([richRun], { findingAdjudications: [{
    findingKey: richFinding.key, finding: richFinding, status: "accepted", evidence: ["chair verified and regression test added"],
  }] });
  const richReport = aggregateReviewBenchmarks([richAdjudication]).providers[0];
  assert.equal(richReport.repositoryCohort, "node-services");
  assert.equal(richReport.citationValidity, 1);
  assert.equal(richReport.evidenceSupport, 1);
  assert.equal(richReport.actionability, 1);
  assert.equal(richReport.uniqueValidFindings, 1);
  assert.equal(richReport.reliability.recoveries, 1);
  assert.equal(richReport.outcomes.postMergeDefects, 1);
  assert.equal(richReport.localWallTimeMs.median, 150);

  const sharedClaim = { path: "src/order.mjs", line: 7, claim: "Shared defect", proposedFix: "Fix it", citationValid: true };
  const lowRun = normalizeReviewEnvelope({ ...base, provider: "alpha", runId: "alpha", findings: [{ ...sharedClaim, severity: "low", blocking: false }] });
  const criticalRun = normalizeReviewEnvelope({ ...base, provider: "beta", runId: "beta", findings: [{ ...sharedClaim, severity: "critical", blocking: true }] });
  const emptyRun = normalizeReviewEnvelope({ ...base, provider: "gamma", runId: "gamma", findings: [] });
  const chairFinding = normalizeFinding({ ...sharedClaim, severity: "medium", blocking: true });
  const orderOptions = { findingAdjudications: [{ findingKey: chairFinding.key, finding: chairFinding, status: "accepted", evidence: ["chair-confirmed defect"] }] };
  const forward = adjudicateReviewRuns([lowRun, criticalRun, emptyRun], orderOptions).results;
  const reversed = adjudicateReviewRuns([criticalRun, lowRun, emptyRun], orderOptions).results;
  assert.deepEqual(forward, reversed, "provider order cannot change blocking or severity metrics");
  assert.equal(forward.find((row) => row.provider === "alpha").blockingTruePositives.length, 0);
  assert.equal(forward.find((row) => row.provider === "beta").blockingTruePositives.length, 1);
  assert.equal(forward.find((row) => row.provider === "gamma").blockingFalseNegatives.length, 1, "missed blocking severity comes from chair adjudication");
  assert.equal(forward.find((row) => row.provider === "alpha").severityCalibratedCount, 0);
  assert.equal(forward.find((row) => row.provider === "beta").severityCalibratedCount, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review benchmark tests passed");

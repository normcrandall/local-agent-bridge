import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendReviewBenchmarkRecord } from "../src/review-benchmark-ledger.mjs";
import { normalizeFinding } from "../src/review-benchmark-model.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "scripts/review-benchmark-report.mjs");
const scratch = await mkdtemp(join(tmpdir(), "review-benchmark-cli-"));
const ledger = join(scratch, "ledger.jsonl");
const head = "a".repeat(40);
const otherHead = "b".repeat(40);

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function record(overrides = {}) {
  return {
    repository: "Veliqon/Example",
    headSha: head,
    provider: "Qwen3-Coder",
    runId: "qwen-1",
    timestamp: "2026-07-26T12:00:00-04:00",
    latencyMs: 120,
    localProvider: true,
    exactHeadComplete: true,
    contractDigest: "c".repeat(64),
    evidenceSurfaceDigest: "e".repeat(64),
    findings: [{ path: "src/a.mjs", line: 4, severity: "high", summary: "Possible loss" }],
    ...overrides,
  };
}

try {
  await appendReviewBenchmarkRecord(ledger, record());
  await appendReviewBenchmarkRecord(ledger, record({
    provider: "Claude",
    runId: "claude-1",
    latencyMs: 300,
    localProvider: false,
    findings: [],
  }));
  await appendReviewBenchmarkRecord(ledger, record({
    repository: "veliqon/other",
    headSha: otherHead,
    provider: "Claude",
    runId: "claude-2",
    latencyMs: 450,
    localProvider: false,
  }));

  const before = await readFile(ledger, "utf8");
  const beforeMode = (await stat(ledger)).mode;
  const jsonRun = run(["--ledger", ledger, "--repository", "VELIQON/EXAMPLE", "--head", head.toUpperCase(), "--json"]);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const report = JSON.parse(jsonRun.stdout);
  assert.deepEqual(report.filters, { provider: null, model: null, cohort: null, repository: "veliqon/example", headSha: head });
  assert.deepEqual(report.sample, {
    state: "incomplete",
    runCount: 2,
    targetCount: 1,
    message: "Samples are observational; precision and recall are unavailable without independent adjudication.",
  });
  assert.deepEqual(report.targets[0].providers.map((row) => row.provider), ["claude", "qwen3-coder"]);
  assert.equal(report.targets[0].providers[0].precision, null);
  assert.equal(report.targets[0].providers[0].recall, null);
  assert.equal(report.targets[0].providers[0].model, null, "missing model identity is explicit, not guessed");
  assert.equal(report.targets[0].providers[1].executionClass, "local");
  assert.equal(report.targets[0].providers[1].latencyMs.median, 120);
  assert.equal(await readFile(ledger, "utf8"), before, "reporting never mutates the ledger");
  assert.equal((await stat(ledger)).mode, beforeMode, "reporting leaves ledger metadata unchanged");

  const deterministicRun = run(["--ledger", ledger, "--repository", "veliqon/example", "--head", head, "--json"]);
  assert.equal(deterministicRun.stdout, jsonRun.stdout, "JSON is byte-for-byte deterministic for equivalent normalized filters");

  const adjudications = join(scratch, "adjudications.json");
  await writeFile(adjudications, JSON.stringify([{ repository: "veliqon/example", headSha: head, findingAdjudications: [{
    findingKey: normalizeFinding(record().findings[0]).key, finding: record().findings[0], status: "accepted", evidence: ["fixed and re-reviewed"],
  }] }]));
  const adjudicatedRun = run(["--ledger", ledger, "--repository", "veliqon/example", "--adjudications", adjudications, "--json"]);
  assert.equal(adjudicatedRun.status, 0, adjudicatedRun.stderr);
  const adjudicated = JSON.parse(adjudicatedRun.stdout);
  assert.equal(adjudicated.sample.state, "adjudicated");
  assert.equal(adjudicated.targets[0].providers.find((row) => row.provider === "qwen3-coder").precision, 1);
  assert.equal(adjudicated.targets[0].providers.find((row) => row.provider === "claude").recall, 0);
  assert.equal(adjudicated.targets[0].confidence, "insufficient");

  const findingKey = normalizeFinding(record().findings[0]).key;
  await appendReviewBenchmarkRecord(ledger, {
    schemaVersion: 1, recordType: "finding_adjudication", repository: "veliqon/example", headSha: head,
    adjudicationId: "decision-1", timestamp: "2026-07-26T17:00:00Z", findingKey,
    finding: record().findings[0], status: "accepted", evidence: ["regression test and exact-head re-review"],
  });
  await appendReviewBenchmarkRecord(ledger, {
    schemaVersion: 1, recordType: "review_outcome", repository: "veliqon/example", headSha: head,
    outcomeId: "outcome-1", provider: "qwen3-coder", runId: "qwen-1", timestamp: "2026-07-27T17:00:00Z",
    outcomes: { postMergeDefects: 1 }, evidence: ["linked post-merge issue"],
  });
  const ledgerAdjudicatedRun = run(["--ledger", ledger, "--repository", "veliqon/example", "--json"]);
  assert.equal(ledgerAdjudicatedRun.status, 0, ledgerAdjudicatedRun.stderr);
  const ledgerAdjudicated = JSON.parse(ledgerAdjudicatedRun.stdout);
  const qwenCohort = ledgerAdjudicated.targets[0].providers.find((row) => row.provider === "qwen3-coder");
  assert.equal(ledgerAdjudicated.sample.state, "adjudicated");
  assert.equal(qwenCohort.precision, 1);
  assert.equal(qwenCohort.outcomes.postMergeDefects, 1);

  const providerRun = run(["--ledger", ledger, "--provider", "CLAUDE", "--repository", "veliqon/example"]);
  assert.equal(providerRun.status, 0, providerRun.stderr);
  assert.match(providerRun.stdout, /OFFLINE REVIEW BENCHMARK · OBSERVATIONAL ONLY/);
  assert.match(providerRun.stdout, /claude \(model n\/r\)/);
  assert.match(providerRun.stdout, /insufficient/);
  assert.match(providerRun.stdout, /cannot satisfy or bypass any review or merge gate/);
  assert.doesNotMatch(providerRun.stdout, /qwen3-coder/);

  const emptyRun = run(["--ledger", ledger, "--provider", "missing", "--json"]);
  assert.equal(emptyRun.status, 0, "an empty filtered result is valid, not an operational failure");
  const empty = JSON.parse(emptyRun.stdout);
  assert.deepEqual(empty.sample, {
    state: "empty",
    runCount: 0,
    targetCount: 0,
    message: "No benchmark runs matched the selected filters.",
  });
  assert.deepEqual(empty.targets, []);

  const missingLedgerRun = run(["--ledger", join(scratch, "not-created.jsonl"), "--json"]);
  assert.equal(missingLedgerRun.status, 1, "an explicitly requested absent ledger is an operational failure");
  assert.equal(missingLedgerRun.stdout, "");
  assert.match(missingLedgerRun.stderr, /explicitly supplied ledger does not exist/);

  const filteredEmptyRun = run(["--ledger", ledger, "--repository", "veliqon/missing", "--json"]);
  assert.equal(filteredEmptyRun.status, 0, "an existing ledger with no matching records is a valid empty sample");
  assert.equal(JSON.parse(filteredEmptyRun.stdout).sample.state, "empty");
  assert.match(JSON.parse(filteredEmptyRun.stdout).sample.message, /No benchmark runs matched/);

  const noLedgerRun = run([]);
  assert.equal(noLedgerRun.status, 2);
  assert.match(noLedgerRun.stderr, /--ledger is required/);
  assert.match(noLedgerRun.stderr, /--help/);
  const badHeadRun = run(["--ledger", ledger, "--head", "abc"]);
  assert.equal(badHeadRun.status, 2);
  assert.match(badHeadRun.stderr, /exact 40-character hexadecimal commit SHA/);
  const unknownRun = run(["--ledger", ledger, "--wat"]);
  assert.equal(unknownRun.status, 2);
  assert.match(unknownRun.stderr, /unknown argument: --wat/);

  const invalidLedger = join(scratch, "invalid.jsonl");
  await writeFile(invalidLedger, "not json\n");
  const invalidRun = run(["--ledger", invalidLedger]);
  assert.equal(invalidRun.status, 1);
  assert.match(invalidRun.stderr, /Ledger error/);
  assert.match(invalidRun.stderr, /line 1/);

  const helpRun = run(["--help"]);
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /OBSERVATIONAL|observational/);
  assert.match(helpRun.stdout, /Exit codes:/);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log("review benchmark CLI tests passed");

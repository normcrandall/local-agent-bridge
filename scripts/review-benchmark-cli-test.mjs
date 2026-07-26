import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendReviewBenchmarkRecord } from "../src/review-benchmark-ledger.mjs";

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
  assert.deepEqual(report.filters, { provider: null, repository: "veliqon/example", headSha: head });
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

  const providerRun = run(["--ledger", ledger, "--provider", "CLAUDE", "--repository", "veliqon/example"]);
  assert.equal(providerRun.status, 0, providerRun.stderr);
  assert.match(providerRun.stdout, /OFFLINE REVIEW BENCHMARK · OBSERVATIONAL ONLY/);
  assert.match(providerRun.stdout, /claude \(model n\/r\)/);
  assert.match(providerRun.stdout, /INCOMPLETE: precision and recall require independent finding adjudication/);
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
  assert.equal(missingLedgerRun.status, 0, "a not-yet-created ledger is an explicit empty sample");
  assert.equal(JSON.parse(missingLedgerRun.stdout).sample.state, "empty");

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

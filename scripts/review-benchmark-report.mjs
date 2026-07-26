#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReviewBenchmarkLedger } from "../src/review-benchmark-ledger.mjs";
import { adjudicateReviewRuns } from "../src/review-benchmark-model.mjs";
import { aggregateReviewBenchmarks } from "../src/review-benchmark-report.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/review-benchmark-report.mjs --ledger PATH [options]

Read an offline review benchmark ledger. This report is observational and never
authorizes a review, pull request, or merge.

Options:
  --ledger PATH       Versioned JSONL benchmark ledger to read (required)
  --provider NAME     Include only this provider/model cohort
  --repository OWNER/NAME
                      Include only this repository (case-insensitive)
  --head SHA          Include only this exact 40-character commit SHA
  --json              Emit deterministic machine-readable JSON
  --help, -h          Show this help message

Exit codes:
  0  Report generated, including a valid empty result
  1  Ledger could not be read or contains invalid records
  2  Command-line arguments are invalid
`);
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a value`);
  return value;
}

export function parseReviewBenchmarkReportArguments(argv) {
  const options = { ledger: null, provider: null, repository: null, headSha: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--json") {
      options.json = true;
    } else if (["--ledger", "--provider", "--repository", "--head"].includes(flag)) {
      const value = requiredValue(argv, index, flag);
      const key = { "--ledger": "ledger", "--provider": "provider", "--repository": "repository", "--head": "headSha" }[flag];
      if (options[key] !== null) throw new TypeError(`${flag} may be supplied only once`);
      options[key] = value;
      index += 1;
    } else {
      throw new TypeError(`unknown argument: ${flag}`);
    }
  }
  if (options.help) return options;
  if (!options.ledger) throw new TypeError("--ledger is required; pass the path to the versioned JSONL ledger");
  if (options.repository && !REPOSITORY.test(options.repository)) {
    throw new TypeError("--repository must use owner/name form");
  }
  if (options.headSha && !EXACT_SHA.test(options.headSha.toLowerCase())) {
    throw new TypeError("--head must be an exact 40-character hexadecimal commit SHA");
  }
  if (options.provider !== null && !options.provider.trim()) {
    throw new TypeError("--provider must be a non-empty provider/model cohort");
  }
  return {
    ...options,
    ledger: resolve(options.ledger),
    provider: options.provider?.trim().toLowerCase() ?? null,
    repository: options.repository?.toLowerCase() ?? null,
    headSha: options.headSha?.toLowerCase() ?? null,
  };
}

function compareRecords(left, right) {
  return left.repository.localeCompare(right.repository)
    || left.headSha.localeCompare(right.headSha)
    || left.provider.localeCompare(right.provider)
    || left.runId.localeCompare(right.runId);
}

function executionClass(records) {
  const classes = new Set(records.map((record) => record.localProvider ? "local" : "hosted"));
  return classes.size === 1 ? [...classes][0] : "mixed";
}

function targetKey(record) {
  return `${record.repository}\u0000${record.headSha}`;
}

export function createReviewBenchmarkReport(records, filters = {}) {
  const selected = records.filter((record) => (
    (!filters.provider || record.provider === filters.provider)
    && (!filters.repository || record.repository === filters.repository)
    && (!filters.headSha || record.headSha === filters.headSha)
  )).sort(compareRecords);
  const groups = new Map();
  for (const record of selected) {
    const group = groups.get(targetKey(record)) ?? [];
    group.push(record);
    groups.set(targetKey(record), group);
  }

  const targets = [...groups.values()].map((runs) => {
    // The v1 ledger contains observations, not accepted/rejected ground truth.
    // Reuse the canonical adjudication and aggregation paths for latency and
    // counts, but never expose their zero-denominator ratio as provider quality.
    const aggregate = aggregateReviewBenchmarks([adjudicateReviewRuns(runs)]);
    const providers = aggregate.providers.map((row) => {
      const providerRuns = runs.filter((run) => run.provider === row.provider);
      return {
        provider: row.provider,
        model: null,
        executionClass: executionClass(providerRuns),
        sampleCount: row.runs,
        findingCount: row.unadjudicated,
        precision: null,
        recall: null,
        latencyMs: row.latencyMs,
        confidence: "incomplete",
        incompleteReason: "the ledger has no independent accepted/rejected finding adjudication",
      };
    });
    return {
      repository: runs[0].repository,
      headSha: runs[0].headSha,
      sampleCount: aggregate.runCount,
      providerCount: aggregate.providerCount,
      confidence: "incomplete",
      incompleteReason: "precision and recall require independent finding adjudication",
      providers,
    };
  });

  return {
    schemaVersion: 1,
    reportType: "offline-review-benchmark",
    purpose: "observational",
    filters: {
      provider: filters.provider ?? null,
      repository: filters.repository ?? null,
      headSha: filters.headSha ?? null,
    },
    sample: {
      state: selected.length === 0 ? "empty" : "incomplete",
      runCount: selected.length,
      targetCount: targets.length,
      message: selected.length === 0
        ? "No benchmark runs matched the selected filters."
        : "Samples are observational; precision and recall are unavailable without independent adjudication.",
    },
    targets,
  };
}

function milliseconds(value) {
  return value == null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatReviewBenchmarkReport(report) {
  const lines = [
    "OFFLINE REVIEW BENCHMARK · OBSERVATIONAL ONLY",
    `Samples: ${report.sample.runCount} run(s) across ${report.sample.targetCount} exact head(s) · ${report.sample.state.toUpperCase()}`,
    report.sample.message,
  ];
  if (report.targets.length === 0) return `${lines.join("\n")}\n`;

  for (const target of report.targets) {
    lines.push("", `${target.repository} @ ${target.headSha}`, "PROVIDER/MODEL COHORT  CLASS   N  PRECISION  RECALL  LATENCY ms (median/p95/mean)");
    for (const row of target.providers) {
      const cohort = row.model ? `${row.provider}/${row.model}` : `${row.provider} (model n/r)`;
      const latency = `${milliseconds(row.latencyMs.median)}/${milliseconds(row.latencyMs.p95)}/${milliseconds(row.latencyMs.mean)}`;
      lines.push(`${cohort.padEnd(22)} ${row.executionClass.padEnd(7)} ${String(row.sampleCount).padStart(2)} ${"n/a".padStart(10)} ${"n/a".padStart(7)}  ${latency}`);
    }
    lines.push(`INCOMPLETE: ${target.incompleteReason}.`);
  }
  lines.push("", "This report cannot satisfy or bypass any review or merge gate.");
  return `${lines.join("\n")}\n`;
}

export async function runReviewBenchmarkReport(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseReviewBenchmarkReportArguments(argv);
  } catch (error) {
    stderr.write(`Argument error: ${error.message}\nRun with --help for usage.\n`);
    return 2;
  }
  if (options.help) {
    usage(stdout);
    return 0;
  }

  let records;
  try {
    records = await readReviewBenchmarkLedger(options.ledger);
  } catch (error) {
    stderr.write(`Ledger error (${options.ledger}): ${error.message}\n`);
    return 1;
  }
  const report = createReviewBenchmarkReport(records, options);
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReviewBenchmarkReport(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReviewBenchmarkReport(process.argv.slice(2));
}

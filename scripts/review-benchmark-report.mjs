#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
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
  --adjudications PATH
                      Optional independent finding-adjudication JSON
  --provider NAME     Include only this provider/model cohort
  --model NAME        Include only this model
  --cohort NAME       Include only this repository cohort
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
  const options = { ledger: null, adjudications: null, provider: null, model: null, cohort: null, repository: null, headSha: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--json") {
      options.json = true;
    } else if (["--ledger", "--adjudications", "--provider", "--model", "--cohort", "--repository", "--head"].includes(flag)) {
      const value = requiredValue(argv, index, flag);
      const key = { "--ledger": "ledger", "--adjudications": "adjudications", "--provider": "provider", "--model": "model", "--cohort": "cohort", "--repository": "repository", "--head": "headSha" }[flag];
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
    adjudications: options.adjudications ? resolve(options.adjudications) : null,
    provider: options.provider?.trim().toLowerCase() ?? null,
    model: options.model?.trim().toLowerCase() ?? null,
    cohort: options.cohort?.trim().toLowerCase() ?? null,
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
  const reviewRuns = records.filter((record) => !record.recordType || record.recordType === "review_run");
  const outcomeRecords = records.filter((record) => record.recordType === "review_outcome");
  const ledgerAdjudications = records.filter((record) => record.recordType === "finding_adjudication");
  const selected = reviewRuns.filter((record) => (
    (!filters.provider || record.provider === filters.provider)
    && (!filters.model || record.model === filters.model)
    && (!filters.cohort || record.repositoryCohort === filters.cohort)
    && (!filters.repository || record.repository === filters.repository)
    && (!filters.headSha || record.headSha === filters.headSha)
  )).sort(compareRecords);
  const groups = new Map();
  for (const record of selected) {
    const group = groups.get(targetKey(record)) ?? [];
    group.push(record);
    groups.set(targetKey(record), group);
  }

  const adjudicationInputs = new Map((filters.adjudications ?? []).map((entry) => {
    const key = `${String(entry.repository).toLowerCase()}\u0000${String(entry.headSha).toLowerCase()}`;
    return [key, entry.findingAdjudications ?? []];
  }));
  for (const record of ledgerAdjudications) {
    const key = targetKey(record);
    const decisions = new Map((adjudicationInputs.get(key) ?? []).map((entry) => [entry.findingKey, entry]));
    decisions.set(record.findingKey, record);
    adjudicationInputs.set(key, [...decisions.values()]);
  }
  const targets = [...groups.values()].map((runs) => {
    runs = runs.map((run) => {
      const later = outcomeRecords.filter((record) => record.repository === run.repository && record.headSha === run.headSha
        && record.provider === run.provider && record.model === run.model && record.runId === run.runId);
      if (later.length === 0) return run;
      const outcomes = Object.fromEntries(Object.keys(run.outcomes).map((key) => [key, run.outcomes[key] + later.reduce((sum, record) => sum + record.outcomes[key], 0)]));
      return { ...run, outcomes };
    });
    // The v1 ledger contains observations, not accepted/rejected ground truth.
    // Reuse the canonical adjudication and aggregation paths for latency and
    // counts, but never expose their zero-denominator ratio as provider quality.
    const targetAdjudications = adjudicationInputs.get(targetKey(runs[0]));
    const hasAdjudication = Array.isArray(targetAdjudications) && targetAdjudications.length > 0;
    const aggregate = aggregateReviewBenchmarks([adjudicateReviewRuns(runs, { findingAdjudications: targetAdjudications ?? [] })]);
    const providers = aggregate.providers.map((row) => {
      const providerRuns = runs.filter((run) => run.provider === row.provider && run.model === row.model && run.repositoryCohort === row.repositoryCohort);
      return {
        provider: row.provider,
        model: row.model,
        repositoryCohort: row.repositoryCohort,
        executionClass: executionClass(providerRuns),
        sampleCount: row.runs,
        findingCount: row.truePositives + row.falsePositives + row.unadjudicated + row.duplicateFindings + row.advisoryFindings,
        precision: hasAdjudication ? row.precision : null,
        recall: hasAdjudication ? row.recall : null,
        blockingRecall: hasAdjudication ? row.blockingRecall : null,
        citationValidity: row.citationValidity,
        citationCoverage: row.citationCoverage,
        evidenceSupport: row.evidenceSupport,
        evidenceCoverage: row.evidenceCoverage,
        actionability: row.actionability,
        duplicateRate: hasAdjudication ? row.duplicateRate : null,
        uniqueValidFindings: hasAdjudication ? row.uniqueValidFindings : null,
        exactHeadCompletionRate: row.exactHeadCompletionRate,
        exactHeadCompletionCoverage: row.exactHeadCompletionCoverage,
        contractBindingCoverage: row.contractBindingCoverage,
        adjudicationCoverage: row.adjudicationCoverage,
        reliability: row.reliability,
        outcomes: row.outcomes,
        latencyMs: row.latencyMs,
        localWallTimeMs: row.localWallTimeMs,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        estimatedCostUsd: row.estimatedCostUsd,
        peakMemoryMb: row.peakMemoryMb,
        confidence: hasAdjudication ? row.confidence : "incomplete",
        incompleteReason: hasAdjudication ? null : "the ledger has no independent finding adjudication",
      };
    });
    return {
      repository: runs[0].repository,
      headSha: runs[0].headSha,
      sampleCount: aggregate.runCount,
      providerCount: aggregate.providerCount,
      confidence: hasAdjudication ? aggregate.providers.reduce((lowest, row) => {
        const order = ["incomplete", "insufficient", "directional", "moderate", "strong"];
        return order.indexOf(row.confidence) < order.indexOf(lowest) ? row.confidence : lowest;
      }, "strong") : "incomplete",
      incompleteReason: hasAdjudication ? null : "precision and recall require independent finding adjudication",
      providers,
    };
  });

  return {
    schemaVersion: 1,
    reportType: "offline-review-benchmark",
    purpose: "observational",
    filters: {
      provider: filters.provider ?? null,
      model: filters.model ?? null,
      cohort: filters.cohort ?? null,
      repository: filters.repository ?? null,
      headSha: filters.headSha ?? null,
    },
    sample: {
      state: selected.length === 0 ? "empty" : targets.every((target) => target.confidence === "incomplete") ? "incomplete" : "adjudicated",
      runCount: selected.length,
      targetCount: targets.length,
      message: selected.length === 0
        ? "No benchmark runs matched the selected filters."
        : targets.every((target) => target.confidence === "incomplete")
          ? "Samples are observational; precision and recall are unavailable without independent adjudication."
          : "Findings are independently adjudicated; confidence remains sample-size bounded and is not a global ranking.",
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
      const precision = row.precision == null ? "n/a" : `${(row.precision * 100).toFixed(1)}%`;
      const recall = row.recall == null ? "n/a" : `${(row.recall * 100).toFixed(1)}%`;
      lines.push(`${cohort.padEnd(22)} ${row.executionClass.padEnd(7)} ${String(row.sampleCount).padStart(2)} ${precision.padStart(10)} ${recall.padStart(7)}  ${latency}  ${row.confidence}`);
    }
    if (target.incompleteReason) lines.push(`INCOMPLETE: ${target.incompleteReason}.`);
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
    await access(options.ledger);
    records = await readReviewBenchmarkLedger(options.ledger);
    // The ledger reader intentionally treats ENOENT as an empty store for
    // programmatic callers. A CLI user supplied this path explicitly, so also
    // catch the narrow race where it disappears between access and reading.
    await access(options.ledger);
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "the explicitly supplied ledger does not exist" : error.message;
    stderr.write(`Ledger error (${options.ledger}): ${reason}\n`);
    return 1;
  }
  let adjudications = [];
  if (options.adjudications) {
    try {
      const parsed = JSON.parse(await readFile(options.adjudications, "utf8"));
      if (!Array.isArray(parsed)) throw new TypeError("adjudication file must contain a JSON array");
      adjudications = parsed;
    } catch (error) {
      stderr.write(`Adjudication error (${options.adjudications}): ${error.message}\n`);
      return 1;
    }
  }
  const report = createReviewBenchmarkReport(records, { ...options, adjudications });
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReviewBenchmarkReport(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReviewBenchmarkReport(process.argv.slice(2));
}

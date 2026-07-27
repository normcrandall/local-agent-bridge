#!/usr/bin/env node

import {
  MISSION_CONTROL_SCALE_BUDGETS,
  growthGateEvidence,
  leastSquaresGrowthFit,
  linearPercentile,
  requireFiniteBudget,
  runMissionControlScaleBenchmark,
} from "../src/mission-control-benchmark.mjs";
import assert from "node:assert/strict";

assert.equal(linearPercentile([1, 2, 3, 4, 5], 0.95), 4.8);
const linearFit = leastSquaresGrowthFit([
  { size: 10, medianMs: 2 },
  { size: 100, medianMs: 20 },
  { size: 1_000, medianMs: 200 },
]);
assert.equal(linearFit.exponent, 1);
assert.equal(linearFit.rmseLog, 0);
assert.throws(() => requireFiniteBudget("growthFit.snapshot.exponent", undefined), /Missing or non-numeric budget/);
assert.throws(() => requireFiniteBudget("growthFit.snapshot.exponent", Number.POSITIVE_INFINITY), /Missing or non-numeric budget/);
assert.equal(growthGateEvidence("burst", {
  exponent: 2.1,
  confidence95Approx: { low: 1.7, high: 2.5 },
}, 1.8).outcome, "regression-not-established");
assert.equal(growthGateEvidence("burst", {
  exponent: 2.1,
  confidence95Approx: { low: 1.9, high: 2.3 },
}, 1.8).outcome, "regression-supported");
assert.throws(() => growthGateEvidence("burst", { exponent: 2.1, confidence95Approx: null }, 1.8), /growth-fit uncertainty/);

let report;
try {
  report = await runMissionControlScaleBenchmark();
} catch (error) {
  report = {
    schemaVersion: 1,
    benchmark: "mission-control-scale",
    resultKind: "execution-error",
    status: "error",
    startedAt: null,
    completedAt: new Date().toISOString(),
    reproducibility: null,
    budgets: MISSION_CONTROL_SCALE_BUDGETS,
    results: null,
    failures: [{
      kind: "execution-error",
      path: "benchmark.execution",
      observed: null,
      limit: null,
      unit: "error",
      message: error?.message || String(error),
    }],
    rustEvaluation: null,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || null,
    },
  };
}

// JSON is emitted before the exit code is selected so CI retains the complete
// measurements and budget diagnosis even when the benchmark fails.
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;

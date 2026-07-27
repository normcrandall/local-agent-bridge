#!/usr/bin/env node

import {
  MISSION_CONTROL_SCALE_BUDGETS,
  leastSquaresGrowthFit,
  linearPercentile,
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

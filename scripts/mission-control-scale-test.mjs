#!/usr/bin/env node

import {
  MISSION_CONTROL_SCALE_BUDGETS,
  runMissionControlScaleBenchmark,
} from "../src/mission-control-benchmark.mjs";

let report;
try {
  report = await runMissionControlScaleBenchmark();
} catch (error) {
  report = {
    schemaVersion: 1,
    benchmark: "mission-control-scale",
    status: "error",
    completedAt: new Date().toISOString(),
    budgets: MISSION_CONTROL_SCALE_BUDGETS,
    failures: [{
      path: "benchmark.execution",
      observed: error?.message || String(error),
      limit: "successful deterministic execution",
      unit: "error",
    }],
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

#!/usr/bin/env node

import { parseWorkflowArguments, startWorkflow } from "../src/workflow-launcher.mjs";

try {
  const options = parseWorkflowArguments(process.argv.slice(2));
  const result = await startWorkflow(options);
  if (["failed", "indeterminate"].includes(result.status)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}

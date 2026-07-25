#!/usr/bin/env node

import process from "node:process";
import { resolveDeliveryPolicy, explainDeliveryPolicy } from "../src/delivery-policy.mjs";

function usage() {
  console.log(`Usage: node scripts/explain-delivery-policy.mjs [options]

Options:
  --workspace PATH   Exact repository worktree (default: cwd)
  --json             Emit structured JSON output instead of human-readable report
  --help             Show this help message
`);
}

async function main() {
  const argv = process.argv.slice(2);
  let workspace = process.cwd();
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
    } else if (arg === "--workspace") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) throw new Error("--workspace requires a path");
      workspace = val;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const effectivePolicy = await resolveDeliveryPolicy({ workspace });
  const output = explainDeliveryPolicy(effectivePolicy, { format: json ? "json" : "human" });
  console.log(output);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

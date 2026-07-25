#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import {
  deliveryPolicyExplainDocument,
  explainDeliveryPolicy,
  resolveDeliveryPolicy,
} from "../src/delivery-policy.mjs";

function usage() {
  process.stdout.write(`Usage: node scripts/explain-delivery-policy.mjs [options]
       ./bridge policy explain [options]

Options:
  --workspace PATH   Exact repository worktree (default: cwd)
  --json             Emit the structured explain document instead of the report
  --help             Show this help message
`);
}

async function main() {
  const argv = process.argv.slice(2);
  let workspace = process.cwd();
  let asJson = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      return;
    }
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--workspace") {
      const supplied = argv[index + 1];
      if (!supplied || supplied.startsWith("--")) throw new Error("--workspace requires a path");
      workspace = supplied;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const policy = await resolveDeliveryPolicy({ workspace: resolve(workspace), diagnostic: true });
  process.stdout.write(asJson
    ? `${JSON.stringify(deliveryPolicyExplainDocument(policy), null, 2)}\n`
    : `${explainDeliveryPolicy(policy, { format: "human" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});

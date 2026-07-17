#!/usr/bin/env node

import { modelPolicyStatus, updateModelPolicy } from "../src/model-policy.mjs";

const [action = "status", provider, ...modelParts] = process.argv.slice(2);
let result;
if (action === "status") {
  if (provider || modelParts.length) throw new Error("Usage: bridge models status");
  result = modelPolicyStatus();
} else if (action === "disable" || action === "enable") {
  if (!provider || modelParts.length === 0) {
    throw new Error(`Usage: bridge models ${action} <provider> <model>`);
  }
  result = updateModelPolicy(action, provider, modelParts.join(" "));
} else {
  throw new Error("Usage: bridge models <status|disable|enable> [provider] [model]");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

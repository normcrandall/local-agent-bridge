#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import {
  POLICY_PROVIDERS,
  analyzePolicy,
  collectPolicySnapshot,
  renderPolicyReport,
  supportedBuilderOperations,
} from "../src/collaboration-doctor.mjs";

function usage() {
  return `Usage: bridge doctor [policy options]

With no options, bridge doctor runs the installation doctor. Supplying policy options runs this read-only effective-policy doctor.

Options:
  --workspace PATH                 Exact repository worktree (default: cwd)
  --host claude|codex|antigravity  Calling host (default: codex)
  --providers CSV                  Eligible provider roster
  --strict-provider NAME           Provider that must be eligible (repeatable)
  --mode review|work               Delegation mode (default: review)
  --role reviewer|writer           Effective role (derived from mode by default)
  --profile exact|implement|deliver
  --permission standard|yolo
  --browser                        Require an isolated delegated browser
  --skill NAME                     Require one installed skill and its dependencies
  --required-command COMMAND       Exact delegated shell requirement (repeatable)
  --allow-command PROVIDER=COMMAND Observed additive allowlist entry (repeatable)
  --builder-operation NAME         Required builder operation (repeatable)
  --require-review-app             Require verified provider reviewer Apps
  --no-review-app                  Do not require reviewer App publication
  --require-fallback               Require overload model fallback for each provider
  --require-budget                 Require an explicit budget
  --max-cost USD                   Budget observation
  --max-tokens COUNT               Budget observation
  --max-minutes COUNT              Budget observation
  --github-verification PATH       Read-only App verification snapshot
  --input PATH                     Analyze a hermetic doctor snapshot instead of probing
  --json                           Emit the versioned machine-readable report
  --help                           Show this help

Supported builder operations: ${supportedBuilderOperations().join(", ")}
The doctor never changes configuration, grants permissions, installs tools, delegates work, or prints secret values.`;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveNumber(value, flag, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${flag} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    providers: [...POLICY_PROVIDERS],
    host: "codex",
    mode: "review",
    role: null,
    workProfile: "exact",
    permissionProfile: "standard",
    browser: false,
    skill: null,
    requiredCommands: [],
    allowedCommands: {},
    requiredBuilderOperations: [],
    requireReviewApp: null,
    requireFallback: false,
    requireBudget: false,
    budget: null,
    strictProviders: [],
    githubVerification: null,
    input: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--json") options.json = true;
    else if (flag === "--browser") options.browser = true;
    else if (flag === "--require-review-app") options.requireReviewApp = true;
    else if (flag === "--no-review-app") options.requireReviewApp = false;
    else if (flag === "--require-fallback") options.requireFallback = true;
    else if (flag === "--require-budget") options.requireBudget = true;
    else if (["--workspace", "--host", "--providers", "--agents", "--strict-provider", "--mode", "--role", "--profile", "--permission", "--skill", "--required-command", "--allow-command", "--builder-operation", "--github-verification", "--input", "--max-cost", "--max-tokens", "--max-minutes"].includes(flag)) {
      const value = takeValue(argv, index, flag);
      index += 1;
      if (flag === "--workspace") options.workspace = value;
      else if (flag === "--host") options.host = value;
      else if (flag === "--providers" || flag === "--agents") options.providers = value.split(",").filter(Boolean);
      else if (flag === "--strict-provider") options.strictProviders.push(value);
      else if (flag === "--mode") options.mode = value;
      else if (flag === "--role") options.role = value;
      else if (flag === "--profile") options.workProfile = value;
      else if (flag === "--permission") options.permissionProfile = value;
      else if (flag === "--skill") options.skill = value;
      else if (flag === "--required-command") options.requiredCommands.push(value);
      else if (flag === "--builder-operation") options.requiredBuilderOperations.push(value);
      else if (flag === "--github-verification") {
        options.githubVerification = JSON.parse(readFileSync(value, "utf8"));
        if (options.githubVerification.version !== 1) throw new Error("--github-verification requires snapshot version 1.");
      }
      else if (flag === "--input") options.input = value;
      else if (flag === "--allow-command") {
        const separator = value.indexOf("=");
        if (separator < 1 || separator === value.length - 1) throw new Error("--allow-command must use PROVIDER=COMMAND.");
        const provider = value.slice(0, separator);
        const command = value.slice(separator + 1);
        options.allowedCommands[provider] ||= [];
        options.allowedCommands[provider].push(command);
      } else {
        options.budget ||= {};
        if (flag === "--max-cost") options.budget.maxCostUsd = positiveNumber(value, flag);
        if (flag === "--max-tokens") options.budget.maxTokens = positiveNumber(value, flag, true);
        if (flag === "--max-minutes") options.budget.maxMinutes = positiveNumber(value, flag);
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }
  options.role ||= options.mode === "work" ? "writer" : "reviewer";
  options.providers = [...new Set(options.providers)];
  options.strictProviders = [...new Set(options.strictProviders)];
  if (options.requireReviewApp === null) options.requireReviewApp = options.role === "reviewer";
  if (!options.requiredBuilderOperations.length && options.role === "writer" && options.workProfile === "deliver") {
    options.requiredBuilderOperations = ["create_branch", "push_branch", "ensure_pull_request"];
  }
  return options;
}

function validate(options) {
  const oneOf = (value, values, label) => {
    if (!values.includes(value)) throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  };
  oneOf(options.host, POLICY_PROVIDERS, "--host");
  oneOf(options.mode, ["review", "work"], "--mode");
  oneOf(options.role, ["reviewer", "writer"], "--role");
  oneOf(options.workProfile, ["exact", "implement", "deliver"], "--profile");
  oneOf(options.permissionProfile, ["standard", "yolo"], "--permission");
  if (!options.providers.length) throw new Error("--providers must select at least one provider.");
  for (const provider of [...options.providers, ...options.strictProviders, ...Object.keys(options.allowedCommands)]) {
    oneOf(provider, POLICY_PROVIDERS, "provider");
  }
  for (const provider of options.strictProviders) {
    if (!options.providers.includes(provider)) throw new Error(`Strict provider ${provider} is not in --providers.`);
  }
  for (const provider of Object.keys(options.allowedCommands)) {
    if (!options.providers.includes(provider)) throw new Error(`Allowlist provider ${provider} is not in --providers.`);
  }
  for (const operation of options.requiredBuilderOperations) oneOf(operation, supportedBuilderOperations(), "--builder-operation");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  validate(options);
  const snapshot = options.input
    ? JSON.parse(readFileSync(options.input, "utf8"))
    : collectPolicySnapshot(options);
  const report = analyzePolicy(snapshot.snapshot || snapshot);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderPolicyReport(report));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Collaboration doctor failed: ${error.message}`);
  process.exitCode = 2;
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  POLICY_REPORT_VERSION,
  analyzePolicy,
  isFailureState,
  renderPolicyReport,
  supportedBuilderOperations,
} from "../src/collaboration-doctor.mjs";

const root = resolve(import.meta.dirname, "..");
const doctor = resolve(root, "scripts/collaboration-doctor.mjs");
const src = (path, field = null) => ({ path, ...(field ? { field } : {}) });
const observed = (state, detail, path) => ({ state, detail, source: src(path) });

function app({ state = "available", login, operations = [], verified = true } = {}) {
  return {
    state,
    detail: `${login || "App"} observation`,
    login: login || null,
    installed: state !== "missing",
    keyState: state === "missing" ? "missing" : "available",
    operations,
    operationsVerified: verified,
    source: src("/safe/github-apps.json"),
  };
}

function provider(name, overrides = {}) {
  return {
    availability: observed("available", `${name} is available`, `/bin/${name}`),
    cli: { version: "test", source: "probe" },
    permissions: { read: true, write: false, shell: "verification-only", browser: name === "antigravity" ? false : "isolated" },
    allowedCommands: [],
    modelFallback: { state: "available", detail: "one fallback", count: 1, models: ["fallback"], source: src("/safe/model-fallbacks.json") },
    github: {
      builder: app({ login: "builder[bot]", operations: supportedBuilderOperations() }),
      reviewer: app({ login: `${name}-reviewer[bot]`, operations: ["submit_review", "publish_status"] }),
      patFallbackAllowed: false,
    },
    ...overrides,
  };
}

function snapshot({ providers = ["claude", "codex", "antigravity"], request = {}, providerOverrides = {}, mcp = {}, skill = {}, workspace = {}, github = {} } = {}) {
  return {
    version: POLICY_REPORT_VERSION,
    workspace: {
      path: "/safe/worktree",
      exists: true,
      git: { ok: true, output: "true" },
      branch: { ok: true, output: "feature" },
      remote: { ok: true, output: "https://secret@example.invalid/token.git" },
      repository: "owner/repo",
      gitCustody: { state: "self-contained", gitMetadataRoot: "/safe/worktree/.git", source: src("/safe/worktree/.git") },
      ...workspace,
    },
    request: {
      providers,
      strictProviders: [],
      host: "codex",
      mode: "review",
      role: "reviewer",
      workProfile: "exact",
      permissionProfile: "standard",
      browser: false,
      requiredCommands: [],
      requiredBuilderOperations: [],
      requireReviewApp: true,
      requireFallback: false,
      requireBudget: false,
      budget: null,
      skill: null,
      ...request,
    },
    providers: Object.fromEntries(providers.map((name) => [name, provider(name, providerOverrides[name])])),
    mcp: {
      host: "codex",
      state: "available",
      source: src("/safe/config.toml"),
      servers: {
        collaboration: observed("available", "registered", "/safe/config.toml"),
        claude_code: observed("available", "registered", "/safe/config.toml"),
        antigravity: observed("available", "registered", "/safe/config.toml"),
      },
      ...mcp,
    },
    skill: {
      name: null,
      state: "optional",
      requirements: { mcpServers: [], browser: false },
      source: null,
      ...skill,
    },
    github: {
      configState: "available",
      source: src("/safe/github-apps.json"),
      repository: "owner/repo",
      allowPatFallback: false,
      enforcement: {
        configuredMode: "broker",
        capabilities: {},
      },
      ...github,
    },
  };
}

const ready = analyzePolicy(snapshot());
assert.equal(ready.ok, true);
assert.equal(ready.summary.eligibleProviders, 3);
assert.equal(ready.summary.failures, 0);
assert.equal(ready.version, 1);
assert.equal(ready.workspace.remoteConfigured, true);
assert.equal(JSON.stringify(ready).includes("secret@example"), false, "Remote credentials must not enter the report");
const readyHuman = renderPolicyReport(ready);
assert.match(readyHuman, /Result: READY/);
assert.match(readyHuman, /3 eligible provider/);
assert.match(readyHuman, /read-only/);
assert.match(readyHuman, /Source:/);
assert.equal(ready.github.mergeEnforcement.effectiveMode, "broker");
assert.ok(ready.findings.some((finding) => finding.code === "github-enforcement-broker-only" && finding.severity === "notice"));
assert.match(readyHuman, /GitHub merge enforcement: configured=broker; effective=broker/);

const sharedWriterCustody = analyzePolicy(snapshot({
  providers: ["codex"],
  request: {
    strictProviders: ["codex"],
    mode: "work",
    role: "writer",
    workProfile: "implement",
    requireReviewApp: false,
  },
  workspace: {
    gitCustody: { state: "shared", gitMetadataRoot: "/safe/repository/.git/worktrees/lane", source: src("/safe/repository/.git") },
  },
  providerOverrides: {
    codex: { permissions: { read: true, write: true, shell: "implement-sandboxed", browser: "isolated" } },
  },
}));
assert.equal(sharedWriterCustody.ok, false);
assert.deepEqual(sharedWriterCustody.matrix.codex.blockers, ["git-custody"]);
assert.ok(sharedWriterCustody.findings.some((finding) => finding.code === "writer-git-custody-shared"));

const sharedWorkModeReviewer = analyzePolicy(snapshot({
  providers: ["codex"],
  request: { mode: "work", role: "reviewer", workProfile: "implement", requireReviewApp: false },
  workspace: {
    gitCustody: { state: "shared", gitMetadataRoot: "/safe/repository/.git/worktrees/lane", source: src("/safe/repository/.git") },
  },
}));
assert.equal(sharedWorkModeReviewer.ok, false);
assert.ok(sharedWorkModeReviewer.findings.some((finding) => finding.code === "writer-git-custody-shared"));

const externalWriterCustody = analyzePolicy(snapshot({
  providers: ["codex"],
  request: { mode: "work", role: "writer", workProfile: "implement", requireReviewApp: false },
  workspace: {
    gitCustody: { state: "external", gitMetadataRoot: "/outside/repository.git", source: src("/outside/repository.git") },
  },
}));
assert.equal(externalWriterCustody.ok, false);
assert.ok(externalWriterCustody.findings.some((finding) => finding.code === "writer-git-custody-external"));
assert.match(renderPolicyReport(externalWriterCustody), /known to be outside the delegated workspace/);

const explicitRulesetUnavailable = analyzePolicy(snapshot({
  github: {
    enforcement: {
      configuredMode: "organization-ruleset",
      capabilities: {},
    },
  },
}));
assert.equal(explicitRulesetUnavailable.ok, false);
assert.equal(explicitRulesetUnavailable.github.mergeEnforcement.effectiveMode, null);
assert.ok(explicitRulesetUnavailable.findings.some((finding) => (
  finding.code === "github-enforcement-unverified" && finding.severity === "failure"
)));

const autoBranchProtection = analyzePolicy(snapshot({
  github: {
    enforcement: {
      configuredMode: "auto",
      capabilities: {
        branchProtection: { verified: true, source: "github-api:branch-protection" },
      },
    },
  },
}));
assert.equal(autoBranchProtection.ok, true);
assert.equal(autoBranchProtection.github.mergeEnforcement.effectiveMode, "branch-protection");
assert.ok(autoBranchProtection.findings.some((finding) => finding.code === "github-enforcement-auto-downgrade"));

const secretCommand = "deploy token=super-secret-value";
const redacted = analyzePolicy(snapshot({
  providers: ["codex"],
  request: { requiredCommands: [secretCommand], requireReviewApp: false },
  providerOverrides: { codex: { allowedCommands: [secretCommand] } },
}));
assert.equal(JSON.stringify(redacted).includes("super-secret-value"), false, "Command values that resemble secrets must be redacted");
assert.match(JSON.stringify(redacted), /token=<redacted>/);

const generatedToken = "plainOpaqueValue123";
const secretFlagCommand = `deploy --password ${generatedToken} --endpoint https://user:password@example.invalid`;
const redactedFlags = analyzePolicy(snapshot({
  request: { requiredCommands: [secretFlagCommand], requireReviewApp: false },
  providerOverrides: { codex: { allowedCommands: [secretFlagCommand] } },
}));
const redactedFlagsText = JSON.stringify(redactedFlags);
assert.equal(redactedFlagsText.includes(generatedToken), false, "Separated secret flags must be redacted");
assert.equal(redactedFlagsText.includes("user:password"), false, "Credential-bearing URLs must be redacted");
assert.match(redactedFlagsText, /--password <redacted>/);

const broken = snapshot({
  request: {
    strictProviders: ["claude", "codex", "antigravity"],
    mode: "work",
    role: "writer",
    workProfile: "deliver",
    browser: true,
    requiredCommands: ["pnpm run ci"],
    requiredBuilderOperations: ["push_branch"],
    requireReviewApp: true,
    requireFallback: true,
    requireBudget: true,
    budget: null,
    skill: "browser-workflow",
  },
  mcp: {
    servers: {
      collaboration: observed("stale", "launcher missing", "/safe/config.toml"),
      claude_code: observed("missing", "not registered", "/safe/config.toml"),
      antigravity: observed("available", "registered", "/safe/config.toml"),
    },
  },
  skill: {
    name: "browser-workflow",
    state: "available",
    requirements: { mcpServers: ["collaboration"], browser: true },
    source: src("/safe/skills/browser-workflow/SKILL.md"),
  },
  providerOverrides: {
    claude: {
      availability: observed("unavailable", "provider overload chain exhausted", "/bin/claude"),
      allowedCommands: ["npm test"],
      modelFallback: observed("missing", "no fallback", "/safe/model-fallbacks.json"),
      github: {
        builder: app({ state: "unverifiable", login: "shared[bot]", verified: false }),
        reviewer: app({ state: "missing", login: "shared[bot]", verified: false }),
        patFallbackAllowed: true,
      },
    },
    codex: {
      allowedCommands: [],
      github: {
        builder: app({ state: "unverifiable", login: "shared[bot]", verified: false }),
        reviewer: app({ state: "available", login: "shared[bot]" }),
        patFallbackAllowed: true,
      },
    },
    antigravity: {
      allowedCommands: null,
      modelFallback: observed("stale", "bad fallback schema", "/safe/model-fallbacks.json"),
      github: {
        builder: app({ state: "unverifiable", login: "builder[bot]", verified: false }),
        reviewer: app({ state: "unverifiable", login: "antigravity-reviewer[bot]", verified: false }),
        patFallbackAllowed: true,
      },
    },
  },
});
const blocked = analyzePolicy(broken);
assert.equal(blocked.ok, false);
for (const finding of blocked.findings) {
  assert.ok(finding.source?.path, `${finding.code} lacks an authoritative source`);
  assert.ok(finding.impact, `${finding.code} lacks impact`);
  assert.ok(finding.remediation, `${finding.code} lacks least-authority remediation`);
}
const codes = new Set(blocked.findings.map((finding) => finding.code));
for (const code of [
  "mcp-registration-stale",
  "mcp-registration-missing",
  "provider-unavailable",
  "model-fallback-incompatible",
  "provider-allowlist-conflict",
  "provider-allowlist-unverifiable",
  "writer-reviewer-authority-overlap",
  "reviewer-app-binding-missing",
  "reviewer-app-scope-unverifiable",
  "builder-operation-scope-unverifiable",
  "unsafe-pat-fallback",
  "browser-mismatch",
  "required-budget-missing",
  "no-eligible-provider",
]) assert.ok(codes.has(code), `Missing incident regression finding ${code}`);
assert.equal(JSON.stringify(blocked).includes("privateKey"), false);
assert.match(renderPolicyReport(blocked), /least/i, "Remediations should preserve least authority");

const degraded = analyzePolicy(snapshot({
  providers: ["codex", "antigravity"],
  request: { requireReviewApp: false },
  providerOverrides: {
    antigravity: { availability: observed("intentionally_disabled", "disabled by owner policy", "/safe/policy.json") },
  },
}));
assert.equal(degraded.ok, true, "An intentional provider restriction should not block another eligible provider");
assert.equal(degraded.summary.eligibleProviders, 1);
assert.ok(degraded.findings.some((finding) => finding.provider === "antigravity" && finding.severity === "constraint"));

for (const state of ["missing", "stale", "denied", "unavailable", "unverifiable"]) assert.equal(isFailureState(state), true);
assert.equal(isFailureState("available"), false);

const temporary = await mkdtemp(resolve(tmpdir(), "collaboration-doctor-"));
try {
  const input = resolve(temporary, "snapshot.json");
  await writeFile(input, `${JSON.stringify(snapshot(), null, 2)}\n`);
  const jsonRun = spawnSync(process.execPath, [doctor, "--input", input, "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const cliReport = JSON.parse(jsonRun.stdout);
  assert.deepEqual(cliReport.summary, ready.summary);
  const humanRun = spawnSync(process.execPath, [doctor, "--input", input], { cwd: root, encoding: "utf8" });
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, new RegExp(`${ready.summary.failures} failures, ${ready.summary.constraints} constraints, ${ready.summary.notices} notices`));

  const blockedInput = resolve(temporary, "blocked.json");
  await writeFile(blockedInput, `${JSON.stringify(broken, null, 2)}\n`);
  const blockedRun = spawnSync(process.execPath, [doctor, "--input", blockedInput, "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(blockedRun.status, 1, blockedRun.stderr);
  assert.equal(JSON.parse(blockedRun.stdout).ok, false);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("Collaboration doctor tests passed.");

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { probeProviderCapabilities } from "./provider-cli-capabilities.mjs";

export const POLICY_REPORT_VERSION = 1;
export const POLICY_PROVIDERS = ["claude", "codex", "antigravity"];
const BUILDER_OPERATIONS = [
  "ensure_pull_request",
  "read_review_threads",
  "reply_review_thread",
  "resolve_review_thread",
  "mark_ready",
  "merge",
  "create_branch",
  "push_branch",
  "replace_branch",
];
const FAILURE_STATES = new Set(["missing", "stale", "denied", "unavailable", "unverifiable"]);

function safeCommand(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*/gi, "<redacted-private-key>")
    .replace(/(^|\s)(--?(?:token|secret|password|private[_-]?key|authorization))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2 <redacted>")
    .replace(/\b(token|secret|password|private[_-]?key|authorization)=([^\s]+)/gi, "$1=<redacted>")
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 <redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1<redacted>@")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted>")
    .slice(0, 240);
}

function source(path, field = null) {
  const value = String(path || "unknown");
  const logical = value.startsWith("policy:") || value.startsWith("adapter:");
  return { path: logical ? value : resolve(value), ...(field ? { field } : {}) };
}

function observation(state, detail, authoritativeSource) {
  return { state, detail, source: authoritativeSource };
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), state: "available", error: null };
  } catch (error) {
    if (error.code === "ENOENT") return { value: null, state: "missing", error: null };
    return { value: null, state: "stale", error: error.message };
  }
}

function expandHome(path, home) {
  if (path === "~") return home;
  if (path?.startsWith("~/")) return resolve(home, path.slice(2));
  return isAbsolute(path || "") ? path : resolve(home, path || "");
}

function resolveConfiguredPath(path, configPath, home) {
  if (path === "~" || path?.startsWith("~/") || isAbsolute(path || "")) return expandHome(path, home);
  return resolve(dirname(configPath), path || "");
}

function safeKeyState(entry, configPath, home) {
  if (!entry) return "missing";
  try {
    const info = statSync(resolveConfiguredPath(entry.privateKeyPath, configPath, home));
    return info.isFile() && (info.mode & 0o077) === 0 ? "available" : "denied";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unverifiable";
  }
}

function which(command) {
  const result = spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function git(workspace, args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 10_000 });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

function configuredMcpServers({ host, home }) {
  if (host === "claude") {
    const path = resolve(home, ".claude.json");
    const parsed = readJson(path);
    return { path, state: parsed.state, error: parsed.error, servers: parsed.value?.mcpServers || {} };
  }
  if (host === "antigravity") {
    const path = resolve(home, ".gemini/config/mcp_config.json");
    const parsed = readJson(path);
    return { path, state: parsed.state, error: parsed.error, servers: parsed.value?.mcpServers || {} };
  }
  const path = resolve(home, ".codex/config.toml");
  try {
    const content = readFileSync(path, "utf8");
    const headings = [...content.matchAll(/^\[([^\]]+)\]\s*$/gm)];
    const servers = Object.fromEntries(headings.flatMap((match, index) => {
      const serverName = match[1].match(/^mcp_servers\.([A-Za-z0-9_-]+)$/)?.[1];
      if (!serverName) return [];
      const body = content.slice(match.index + match[0].length, headings[index + 1]?.index ?? content.length);
      const command = body.match(/^command\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || null;
      const url = body.match(/^url\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || null;
      const cwd = body.match(/^cwd\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || null;
      const enabled = !/^enabled\s*=\s*false\s*$/m.test(body);
      const argsBody = body.match(/^args\s*=\s*\[([^\]]*)\]\s*$/m)?.[1] || "";
      const args = [...argsBody.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
      return [[serverName, { command, url, cwd, enabled, args }]];
    }));
    return { path, state: "available", error: null, servers };
  } catch (error) {
    return { path, state: error.code === "ENOENT" ? "missing" : "stale", error: error.message, servers: {} };
  }
}

function executableExists(command, configPath, home, cwd = null) {
  if (!command) return false;
  if (!command.includes("/")) return Boolean(which(command));
  const base = cwd ? resolveConfiguredPath(cwd, configPath, home) : dirname(configPath);
  const path = isAbsolute(command) ? command : resolve(base, command);
  return existsSync(path);
}

function inspectMcpRegistration(entry, { configPath, home }) {
  if (!entry || typeof entry !== "object") return { state: "missing", reason: "No registration exists." };
  if (entry.enabled === false || entry.disabled === true) return { state: "stale", reason: "The registration is disabled." };
  if (typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) return { state: "available", reason: "A remote MCP URL is configured." };
  const command = typeof entry.command === "string" ? entry.command : null;
  if (!command) return { state: "stale", reason: "The registration has neither a usable command nor URL." };
  if (!executableExists(command, configPath, home, entry.cwd)) {
    return { state: "stale", reason: `The configured command is unavailable: ${command}.` };
  }
  const launcher = Array.isArray(entry.args)
    ? entry.args.find((argument) => typeof argument === "string" && /(?:^|\/)[^/]+\.(?:mjs|cjs|js|sh)$/.test(argument))
    : null;
  if (launcher) {
    const base = entry.cwd ? resolveConfiguredPath(entry.cwd, configPath, home) : dirname(configPath);
    const launcherPath = isAbsolute(launcher) ? launcher : resolve(base, launcher);
    if (!existsSync(launcherPath)) return { state: "stale", reason: `The registered launcher is missing: ${launcher}.` };
  }
  return { state: "available", reason: "The registered transport is locally resolvable." };
}

function modelFallbackObservation(provider, { path, parsed }) {
  if (parsed.state === "missing") {
    return observation("optional", "No machine-wide overload fallback chain is configured.", source(path));
  }
  if (parsed.state !== "available" || parsed.value?.version !== 1) {
    return observation("stale", parsed.error || "Unsupported model fallback configuration version.", source(path));
  }
  const values = parsed.value.providers?.[provider]?.fallbackModels;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    return observation("stale", `providers.${provider}.fallbackModels is not a valid string array.`, source(path, `providers.${provider}.fallbackModels`));
  }
  return {
    state: values.length ? "available" : "intentionally_disabled",
    detail: values.length ? `${values.length} overload fallback model(s) configured.` : "The provider fallback chain is explicitly empty.",
    count: values.length,
    models: values.map((value) => value.trim()),
    source: source(path, `providers.${provider}.fallbackModels`),
  };
}

function appObservation({ entry, label, repository, repositoryOwner, configPath, home, verified = null }) {
  if (!entry) return observation("missing", `${label} App is not configured.`, source(configPath, `roles.${label}`));
  const installed = repositoryOwner ? Boolean(entry.installations?.[repositoryOwner]) : Object.keys(entry.installations || {}).length > 0;
  const keyState = safeKeyState(entry, configPath, home);
  const configured = /^\d+$/.test(String(entry.appId || ""))
    && /^[A-Za-z0-9-]+(?:\[bot\])?$/.test(entry.expectedLogin || "")
    && installed
    && keyState === "available";
  const verificationValid = Boolean(verified
    && verified.repository === repository
    && verified.login === entry.expectedLogin
    && Array.isArray(verified.operations)
    && verified.operations.every((operation) => typeof operation === "string")
    && (!label.startsWith("reviewers.") || verified.operations.includes("submit_review")));
  const state = configured ? (verificationValid ? "available" : "unverifiable") : keyState === "denied" ? "denied" : "missing";
  return {
    state,
    detail: configured
      ? verificationValid
        ? `${label} App binding and operation scopes were supplied by a verification report.`
        : `${label} App is configured, but live installation permissions were not verified by this read-only run.`
      : `${label} App configuration is incomplete for ${repositoryOwner || "the requested owner"}.`,
    login: entry.expectedLogin || null,
    installed,
    keyState,
    operations: verificationValid ? [...new Set(verified.operations)] : [],
    operationsVerified: verificationValid,
    source: source(configPath, `roles.${label}`),
  };
}

function skillObservation({ root, name }) {
  if (!name) return { name: null, state: "optional", requirements: { mcpServers: [], browser: false }, source: null };
  const skillRoot = resolve(root, "skills", name);
  const skillPath = resolve(skillRoot, "SKILL.md");
  if (!existsSync(skillPath)) {
    return { name, state: "missing", requirements: { mcpServers: [], browser: false }, source: source(skillPath) };
  }
  const yamlPath = resolve(skillRoot, "agents/openai.yaml");
  let yaml = "";
  try { yaml = readFileSync(yamlPath, "utf8"); } catch {}
  const mcpServers = [...yaml.matchAll(/^\s*value:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gm)].map((match) => match[1]);
  const body = readFileSync(skillPath, "utf8");
  return {
    name,
    state: "available",
    requirements: {
      mcpServers: [...new Set(mcpServers)].sort(),
      browser: /(?:browser:\s*true|requires? (?:an? )?(?:isolated )?browser)/i.test(body),
    },
    source: source(skillPath),
  };
}

function providerPermissions(provider, { mode, role, workProfile, permissionProfile }) {
  const reviewer = mode === "review" || role === "reviewer";
  const shell = reviewer ? "verification-only"
    : permissionProfile === "yolo" ? "unrestricted"
      : provider === "claude" ? `${workProfile}-profiled` : `${workProfile}-sandboxed`;
  return {
    read: true,
    write: !reviewer,
    shell,
    browser: provider === "antigravity" ? false : "isolated",
  };
}

function expectedPeerServers(host) {
  if (host === "claude") return ["codex", "antigravity", "collaboration"];
  if (host === "antigravity") return ["codex", "claude_code", "collaboration"];
  return ["claude_code", "antigravity", "collaboration"];
}

export function collectPolicySnapshot({
  workspace,
  providers = POLICY_PROVIDERS,
  host = "codex",
  mode = "review",
  role = mode === "work" ? "writer" : "reviewer",
  workProfile = "exact",
  permissionProfile = "standard",
  browser = false,
  skill = null,
  requiredCommands = [],
  allowedCommands = {},
  requiredBuilderOperations = role === "writer" && workProfile === "deliver" ? ["create_branch", "push_branch", "ensure_pull_request"] : [],
  requireReviewApp = role === "reviewer",
  requireFallback = false,
  requireBudget = false,
  budget = null,
  strictProviders = [],
  home = homedir(),
  root = resolve(import.meta.dirname, ".."),
  githubVerification = null,
} = {}) {
  const actualWorkspace = resolve(workspace || process.cwd());
  const remote = git(actualWorkspace, ["remote", "get-url", "origin"]);
  const repositoryMatch = remote.output.match(/(?:github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const repository = repositoryMatch ? `${repositoryMatch[1]}/${repositoryMatch[2]}` : null;
  const repositoryOwner = repositoryMatch?.[1] || null;
  const fallbackPath = process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG
    || resolve(home, ".config/local-agent-bridge/model-fallbacks.json");
  const fallbackParsed = readJson(fallbackPath);
  const appConfigPath = process.env.AGENT_BRIDGE_GITHUB_APPS_CONFIG
    || resolve(home, ".config/local-agent-bridge/github-apps.json");
  const appParsed = readJson(appConfigPath);
  const appConfig = appParsed.value || {};
  const mcp = configuredMcpServers({ host, home });
  const mcpRequired = new Set(expectedPeerServers(host));
  const selectedSkill = skillObservation({ root, name: skill });
  for (const server of selectedSkill.requirements.mcpServers) mcpRequired.add(server);
  const mcpState = Object.fromEntries([...mcpRequired].sort().map((server) => {
    const configured = mcp.servers[server];
    const inspection = mcp.state === "available"
      ? inspectMcpRegistration(configured, { configPath: mcp.path, home })
      : { state: mcp.state, reason: mcp.error || "The host MCP configuration is unavailable." };
    return [server, observation(
      inspection.state,
      configured ? `${server}: ${inspection.reason}` : `${server} is not registered for host ${host}.`,
      source(mcp.path, server),
    )];
  }));
  const builderEntry = appConfig.roles?.builder;
  const builderVerification = githubVerification?.roles?.builder || null;
  const providerEntries = {};
  for (const provider of providers) {
    const command = provider === "antigravity" ? "agy" : provider;
    const explicit = provider === "claude" ? process.env.CLAUDE_BIN
      : provider === "codex" ? process.env.CODEX_BRIDGE_CODEX_BIN
        : process.env.AGY_BIN;
    const requestedBinary = explicit || command;
    const binary = requestedBinary.includes("/") ? requestedBinary : which(requestedBinary);
    let availability;
    let cli = null;
    if (!binary) availability = observation("missing", `${command} was not found.`, source("/usr/bin/env", `which ${command}`));
    else {
      try {
        cli = probeProviderCapabilities({ provider, binary });
        availability = observation("available", `${provider} CLI ${cli.version} was probed without using its capability cache.`, source(binary));
      } catch (error) {
        availability = observation("unavailable", error.message, source(binary));
      }
    }
    const reviewerEntry = appConfig.roles?.reviewers?.[provider] || appConfig.roles?.reviewer;
    providerEntries[provider] = {
      availability,
      cli,
      permissions: providerPermissions(provider, { mode, role, workProfile, permissionProfile }),
      allowedCommands: allowedCommands[provider] || null,
      modelFallback: modelFallbackObservation(provider, { path: fallbackPath, parsed: fallbackParsed }),
      github: {
        builder: appObservation({
          entry: builderEntry,
          label: "builder",
          repository,
          repositoryOwner,
          configPath: appConfigPath,
          home,
          verified: builderVerification,
        }),
        reviewer: appObservation({
          entry: reviewerEntry,
          label: `reviewers.${provider}`,
          repository,
          repositoryOwner,
          configPath: appConfigPath,
          home,
          verified: githubVerification?.roles?.reviewers?.[provider] || null,
        }),
        patFallbackAllowed: appConfig.compatibility?.allowPatFallback !== false,
      },
    };
  }
  return {
    version: POLICY_REPORT_VERSION,
    workspace: {
      path: actualWorkspace,
      exists: existsSync(actualWorkspace),
      git: git(actualWorkspace, ["rev-parse", "--is-inside-work-tree"]),
      branch: git(actualWorkspace, ["branch", "--show-current"]),
      remote,
      repository,
    },
    request: {
      providers,
      strictProviders,
      host,
      mode,
      role,
      workProfile,
      permissionProfile,
      browser,
      requiredCommands,
      requiredBuilderOperations,
      requireReviewApp,
      requireFallback,
      requireBudget,
      budget,
      skill,
    },
    providers: providerEntries,
    mcp: { host, state: mcp.state, source: source(mcp.path), servers: mcpState },
    skill: selectedSkill,
    github: {
      configState: appParsed.state,
      source: source(appConfigPath),
      repository,
      allowPatFallback: appConfig.compatibility?.allowPatFallback !== false,
    },
  };
}

function policyFinding({ code, severity, state, provider = null, role = null, source: authoritativeSource, impact, remediation }) {
  return { code, severity, state, provider, role, source: authoritativeSource, impact, remediation };
}

function requirementSeverity(provider, strictProviders) {
  return strictProviders.includes(provider) ? "failure" : "constraint";
}

export function analyzePolicy(snapshot) {
  if (snapshot?.version !== POLICY_REPORT_VERSION) throw new Error("Unsupported collaboration doctor snapshot version.");
  const request = snapshot.request || {};
  const findings = [];
  const strictProviders = request.strictProviders || [];
  const matrix = {};
  if (!snapshot.workspace?.exists || !snapshot.workspace?.git?.ok) {
    findings.push(policyFinding({
      code: "workspace-unavailable", severity: "failure", state: "missing", source: source(snapshot.workspace?.path || "."),
      impact: "The requested workspace cannot be inspected as a Git worktree.",
      remediation: "Select an existing repository worktree; do not delegate until its exact path is verified.",
    }));
  }
  for (const [server, observed] of Object.entries(snapshot.mcp?.servers || {})) {
    if (observed.state !== "available") findings.push(policyFinding({
      code: observed.state === "stale" ? "mcp-registration-stale" : "mcp-registration-missing",
      severity: "failure", state: observed.state, role: "host", source: observed.source,
      impact: `The ${snapshot.mcp.host} host cannot call the required ${server} MCP server.`,
      remediation: `Reinstall or repair only the ${server} registration for ${snapshot.mcp.host}, then rerun the doctor.`,
    }));
  }
  if (snapshot.skill?.state === "missing") findings.push(policyFinding({
    code: "skill-missing", severity: "failure", state: "missing", role: "host", source: snapshot.skill.source,
    impact: `The requested ${request.skill} workflow is not installed in this runtime.`,
    remediation: "Install the canonical skill export and rerun the doctor; do not approximate its policy from memory.",
  }));
  let eligible = 0;
  for (const provider of request.providers || []) {
    const observed = snapshot.providers?.[provider];
    if (!observed) {
      findings.push(policyFinding({
        code: "provider-observation-missing", severity: "failure", state: "unverifiable", provider, role: request.role,
        source: snapshot.github?.source, impact: `${provider} has no policy observation.`,
        remediation: "Probe the provider with the read-only doctor collector before delegation.",
      }));
      continue;
    }
    const blockers = [];
    if (observed.availability.state !== "available") blockers.push("availability");
    if (request.mode === "work" && request.role === "writer" && !observed.permissions.write) blockers.push("write");
    if (request.mode === "work" && request.role === "writer" && !observed.permissions.shell) blockers.push("shell");
    if (request.browser && !observed.permissions.browser) blockers.push("browser");
    if (request.requireFallback && observed.modelFallback.state !== "available") blockers.push("fallback");
    const allowlist = observed.allowedCommands;
    const missingCommands = (request.requiredCommands || []).filter((command) => !allowlist?.includes(command));
    if (missingCommands.length) blockers.push("allowlist");
    if (request.requireReviewApp && observed.github.reviewer.state !== "available") blockers.push("review-app");
    const missingBuilderOperations = (request.requiredBuilderOperations || []).filter((operation) => (
      !observed.github.builder.operationsVerified || !observed.github.builder.operations.includes(operation)
    ));
    if (missingBuilderOperations.length) blockers.push("builder-scope");
    matrix[provider] = {
      eligible: blockers.length === 0,
      blockers,
      availability: observed.availability.state,
      read: observed.permissions.read,
      write: observed.permissions.write,
      shell: observed.permissions.shell,
      browser: observed.permissions.browser,
      modelFallback: observed.modelFallback.state,
      reviewerApp: observed.github.reviewer.state,
      builderApp: observed.github.builder.state,
    };
    if (!blockers.length) eligible += 1;
    if (observed.availability.state !== "available") findings.push(policyFinding({
      code: observed.availability.state === "stale" ? "provider-cli-stale" : "provider-unavailable",
      severity: requirementSeverity(provider, strictProviders), state: observed.availability.state, provider, role: request.role,
      source: observed.availability.source, impact: `${provider} cannot currently perform the requested role.`,
      remediation: `Repair or intentionally remove ${provider} from the eligible roster; do not wait on an unavailable provider.`,
    }));
    if (request.mode === "work" && request.role === "writer" && !observed.permissions.write) findings.push(policyFinding({
      code: "provider-write-denied", severity: requirementSeverity(provider, strictProviders), state: "denied", provider, role: "writer",
      source: source("adapter:provider", `${provider}.write`),
      impact: `${provider} is effectively read-only for a phase that requires one source writer.`,
      remediation: "Assign an eligible writer profile to this provider or keep it as a reviewer; do not broaden reviewer permissions.",
    }));
    if (request.mode === "work" && request.role === "writer" && !observed.permissions.shell) findings.push(policyFinding({
      code: "provider-shell-denied", severity: requirementSeverity(provider, strictProviders), state: "denied", provider, role: "writer",
      source: source("adapter:provider", `${provider}.shell`),
      impact: `${provider} cannot execute the declared verification and delivery commands for the writer role.`,
      remediation: "Grant only the named work profile or exact command allowlist, or assign another eligible writer.",
    }));
    if (request.browser && !observed.permissions.browser) findings.push(policyFinding({
      code: "browser-mismatch", severity: requirementSeverity(provider, strictProviders), state: "denied", provider, role: request.role,
      source: source("adapter:provider", `${provider}.browser`), impact: `${provider} cannot satisfy the requested browser phase.`,
      remediation: "Assign the browser phase to an eligible provider or remove the browser requirement; do not claim access to another app's signed-in browser.",
    }));
    if (request.requireFallback && observed.modelFallback.state !== "available") findings.push(policyFinding({
      code: "model-fallback-incompatible", severity: requirementSeverity(provider, strictProviders), state: observed.modelFallback.state,
      provider, role: request.role, source: observed.modelFallback.source,
      impact: `${provider} cannot recover from a model-capacity error using the requested policy.`,
      remediation: "Configure a bounded overload-only fallback chain or remove this provider from a recovery-critical lane.",
    }));
    if (!request.requireFallback && observed.modelFallback.state !== "available") findings.push(policyFinding({
      code: "model-fallback-optional", severity: "notice", state: observed.modelFallback.state, provider, role: request.role,
      source: observed.modelFallback.source, impact: `${provider} has no required overload fallback for this request.`,
      remediation: "No action is required unless this workflow must survive provider model-capacity failures.",
    }));
    if (missingCommands.length) findings.push(policyFinding({
      code: allowlist ? "provider-allowlist-conflict" : "provider-allowlist-unverifiable",
      severity: requirementSeverity(provider, strictProviders), state: allowlist ? "denied" : "unverifiable", provider, role: request.role,
      source: source("policy:request", `${provider}.allowedCommands`),
      impact: `${provider} cannot be shown to execute: ${missingCommands.map(safeCommand).join(", ")}.`,
      remediation: "Add only the exact missing command through the role's additive allowlist, or assign another eligible provider.",
    }));
    if (request.requireReviewApp && observed.github.reviewer.state !== "available") findings.push(policyFinding({
      code: observed.github.reviewer.state === "missing" ? "reviewer-app-binding-missing" : "reviewer-app-scope-unverifiable",
      severity: requirementSeverity(provider, strictProviders), state: observed.github.reviewer.state, provider, role: "reviewer",
      source: observed.github.reviewer.source,
      impact: `${provider} cannot be proven able to publish the formal independent review gate.`,
      remediation: "Bind a provider-specific reviewer App and verify its repository Pull requests write scope without enabling PAT review fallback.",
    }));
    if (missingBuilderOperations.length) findings.push(policyFinding({
      code: observed.github.builder.state === "missing" ? "builder-app-binding-missing" : "builder-operation-scope-unverifiable",
      severity: requirementSeverity(provider, strictProviders), state: observed.github.builder.state, provider, role: "writer",
      source: observed.github.builder.source,
      impact: `${provider} cannot be proven able to deliver operations: ${missingBuilderOperations.join(", ")}.`,
      remediation: "Verify only the required builder App operations for this repository and provide that read-only verification report.",
    }));
    if (observed.github.patFallbackAllowed) findings.push(policyFinding({
      code: "unsafe-pat-fallback",
      severity: request.requireReviewApp && observed.github.reviewer.state !== "available"
        ? requirementSeverity(provider, strictProviders)
        : "constraint",
      state: "optional", provider, role: request.role, source: snapshot.github.source,
      impact: "A personal PAT compatibility path exists and can blur agent identity if an App permission fails.",
      remediation: "Set compatibility.allowPatFallback to false after the required Apps are verified.",
    }));
    const builderLogin = observed.github.builder.login;
    const reviewerLogin = observed.github.reviewer.login;
    if (builderLogin && reviewerLogin && builderLogin === reviewerLogin) findings.push(policyFinding({
      code: "writer-reviewer-authority-overlap", severity: "failure", state: "denied", provider, role: "reviewer",
      source: snapshot.github.source,
      impact: `${provider} reviewer and builder resolve to the same GitHub identity, so independence cannot be established.`,
      remediation: "Bind distinct builder and provider-reviewer Apps; do not use a personal identity to simulate separation.",
    }));
  }
  if ((request.providers || []).length && eligible === 0) findings.push(policyFinding({
    code: "no-eligible-provider", severity: "failure", state: "denied", role: request.role,
    source: source("policy:request", "providers"),
    impact: "No selected provider can satisfy the complete requested role, so failover would stall or violate policy.",
    remediation: "Reduce the requested capability set or add one provider whose observed policy satisfies every required capability.",
  }));
  if (snapshot.skill?.requirements?.browser && !(request.providers || []).some((provider) => snapshot.providers?.[provider]?.permissions?.browser)) {
    findings.push(policyFinding({
      code: "skill-capability-unavailable", severity: "failure", state: "missing", role: "host", source: snapshot.skill.source,
      impact: `Skill ${snapshot.skill.name} requires a browser but no selected provider exposes one.`,
      remediation: "Select a provider with the required isolated browser capability or use a skill that does not require browser access.",
    }));
  }
  if (request.requireBudget && !request.budget) findings.push(policyFinding({
    code: "required-budget-missing", severity: "failure", state: "missing", role: "host", source: source("policy:request", "budget"),
    impact: "This workflow requires a bounded budget but none is present.",
    remediation: "Add only the required cost, token, or elapsed-time ceiling before delegation.",
  }));
  if (!request.requireBudget && !request.budget) findings.push(policyFinding({
    code: "budget-optional", severity: "notice", state: "optional", role: "host", source: source("policy:request", "budget"),
    impact: "No budget is configured, and this workflow did not require one.",
    remediation: "No action is required; add a budget only when the workflow needs an explicit ceiling.",
  }));
  if (request.permissionProfile === "yolo") findings.push(policyFinding({
    code: "yolo-permission-profile", severity: "constraint", state: "intentionally_enabled", role: request.role,
    source: source("policy:request", "permissionProfile"),
    impact: "The writer may execute outside the standard command profile, increasing the blast radius of a delegated turn.",
    remediation: "Prefer the standard named profile; retain yolo only when the owner explicitly accepts the broader local authority.",
  }));
  const order = { failure: 0, constraint: 1, notice: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity]
    || left.code.localeCompare(right.code)
    || String(left.provider || "").localeCompare(String(right.provider || "")));
  const safeWorkspace = {
    path: snapshot.workspace?.path || null,
    exists: Boolean(snapshot.workspace?.exists),
    git: { ok: Boolean(snapshot.workspace?.git?.ok) },
    branch: snapshot.workspace?.branch?.ok ? snapshot.workspace.branch.output : null,
    repository: snapshot.workspace?.repository || null,
    remoteConfigured: Boolean(snapshot.workspace?.remote?.ok),
  };
  const safeRequest = {
    ...request,
    requiredCommands: (request.requiredCommands || []).map(safeCommand),
  };
  return {
    version: POLICY_REPORT_VERSION,
    ok: findings.every((item) => item.severity !== "failure"),
    workspace: safeWorkspace,
    request: safeRequest,
    matrix,
    findings,
    summary: {
      eligibleProviders: eligible,
      failures: findings.filter((item) => item.severity === "failure").length,
      constraints: findings.filter((item) => item.severity === "constraint").length,
      notices: findings.filter((item) => item.severity === "notice").length,
    },
  };
}

export function renderPolicyReport(report) {
  const lines = [
    "COLLABORATION POLICY DOCTOR",
    `Result: ${report.ok ? "READY" : "BLOCKED"}`,
    `Workspace: ${report.workspace.path}`,
    `Request: ${report.request.mode}/${report.request.role}/${report.request.workProfile} on ${report.request.providers.join(", ")}`,
    `Summary: ${report.summary.eligibleProviders} eligible provider(s); ${report.summary.failures} failures; ${report.summary.constraints} constraints; ${report.summary.notices} notices`,
    "",
    "Provider matrix:",
  ];
  for (const [provider, row] of Object.entries(report.matrix)) {
    lines.push(`- ${provider}: ${row.eligible ? "eligible" : "ineligible"}; availability=${row.availability}; write=${row.write}; shell=${row.shell}; browser=${row.browser || "none"}; fallback=${row.modelFallback}; review=${row.reviewerApp}; builder=${row.builderApp}${row.blockers.length ? `; blockers=${row.blockers.join(",")}` : ""}`);
  }
  lines.push("", `Findings (${report.summary.failures} failures, ${report.summary.constraints} constraints, ${report.summary.notices} notices):`);
  if (!report.findings.length) lines.push("- none");
  for (const item of report.findings) {
    const affected = [item.provider, item.role].filter(Boolean).join("/") || "global";
    const authoritativeSource = item.source?.field ? `${item.source.path}#${item.source.field}` : item.source?.path || "unknown";
    lines.push(`- [${item.severity.toUpperCase()}] ${item.code} (${affected}, ${item.state})`);
    lines.push(`  Impact: ${item.impact}`);
    lines.push(`  Source: ${authoritativeSource}`);
    lines.push(`  Least-authority remediation: ${item.remediation}`);
  }
  lines.push("", "This report is read-only. It did not grant permissions, change configuration, install tools, or run delegated work.");
  return `${lines.join("\n")}\n`;
}

export function supportedBuilderOperations() {
  return [...BUILDER_OPERATIONS];
}

export function isFailureState(value) {
  return FAILURE_STATES.has(value);
}

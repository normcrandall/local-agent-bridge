import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GITHUB_LOGIN_PATTERN } from "./github-app-auth.mjs";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";

export const PROVIDERS = ["claude", "codex", "antigravity", "docker", "ollama"];
export const WRITER_PROVIDERS = ["claude", "codex", "antigravity"];

export function isTransportLivenessSummary(value) {
  const summary = String(value || "").trim();
  return /^(Claude Code|Codex|Antigravity|Ollama|Docker Model Runner|The local reviewer) started the delegated turn\.?$/i.test(summary)
    || /^(Claude Code|Codex|Antigravity|Ollama|Docker Model Runner) is still working \(\d+s heartbeat\)\.?$/i.test(summary)
    || /^(The local reviewer|The Docker local reviewer) is still working; its last repository action remains current\.?$/i.test(summary);
}

export function isSafeWorkerPid(value) {
  return Number.isInteger(value) && value > 1;
}

export function selectRoles({ taskNumber, agents = PROVIDERS, offset = 0 }) {
  if (!Number.isInteger(taskNumber) || taskNumber < 0) throw new Error("taskNumber must be a non-negative integer.");
  if (!agents.length || agents.some((agent) => !PROVIDERS.includes(agent))) throw new Error("agents contains an unsupported provider.");
  const writerCandidates = agents.filter((agent) => WRITER_PROVIDERS.includes(agent));
  if (!writerCandidates.length) throw new Error("Role rotation requires at least one write-capable provider.");
  const writer = writerCandidates[(taskNumber + offset) % writerCandidates.length];
  return { writer, reviewers: agents.filter((agent) => agent !== writer) };
}

function executable(command) {
  return spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" }).status === 0;
}

function negotiated(provider, command, explicit) {
  const lookup = explicit || spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" }).stdout?.trim();
  if (!lookup || !existsSync(lookup)) return { available: false, reason: `${command} was not found` };
  try { return { available: true, negotiated: negotiateProviderCapabilities({ provider, binary: lookup }) }; }
  catch (error) { return { available: false, binary: lookup, reason: error.message }; }
}

export function providerCapabilities({ home = homedir() } = {}) {
  const tokenPath = resolve(home, ".config/ghtoken");
  const configPath = resolve(home, ".config/local-agent-bridge/github-apps.json");
  let appConfig = null;
  try { appConfig = JSON.parse(readFileSync(configPath, "utf8")); } catch {}
  const entryConfigured = (selected) => {
    if (appConfig) {
      try {
        if (selected) {
          const keyPath = selected.privateKeyPath?.startsWith("~/")
            ? resolve(home, selected.privateKeyPath.slice(2))
            : isAbsolute(selected.privateKeyPath || "")
              ? selected.privateKeyPath
              : resolve(dirname(configPath), selected.privateKeyPath || "");
          const key = statSync(keyPath);
          return /^\d+$/.test(String(selected.appId || ""))
            && GITHUB_LOGIN_PATTERN.test(selected.expectedLogin || "")
            && Object.keys(selected.installations || {}).length > 0
            && key.isFile()
            && (key.mode & 0o077) === 0;
        }
      } catch { return false; }
    }
    return false;
  };
  const roleConfigured = (role) => entryConfigured(appConfig?.roles?.[role]);
  const reviewerConfigured = (provider) => entryConfigured(appConfig?.roles?.reviewers?.[provider] || appConfig?.roles?.reviewer);
  const reviewerDeclared = Boolean(appConfig?.roles?.reviewer || Object.keys(appConfig?.roles?.reviewers || {}).length);
  const patFallbackAllowed = appConfig?.compatibility?.allowPatFallback !== false;
  const patReviewFallback = !reviewerDeclared && patFallbackAllowed && (() => {
    try { return statSync(tokenPath).isFile() && (statSync(tokenPath).mode & 0o077) === 0; } catch { return false; }
  })();
  const builderBot = roleConfigured("builder");
  const providers = {
    claude: negotiated("claude", "claude", process.env.CLAUDE_BIN),
    codex: negotiated("codex", "codex", process.env.CODEX_BRIDGE_CODEX_BIN),
    antigravity: negotiated("antigravity", "agy", process.env.AGY_BIN),
    ollama: (() => {
      const binary = process.env.OLLAMA_BIN || spawnSync("/usr/bin/env", ["which", "ollama"], { encoding: "utf8" }).stdout?.trim();
      if (!binary || !existsSync(binary)) return { available: false, reason: "ollama was not found" };
      const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
      return result.status === 0
        ? { available: true, binary, negotiated: { version: (result.stdout || result.stderr).trim() } }
        : { available: false, binary, reason: (result.stderr || result.stdout).trim() };
    })(),
    docker: (() => {
      const binary = process.env.DOCKER_BIN || spawnSync("/usr/bin/env", ["which", "docker"], { encoding: "utf8" }).stdout?.trim();
      if (!binary || !existsSync(binary)) return { available: false, reason: "docker was not found" };
      const result = spawnSync(binary, ["model", "status"], { encoding: "utf8", timeout: 10_000 });
      return result.status === 0
        ? { available: true, binary, negotiated: { version: (result.stdout || result.stderr).trim() } }
        : { available: false, binary, reason: (result.stderr || result.stdout || result.error?.message || "docker model status failed").trim() };
    })(),
  };
  return {
    claude: { ...providers.claude, read: true, write: true, shell: "profiled", browser: "isolated", githubReview: reviewerConfigured("claude") || patReviewFallback, githubBuilder: builderBot },
    codex: { ...providers.codex, read: true, write: true, shell: "sandboxed", browser: "isolated", githubReview: reviewerConfigured("codex") || patReviewFallback, githubBuilder: builderBot },
    antigravity: { ...providers.antigravity, read: true, write: true, shell: "sandboxed", browser: false, githubReview: (reviewerConfigured("antigravity") || patReviewFallback) ? "broker-envelope" : false, githubBuilder: builderBot ? "broker-envelope" : false },
    ollama: { ...providers.ollama, read: true, write: false, shell: false, browser: false, githubReview: (reviewerConfigured("ollama") || patReviewFallback) ? "broker-envelope" : false, githubBuilder: false },
    docker: { ...providers.docker, read: true, write: false, shell: false, browser: false, githubReview: (reviewerConfigured("docker") || patReviewFallback) ? "broker-envelope" : false, githubBuilder: false },
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

export function preflight({ workspace, agents = PROVIDERS, mode = "review", workProfile = "exact", permissionProfile = "standard" }) {
  const root = resolve(workspace);
  const capabilities = providerCapabilities();
  const checks = [
    { name: "workspace", ok: existsSync(root), detail: root },
    { name: "git-repository", ...git(root, ["rev-parse", "--is-inside-work-tree"]) },
    { name: "branch", ...git(root, ["branch", "--show-current"]) },
    { name: "remote", ...git(root, ["remote", "get-url", "origin"]) },
    ...agents.map((agent) => ({ name: `provider:${agent}`, ok: Boolean(capabilities[agent]?.available), detail: capabilities[agent] })),
    { name: "work-profile", ok: mode !== "work" || ["exact", "implement", "deliver"].includes(workProfile), detail: workProfile },
    { name: "permission-profile", ok: permissionProfile !== "yolo" || mode === "work", detail: permissionProfile },
  ];
  return { ok: checks.every((check) => check.ok), workspace: root, checks, capabilities };
}

export function collaborationStates(stateDirectory) {
  const directory = resolve(stateDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^bridge-[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function inspectRecovery(state) {
  const heartbeat = state.runtime?.activeCall?.heartbeatAt;
  const heartbeatAgeSeconds = heartbeat ? Math.max(0, Math.floor((Date.now() - Date.parse(heartbeat)) / 1000)) : null;
  const processAlive = pidAlive(state.workerPid);
  const gitStatus = existsSync(state.workspace) ? git(state.workspace, ["status", "--short", "--branch"]) : { ok: false, output: "workspace missing" };
  let recommendation = "no-action";
  if (state.status === "indeterminate") recommendation = processAlive ? "inspect-running-provider" : "inspect-git-then-cancel-or-resume";
  else if (state.status === "running" && !processAlive) recommendation = "mark-indeterminate-and-inspect";
  else if (state.status === "running" && heartbeatAgeSeconds > 120) recommendation = "stalled-inspect-before-cancel";
  return { id: state.id, status: state.status, writer: state.writer, processAlive, heartbeatAgeSeconds, gitStatus, recommendation };
}

export function summarizeStates(states) {
  return states.map((state) => ({
    id: state.id,
    status: state.status,
    workspace: state.workspace,
    writer: state.writer,
    activeAgent: state.runtime?.activeCall?.agent || null,
    phase: state.runtime?.activeCall?.phase || null,
    summary: state.runtime?.activeCall?.summary || null,
    heartbeatAt: state.runtime?.activeCall?.heartbeatAt || null,
    branch: git(state.workspace, ["branch", "--show-current"]).output || null,
    pr: state.ci?.pr || state.githubReview?.prNumber || null,
    usage: state.usage || {},
    permissionProfile: state.permissionProfile || "standard",
    recovery: state.status === "indeterminate"
      ? "Execution ownership is ambiguous. Inspect with bridge recover <id>; do not start replacement work. Cancel only after verifying workspace and provider state."
      : null,
  }));
}

export function reconcileReviews(reviews) {
  const findings = new Map();
  for (const review of reviews) {
    for (const finding of review.findings || []) {
      const key = `${finding.path}:${finding.line}:${finding.title}`;
      const current = findings.get(key) || { ...finding, supporters: [], dissenters: [] };
      (finding.verdict === "reject" ? current.dissenters : current.supporters).push(review.agent);
      findings.set(key, current);
    }
  }
  const values = [...findings.values()];
  return {
    accepted: values.filter((finding) => finding.supporters.length && !finding.dissenters.length),
    disputed: values.filter((finding) => finding.supporters.length && finding.dissenters.length),
    rejected: values.filter((finding) => !finding.supporters.length),
  };
}

export function usageDecision({ usage = {}, budget = {} }) {
  const costUsd = Object.values(usage).reduce((sum, item) => sum + (item.costUsd || 0), 0);
  const tokens = Object.values(usage).reduce((sum, item) => sum + (item.tokens || 0), 0);
  const exceeded = Boolean(
    (budget.maxCostUsd != null && costUsd >= budget.maxCostUsd)
    || (budget.maxTokens != null && tokens >= budget.maxTokens)
  );
  return { costUsd, tokens, exceeded, action: exceeded ? "stop-after-current-turn" : "continue" };
}

export function createWorktree({ workspace, taskId, branch, base = "HEAD", worktreeRoot }) {
  if (branch?.startsWith("-") || taskId?.startsWith("-")
    || !/^[A-Za-z0-9._/-]+$/.test(branch) || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error("Unsafe task or branch name.");
  }
  const root = resolve(worktreeRoot || join(workspace, ".bridge/worktrees"));
  const path = resolve(root, taskId);
  if (existsSync(path)) throw new Error(`Worktree already exists: ${path}`);
  const result = spawnSync("git", ["worktree", "add", "-b", branch, path, base], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return { path, branch, base };
}

export function exportPortableManifest({ destination, sourceRoot }) {
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: resolve(sourceRoot),
    excludes: ["node_modules", ".git", ".bridge", "~/.config/ghtoken", "~/.config/local-agent-bridge/github-apps", "provider credentials", "collaboration state", "capsule files"],
    install: ["npm ci", "npm run install:global", "npm run doctor"],
    launchers: ["claude", "codex", "antigravity", "docker", "ollama", "collaboration", "playwright"],
  };
  writeFileSync(resolve(destination), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function refreshCi({ workspace, prNumber, timeoutMs = 15_000 }) {
  const result = spawnSync("gh", ["pr", "checks", String(prNumber), "--json", "name,state,link"], {
    cwd: workspace, encoding: "utf8", timeout: timeoutMs,
  });
  if (result.status !== 0) return {
    ok: false,
    error: (result.error?.message || result.stderr || result.stdout || "GitHub CI refresh failed.").trim(),
    checks: [],
  };
  return { ok: true, checks: JSON.parse(result.stdout), checkedAt: new Date().toISOString(), pr: prNumber };
}

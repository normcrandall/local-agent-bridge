import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PROVIDERS = ["claude", "codex", "antigravity"];

export function isTransportLivenessSummary(value) {
  return /^(Claude Code|Codex|Antigravity) (?:started the delegated turn|is still working \(\d+s heartbeat\))\.?$/i
    .test(String(value || "").trim());
}

export function isSafeWorkerPid(value) {
  return Number.isInteger(value) && value > 1;
}

export function selectRoles({ taskNumber, agents = PROVIDERS, offset = 0 }) {
  if (!Number.isInteger(taskNumber) || taskNumber < 0) throw new Error("taskNumber must be a non-negative integer.");
  if (!agents.length || agents.some((agent) => !PROVIDERS.includes(agent))) throw new Error("agents contains an unsupported provider.");
  const writer = agents[(taskNumber + offset) % agents.length];
  return { writer, reviewers: agents.filter((agent) => agent !== writer) };
}

function executable(command) {
  return spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" }).status === 0;
}

export function providerCapabilities({ home = homedir() } = {}) {
  const tokenPath = resolve(home, ".config/ghtoken");
  const reviewBot = (() => {
    try { return statSync(tokenPath).isFile() && (statSync(tokenPath).mode & 0o077) === 0; } catch { return false; }
  })();
  return {
    claude: { available: executable("claude"), read: true, write: true, shell: "profiled", browser: "isolated", githubReview: reviewBot },
    codex: { available: executable("codex"), read: true, write: true, shell: "sandboxed", browser: "isolated", githubReview: reviewBot },
    antigravity: { available: executable("agy"), read: true, write: true, shell: "sandboxed", browser: false, githubReview: reviewBot ? "broker-envelope" : false },
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
    excludes: ["node_modules", ".git", ".bridge", "~/.config/ghtoken", "provider credentials", "collaboration state"],
    install: ["npm ci", "npm run install:global", "npm run doctor"],
    launchers: ["claude", "codex", "antigravity", "collaboration", "playwright"],
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

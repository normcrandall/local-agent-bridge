import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { queryControlPlane } from "./collaboration-store.mjs";

const PHASES = new Set(["postCreate", "prePublish", "preRetire"]);
const RECIPE_ENVIRONMENT_KEYS = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_CACHE_HOME", "NVM_DIR"];
const DEFAULT_RECIPE_TIMEOUT_MS = 10 * 60 * 1_000;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateCommands(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must be an array with at most 20 commands.`);
  return value.map((command) => {
    if (typeof command !== "string" || !command.trim() || /[\r\n]/.test(command) || command.length > 500) {
      throw new Error(`${label} contains an invalid command.`);
    }
    return command.trim();
  });
}

export function loadWorkspaceRecipe(workspace, {
  home = homedir(),
  projectPath = resolve(workspace, ".agent-bridge/workspace-recipes.json"),
  approvalsPath = resolve(home, ".config/local-agent-bridge/workspace-recipe-approvals.json"),
  approvalWorkspace = workspace,
} = {}) {
  const project = readJson(projectPath) || { version: 1, phases: {} };
  if (project.version !== 1) throw new Error(`Unsupported workspace recipe version in ${projectPath}.`);
  const phases = Object.fromEntries([...PHASES].map((phase) => [phase, validateCommands(project.phases?.[phase], `phases.${phase}`)]));
  const approvals = readJson(approvalsPath) || { version: 1, workspaces: {} };
  if (approvals.version !== 1) throw new Error(`Unsupported workspace recipe approvals version in ${approvalsPath}.`);
  const approved = approvals.workspaces?.[resolve(approvalWorkspace)] || {};
  return {
    workspace: resolve(workspace),
    projectPath,
    approvalsPath,
    approvalWorkspace: resolve(approvalWorkspace),
    phases: Object.fromEntries(Object.entries(phases).map(([phase, commands]) => [phase, {
      commands,
      approved: commands.length > 0 && JSON.stringify(commands) === JSON.stringify(approved[phase] || []),
    }])),
  };
}

export function workspaceRecipePlan(workspace, phase, options = {}) {
  if (!PHASES.has(phase)) throw new Error(`Unknown workspace recipe phase: ${phase}`);
  const recipe = loadWorkspaceRecipe(workspace, options);
  const selected = recipe.phases[phase];
  return {
    ...recipe,
    phase,
    commands: selected.commands,
    approved: selected.approved,
    executable: selected.commands.length > 0 && selected.approved,
    note: selected.commands.length === 0
      ? "No project recipe is configured for this phase."
      : selected.approved
        ? "The exact project command list matches the machine-local approval."
        : "Preview only: approve this exact command list in the machine-local approvals file before execution is enabled.",
  };
}

export function sanitizedRecipeEnvironment(environment = process.env, additions = {}) {
  return Object.fromEntries([
    ...RECIPE_ENVIRONMENT_KEYS.flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]]] : []),
    ...Object.entries(additions),
  ]);
}

export function runWorkspaceRecipe(workspace, phase, options = {}) {
  const plan = workspaceRecipePlan(workspace, phase, options);
  if (!plan.executable) throw new Error(plan.note);
  const results = [];
  for (const command of plan.commands) {
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: plan.workspace,
      encoding: "utf8",
      env: sanitizedRecipeEnvironment(options.environment || process.env, {
        AGENT_BRIDGE_RECIPE_PHASE: phase,
        AGENT_BRIDGE_WORKSPACE: plan.workspace,
      }),
      timeout: options.timeoutMs || DEFAULT_RECIPE_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: 4 * 1024 * 1024,
    });
    const receipt = {
      command,
      exitCode: result.status,
      signal: result.signal || null,
      timedOut: result.error?.code === "ETIMEDOUT",
      output: (result.stdout || result.stderr || result.error?.message || "").trim().slice(0, 2_000),
    };
    results.push(receipt);
    if (result.status !== 0) return { ...plan, applied: true, ok: false, results };
  }
  return { ...plan, applied: true, ok: true, results };
}

function parseWorktrees(output) {
  const records = [];
  let current = null;
  for (const token of output.split("\0").filter(Boolean)) {
    const [key, ...rest] = token.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value };
    } else if (current) current[key] = value || true;
  }
  if (current) records.push(current);
  return records;
}

export async function auditWorkspaceSweep(workspace, { stateRoot, retiredHeads = [] } = {}) {
  const root = resolve(workspace);
  const listed = git(root, ["worktree", "list", "--porcelain", "-z"]);
  if (!listed.ok) throw new Error(`Unable to list worktrees: ${listed.output}`);
  const controlPlane = stateRoot ? await queryControlPlane(stateRoot) : { lanes: [] };
  const records = parseWorktrees(listed.output);
  const primary = records[0]?.path || root;
  const worktrees = records.filter((record) => record.path !== primary).map((record) => {
    const status = git(record.path, ["status", "--porcelain"]);
    const head = record.HEAD || git(record.path, ["rev-parse", "HEAD"]).output;
    const refs = git(root, ["for-each-ref", "--format=%(refname)", "--contains", head, "refs/remotes"]);
    const recoveryRefs = refs.ok ? refs.output.split("\n").filter(Boolean) : [];
    const owners = controlPlane.lanes.filter((lane) => lane.workspace && resolve(lane.workspace) === resolve(record.path)
      && ["queued", "running", "recovering", "cancelling", "indeterminate", "implementing", "reviewing", "integrating", "arbitrating"].includes(lane.lifecyclePhase));
    const dirty = !status.ok || Boolean(status.output);
    const recoverabilityProven = recoveryRefs.length > 0;
    const retirementProven = retiredHeads.includes(head);
    const safe = !dirty && owners.length === 0 && recoverabilityProven && retirementProven;
    return {
      path: record.path,
      branch: record.branch?.replace(/^refs\/heads\//, "") || null,
      head,
      dirty,
      liveOwners: owners.map((lane) => lane.alias || lane.id),
      recoveryRefs,
      recoverabilityProven,
      retirementProven,
      safeToQuarantine: safe,
      reason: dirty ? "dirty_worktree" : owners.length ? "live_owner" : !recoverabilityProven ? "no_remote_recovery_ref" : !retirementProven ? "github_retirement_unverified" : "retirement_and_recoverability_proven",
    };
  });
  return { workspace: root, primary, dryRun: true, worktrees, safeCount: worktrees.filter((item) => item.safeToQuarantine).length };
}

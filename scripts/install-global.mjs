#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  addCommandHook,
  configuredCodexHookPath,
  ensureCodexHookConfiguration,
  resolveCodexHookPath,
} from "../src/coordinator-hook-config.mjs";
import { exportSkills } from "./skill-portability.mjs";
import { deployRuntime } from "../src/runtime-deployment.mjs";
import { refreshSupervisor } from "../src/worker-supervisor-client.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");
const installRoot = resolve(homedir(), ".local/share/agent-bridge");
const runtimeRoot = resolve(installRoot, "runtime");
const stateRoot = resolve(installRoot, "state");
const binRoot = resolve(homedir(), ".local/bin");
const skillNames = (await readdir(resolve(sourceRoot, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const codexDialogueSkillSource = resolve(sourceRoot, ".agents/skills/agent-dialogue");
const claudeDialogueSkillSource = resolve(sourceRoot, "assets/skills/claude/agent-dialogue");

await mkdir(installRoot, { recursive: true, mode: 0o700 });
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
await deployRuntime({
  sourceRoot,
  installRoot,
  runtimeRoot,
  entries: ["src", "scripts", "skills", "package.json", "package-lock.json"],
  installDependencies: async (stagedRuntime) => {
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
      cwd: stagedRuntime,
      stdio: "inherit",
    });
  },
});

await mkdir(binRoot, { recursive: true, mode: 0o700 });
const launchers = {
  "agent-claude-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"

exec "$RUNTIME/scripts/claude-bridge-mcp.sh"
`,
  "agent-codex-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
exec "$RUNTIME/scripts/codex-mcp.sh"
`,
  "agent-antigravity-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"

exec "$RUNTIME/scripts/antigravity-bridge-mcp.sh"
`,
  "agent-ollama-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"

exec "$RUNTIME/scripts/ollama-bridge-mcp.sh"
`,
  "agent-docker-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"

exec "$RUNTIME/scripts/docker-bridge-mcp.sh"
`,
  "agent-collaboration-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"
export BRIDGE_COLLABORATION_DIR="$HOME/.local/share/agent-bridge/state"

exec "$RUNTIME/scripts/collaboration-bridge-mcp.sh"
`,
  "agent-playwright-mcp": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
exec "$RUNTIME/scripts/playwright-mcp.sh"
`,
  "agent-bridge-claude-statusline": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_COLLABORATION_DIR="$HOME/.local/share/agent-bridge/state"
export BRIDGE_BASE_STATUSLINE="npx -y ccstatusline@latest"

exec "$NODE_BIN" "$RUNTIME/scripts/claude-statusline.mjs"
`,
  "agent-bridge-coordinator-hook": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_COLLABORATION_DIR="$HOME/.local/share/agent-bridge/state"

exec "$NODE_BIN" "$RUNTIME/scripts/coordinator-hook.mjs" "$@"
`,
  "agent-bridge-host-activity-hook": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_COLLABORATION_DIR="$HOME/.local/share/agent-bridge/state"

exec "$NODE_BIN" "$RUNTIME/scripts/host-activity-hook.mjs" "$@"
`,
  "agent-bridge-claude-wake-channel": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
export BRIDGE_RUNTIME_ROOT="$RUNTIME"
export BRIDGE_COLLABORATION_DIR="$HOME/.local/share/agent-bridge/state"
export BRIDGE_WORKSPACE_ROOT="\${AGENT_BRIDGE_WORKSPACE:-$PWD}"

exec "$NODE_BIN" "$RUNTIME/src/claude-wake-channel.mjs"
`,
  "claude-collab": `#!/bin/zsh
set -eu

exec claude --dangerously-load-development-channels server:collaboration_wake "$@"
`,
  "bridge": `#!/bin/zsh
set -eu

RUNTIME="$HOME/.local/share/agent-bridge/runtime"
export NODE_BIN=${JSON.stringify(process.execPath)}
COMMAND="\${1:-help}"
if [[ "$COMMAND" == "talk" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/bridge-talk.mjs" "$@"
elif [[ "$COMMAND" == "start" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/workflow-launcher.mjs" "$@"
elif [[ "$COMMAND" == "watchdog" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/codex-turn-watchdog.mjs" "$@"
elif [[ "$COMMAND" == "doctor" ]]; then
  shift
  if (( \$# == 0 )); then
    exec "$NODE_BIN" "$RUNTIME/scripts/doctor.mjs"
  fi
  exec "$NODE_BIN" "$RUNTIME/scripts/collaboration-doctor.mjs" "\$@"
elif [[ "$COMMAND" == "smoke" ]]; then
  exec "$NODE_BIN" "$RUNTIME/scripts/smoke-test.mjs"
elif [[ "$COMMAND" == "skills" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/skill-portability.mjs" "$@"
elif [[ "$COMMAND" == "models" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/model-policy-cli.mjs" "$@"
elif [[ "$COMMAND" == "mc" || "$COMMAND" == "mission-control" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/mission-control.mjs" "$@"
elif [[ "$COMMAND" == "supervisor" ]]; then
  shift
  exec "$NODE_BIN" "$RUNTIME/scripts/supervisor-control.mjs" "$@"
else
  [[ "$COMMAND" == "help" ]] || shift
  exec "$NODE_BIN" "$RUNTIME/scripts/bridge-ops.mjs" "$COMMAND" "$@"
fi
`,
};
for (const [name, script] of Object.entries(launchers)) {
  const path = resolve(binRoot, name);
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readText(path, fallback = "") {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path, content) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.agent-bridge-${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const hookLauncher = resolve(binRoot, "agent-bridge-coordinator-hook");
const hostActivityHookLauncher = resolve(binRoot, "agent-bridge-host-activity-hook");
const claudeSettingsPath = resolve(homedir(), ".claude/settings.json");
let claudeSettings = await readJson(claudeSettingsPath);
claudeSettings = addCommandHook(claudeSettings, "Stop", `${hookLauncher} claude stop`);
claudeSettings = addCommandHook(claudeSettings, "SessionStart", `${hookLauncher} claude session_start`);
claudeSettings = addCommandHook(claudeSettings, "UserPromptSubmit", `${hostActivityHookLauncher} claude start`);
claudeSettings = addCommandHook(claudeSettings, "PreToolUse", `${hostActivityHookLauncher} claude heartbeat`);
claudeSettings = addCommandHook(claudeSettings, "PostToolUse", `${hostActivityHookLauncher} claude heartbeat`);
claudeSettings = addCommandHook(claudeSettings, "Stop", `${hostActivityHookLauncher} claude stop`);
claudeSettings = addCommandHook(claudeSettings, "SessionEnd", `${hostActivityHookLauncher} claude stop`);
await writeJson(claudeSettingsPath, claudeSettings);

const claudeUserConfigPath = resolve(homedir(), ".claude.json");
const claudeUserConfig = await readJson(claudeUserConfigPath);
claudeUserConfig.mcpServers = {
  ...(claudeUserConfig.mcpServers || {}),
  ollama: {
    command: resolve(binRoot, "agent-ollama-mcp"),
    args: [],
  },
  docker: {
    command: resolve(binRoot, "agent-docker-mcp"),
    args: [],
  },
  collaboration_wake: {
    command: resolve(binRoot, "agent-bridge-claude-wake-channel"),
    args: [],
  },
};
await writeJson(claudeUserConfigPath, claudeUserConfig);

const antigravitySettingsPath = resolve(homedir(), ".gemini/antigravity-cli/settings.json");
let antigravitySettings = await readJson(antigravitySettingsPath);
antigravitySettings = addCommandHook(antigravitySettings, "AfterAgent", `${hookLauncher} antigravity stop`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "SessionStart", `${hookLauncher} antigravity session_start`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "BeforeAgent", `${hostActivityHookLauncher} antigravity start`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "BeforeTool", `${hostActivityHookLauncher} antigravity heartbeat`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "AfterTool", `${hostActivityHookLauncher} antigravity heartbeat`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "AfterAgent", `${hostActivityHookLauncher} antigravity stop`, { timeout: 5_000 });
antigravitySettings = addCommandHook(antigravitySettings, "SessionEnd", `${hostActivityHookLauncher} antigravity stop`, { timeout: 5_000 });
await writeJson(antigravitySettingsPath, antigravitySettings);

const antigravityMcpPath = resolve(homedir(), ".gemini/config/mcp_config.json");
const antigravityMcp = await readJson(antigravityMcpPath);
antigravityMcp.mcpServers = {
  ...(antigravityMcp.mcpServers || {}),
  ollama: {
    command: resolve(binRoot, "agent-ollama-mcp"),
    args: [],
  },
  docker: {
    command: resolve(binRoot, "agent-docker-mcp"),
    args: [],
  },
};
await writeJson(antigravityMcpPath, antigravityMcp);

const codexConfigPath = resolve(homedir(), ".codex/config.toml");
let codexConfig = await readText(codexConfigPath);
const configuredHookPath = configuredCodexHookPath(codexConfig);
const legacyCodexHookPath = resolveCodexHookPath(codexConfigPath, configuredHookPath);
const codexHookPath = resolve(homedir(), ".codex/hooks.json");
let codexHooks = await readJson(codexHookPath);
if (legacyCodexHookPath && legacyCodexHookPath !== codexHookPath) {
  const legacyHooks = await readJson(legacyCodexHookPath);
  const events = new Set([
    ...Object.keys(legacyHooks.hooks || {}),
    ...Object.keys(codexHooks.hooks || {}),
  ]);
  codexHooks = {
    ...legacyHooks,
    ...codexHooks,
    hooks: Object.fromEntries([...events].map((event) => {
      const groups = [
        ...(legacyHooks.hooks?.[event] || []),
        ...(codexHooks.hooks?.[event] || []),
      ];
      const seen = new Set();
      return [event, groups.filter((group) => {
        const key = JSON.stringify(group);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
    })),
  };
}
codexHooks = addCommandHook(codexHooks, "Stop", `${hookLauncher} codex stop`);
codexHooks = addCommandHook(codexHooks, "SessionStart", `${hookLauncher} codex session_start`);
codexHooks = addCommandHook(codexHooks, "UserPromptSubmit", `${hostActivityHookLauncher} codex start`);
codexHooks = addCommandHook(codexHooks, "PreToolUse", `${hostActivityHookLauncher} codex heartbeat`);
codexHooks = addCommandHook(codexHooks, "PostToolUse", `${hostActivityHookLauncher} codex heartbeat`);
codexHooks = addCommandHook(codexHooks, "Stop", `${hostActivityHookLauncher} codex stop`);
codexHooks = addCommandHook(codexHooks, "SessionEnd", `${hostActivityHookLauncher} codex stop`);
await writeJson(codexHookPath, codexHooks);
codexConfig = ensureCodexHookConfiguration(codexConfig);
if (!/^\[mcp_servers\.ollama\]\s*$/m.test(codexConfig)) {
  codexConfig = `${codexConfig.trimEnd()}\n\n[mcp_servers.ollama]\ncommand = ${JSON.stringify(resolve(binRoot, "agent-ollama-mcp"))}\nargs = []\nstartup_timeout_sec = 20\ntool_timeout_sec = 1800\nenabled = true\nrequired = false\ndefault_tools_approval_mode = "prompt"\n`;
}
if (!/^\[mcp_servers\.docker\]\s*$/m.test(codexConfig)) {
  codexConfig = `${codexConfig.trimEnd()}\n\n[mcp_servers.docker]\ncommand = ${JSON.stringify(resolve(binRoot, "agent-docker-mcp"))}\nargs = []\nstartup_timeout_sec = 20\ntool_timeout_sec = 1800\nenabled = true\nrequired = false\ndefault_tools_approval_mode = "prompt"\n`;
}
await writeTextAtomic(codexConfigPath, codexConfig);

const portableSkills = await exportSkills({ homeRoot: homedir(), sourceRoot });
const skillRoots = [
  resolve(homedir(), ".codex/skills"),
  resolve(homedir(), ".claude/skills"),
  resolve(homedir(), ".gemini/config/skills"),
];
for (const [skillRoot, source] of [
  [skillRoots[0], codexDialogueSkillSource],
  [skillRoots[1], claudeDialogueSkillSource],
]) {
  const destination = resolve(skillRoot, "agent-dialogue");
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

console.log(`Installed runtime: ${runtimeRoot}`);
console.log(`Installed launchers: ${Object.keys(launchers).map((name) => resolve(binRoot, name)).join(", ")}`);
console.log(`Persistent state: ${stateRoot}`);
console.log(`Coordinator hooks: Claude Stop/SessionStart, Codex Stop/SessionStart, Antigravity AfterAgent/SessionStart`);
console.log(`Mission Control host hooks: native Claude, Codex, and Antigravity turn start/progress/stop events`);
console.log(`Claude wake channel: start Claude with ${resolve(binRoot, "claude-collab")} during the Channels research preview`);
console.log(`Installed skills: agent-dialogue, ${skillNames.join(", ")}`);
for (const [target, skills] of Object.entries(portableSkills.exports)) {
  for (const [name, result] of Object.entries(skills)) {
    if (!result.supported) console.log(`UNSUPPORTED: ${target}/${name}: ${result.unsupported.join("; ")}`);
  }
}

const supervisorRefresh = await refreshSupervisor({
  runtimeRoot,
  workspaceRoot: sourceRoot,
  stateDirectory: stateRoot,
  startIfMissing: false,
});
if (supervisorRefresh.running) {
  console.log(`Refreshed supervisor: ${supervisorRefresh.previous.supervisorId} -> ${supervisorRefresh.current.supervisorId}; ${supervisorRefresh.current.monitoredWorkers} worker(s) adopted`);
} else {
  console.log("Supervisor refresh: no running supervisor");
}

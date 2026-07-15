#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

for (const name of ["src", "scripts", "package.json", "package-lock.json"]) {
  await cp(resolve(sourceRoot, name), resolve(runtimeRoot, name), { recursive: true });
}

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: runtimeRoot,
  stdio: "inherit",
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
  exec "$NODE_BIN" "$RUNTIME/scripts/doctor.mjs"
elif [[ "$COMMAND" == "smoke" ]]; then
  exec "$NODE_BIN" "$RUNTIME/scripts/smoke-test.mjs"
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

const skillRoots = [
  resolve(homedir(), ".codex/skills"),
  resolve(homedir(), ".claude/skills"),
  resolve(homedir(), ".gemini/config/skills"),
];
for (const skillRoot of skillRoots) {
  await mkdir(skillRoot, { recursive: true, mode: 0o700 });
  for (const name of skillNames) {
    const destination = resolve(skillRoot, name);
    await rm(destination, { recursive: true, force: true });
    await cp(resolve(sourceRoot, "skills", name), destination, { recursive: true });
  }
}
for (const [skillRoot, source] of [
  [skillRoots[0], codexDialogueSkillSource],
  [skillRoots[1], claudeDialogueSkillSource],
]) {
  const destination = resolve(skillRoot, "agent-dialogue");
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

const antigravityCliSkills = resolve(homedir(), ".gemini/antigravity-cli/skills");
await mkdir(antigravityCliSkills, { recursive: true, mode: 0o700 });
for (const name of skillNames) {
  await cp(
    resolve(sourceRoot, "skills", name, "SKILL.md"),
    resolve(antigravityCliSkills, `${name}.md`),
  );
}

console.log(`Installed runtime: ${runtimeRoot}`);
console.log(`Installed launchers: ${Object.keys(launchers).map((name) => resolve(binRoot, name)).join(", ")}`);
console.log(`Persistent state: ${stateRoot}`);
console.log(`Installed skills: agent-dialogue, ${skillNames.join(", ")}`);

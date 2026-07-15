import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { GITHUB_LOGIN_PATTERN } from "../src/github-app-auth.mjs";

const root = resolve(import.meta.dirname, "..");
let failed = false;

function check(label, test, detail = "") {
  try {
    if (!test()) throw new Error(detail || "check failed");
    console.log(`OK   ${label}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}

check("Claude Code", () => {
  const claude = process.env.CLAUDE_BIN || resolve(homedir(), ".local/bin/claude");
  const result = spawnSync(claude, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}, "install or repair Claude Code, or set CLAUDE_BIN");

check("Codex app binary", () => {
  const codex = process.env.CODEX_BRIDGE_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = spawnSync(codex, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}, "ChatGPT/Codex app binary is unavailable; set CODEX_BRIDGE_CODEX_BIN");

check("Codex CLI", () => {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}, "install or repair @openai/codex on PATH");

check("Provider overload fallback policy", () => {
  const path = process.env.AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG
    || resolve(homedir(), ".config/local-agent-bridge/model-fallbacks.json");
  if (!existsSync(path)) return true;
  const info = statSync(path);
  const config = JSON.parse(readFileSync(path, "utf8"));
  const providers = Object.values(config.providers || {});
  return info.isFile()
    && (info.mode & 0o077) === 0
    && config.version === 1
    && providers.every((provider) => (
      Array.isArray(provider.fallbackModels)
      && provider.fallbackModels.length <= 5
      && provider.fallbackModels.every((model) => typeof model === "string" && model.trim())
    ));
}, "fix ~/.config/local-agent-bridge/model-fallbacks.json or remove it to disable machine fallback");

check("Antigravity CLI", () => {
  const agy = process.env.AGY_BIN || resolve(homedir(), ".local/bin/agy");
  const result = spawnSync(agy, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}, "install or repair Antigravity CLI, or set AGY_BIN");

check("Bridge dependencies", () => existsSync(resolve(root, "node_modules/@modelcontextprotocol/sdk")), "run npm install");
check("Playwright MCP", () => existsSync(resolve(root, "node_modules/@playwright/mcp/cli.js")), "run npm install");
check("Codex project config", () => existsSync(resolve(root, ".codex/config.toml")));
check("Claude project config", () => existsSync(resolve(root, ".mcp.json")));
check("Antigravity global MCP config", () => {
  const config = JSON.parse(readFileSync(resolve(homedir(), ".gemini/config/mcp_config.json"), "utf8"));
  return Boolean(config.mcpServers?.codex && config.mcpServers?.claude_code && config.mcpServers?.collaboration);
}, "register codex, claude_code, and collaboration in ~/.gemini/config/mcp_config.json");
check("Claude Desktop collaboration config", () => {
  const path = resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  return config.mcpServers?.collaboration?.command
    === resolve(homedir(), ".local/bin/agent-collaboration-mcp");
}, "point Claude Desktop collaboration at the stable global launcher");
check("Claude CLI user-scope bridge config", () => {
  const config = JSON.parse(readFileSync(resolve(homedir(), ".claude.json"), "utf8"));
  const expected = {
    codex: "agent-codex-mcp",
    antigravity: "agent-antigravity-mcp",
    collaboration: "agent-collaboration-mcp",
    playwright: "agent-playwright-mcp",
  };
  return Object.entries(expected).every(([name, executable]) => (
    config.mcpServers?.[name]?.command === resolve(homedir(), `.local/bin/${executable}`)
  ));
}, "register the bridge MCPs with `claude mcp add --scope user`");
check("Claude CLI collaboration status line", () => {
  const settings = JSON.parse(readFileSync(resolve(homedir(), ".claude/settings.json"), "utf8"));
  const launcher = resolve(homedir(), ".local/bin/agent-bridge-claude-statusline");
  accessSync(launcher, constants.X_OK);
  return settings.statusLine?.command === launcher
    && settings.statusLine?.refreshInterval <= 2;
}, "point Claude statusLine at agent-bridge-claude-statusline with refreshInterval 2");
function configuredGitHubEntry(selected) {
  const configPath = resolve(homedir(), ".config/local-agent-bridge/github-apps.json");
  if (!existsSync(configPath)) return false;
  if (!selected) return false;
  const keyPath = selected.privateKeyPath?.startsWith("~/")
    ? resolve(homedir(), selected.privateKeyPath.slice(2))
    : isAbsolute(selected.privateKeyPath || "")
      ? selected.privateKeyPath
      : resolve(dirname(configPath), selected.privateKeyPath || "");
  const info = statSync(keyPath);
  return /^\d+$/.test(String(selected.appId || ""))
    && GITHUB_LOGIN_PATTERN.test(selected.expectedLogin || "")
    && Object.keys(selected.installations || {}).length > 0
    && info.isFile()
    && (info.mode & 0o077) === 0;
}
function configuredGitHubRole(role) {
  const configPath = resolve(homedir(), ".config/local-agent-bridge/github-apps.json");
  if (!existsSync(configPath)) return false;
  return configuredGitHubEntry(JSON.parse(readFileSync(configPath, "utf8")).roles?.[role]);
}
function configuredGitHubReviewer(provider) {
  const configPath = resolve(homedir(), ".config/local-agent-bridge/github-apps.json");
  if (!existsSync(configPath)) return false;
  const roles = JSON.parse(readFileSync(configPath, "utf8")).roles || {};
  return configuredGitHubEntry(roles.reviewers?.[provider] || roles.reviewer);
}
check("GitHub builder App", () => configuredGitHubRole("builder"), "configure the builder role in ~/.config/local-agent-bridge/github-apps.json");
for (const provider of ["claude", "codex", "antigravity"]) {
  check(`GitHub ${provider} reviewer App`, () => configuredGitHubReviewer(provider), `configure roles.reviewers.${provider} in ~/.config/local-agent-bridge/github-apps.json`);
}
check("GitHub reviewer credential", () => {
  if (["claude", "codex", "antigravity"].every((provider) => configuredGitHubReviewer(provider))) return true;
  const configPath = resolve(homedir(), ".config/local-agent-bridge/github-apps.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.compatibility?.allowPatFallback === false) return false;
  }
  const tokenPath = resolve(homedir(), ".config/ghtoken");
  const info = statSync(tokenPath);
  return info.isFile() && (info.mode & 0o077) === 0 && readFileSync(tokenPath, "utf8").trim().length > 0;
}, "configure a reviewer GitHub App, or explicitly allow the mode-600 PAT compatibility fallback");
check("Codex user-scope bridge config", () => {
  const expected = {
    claude_code: "agent-claude-mcp",
    antigravity: "agent-antigravity-mcp",
    collaboration: "agent-collaboration-mcp",
    playwright: "agent-playwright-mcp",
  };
  return Object.entries(expected).every(([name, executable]) => {
    const result = spawnSync("codex", ["mcp", "get", name], {
      cwd: "/tmp",
      encoding: "utf8",
    });
    return result.status === 0
      && result.stdout.includes(resolve(homedir(), `.local/bin/${executable}`));
  });
}, "register the bridge MCPs in ~/.codex/config.toml with the stable global launchers");
check("Codex dialogue skill", () => existsSync(resolve(homedir(), ".codex/skills/agent-dialogue/SKILL.md")));
check("Claude dialogue skill", () => existsSync(resolve(homedir(), ".claude/skills/agent-dialogue/SKILL.md")));
check("Bridge launcher executable", () => {
  accessSync(resolve(root, "scripts/claude-bridge-mcp.sh"), constants.X_OK);
  return true;
});
check("Antigravity launcher executable", () => {
  accessSync(resolve(root, "scripts/antigravity-bridge-mcp.sh"), constants.X_OK);
  return true;
});
check("Collaboration launcher executable", () => {
  accessSync(resolve(root, "scripts/collaboration-bridge-mcp.sh"), constants.X_OK);
  return true;
});
check("Global collaboration launcher executable", () => {
  for (const name of ["claude", "codex", "antigravity", "collaboration", "playwright"]) {
    accessSync(resolve(homedir(), `.local/bin/agent-${name}-mcp`), constants.X_OK);
  }
  return existsSync(resolve(homedir(), ".local/share/agent-bridge/runtime/src/collaboration-bridge.mjs"));
});
check("Global bridge operations CLI", () => {
  const launcher = resolve(homedir(), ".local/bin/bridge");
  accessSync(launcher, constants.X_OK);
  const result = spawnSync(launcher, ["capabilities"], { encoding: "utf8" });
  const source = readFileSync(launcher, "utf8");
  return result.status === 0
    && result.stdout.includes('"claude"')
    && result.stdout.includes('"codex"')
    && source.includes("workflow-launcher.mjs")
    && source.includes("codex-turn-watchdog.mjs");
}, "run npm run install:global to install ~/.local/bin/bridge");
check("Global collaboration skills", () => {
  const names = readdirSync(resolve(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const roots = [
    resolve(homedir(), ".codex/skills"),
    resolve(homedir(), ".claude/skills"),
    resolve(homedir(), ".gemini/config/skills"),
  ];
  return roots.every((skillRoot) => names.every((name) => (
    existsSync(resolve(skillRoot, name, "SKILL.md"))
  ))) && names.every((name) => (
    existsSync(resolve(homedir(), `.gemini/antigravity-cli/skills/${name}.md`))
  ));
}, "run npm run install:global to install the bridge skills for all three products");
check("Browser launcher executable", () => {
  accessSync(resolve(root, "scripts/playwright-mcp.sh"), constants.X_OK);
  return true;
});

if (failed) process.exit(1);
console.log("\nRun `npm run smoke`, `npm run test:talk`, `npm run test:collaboration`, `npm run test:desktop`, `npm run test:skills`, and `npm run test:models` for model-free validation.");

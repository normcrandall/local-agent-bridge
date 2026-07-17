import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function environmentModel(names, environment) {
  for (const name of names) {
    const value = environment[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function topLevelTomlString(path, key) {
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|'([^']*)'|([^#\\s]+))`));
    if (!match) continue;
    if (match[1] !== undefined) {
      try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
    }
    return match[2] ?? match[3] ?? null;
  }
  return null;
}

export function loadConfiguredCodexModel({
  home = homedir(),
  environment = process.env,
} = {}) {
  const fromEnvironment = environmentModel(["CODEX_MODEL"], environment);
  if (fromEnvironment) return fromEnvironment;
  const codexHome = environment.CODEX_HOME || resolve(home, ".codex");
  return topLevelTomlString(resolve(codexHome, "config.toml"), "model");
}

export function loadConfiguredAntigravityModel({ environment = process.env } = {}) {
  return environmentModel(["AGY_MODEL", "ANTIGRAVITY_MODEL", "GEMINI_MODEL"], environment);
}

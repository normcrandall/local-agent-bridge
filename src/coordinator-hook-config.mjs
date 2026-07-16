import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export function addCommandHook(settings, event, command, { timeout = 5 } = {}) {
  const hooks = { ...(settings.hooks || {}) };
  const groups = [...(hooks[event] || [])];
  const exists = groups.some((group) => group.hooks?.some((hook) => hook.command === command));
  if (!exists) groups.push({ hooks: [{ type: "command", command, timeout }] });
  hooks[event] = groups;
  return { ...settings, hooks };
}

export function configuredCodexHookPath(config) {
  const firstTable = config.search(/^\[/m);
  const preamble = firstTable === -1 ? config : config.slice(0, firstTable);
  return preamble.match(/^hooks\s*=\s*(["'])(.*?)\1\s*$/m)?.[2] || null;
}

export function resolveCodexHookPath(configPath, configuredPath) {
  if (!configuredPath) return null;
  if (configuredPath.startsWith("~/")) return resolve(homedir(), configuredPath.slice(2));
  if (isAbsolute(configuredPath)) return configuredPath;
  return resolve(dirname(configPath), configuredPath);
}

export function ensureCodexHookConfiguration(config) {
  const firstTable = config.search(/^\[/m);
  const preambleEnd = firstTable === -1 ? config.length : firstTable;
  const preamble = config.slice(0, preambleEnd)
    .replace(/^hooks\s*=\s*(["']).*?\1\s*\n?/gm, "");
  let output = `${preamble}${config.slice(preambleEnd)}`;
  const featureHeader = /^\[features\]\s*$/m.exec(output);
  if (!featureHeader) return `${output.trimEnd()}\n\n[features]\nhooks = true\n`;
  const start = featureHeader.index + featureHeader[0].length;
  const nextTableOffset = output.slice(start).search(/^\[/m);
  const end = nextTableOffset === -1 ? output.length : start + nextTableOffset;
  const block = output.slice(start, end);
  const updated = /^[ \t]*hooks\s*=/m.test(block)
    ? block.replace(/^[ \t]*hooks\s*=.*$/m, "hooks = true")
    : `${block.trimEnd()}\nhooks = true\n\n`;
  return `${output.slice(0, start)}${updated}${output.slice(end)}`;
}

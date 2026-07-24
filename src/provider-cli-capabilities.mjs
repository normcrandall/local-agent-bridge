import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_CACHE = resolve(homedir(), ".cache/local-agent-bridge/provider-capabilities.json");
const CAPABILITY_SCHEMA_VERSION = 6;

function flags(help) {
  return new Set([...String(help || "").matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*)/gi)].map((match) => match[1]));
}

export function parseProviderHelp(provider, { version = "unknown", mainHelp = "", newHelp = "", resumeHelp = "" } = {}) {
  const main = flags(mainHelp);
  const fresh = flags(newHelp);
  const resume = flags(resumeHelp);
  if (provider === "codex") return {
    provider, version,
    newSession: {
      json: fresh.has("--json"), model: fresh.has("--model"), sandbox: fresh.has("--sandbox"),
      cd: fresh.has("--cd"), skipGitRepoCheck: fresh.has("--skip-git-repo-check"), config: fresh.has("--config"),
    },
    resume: {
      json: resume.has("--json"), model: resume.has("--model"), skipGitRepoCheck: resume.has("--skip-git-repo-check"), config: resume.has("--config"),
    },
  };
  if (provider === "claude") return {
    provider, version,
    print: main.has("--print") || /(?:^|\s)-p(?:,|\s)/.test(mainHelp),
    streamJson: main.has("--output-format"), model: main.has("--model"), fallbackModel: main.has("--fallback-model"),
    resume: main.has("--resume"), strictMcpConfig: main.has("--strict-mcp-config"), mcpConfig: main.has("--mcp-config"),
    verbose: main.has("--verbose"), allowedTools: main.has("--allowedTools") || main.has("--allowed-tools"),
    permissionMode: main.has("--permission-mode"), yolo: main.has("--dangerously-skip-permissions"),
    addDir: main.has("--add-dir"),
  };
  return {
    provider, version,
    print: main.has("--print"), printTimeout: main.has("--print-timeout"), mode: main.has("--mode"),
    logFile: main.has("--log-file"), addDir: main.has("--add-dir"),
    model: main.has("--model"), effort: main.has("--effort"), sandbox: main.has("--sandbox"),
    yolo: main.has("--dangerously-skip-permissions"),
    conversation: main.has("--conversation") || main.has("--conversation-id") || main.has("--continue"),
  };
}

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000 });
  return { ok: result.status === 0, output: `${result.stdout || ""}\n${result.stderr || ""}`.trim() };
}

export function probeProviderCapabilities({ provider, binary }) {
  if (!existsSync(binary)) throw new Error(`${provider} binary does not exist: ${binary}`);
  const versionResult = run(binary, ["--version"]);
  const version = versionResult.ok ? versionResult.output.split("\n")[0] : "unknown";
  let mainHelp = "";
  let newHelp = "";
  let resumeHelp = "";
  if (provider === "codex") {
    mainHelp = run(binary, ["--help"]).output;
    newHelp = run(binary, ["exec", "--help"]).output;
    resumeHelp = run(binary, ["exec", "resume", "--help"]).output;
  } else {
    mainHelp = run(binary, ["--help"]).output;
  }
  const parsed = {
    ...parseProviderHelp(provider, { version, mainHelp, newHelp, resumeHelp }),
    binary: resolve(binary), binaryName: basename(binary), source: "probe", probedAt: new Date().toISOString(),
  };
  if (provider !== "antigravity") return parsed;
  const modelsResult = run(binary, ["models"]);
  return {
    ...parsed,
    models: modelsResult.ok
      ? modelsResult.output.split("\n").map((entry) => entry.trim()).filter(Boolean)
      : [],
  };
}

function readCache(path) {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    return cache.version === CAPABILITY_SCHEMA_VERSION ? cache : { version: CAPABILITY_SCHEMA_VERSION, entries: {} };
  } catch { return { version: CAPABILITY_SCHEMA_VERSION, entries: {} }; }
}

function writeCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function acquireCacheLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const descriptor = openSync(lock, "wx", 0o600);
      return () => { closeSync(descriptor); try { unlinkSync(lock); } catch {} };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`Timed out acquiring provider capability cache lock: ${lock}`);
}

export function negotiateProviderCapabilities({ provider, binary, cachePath = DEFAULT_CACHE, useCache = true }) {
  if (!existsSync(binary)) throw new Error(`${provider} binary does not exist: ${binary}`);
  const info = statSync(binary);
  const versionResult = run(binary, ["--version"]);
  const version = versionResult.ok ? versionResult.output.split("\n")[0] : "unknown";
  const key = `${CAPABILITY_SCHEMA_VERSION}:${provider}:${resolve(binary)}:${info.size}:${Math.floor(info.mtimeMs)}:${version}`;
  const cache = readCache(cachePath);
  if (useCache && cache.entries?.[key]) return { ...cache.entries[key], source: "cache" };
  const result = probeProviderCapabilities({ provider, binary });
  const release = acquireCacheLock(cachePath);
  try {
    const latest = readCache(cachePath);
    latest.version = CAPABILITY_SCHEMA_VERSION;
    latest.entries = { ...(latest.entries || {}), [key]: result };
    writeCache(cachePath, latest);
  } finally { release(); }
  return result;
}

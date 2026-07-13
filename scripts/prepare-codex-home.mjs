#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(process.argv[2] || join(homedir(), ".codex"));
const destination = resolve(process.argv[3] || join(homedir(), ".local/share/agent-bridge/codex-home"));
const safeTopLevelKeys = new Set([
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_context_window",
  "model_auto_compact_token_limit",
  "service_tier",
  "personality",
]);

mkdirSync(destination, { recursive: true, mode: 0o700 });
const lock = join(destination, ".prepare-lock");
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 5_000;
while (true) {
  try {
    mkdirSync(lock, { mode: 0o700 });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - statSync(lock).mtimeMs > 30_000) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out preparing delegated Codex home: ${destination}`);
    Atomics.wait(waitArray, 0, 0, 25);
  }
}

try {
  const sourceConfig = join(source, "config.toml");
  const safeLines = [];
  if (existsSync(sourceConfig)) {
    for (const line of readFileSync(sourceConfig, "utf8").split("\n")) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (match && safeTopLevelKeys.has(match[1])) safeLines.push(line.trim());
    }
  }
  const config = join(destination, "config.toml");
  const configTemporary = `${config}.${process.pid}.tmp`;
  writeFileSync(configTemporary, `${safeLines.join("\n")}\n`, { mode: 0o600 });
  renameSync(configTemporary, config);

  const sourceAuth = join(source, "auth.json");
  const destinationAuth = join(destination, "auth.json");
  if (existsSync(sourceAuth)) {
    let destinationStat = null;
    try { destinationStat = lstatSync(destinationAuth); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const currentIsCorrect = destinationStat?.isSymbolicLink()
      && resolve(dirname(destinationAuth), readlinkSync(destinationAuth)) === resolve(sourceAuth);
    if (!currentIsCorrect) {
      if (destinationStat?.isFile()) {
        const rotatedAuth = readFileSync(destinationAuth, "utf8");
        try {
          JSON.parse(rotatedAuth);
        } catch (error) {
          throw new Error(`Delegated Codex credential file is corrupt: ${destinationAuth}. Remove that file and restart the bridge.`, { cause: error });
        }
        const sourceTemporary = `${sourceAuth}.${process.pid}.tmp`;
        writeFileSync(sourceTemporary, rotatedAuth, { mode: 0o600 });
        renameSync(sourceTemporary, sourceAuth);
      }
      const linkTemporary = `${destinationAuth}.${process.pid}.tmp`;
      rmSync(linkTemporary, { force: true });
      symlinkSync(sourceAuth, linkTemporary);
      renameSync(linkTemporary, destinationAuth);
    }
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}

process.stdout.write(`${destination}\n`);

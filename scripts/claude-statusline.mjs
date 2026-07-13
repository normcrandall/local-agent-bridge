#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function inputJson() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

function baseStatus(input) {
  const command = process.env.BRIDGE_BASE_STATUSLINE?.trim();
  if (!command) return "";
  try {
    return execFileSync("/bin/zsh", ["-lc", command], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    return "";
  }
}

function activeCollaboration(cwd) {
  const directory = resolve(
    process.env.BRIDGE_COLLABORATION_DIR || join(homedir(), ".local/share/agent-bridge/state"),
  );
  let names;
  try { names = readdirSync(directory); } catch { return null; }
  return names
    .filter((name) => /^bridge-[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => {
      try { return JSON.parse(readFileSync(join(directory, name), "utf8")); } catch { return null; }
    })
    .filter((state) => state && ["queued", "running", "indeterminate"].includes(state.status))
    .filter((state) => {
      const workspace = resolve(state.workspace || "/");
      const current = resolve(cwd || "/");
      return current === workspace || current.startsWith(`${workspace}/`) || workspace.startsWith(`${current}/`);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
}

function heartbeatLine(state) {
  if (!state) return "";
  const active = state.runtime?.activeCall;
  if (!active) return `↻ agents · ${state.status} · ${state.id}`;
  const heartbeatAge = active.heartbeatAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(active.heartbeatAt)) / 1000))
    : null;
  const agent = active.agent || "agent";
  const phase = active.phase || active.status || "working";
  const age = heartbeatAge === null ? "heartbeat unknown" : `heartbeat ${heartbeatAge}s`;
  const summary = (active.summary || "No new agent summary").replace(/\s+/g, " ").slice(0, 120);
  const liveness = active.livenessMessage
    ? ` · ${active.livenessMessage.replace(/\s+/g, " ").slice(0, 80)}`
    : "";
  return `↻ ${agent} · ${phase} · ${age}${liveness} · ${summary} · ${state.id}`;
}

const input = inputJson();
const lines = [
  baseStatus(input),
  heartbeatLine(activeCollaboration(input.workspace?.current_dir || input.cwd)),
].filter(Boolean);
if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);

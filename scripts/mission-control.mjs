#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  clearRepositoryCache,
  loadMissionControlSnapshot,
  loadTimeline,
  navigationIntent,
  renderMissionControl,
  renderSnapshot,
} from "../src/mission-control.mjs";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

function usage() {
  process.stdout.write(`Usage: bridge mission-control [options]\n\n`);
  process.stdout.write(`Aliases: bridge mc\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --snapshot          Print one human-readable snapshot and exit\n`);
  process.stdout.write(`  --json              Print one JSON snapshot and exit\n`);
  process.stdout.write(`  --attention         Show current attention items\n`);
  process.stdout.write(`  --all               Show active terminal history\n`);
  process.stdout.write(`  --include-stale     Include stale attention and portfolio items\n`);
  process.stdout.write(`  --stale-after-hours N  Collapse attention items older than N hours (default: 24)\n`);
  process.stdout.write(`  --repo OWNER/REPO   Filter to one repository\n`);
  process.stdout.write(`  --refresh-ms N      Interactive refresh interval (default: 1000)\n`);
  process.stdout.write(`  --state-root PATH   Read a different bridge state directory\n`);
  process.stdout.write(`  --no-color          Disable ANSI colors\n`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const stateRoot = resolve(value("--state-root", process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state")));
const repositoryFilter = value("--repo");
const refreshMs = Math.max(250, Number.parseInt(value("--refresh-ms", "1000"), 10) || 1000);
let view = args.includes("--all") ? "all" : args.includes("--attention") ? "attention" : "live";
let includeStale = args.includes("--include-stale");
const staleAfterHours = Math.max(1, Number.parseInt(value("--stale-after-hours", "24"), 10) || 24);
const color = !args.includes("--no-color") && process.env.NO_COLOR === undefined;
const oneShot = args.includes("--snapshot") || args.includes("--json") || !process.stdin.isTTY || !process.stdout.isTTY;

async function snapshot() {
  return loadMissionControlSnapshot({
    stateRoot,
    view,
    includeStale,
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
    repositoryFilter,
  });
}

if (oneShot) {
  const current = await snapshot();
  let output;
  if (args.includes("--json")) {
    output = `${JSON.stringify(current, null, 2)}\n`;
  } else {
    const selected = current.lanes[0];
    const timeline = selected ? await loadTimeline(stateRoot, selected.id) : [];
    const parsedWidth = Number.parseInt(process.env.COLUMNS || "120", 10);
    output = `${renderSnapshot(current, {
      selectedIndex: 0,
      timeline,
      width: Number.isFinite(parsedWidth) ? parsedWidth : 120,
    })}\n`;
  }
  await new Promise((resolveWrite) => process.stdout.write(output, resolveWrite));
  process.exit(0);
}

let selectedIndex = 0;
let selectedId = null;
let drawing = false;
let stopped = false;
let timer = null;

function restore() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

async function draw() {
  if (drawing || stopped) return;
  drawing = true;
  try {
    const current = await snapshot();
    if (selectedId) {
      const preserved = current.lanes.findIndex((lane) => lane.id === selectedId);
      if (preserved >= 0) selectedIndex = preserved;
    }
    selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, current.lanes.length - 1));
    selectedId = current.lanes[selectedIndex]?.id || null;
    const timeline = selectedId ? await loadTimeline(stateRoot, selectedId) : [];
    const output = renderMissionControl(current, {
      selectedIndex,
      timeline,
      width: process.stdout.columns || 120,
      height: process.stdout.rows || 40,
      color,
      interactive: true,
    });
    process.stdout.write(`\x1b[H\x1b[2J${output}`);
  } catch (error) {
    process.stdout.write(`\x1b[H\x1b[2JMission Control refresh failed: ${error.message}\nPress r to retry or q to quit.`);
  } finally {
    drawing = false;
  }
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (key) => {
  if (key === "q" || key === "\u0003") {
    restore();
    process.exit(0);
  }
  if (["l", "a", "h"].includes(key)) {
    view = key === "l" ? "live" : key === "a" ? "attention" : "all";
    selectedIndex = 0;
    selectedId = null;
  }
  else if (key === "s") { includeStale = !includeStale; selectedIndex = 0; selectedId = null; }
  else if (key === "r") clearRepositoryCache();
  else {
    const intent = navigationIntent(key, selectedIndex);
    selectedIndex = intent.selectedIndex;
    if (!intent.preserveSelectedId) selectedId = null;
  }
  await draw();
});
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("exit", restore);
process.stdout.on("resize", draw);

timer = setInterval(draw, refreshMs);
timer.unref();
await draw();
await new Promise(() => {});

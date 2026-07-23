#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  loadMissionControlSnapshot,
  loadTimeline,
  renderMissionControl,
  renderSnapshot,
} from "../src/mission-control.mjs";

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
  process.stdout.write(`  --all               Include terminal collaboration history\n`);
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
let showAll = args.includes("--all");
const color = !args.includes("--no-color") && process.env.NO_COLOR === undefined;
const oneShot = args.includes("--snapshot") || args.includes("--json") || !process.stdin.isTTY || !process.stdout.isTTY;

async function snapshot() {
  return loadMissionControlSnapshot({ stateRoot, showAll, repositoryFilter });
}

if (oneShot) {
  const current = await snapshot();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  } else {
    const selected = current.lanes[0];
    const timeline = selected ? await loadTimeline(stateRoot, selected.id) : [];
    process.stdout.write(`${renderSnapshot(current, {
      selectedIndex: 0,
      timeline,
      width: Number.parseInt(process.env.COLUMNS || "120", 10),
    })}\n`);
  }
  process.exit(0);
}

let selectedIndex = 0;
let selectedId = null;
let drawing = false;
let stopped = false;

function restore() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
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
  if (key === "j" || key === "\x1b[B") selectedIndex += 1;
  else if (key === "k" || key === "\x1b[A") selectedIndex -= 1;
  else if (key === "g") selectedIndex = 0;
  else if (key === "G") selectedIndex = Number.MAX_SAFE_INTEGER;
  else if (key === "a") { showAll = !showAll; selectedIndex = 0; selectedId = null; }
  await draw();
});
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("exit", restore);
process.stdout.on("resize", draw);

const timer = setInterval(draw, refreshMs);
timer.unref();
await draw();
await new Promise(() => {});

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { findCodexTrace, inspectTrace } from "../src/codex-turn-watchdog.mjs";

const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

const thread = value("--thread", "latest");
const thresholdSeconds = Number(value("--threshold-seconds", "60"));
const intervalSeconds = Math.max(2, Number(value("--interval-seconds", "5")));
const watch = args.includes("--watch");
const notify = args.includes("--notify");
const trace = findCodexTrace({ thread });
let previous = null;

function report() {
  const state = inspectTrace(trace, { thresholdMs: thresholdSeconds * 1000 });
  const signature = `${state.status}:${state.phase}:${state.firstOutputAt || ""}`;
  if (signature !== previous) {
    process.stdout.write(`${JSON.stringify(state)}\n`);
    if (notify && state.status === "silent") {
      spawnSync("osascript", ["-e", `display notification "No first model output after ${Math.floor(state.elapsedMs / 1000)}s" with title "Codex turn is silent"`]);
    }
    previous = signature;
  }
  return state;
}

const initial = report();
if (!watch || ["completed", "aborted"].includes(initial.status)) process.exit(initial.status === "silent" ? 2 : 0);
const timer = setInterval(() => {
  const state = report();
  if (["completed", "aborted"].includes(state.status)) {
    clearInterval(timer);
    process.exit(0);
  }
}, intervalSeconds * 1000);

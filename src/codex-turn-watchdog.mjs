import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const START_EVENTS = new Set(["task_started", "turn_started"]);
const COMPLETE_EVENTS = new Set(["task_complete", "turn_complete"]);
const ABORT_EVENTS = new Set(["task_aborted", "turn_aborted", "turn_cancelled"]);

function eventKind(event) {
  return event?.payload?.type || event?.type || null;
}

function isAssistantOutput(event) {
  if (event?.type !== "response_item") return false;
  const payload = event.payload || {};
  return payload.type === "message" && payload.role === "assistant"
    || payload.type === "function_call"
    || payload.type === "tool_call";
}

export function inspectTurnSilence(events, { now = Date.now(), thresholdMs = 60_000 } = {}) {
  let startIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (START_EVENTS.has(eventKind(events[index]))) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return { status: "idle", phase: "no-active-turn", elapsedMs: 0, startedAt: null, firstOutputAt: null };

  const started = events[startIndex];
  const startedAt = started.timestamp || started.payload?.timestamp || null;
  const startedMs = Date.parse(startedAt);
  const tail = events.slice(startIndex + 1);
  const terminal = tail.find((event) => COMPLETE_EVENTS.has(eventKind(event)) || ABORT_EVENTS.has(eventKind(event)));
  if (terminal) {
    const kind = eventKind(terminal);
    return {
      status: COMPLETE_EVENTS.has(kind) ? "completed" : "aborted",
      phase: "terminal",
      elapsedMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0,
      startedAt,
      firstOutputAt: tail.find(isAssistantOutput)?.timestamp || null,
      terminalAt: terminal.timestamp || null,
    };
  }

  const firstOutput = tail.find(isAssistantOutput);
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
  if (firstOutput) {
    return {
      status: "responsive",
      phase: "model-output-observed",
      elapsedMs,
      startedAt,
      firstOutputAt: firstOutput.timestamp || null,
    };
  }
  return {
    status: elapsedMs >= thresholdMs ? "silent" : "pending",
    phase: "pre-first-output",
    elapsedMs,
    startedAt,
    firstOutputAt: null,
  };
}

function visitJsonl(directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visitJsonl(path, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
  }
}

export function findCodexTrace({ thread = "latest", sessionsRoot = resolve(homedir(), ".codex/sessions") } = {}) {
  const files = [];
  visitJsonl(sessionsRoot, files);
  const candidates = thread === "latest"
    ? files
    : files.filter((path) => path.includes(thread));
  if (!candidates.length) throw new Error(`No Codex trace found for ${thread}.`);
  return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

export function readTrace(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function inspectTrace(path, options = {}) {
  return { trace: path, ...inspectTurnSilence(readTrace(path), options) };
}

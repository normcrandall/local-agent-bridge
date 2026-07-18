// Issue #55 fixture: reap a cancelled worker's descendant tree (shell -> npm -> node)
// via ps-based PPID discovery, process-group + descendant SIGTERM, bounded grace, then
// SIGKILL. Covers a deterministic injected run and a real spawned tree.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  discoverDescendants,
  readProcessTable,
  reapProcessTree,
} from "../src/process-reaper.mjs";

// --- ps table parsing -------------------------------------------------------
assert.deepEqual(
  readProcessTable(() => "  100  1 \n 200 100\nheader junk\n300 200\n"),
  [{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 300, ppid: 200 }],
);

// --- PPID discovery: shell(100) -> npm(200) -> node(300), 999 unrelated -----
const table = [
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 200 },
  { pid: 999, ppid: 1 },
];
assert.deepEqual(discoverDescendants(100, table), [200, 300]);
assert.deepEqual(discoverDescendants(1, table), []);

// --- Deterministic reap with SIGKILL escalation -----------------------------
// Model processes that ignore SIGTERM: only a positive-pid SIGKILL clears liveness.
{
  const alive = new Map([[100, true], [200, true], [300, true]]);
  const events = [];
  const kill = (target, signal) => {
    events.push([target, signal]);
    if (signal === 0) {
      if (!alive.get(target)) { const error = new Error("no such process"); error.code = "ESRCH"; throw error; }
      return;
    }
    if (signal === "SIGKILL" && target > 0) alive.set(target, false);
  };
  const result = await reapProcessTree(100, {
    graceMs: 60,
    pollMs: 20,
    ps: () => "100 1\n200 100\n300 200\n999 1\n",
    kill,
    sleep: async () => {},
  });
  assert.deepEqual(result.descendants, [200, 300]);
  // SIGTERM went to the process group and to every descendant, before any SIGKILL.
  assert.ok(events.some(([t, s]) => t === -100 && s === "SIGTERM"));
  assert.ok(events.some(([t, s]) => t === 200 && s === "SIGTERM"));
  assert.ok(events.some(([t, s]) => t === 300 && s === "SIGTERM"));
  const firstKill = events.findIndex(([, s]) => s === "SIGKILL");
  const lastTerm = events.map(([, s]) => s).lastIndexOf("SIGTERM");
  assert.ok(firstKill > lastTerm, "SIGKILL escalates only after SIGTERM grace");
  assert.equal(result.escalated, true);
  assert.ok(result.killed.includes(200) && result.killed.includes(300));
}

// --- Happy path: processes exit on SIGTERM, no SIGKILL ----------------------
{
  const alive = new Map([[100, true], [200, true]]);
  const kill = (target, signal) => {
    if (signal === 0) {
      if (!alive.get(target)) { const error = new Error("gone"); error.code = "ESRCH"; throw error; }
      return;
    }
    if (signal === "SIGTERM") { alive.set(100, false); alive.set(200, false); }
  };
  const result = await reapProcessTree(100, {
    graceMs: 100,
    pollMs: 20,
    ps: () => "100 1\n200 100\n",
    kill,
    sleep: async () => {},
  });
  assert.equal(result.escalated, false);
  assert.deepEqual(result.killed, []);
}

// --- Real spawned tree: leader -> child, both ignoring SIGTERM --------------
// Emulates shell -> npm -> node: a detached group leader that spawns a grandchild.
// Both trap SIGTERM, so the reaper must escalate to SIGKILL to actually clear them.
{
  const childProgram = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const leaderProgram = `process.on("SIGTERM", () => {});
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "ignore" });
setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ["-e", leaderProgram], { detached: true, stdio: "ignore" });
  leader.unref();
  const leaderPid = leader.pid;
  const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  try {
    // Wait for the grandchild to appear in the process table.
    let descendants = [];
    for (let attempt = 0; attempt < 40 && descendants.length === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      descendants = discoverDescendants(leaderPid, readProcessTable());
    }
    assert.ok(descendants.length >= 1, "spawned grandchild should be discovered via ps");

    const result = await reapProcessTree(leaderPid, { graceMs: 300, pollMs: 50 });
    assert.equal(result.escalated, true, "SIGTERM-ignoring tree must be SIGKILLed");

    // Give the OS a moment to deliver SIGKILL, then confirm the tree is gone.
    let allDead = false;
    for (let attempt = 0; attempt < 40 && !allDead; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      allDead = !isAlive(leaderPid) && descendants.every((pid) => !isAlive(pid));
    }
    assert.ok(allDead, "the whole spawned tree must be dead after reaping");
  } finally {
    try { process.kill(-leaderPid, "SIGKILL"); } catch { /* already reaped */ }
  }
}

console.log("Issue #55 descendant reaping tests passed.");

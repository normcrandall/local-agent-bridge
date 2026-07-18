// Issue #55: reap a cancelled worker's descendant tree. The detached worker is a
// process-group leader, but the provider MCP stdio children inherit the group only
// loosely, and grandchildren (shell -> npm -> node) can survive a single group
// SIGTERM. We therefore discover descendants by ps-based PPID walk, signal the
// process group *and* every discovered descendant, wait a bounded grace, then SIGKILL
// survivors. No new dependency: discovery uses /bin/ps, signalling uses process.kill.

import { spawnSync } from "node:child_process";

// Default ps reader: one snapshot of every pid/ppid on the machine (BSD/macOS + Linux
// both accept `-A -o pid=,ppid=`). Returns rows of { pid, ppid }.
export function readProcessTable(ps = () => spawnSync("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" }).stdout || "") {
  const raw = ps();
  const rows = [];
  for (const line of String(raw).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    rows.push({ pid: Number.parseInt(match[1], 10), ppid: Number.parseInt(match[2], 10) });
  }
  return rows;
}

// Breadth-first walk of the PPID graph from `rootPid`, excluding the root itself.
// Guards against cycles and never returns pids <= 1.
export function discoverDescendants(rootPid, table) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const childrenByParent = new Map();
  for (const { pid, ppid } of table) {
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(pid);
  }
  const descendants = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of childrenByParent.get(parent) || []) {
      if (seen.has(child) || child <= 1) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// Reap the worker process group and its descendants. Deterministic ordering:
//   1. SIGTERM the process group (-rootPid) and each discovered descendant.
//   2. Wait up to graceMs, re-checking liveness on a short interval.
//   3. SIGKILL the process group and any descendant still alive.
// `kill`, `ps`, and `sleep` are injectable for deterministic tests.
export async function reapProcessTree(rootPid, {
  graceMs = 2_000,
  pollMs = 50,
  kill = (target, signal) => process.kill(target, signal),
  ps,
  sleep = wait,
} = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return { rootPid, descendants: [], signalled: [], killed: [], escalated: false };
  }
  const table = ps ? readProcessTable(ps) : readProcessTable();
  const descendants = discoverDescendants(rootPid, table);

  const alive = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  const signal = (target, sig) => {
    try {
      kill(target, sig);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  };

  const signalled = [];
  // Process group first (negative pid), then every descendant leaf-first coverage.
  if (signal(-rootPid, "SIGTERM")) signalled.push(-rootPid);
  for (const pid of descendants) {
    if (signal(pid, "SIGTERM")) signalled.push(pid);
  }

  const deadline = graceMs;
  let waited = 0;
  const survivors = () => descendants.filter((pid) => alive(pid)).concat(alive(rootPid) ? [rootPid] : []);
  while (waited < deadline && survivors().length) {
    await sleep(pollMs);
    waited += pollMs;
  }

  const killed = [];
  const remaining = survivors();
  if (remaining.length) {
    if (signal(-rootPid, "SIGKILL")) killed.push(-rootPid);
    for (const pid of descendants) {
      if (alive(pid) && signal(pid, "SIGKILL")) killed.push(pid);
    }
  }
  return { rootPid, descendants, signalled, killed, escalated: killed.length > 0 };
}

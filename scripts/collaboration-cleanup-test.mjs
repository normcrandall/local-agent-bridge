import assert from "node:assert/strict";
import { clearTerminalRuntime, legacyWorkerCommandMatches, reconciliationAction, workerCancellationMatches, workerCommandMatches } from "../src/collaboration-cleanup.mjs";

for (const status of ["agreed", "cancelled", "failed", "turn_limit", "budget", "needs_user"]) {
  const state = clearTerminalRuntime({ status: "running", workerPid: 99, workerOwner: { id: "bridge-x", pid: 99 }, runtime: { activeCall: { agent: "codex" } } }, { status });
  assert.equal(state.runtime.activeCall, null, status);
  assert.equal(state.workerPid, null, status);
}
const indeterminate = clearTerminalRuntime({ status: "indeterminate", workerPid: 99, runtime: { activeCall: { status: "indeterminate" } } });
assert.equal(indeterminate.runtime.activeCall.status, "indeterminate");
assert.equal(reconciliationAction({ status: "running" }, { processAlive: false, commandMatches: false }), "mark-indeterminate");
assert.equal(reconciliationAction({ status: "running" }, { processAlive: true, commandMatches: false }), "retain-indeterminate-owner-mismatch");
assert.equal(reconciliationAction({ status: "recovering" }, { processAlive: false, commandMatches: false }), "none");
assert.equal(workerCommandMatches({ id: "bridge-1", workerPid: 12, workerOwner: { id: "bridge-1", pid: 12 } }, () => "node collaboration-worker.mjs bridge-1"), true);
assert.equal(workerCommandMatches({ id: "bridge-1", workerPid: 12, workerOwner: { id: "bridge-1", pid: 12 } }, () => "node unrelated.mjs"), false);
assert.equal(legacyWorkerCommandMatches({ id: "bridge-1", workerPid: 12 }, () => "node collaboration-worker.mjs bridge-1"), true);
assert.equal(workerCancellationMatches({ id: "bridge-1", workerPid: 12 }, () => "node collaboration-worker.mjs bridge-1"), true);
assert.equal(workerCancellationMatches({ id: "bridge-1", workerPid: 12 }, () => "node unrelated.mjs"), false);

console.log("Collaboration terminal cleanup and ownership tests passed.");

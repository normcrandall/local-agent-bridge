import { processProbe } from "./process-identity-probe.mjs";

export const TERMINAL_COLLABORATION_STATUSES = new Set([
  "agreed", "needs_user", "turn_limit", "failed", "cancelled", "budget",
]);

export const LIVE_COLLABORATION_STATUSES = new Set([
  "queued", "running", "recovering", "cancelling",
]);

export function clearTerminalRuntime(state, { status = state.status, error = state.error || null, at = new Date().toISOString() } = {}) {
  const terminal = TERMINAL_COLLABORATION_STATUSES.has(status);
  const activeCall = state.runtime?.activeCall || null;
  return {
    ...state,
    status,
    error,
    workerPid: terminal ? null : state.workerPid,
    workerOwner: terminal ? null : state.workerOwner,
    runtime: terminal ? {
      ...(state.runtime || {}),
      // Mission Control must retain the provider/model and last meaningful
      // activity after the live call is cleared. This is operational metadata,
      // not provider memory or hidden reasoning.
      lastCall: activeCall ? {
        agent: activeCall.agent || null,
        model: activeCall.model || activeCall.selectedModel || null,
        role: activeCall.role || (state.writer ? "writer" : "reviewer"),
        phase: activeCall.phase || activeCall.status || null,
        summary: activeCall.summary || null,
        summaryAt: activeCall.summaryAt || activeCall.heartbeatAt || at,
        summarySource: activeCall.summarySource || null,
        activity: activeCall.activity || null,
      } : state.runtime?.lastCall || null,
      activeCall: null,
    } : state.runtime,
    cleanup: terminal ? {
      ...(state.cleanup || {}), terminalAt: at, activeCallCleared: true,
      workspaceLeaseReleased: Boolean(state.cleanup?.workspaceLeaseReleased),
      workerLeaseReleased: Boolean(state.cleanup?.workerLeaseReleased),
      providerClosed: Boolean(state.cleanup?.providerClosed),
    } : state.cleanup,
  };
}

export function workerCommandMatches(state, ps = (pid) => processProbe(pid, "command").value || "") {
  const owner = state.workerOwner;
  if (!owner || owner.id !== state.id || owner.pid !== state.workerPid || !Number.isInteger(owner.pid) || owner.pid <= 1) return false;
  const command = ps(owner.pid) || "";
  return command.includes("collaboration-worker.mjs") && command.includes(state.id);
}

export function legacyWorkerCommandMatches(state, ps = (pid) => processProbe(pid, "command").value || "") {
  if (!Number.isInteger(state.workerPid) || state.workerPid <= 1) return false;
  const command = ps(state.workerPid) || "";
  return command.includes("collaboration-worker.mjs") && command.includes(state.id);
}

export function workerCancellationMatches(state, ps) {
  return state.workerOwner ? workerCommandMatches(state, ps) : legacyWorkerCommandMatches(state, ps);
}

export function reconciliationAction(state, { processAlive, commandMatches }) {
  if (TERMINAL_COLLABORATION_STATUSES.has(state.status)) {
    return state.runtime?.activeCall || state.workerPid || state.workerOwner ? "clear-terminal-metadata" : "none";
  }
  if (["queued", "running", "cancelling"].includes(state.status) && !processAlive) return "mark-indeterminate";
  if (["queued", "running", "cancelling"].includes(state.status) && processAlive && !commandMatches) return "retain-indeterminate-owner-mismatch";
  if (state.status === "recovering") return "none";
  return "none";
}

const SUCCESSFUL_STATUSES = new Set([
  "approved", "closed", "complete", "completed", "done", "merged", "superseded",
]);

const COORDINATOR_ACTIONS = new Set([
  "chair_verify", "peer_review", "provider_work", "writer_fix", "continue",
  "inspect", "inspect_recovery", "merge", "merge_ready", "requeue", "retry",
  "requeue_or_cancel", "start_collaboration",
]);

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}
function lifecycle(state) {
  return clean(state.lifecycle?.phase || state.lifecyclePhase || state.status || state.phase || "unknown");
}

function portfolioStatus(state) {
  return clean(state.portfolio?.status);
}

function pendingWake(state) {
  const wake = state.coordinatorWake;
  return wake && ["pending", "delivered"].includes(clean(wake.status)) ? wake : null;
}

function hasSuccessfulOutcome(state) {
  return state.archived === true
    || SUCCESSFUL_STATUSES.has(lifecycle(state))
    || SUCCESSFUL_STATUSES.has(portfolioStatus(state))
    || Boolean(state.github?.mergedAt || state.github?.mergeCommitSha || state.mergeCommitSha);
}

function providerStillOwnsExecution(state) {
  return Boolean(state.runtime?.activeCall)
    || state.recovery?.processAlive === true
    || state.hostActivity?.processAlive === true;
}

/**
 * True only for a stopped, current boundary that agents cannot resolve without
 * human authority. This is the canonical policy for Mission Control counts and
 * user-facing notifications.
 */
export function requiresHumanAttention(state) {
  if (!state || hasSuccessfulOutcome(state) || providerStillOwnsExecution(state)) return false;
  const wake = pendingWake(state);
  const status = lifecycle(state);
  if (status === "needs_user") {
    return Boolean(wake && (clean(wake.kind) === "needs_user" || clean(wake.nextAction) === "needs_user"));
  }
  if (status === "indeterminate") {
    // Indeterminate execution is a protected ownership boundary. A wake is
    // created by the coordinator when one exists, but older persisted records
    // without that metadata must remain visible and actionable too.
    return !state.coordinatorWake || Boolean(wake);
  }
  return false;
}

/** True when the chair/provider can advance the lane without human authority. */
export function requiresCoordinatorAction(state) {
  if (!state || requiresHumanAttention(state) || hasSuccessfulOutcome(state)) return false;
  const wake = pendingWake(state);
  if (wake && (wake.actionable === true || COORDINATOR_ACTIONS.has(clean(wake.nextAction)))) return true;
  const handoff = state.handoff || state.completion;
  return handoff?.acknowledged === false
    && COORDINATOR_ACTIONS.has(clean(handoff.nextAction));
}

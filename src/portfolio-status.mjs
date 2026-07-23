export const PORTFOLIO_STATUS_GROUPS = Object.freeze({
  ready: Object.freeze(["ready"]),
  active: Object.freeze(["claimed", "planning", "implementing", "verifying", "reviewing", "repairing"]),
  integration: Object.freeze(["ready_to_merge", "integrating", "arbitrating"]),
  paused: Object.freeze(["blocked", "needs_user", "indeterminate", "failed"]),
  terminal: Object.freeze(["merged", "completed", "obsolete"]),
});

export const PORTFOLIO_STATUSES = Object.freeze(Object.values(PORTFOLIO_STATUS_GROUPS).flat());

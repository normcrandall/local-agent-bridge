const TERMINAL = new Set(["agreed", "completed", "merged", "needs_user", "failed", "cancelled", "budget", "turn_limit", "obsolete"]);

export function resolveMissionControlSelection(lanes, selectedId, selectedIndex) {
  if (!Array.isArray(lanes) || lanes.length === 0) return null;
  const byId = selectedId ? lanes.find((lane) => lane.id === selectedId) : null;
  if (byId) return byId;
  const index = Math.min(Math.max(0, Number.isFinite(selectedIndex) ? selectedIndex : 0), lanes.length - 1);
  return lanes[index] || null;
}

export function missionControlConfirmation(pending, { key, lane, now = Date.now(), ttlMs = 5_000 }) {
  if (!lane) return { confirmed: false, pending: null, lane: null };
  if (pending?.key === key && pending?.lane?.id === lane.id && pending.expiresAt >= now) {
    return { confirmed: true, pending: null, lane: pending.lane };
  }
  return {
    confirmed: false,
    pending: { key, lane: structuredClone(lane), expiresAt: now + ttlMs },
    lane,
  };
}

export function missionControlActionAvailability(lane) {
  if (!lane) return { openPr: false, copy: false, continue: false, cancel: false, archive: false, acknowledgeWake: false };
  const collaboration = lane.type === "collaboration";
  return {
    openPr: Boolean(lane.repository && lane.prNumber),
    copy: true,
    continue: collaboration && TERMINAL.has(lane.lifecyclePhase) && lane.lifecyclePhase !== "indeterminate"
      && lane.handoff?.acknowledged !== false
      && !(lane.coordinatorWake?.actionable && lane.coordinatorWake.status !== "acknowledged"),
    cancel: collaboration && ["queued", "running", "recovering", "cancelling"].includes(lane.lifecyclePhase),
    archive: collaboration && TERMINAL.has(lane.lifecyclePhase) && lane.lifecyclePhase !== "indeterminate",
    acknowledgeWake: collaboration && Boolean(lane.coordinatorWake?.sequence && lane.coordinatorWake.status !== "acknowledged"),
  };
}

export function missionControlPrUrl(lane) {
  if (!missionControlActionAvailability(lane).openPr) return null;
  return `https://github.com/${lane.repository}/pull/${lane.prNumber}`;
}

export function missionControlCopyText(lane) {
  if (!lane) return "";
  return [lane.alias, lane.id, lane.repository, lane.prNumber ? `PR #${lane.prNumber}` : null].filter(Boolean).join("\t");
}

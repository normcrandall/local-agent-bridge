const TERMINAL = new Set(["agreed", "completed", "merged", "failed", "cancelled", "budget", "turn_limit", "obsolete"]);

export const MISSION_CONTROL_PANE_IDS = Object.freeze(["repositories", "work", "details"]);

function normalizePaneWeights(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const bounded = values.map((value) => Math.min(0.7, Math.max(0.15, value / total)));
  const boundedTotal = bounded.reduce((sum, value) => sum + value, 0);
  if (Math.abs(boundedTotal - 1) <= Number.EPSILON) return bounded;
  if (boundedTotal > 1) {
    const excess = boundedTotal - 1;
    const capacity = bounded.map((value) => value - 0.15);
    const available = capacity.reduce((sum, value) => sum + value, 0);
    return bounded.map((value, index) => value - excess * (capacity[index] / available));
  }
  const deficit = 1 - boundedTotal;
  const capacity = bounded.map((value) => 0.7 - value);
  const available = capacity.reduce((sum, value) => sum + value, 0);
  return bounded.map((value, index) => value + deficit * (capacity[index] / available));
}

export function createMissionControlPaneLayout(value = {}) {
  const rawWeights = Array.isArray(value.weights) && value.weights.length === 3
    ? value.weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 1)
    : [18, 28, 54];
  const normalized = normalizePaneWeights(rawWeights);
  const zoomedPane = Number.isInteger(value.zoomedPane) && value.zoomedPane >= 0 && value.zoomedPane < 3
    ? value.zoomedPane
    : null;
  let detached = [...new Set((Array.isArray(value.detached) ? value.detached : [])
    .filter((pane) => Number.isInteger(pane) && pane >= 0 && pane < 3))];
  // A persisted or caller-supplied corrupt layout must never produce an empty
  // console. Keep the most recently listed pane visible as a safe fallback.
  if (detached.length === MISSION_CONTROL_PANE_IDS.length) detached = detached.slice(0, -1);
  return { split: value.split !== false, weights: normalized, zoomedPane, detached };
}

export function missionControlVisiblePanes(layout, activePane = 1) {
  const current = createMissionControlPaneLayout(layout);
  const pane = Math.min(2, Math.max(0, Number.isInteger(activePane) ? activePane : 1));
  const attached = [0, 1, 2].filter((candidate) => !current.detached.includes(candidate));
  if (current.zoomedPane != null && attached.includes(current.zoomedPane)) return [current.zoomedPane];
  return attached.length ? attached : [pane];
}

export function missionControlPaneFocusIntent(layout, key, activePane) {
  const visible = missionControlVisiblePanes(layout, activePane);
  const current = visible.includes(activePane) ? activePane : visible[0];
  if (!["\t", "\x1b[C", "\x1b[Z", "\x1b[D"].includes(key) || visible.length === 1) return current;
  const direction = key === "\t" || key === "\x1b[C" ? 1 : -1;
  return visible[(visible.indexOf(current) + direction + visible.length) % visible.length];
}

/** Pure keyboard transition for the interactive pane layout. */
export function missionControlPaneLayoutIntent(layout, key, activePane) {
  const current = createMissionControlPaneLayout(layout);
  const pane = Math.min(2, Math.max(0, Number.isInteger(activePane) ? activePane : 1));
  if (key === "\\") return { ...current, split: !current.split, zoomedPane: null };
  if (key === "z") return { ...current, zoomedPane: current.zoomedPane === pane ? null : pane };
  if (key === "d" || key === "D") {
    const attached = [0, 1, 2].filter((candidate) => !current.detached.includes(candidate));
    const detached = current.detached.includes(pane)
      ? current.detached.filter((candidate) => candidate !== pane)
      : key === "D" || attached.length <= 1
        ? current.detached.slice(0, -1)
        : [...current.detached, pane];
    return { ...current, detached, zoomedPane: current.zoomedPane === pane ? null : current.zoomedPane };
  }
  if (!["+", "=", "-", "_"].includes(key)) return current;
  const direction = ["+", "="].includes(key) ? 1 : -1;
  const visible = [0, 1, 2].filter((candidate) => candidate !== pane && !current.detached.includes(candidate));
  if (!visible.length) return current;
  const weights = [...current.weights];
  const capacity = direction > 0
    ? visible.map((candidate) => Math.max(0, weights[candidate] - 0.15))
    : visible.map((candidate) => Math.max(0, 0.7 - weights[candidate]));
  const totalCapacity = capacity.reduce((sum, value) => sum + value, 0);
  const paneCapacity = direction > 0 ? 0.7 - weights[pane] : weights[pane] - 0.15;
  const delta = Math.min(0.05, totalCapacity, paneCapacity);
  if (delta <= Number.EPSILON) return current;
  weights[pane] += delta * direction;
  for (let index = 0; index < visible.length; index += 1) {
    weights[visible[index]] -= delta * direction * (capacity[index] / totalCapacity);
  }
  return createMissionControlPaneLayout({ ...current, weights });
}

export function missionControlPaneControlIntent(layout, key, activePane) {
  const previous = createMissionControlPaneLayout(layout);
  if (["\t", "\x1b[C", "\x1b[Z", "\x1b[D"].includes(key)) {
    return { layout: previous, activePane: missionControlPaneFocusIntent(previous, key, activePane) };
  }
  const next = missionControlPaneLayoutIntent(previous, key, activePane);
  const visible = missionControlVisiblePanes(next, activePane);
  const detachedPane = next.detached.find((pane) => !previous.detached.includes(pane));
  const reattachedPane = previous.detached.find((pane) => !next.detached.includes(pane));
  const operation = detachedPane != null
    ? { type: "detached", pane: detachedPane }
    : reattachedPane != null ? { type: "reattached", pane: reattachedPane } : null;
  if (visible.includes(activePane)) return { layout: next, activePane, operation };
  const nextPane = [1, 2, 0].find((pane) => visible.includes(pane)) ?? visible[0];
  return { layout: next, activePane: nextPane, operation };
}

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
  const pendingWake = lane.coordinatorWake
    && ["pending", "delivered"].includes(lane.coordinatorWake.status);
  const pendingHandoff = lane.handoff?.acknowledged === false
    && !["complete", "completed", "none"].includes(lane.handoff?.nextAction);
  return {
    openPr: Boolean(lane.repository && lane.prNumber),
    copy: true,
    continue: collaboration && TERMINAL.has(lane.lifecyclePhase) && lane.lifecyclePhase !== "indeterminate"
      && lane.handoff?.acknowledged !== false
      && !(lane.coordinatorWake?.actionable && lane.coordinatorWake.status !== "acknowledged"),
    cancel: collaboration && ["queued", "running", "recovering", "cancelling"].includes(lane.lifecyclePhase),
    archive: collaboration && TERMINAL.has(lane.lifecyclePhase)
      && lane.lifecyclePhase !== "indeterminate"
      && !pendingWake
      && !pendingHandoff,
    acknowledgeWake: collaboration
      && lane.coordinatorWake?.actionable === false
      && Boolean(lane.coordinatorWake?.sequence && lane.coordinatorWake.status !== "acknowledged"),
  };
}

export function missionControlPlatformCommands(platform = process.platform) {
  if (platform === "darwin") {
    return {
      open: [{ command: "open", args: [] }],
      copy: [{ command: "pbcopy", args: [] }],
    };
  }
  if (platform === "win32") {
    return {
      open: [{ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler"] }],
      copy: [{ command: "clip.exe", args: [] }],
    };
  }
  return {
    open: [{ command: "xdg-open", args: [] }],
    copy: [
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ],
  };
}

export function runClipboardCopy(input, { commands = missionControlPlatformCommands().copy, run } = {}) {
  const attempts = [];
  for (const candidate of commands) {
    const result = run(candidate, input) || {};
    attempts.push({
      command: candidate.command,
      status: Number.isInteger(result.status) ? result.status : null,
      errorCode: result.error?.code || null,
    });
    if (!result.error && result.status === 0) return { copied: true, command: candidate.command, attempts };
  }
  return { copied: false, command: null, attempts };
}

export function missionControlShouldRedraw({ promptOpen = false, stopped = false } = {}) {
  return !promptOpen && !stopped;
}

export function missionControlPrUrl(lane) {
  if (!missionControlActionAvailability(lane).openPr) return null;
  return `https://github.com/${lane.repository}/pull/${lane.prNumber}`;
}

export function missionControlCopyText(lane) {
  if (!lane) return "";
  return [
    lane.alias,
    lane.id,
    lane.repository,
    lane.prNumber ? `PR #${lane.prNumber}` : null,
    lane.relatedLaneCount > 1 ? `related: ${lane.relatedLaneIds.join(",")}` : null,
  ].filter(Boolean).join("\t");
}

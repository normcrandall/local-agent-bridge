import { queryControlPlane } from "./collaboration-store.mjs";

export const TERMINAL_LANE_STATUSES = new Set(["agreed", "completed", "merged", "needs_user", "failed", "cancelled", "budget", "turn_limit", "indeterminate", "obsolete"]);
const DEFAULT_HEARTBEAT_AFTER_MS = 60_000;

function resolveHandle(lanes, handle) {
  const exactId = lanes.find((lane) => lane.id === handle);
  if (exactId) return exactId;
  const aliases = lanes.filter((lane) => lane.alias === handle);
  if (aliases.length > 1) throw new Error(`Ambiguous collaboration alias: ${handle}`);
  if (aliases.length === 1) return aliases[0];
  if (/^bridge-[0-9a-f-]{8,}$/i.test(handle)) {
    const prefixes = lanes.filter((lane) => lane.id.startsWith(handle));
    if (prefixes.length > 1) throw new Error(`Ambiguous collaboration ID prefix: ${handle}`);
    if (prefixes.length === 1) return prefixes[0];
  }
  return null;
}

export function classifyWaitLane(lane, { now = Date.now(), heartbeatAfterMs = DEFAULT_HEARTBEAT_AFTER_MS } = {}) {
  if (!lane) return "missing";
  if (TERMINAL_LANE_STATUSES.has(lane.lifecyclePhase)) return "terminal";
  const heartbeatMs = Date.parse(lane.heartbeat?.heartbeatAt || "");
  const heartbeatIsStale = !Number.isFinite(heartbeatMs) || now - heartbeatMs > heartbeatAfterMs;
  if (lane.lifecyclePhase === "running" && lane.recovery?.processAlive === false && heartbeatIsStale) return "crashed";
  return lane.lifecyclePhase;
}

export async function waitForControlPlane(stateRoot, {
  handles,
  any = false,
  statuses = null,
  afterUpdatedAt = null,
  timeoutMs = 30_000,
  intervalMs = 200,
  now = () => Date.now(),
} = {}) {
  const requested = [...new Set((handles || []).filter(Boolean))];
  if (!requested.length) throw new Error("wait requires at least one collaboration ID or alias.");
  const afterMs = afterUpdatedAt ? Date.parse(afterUpdatedAt) : null;
  if (afterUpdatedAt && !Number.isFinite(afterMs)) throw new Error("afterUpdatedAt must be an ISO timestamp.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative finite number.");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be a positive finite number.");
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() <= deadline) {
    const plane = await queryControlPlane(stateRoot);
    const lanes = requested.map((handle) => resolveHandle(plane.lanes, handle));
    const changed = lanes.map((lane) => Boolean(lane) && (!Number.isFinite(afterMs) || Date.parse(lane.updatedAt || "") > afterMs));
    const observedAt = now();
    const classifications = lanes.map((lane) => classifyWaitLane(lane, { now: observedAt }));
    const desired = lanes.map((lane, index) => changed[index] && (statuses?.length ? Boolean(lane && statuses.includes(lane.lifecyclePhase)) : classifications[index] === "terminal"));
    const cursor = lanes.reduce((latest, lane) => {
      const laneMs = Date.parse(lane?.updatedAt || "");
      const latestMs = Date.parse(latest || "");
      return Number.isFinite(laneMs) && (!Number.isFinite(latestMs) || laneMs > latestMs) ? lane.updatedAt : latest;
    }, afterUpdatedAt);
    last = { requested, lanes, classifications, changed, cursor, reached: any ? desired.some(Boolean) : desired.every(Boolean) };
    if (last.reached || last.classifications.includes("missing") || last.classifications.includes("crashed")) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return { ...(last || { requested, lanes: [], classifications: [], changed: [], cursor: afterUpdatedAt, reached: false }), timedOut: true };
}

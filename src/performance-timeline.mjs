const MAX_SPANS = 250;
const MAX_MILESTONES = 250;

const DEAD_TIME_PAIRS = {
  coordinator_wake_enqueued: ["provider_completed", "completion_to_wake"],
  coordinator_wake_delivered: ["coordinator_wake_enqueued", "wake_delivery"],
  coordinator_wake_acknowledged: ["coordinator_wake_delivered", "wake_acknowledgement"],
  review_started: ["coordinator_wake_acknowledged", "wake_to_review"],
  merge_authorized: ["review_completed", "review_to_merge_authorization"],
  merge_completed: ["merge_authorized", "merge_execution"],
};

function timestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid performance timestamp: ${value}`);
  return parsed;
}

function normalize(timeline) {
  return timeline && timeline.version === 1
    ? structuredClone(timeline)
    : createPerformanceTimeline();
}

function completedSpan({ name, category, startedAt, completedAt, metadata = {} }) {
  const durationMs = Math.max(0, timestamp(completedAt) - timestamp(startedAt));
  return { name, category, startedAt, completedAt, durationMs, metadata };
}

export function createPerformanceTimeline(createdAt = new Date().toISOString()) {
  timestamp(createdAt);
  return { version: 1, createdAt, active: {}, spans: [], milestones: [] };
}

export function startPerformanceSpan(timeline, name, { at = new Date().toISOString(), category = "active", metadata = {}, key = name } = {}) {
  if (!String(name || "").trim()) throw new Error("Performance span name is required.");
  timestamp(at);
  const next = normalize(timeline);
  next.active[key] = { name, key, category, startedAt: at, metadata };
  return next;
}

export function finishPerformanceSpan(timeline, name, { at = new Date().toISOString(), metadata = {}, key = name } = {}) {
  timestamp(at);
  const next = normalize(timeline);
  const active = next.active[key];
  if (!active) return next;
  delete next.active[key];
  next.spans.push(completedSpan({
    ...active,
    completedAt: at,
    metadata: { ...(active.metadata || {}), ...metadata },
  }));
  next.spans = next.spans.slice(-MAX_SPANS);
  return next;
}

export function markPerformanceMilestone(timeline, name, { at = new Date().toISOString(), metadata = {} } = {}) {
  if (!String(name || "").trim()) throw new Error("Performance milestone name is required.");
  timestamp(at);
  const next = normalize(timeline);
  const pair = DEAD_TIME_PAIRS[name];
  if (pair) {
    const [priorName, spanName] = pair;
    const prior = [...next.milestones].reverse().find((entry) => entry.name === priorName);
    if (prior && timestamp(at) >= timestamp(prior.at)) {
      next.spans.push(completedSpan({
        name: spanName,
        category: "dead_time",
        startedAt: prior.at,
        completedAt: at,
        metadata: { from: priorName, to: name },
      }));
      next.spans = next.spans.slice(-MAX_SPANS);
    }
  }
  next.milestones.push({ name, at, metadata });
  next.milestones = next.milestones.slice(-MAX_MILESTONES);
  return next;
}

export function summarizePerformance(timeline) {
  const current = normalize(timeline);
  const byName = {};
  const activeIntervals = [];
  let attributedActiveTimeMs = 0;
  let deadTimeMs = 0;
  for (const span of current.spans) {
    const entry = byName[span.name] || { count: 0, totalMs: 0, maxMs: 0, category: span.category };
    entry.count += 1;
    entry.totalMs += span.durationMs;
    entry.maxMs = Math.max(entry.maxMs, span.durationMs);
    entry.meanMs = Math.round(entry.totalMs / entry.count);
    byName[span.name] = entry;
    if (span.category === "dead_time") deadTimeMs += span.durationMs;
    else {
      attributedActiveTimeMs += span.durationMs;
      activeIntervals.push([timestamp(span.startedAt), timestamp(span.completedAt)]);
    }
  }
  activeIntervals.sort((left, right) => left[0] - right[0]);
  let activeTimeMs = 0;
  let activeStart = null;
  let activeEnd = null;
  for (const [startedAt, completedAt] of activeIntervals) {
    if (activeStart === null) {
      activeStart = startedAt;
      activeEnd = completedAt;
    } else if (startedAt <= activeEnd) {
      activeEnd = Math.max(activeEnd, completedAt);
    } else {
      activeTimeMs += Math.max(0, activeEnd - activeStart);
      activeStart = startedAt;
      activeEnd = completedAt;
    }
  }
  if (activeStart !== null) activeTimeMs += Math.max(0, activeEnd - activeStart);
  return {
    activeTimeMs,
    attributedActiveTimeMs,
    deadTimeMs,
    byName,
    openSpans: Object.values(current.active),
    latestMilestone: current.milestones.at(-1) || null,
  };
}

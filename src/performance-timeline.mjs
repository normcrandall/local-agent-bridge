const MAX_SPANS = 250;
const MAX_MILESTONES = 250;

const DEAD_TIME_TRANSITIONS = {
  coordinator_wake_enqueued: { priors: ["provider_completed"], span: "completion_to_wake" },
  coordinator_wake_delivered: { priors: ["coordinator_wake_enqueued"], span: "wake_delivery" },
  coordinator_wake_acknowledged: {
    priors: ["coordinator_wake_delivered", "coordinator_wake_enqueued"],
    span: "wake_acknowledgement",
  },
  handoff_acknowledged: {
    priors: ["handoff_completed", "provider_completed"],
    span: "handoff_to_chair_acknowledgement",
  },
  review_started: {
    priors: ["coordinator_wake_acknowledged", "handoff_acknowledged"],
    span: "wake_to_review",
  },
  review_completed: { priors: ["formal_review_published"], span: "formal_review_to_portfolio_review" },
  merge_validation_started: { priors: ["review_completed"], span: "merge_coordinator_wait" },
  merge_validation_completed: { priors: ["merge_validation_started"], span: "merge_ci_validation" },
  merge_authorized: {
    priors: ["merge_validation_completed", "review_completed"],
    span: "merge_policy_wait",
  },
  merge_completed: { priors: ["merge_authorized"], span: "github_merge_execution" },
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
  const transition = DEAD_TIME_TRANSITIONS[name];
  if (transition) {
    const prior = transition.priors
      .map((priorName) => [...next.milestones].reverse().find((entry) => entry.name === priorName))
      .filter(Boolean)
      .sort((left, right) => timestamp(right.at) - timestamp(left.at))[0];
    if (prior && timestamp(at) >= timestamp(prior.at)) {
      const alreadyRecorded = next.spans.some((span) => (
        span.name === transition.span
        && span.startedAt === prior.at
        && span.metadata?.to === name
      ));
      if (!alreadyRecorded) {
        next.spans.push(completedSpan({
          name: transition.span,
          category: "dead_time",
          startedAt: prior.at,
          completedAt: at,
          metadata: { from: prior.name, to: name },
        }));
        next.spans = next.spans.slice(-MAX_SPANS);
      }
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
  const deadIntervals = [];
  let attributedActiveTimeMs = 0;
  let attributedDeadTimeMs = 0;
  for (const span of current.spans) {
    const entry = byName[span.name] || { count: 0, totalMs: 0, maxMs: 0, category: span.category };
    entry.count += 1;
    entry.totalMs += span.durationMs;
    entry.maxMs = Math.max(entry.maxMs, span.durationMs);
    entry.meanMs = Math.round(entry.totalMs / entry.count);
    byName[span.name] = entry;
    if (span.category === "dead_time") {
      attributedDeadTimeMs += span.durationMs;
      deadIntervals.push([timestamp(span.startedAt), timestamp(span.completedAt)]);
    }
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
  deadIntervals.sort((left, right) => left[0] - right[0]);
  let deadTimeMs = 0;
  let deadStart = null;
  let deadEnd = null;
  for (const [startedAt, completedAt] of deadIntervals) {
    if (deadStart === null) {
      deadStart = startedAt;
      deadEnd = completedAt;
    } else if (startedAt <= deadEnd) {
      deadEnd = Math.max(deadEnd, completedAt);
    } else {
      deadTimeMs += Math.max(0, deadEnd - deadStart);
      deadStart = startedAt;
      deadEnd = completedAt;
    }
  }
  if (deadStart !== null) deadTimeMs += Math.max(0, deadEnd - deadStart);
  return {
    activeTimeMs,
    attributedActiveTimeMs,
    deadTimeMs,
    attributedDeadTimeMs,
    byName,
    openSpans: Object.values(current.active),
    latestMilestone: current.milestones.at(-1) || null,
  };
}

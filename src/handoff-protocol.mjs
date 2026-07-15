const OUTCOMES = new Set(["completed", "blocked", "needs_review", "continue"]);
const NEXT_ACTIONS = new Set(["chair_verify", "peer_review", "writer_fix", "continue", "needs_user"]);

function strings(value, field, maximum = 50) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`HANDOFF ${field} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

export function normalizeHandoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HANDOFF must be a JSON object.");
  if (!OUTCOMES.has(value.outcome)) throw new Error(`HANDOFF outcome must be one of: ${[...OUTCOMES].join(", ")}.`);
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("HANDOFF summary is required.");
  if (!NEXT_ACTIONS.has(value.nextAction)) throw new Error(`HANDOFF nextAction must be one of: ${[...NEXT_ACTIONS].join(", ")}.`);
  const optionalString = (field) => {
    if (value[field] === undefined || value[field] === null || value[field] === "") return null;
    if (typeof value[field] !== "string") throw new Error(`HANDOFF ${field} must be a string.`);
    return value[field].trim();
  };
  return {
    outcome: value.outcome,
    summary: value.summary.trim(),
    artifacts: strings(value.artifacts, "artifacts"),
    verification: strings(value.verification, "verification"),
    commit: optionalString("commit"),
    pullRequest: optionalString("pullRequest"),
    remaining: strings(value.remaining, "remaining"),
    nextAction: value.nextAction,
  };
}

export function completionAfterHandoff(previous, { handoff, agent, turn, at = new Date().toISOString() }) {
  const normalized = normalizeHandoff(handoff);
  const sequence = (previous?.sequence || 0) + 1;
  const lastHandoff = { ...normalized, sequence, agent, turn, recordedAt: at };
  const awaitingVerification = normalized.outcome === "completed" && normalized.nextAction === "chair_verify";
  return {
    sequence,
    phase: awaitingVerification ? "awaiting_chair_verification" : "provider_handoff",
    acknowledged: false,
    nextAction: normalized.nextAction,
    lastHandoff,
    acknowledgement: null,
  };
}

export function acknowledgeCompletion(current, {
  sequence,
  accepted,
  summary,
  verification = [],
  remaining = [],
  at = new Date().toISOString(),
}) {
  if (!current?.lastHandoff) throw new Error("Collaboration has no HANDOFF receipt to acknowledge.");
  if (sequence !== current.sequence) throw new Error(`HANDOFF sequence mismatch: expected ${current.sequence}, received ${sequence}.`);
  if (typeof accepted !== "boolean") throw new Error("HANDOFF acknowledgement accepted must be boolean.");
  if (typeof summary !== "string" || !summary.trim()) throw new Error("HANDOFF acknowledgement summary is required.");
  const checked = strings(verification, "acknowledgement verification");
  const pending = strings(remaining, "acknowledgement remaining");
  const phase = accepted
    ? (pending.length ? "verified_partial" : "verified_complete")
    : "requires_followup";
  return {
    ...current,
    phase,
    acknowledged: true,
    nextAction: accepted && !pending.length ? "complete" : "continue",
    acknowledgement: {
      sequence,
      accepted,
      summary: summary.trim(),
      verification: checked,
      remaining: pending,
      recordedAt: at,
    },
  };
}

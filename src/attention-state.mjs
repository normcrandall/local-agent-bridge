export const DEFAULT_ATTENTION_FRESH_MS = 6 * 60 * 60 * 1000;

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function attentionRequestAt(state) {
  return state.attentionRequestedAt
    || state.coordinatorWake?.createdAt
    || state.completion?.lastHandoff?.recordedAt
    || state.decisionEscalation?.recordedAt
    || state.decisionEscalation?.createdAt
    || state.decisionEscalation?.at
    || state.createdAt
    || null;
}

export function attentionRequestIsFresh(state, now = Date.now(), maxAgeMs = DEFAULT_ATTENTION_FRESH_MS) {
  const requestedAt = dateMs(attentionRequestAt(state));
  return requestedAt > 0 && now - requestedAt <= maxAgeMs;
}

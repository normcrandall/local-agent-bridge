export const DECISION_CATEGORIES = [
  "reversible_technical",
  "external_authorization",
  "money",
  "legal_compliance",
  "destructive_irreversible",
  "user_preference",
];

const BASELINE_ESCALATIONS = new Set(DECISION_CATEGORIES.filter((value) => value !== "reversible_technical"));

export function decisionDisposition({ category, additionalEscalations = [] }) {
  if (!DECISION_CATEGORIES.includes(category)) throw new Error(`Unsupported decision category: ${category}`);
  const escalations = new Set([...BASELINE_ESCALATIONS, ...additionalEscalations]);
  return {
    category,
    action: escalations.has(category) ? "needs_user" : "resolve_by_agents",
    authorityExpanded: false,
  };
}

export function createDecisionReceipt({
  question,
  category,
  alternatives = [],
  decision = null,
  confidence = null,
  dissent = [],
  rollbackPath = null,
  owner,
  additionalEscalations = [],
}) {
  const disposition = decisionDisposition({ category, additionalEscalations });
  if (!question?.trim()) throw new Error("Decision question is required.");
  if (!owner?.trim()) throw new Error("Decision owner is required.");
  if (disposition.action === "needs_user") {
    return {
      question: question.trim(), category, action: "needs_user", owner: owner.trim(),
      reason: `Human authority is required for ${category.replaceAll("_", " ")}.`,
      authorityExpanded: false,
    };
  }
  if (alternatives.length < 2 || alternatives.some((value) => !value?.trim())) {
    throw new Error("A reversible technical decision requires at least two alternatives.");
  }
  if (!decision?.trim()) throw new Error("A reversible technical decision requires a selected decision.");
  if (!rollbackPath?.trim()) throw new Error("A reversible technical decision requires a rollback path.");
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error("Decision confidence must be between 0 and 1.");
  }
  return {
    question: question.trim(), category, action: "resolved", owner: owner.trim(),
    alternatives: alternatives.map((value) => value.trim()), decision: decision.trim(), confidence,
    dissent: dissent.map((value) => value.trim()).filter(Boolean), rollbackPath: rollbackPath.trim(),
    authorityExpanded: false,
  };
}

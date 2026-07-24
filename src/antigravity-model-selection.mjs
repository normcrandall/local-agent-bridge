export function resolveAntigravityModelSelection({
  model,
  advertisedModels = [],
  effortSupported = false,
} = {}) {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return { model: null, effort: null, effortSource: null };

  const available = new Set(advertisedModels.map((entry) => String(entry).trim().toLowerCase()));
  const suffixed = requested.match(/^(.+)-(low|medium|high)$/i);
  let selection = { model: requested, effort: null, effortSource: null };
  if (suffixed && available.has(requested.toLowerCase())) {
    selection = {
      model: suffixed[1],
      effort: suffixed[2].toLowerCase(),
      effortSource: "explicit_route",
    };
  } else {
    for (const effort of ["high", "medium", "low"]) {
      if (!available.has(`${requested}-${effort}`.toLowerCase())) continue;
      selection = { model: requested, effort, effortSource: "inferred_from_advertised_route" };
      break;
    }
  }

  if (!selection.effort || effortSupported) return selection;
  if (selection.effortSource === "explicit_route") {
    throw new Error(`Installed Antigravity cannot select the explicit ${selection.effort} model effort.`);
  }
  return { ...selection, effort: null, effortSource: "inferred_but_unsupported" };
}

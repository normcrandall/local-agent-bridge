import assert from "node:assert/strict";
import { resolveAntigravityModelSelection } from "../src/antigravity-model-selection.mjs";

const advertisedModels = [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gpt-oss-120b-medium",
];

assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels,
  effortSupported: true,
}), {
  model: "gemini-3.6-flash",
  effort: "high",
  effortSource: "inferred_from_advertised_route",
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels,
  effortSupported: true,
}), {
  model: "gemini-3.6-flash",
  effort: "medium",
  effortSource: "explicit_route",
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "custom-model-high",
  advertisedModels,
  effortSupported: true,
}), {
  model: "custom-model-high",
  effort: null,
  effortSource: null,
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels,
  effortSupported: false,
}), {
  model: "gemini-3.6-flash",
  effort: null,
  effortSource: "inferred_but_unsupported",
});
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels,
  effortSupported: false,
}), /cannot select the explicit medium model effort/i);
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels: null,
  effortSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels: null,
  effortSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels: null,
  effortSupported: false,
}), /cannot select the explicit medium model effort/i);
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.5-flash-high",
  advertisedModels,
  effortSupported: true,
  requireAdvertisedRoute: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_ROUTE_UNAVAILABLE");
assert.deepEqual(resolveAntigravityModelSelection({
  model: "-high",
  advertisedModels: ["-high"],
  effortSupported: true,
}), {
  model: "-high",
  effort: null,
  effortSource: null,
});

console.log("Antigravity model selection tests passed for advertised routes, inferred effort, catalog failures, unavailable fallbacks, legacy CLIs, and unrelated model names.");

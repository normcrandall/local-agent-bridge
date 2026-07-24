import assert from "node:assert/strict";
import {
  allProviderFailuresAreTransientCapacity,
  classifyProviderFailure,
  providerFailuresSummary,
  resolveProviderFailoverRoster,
} from "../src/provider-failover.mjs";

assert.equal(classifyProviderFailure("Model is overloaded (529)."), "transient_capacity");
assert.equal(
  classifyProviderFailure('invalid model selection (--model "gemini-3.6-flash" --effort ""): model unavailable because --effort is required'),
  "configuration",
);
assert.equal(classifyProviderFailure("Codex handoffPath must stay inside delegated workspace."), "invalid_request");
assert.equal(classifyProviderFailure("permission denied by sandbox allowlist"), "permission");
assert.equal(classifyProviderFailure("API token is unauthorized (401)"), "authentication");
assert.equal(classifyProviderFailure("MCP error -32000: Connection closed"), "transport");

assert.equal(allProviderFailuresAreTransientCapacity({
  codex: "The model is overloaded.",
  claude: "Service temporarily unavailable (503).",
}), true);
assert.equal(allProviderFailuresAreTransientCapacity({
  codex: "The model is overloaded.",
  antigravity: "--effort is required",
}), false);

assert.equal(
  providerFailuresSummary({
    codex: "The model is overloaded.",
    antigravity: "--effort is required",
  }),
  "All requested providers failed: Codex (transient_capacity): The model is overloaded.; Antigravity (configuration): --effort is required",
);

const automatic = resolveProviderFailoverRoster({
  agents: ["antigravity"],
  mode: "work",
  issueClaim: { repository: "owner/repo", issueNumber: 143 },
});
assert.deepEqual(automatic.agents, ["antigravity", "claude", "codex"]);
assert.equal(automatic.policy.enabled, true);

const strict = resolveProviderFailoverRoster({
  agents: ["antigravity"],
  mode: "work",
  issueClaim: { repository: "owner/repo", issueNumber: 143 },
  providerFailover: { enabled: false },
});
assert.deepEqual(strict.agents, ["antigravity"]);

const unclaimed = resolveProviderFailoverRoster({
  agents: ["antigravity"],
  mode: "work",
  issueClaim: null,
});
assert.deepEqual(unclaimed.agents, ["antigravity"]);

console.log("Provider failover tests passed.");

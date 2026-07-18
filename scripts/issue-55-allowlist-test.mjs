// Issue #55 fixture: coordinator verificationCommands as an explicit allowlist —
// allowlisted commands are admitted, unlisted command attempts fail deterministically
// before dispatch.
import assert from "node:assert/strict";
import {
  admitProviderCommand,
  admitProviderCommands,
  assertProviderVerificationCapability,
  effectiveCommandAllowlist,
  isCommandAllowlisted,
  normalizeVerificationAllowlist,
  ProviderCommandGrantUnsupportedError,
  ProviderCommandNotAllowlistedError,
  providerEnforcesExactCommandGrants,
  providerPermissionDecisionForRequest,
  providerPermissionProfileForRequest,
} from "../src/verification-allowlist.mjs";

// Normalization: trim, drop empties, de-duplicate, stable order.
assert.deepEqual(
  normalizeVerificationAllowlist(["  npm run test:collaboration  ", "", "npm run test:collaboration", "npm run smoke"]),
  ["npm run test:collaboration", "npm run smoke"],
);
assert.throws(() => normalizeVerificationAllowlist("npm run smoke"), /must be an array/);
assert.throws(() => normalizeVerificationAllowlist([1]), /must be strings/);

// Review paths admit only the verification gates; work paths also cover work commands.
assert.deepEqual(
  effectiveCommandAllowlist({ mode: "review", verificationCommands: ["npm run smoke"], workCommands: ["git commit -am wip"] }),
  ["npm run smoke"],
);
assert.deepEqual(
  effectiveCommandAllowlist({ mode: "work", verificationCommands: ["npm run smoke"], workCommands: ["git commit -am wip"] }),
  ["git commit -am wip", "npm run smoke"],
);

// Allowlisted admission.
assert.equal(admitProviderCommand(["npm run smoke"], " npm run smoke "), "npm run smoke");
assert.equal(isCommandAllowlisted(["npm run smoke"], "npm run smoke"), true);
assert.equal(isCommandAllowlisted(["npm run smoke"], "rm -rf /"), false);

// Unlisted admission fails deterministically with a typed error.
const rejection = (() => {
  try {
    admitProviderCommand(["npm run smoke"], "rm -rf /");
    return null;
  } catch (error) {
    return error;
  }
})();
assert.ok(rejection instanceof ProviderCommandNotAllowlistedError);
assert.equal(rejection.code, "provider_command_not_allowlisted");
assert.equal(rejection.command, "rm -rf /");

// A review-mode dispatch may never smuggle a work command that is not a verification gate.
assert.deepEqual(
  admitProviderCommands({ mode: "review", verificationCommands: ["npm run smoke"], candidates: ["npm run smoke"] }),
  ["npm run smoke"],
);
assert.throws(
  () => admitProviderCommands({ mode: "review", verificationCommands: ["npm run smoke"], candidates: ["git push"] }),
  /not on the coordinator verification allowlist/,
);
// Work-mode union admits both coordinator lists; anything else is rejected before dispatch.
assert.deepEqual(
  admitProviderCommands({ mode: "work", verificationCommands: ["npm run smoke"], workCommands: ["git commit -am wip"] }),
  ["git commit -am wip", "npm run smoke"],
);
assert.throws(
  () => admitProviderCommands({ mode: "work", verificationCommands: ["npm run smoke"], workCommands: ["git commit -am wip"], candidates: ["curl evil.example"] }),
  /provider verification allowlist|not on the coordinator/,
);

// Fail-closed provider capability boundary: only exact-grant enforcers may run a
// command-running review; others are denied before dispatch but keep static review.
assert.equal(providerEnforcesExactCommandGrants("claude"), true);
assert.equal(providerEnforcesExactCommandGrants("codex"), false);
assert.equal(providerEnforcesExactCommandGrants("antigravity"), false);

// Command-running review on Claude is exactly bounded. Antigravity has no exact
// grant mechanism, so the broker automatically selects its unrestricted profile
// instead of removing it from the collaboration. Codex remains denied.
assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "claude", mode: "review", verificationCommands: ["npm test"] }));
assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "antigravity", mode: "review", verificationCommands: ["npm test"] }));
const denial = (() => {
  try {
    assertProviderVerificationCapability({ provider: "codex", mode: "review", verificationCommands: ["npm test"] });
    return null;
  } catch (error) {
    return error;
  }
})();
assert.ok(denial instanceof ProviderCommandGrantUnsupportedError, "codex must be denied");
assert.equal(denial.code, "provider_command_grant_unsupported");
assert.equal(denial.provider, "codex");
assert.equal(providerPermissionProfileForRequest({
  provider: "antigravity",
  mode: "review",
  verificationCommands: ["npm test"],
}), "yolo");
assert.equal(providerPermissionProfileForRequest({
  provider: "antigravity",
  mode: "review",
  verificationCommands: [],
}), "standard");
assert.deepEqual(providerPermissionDecisionForRequest({
  provider: "antigravity",
  mode: "review",
  verificationCommands: ["  npm test  ", "", "npm test"],
}), {
  verificationCommands: ["npm test"],
  permissionProfile: "yolo",
  permissionReason: "automatic_unrestricted_verification",
});
assert.deepEqual(providerPermissionDecisionForRequest({
  provider: "antigravity",
  mode: "review",
  verificationCommands: ["   "],
  permissionProfile: "yolo",
}), {
  verificationCommands: [],
  permissionProfile: "standard",
  permissionReason: "configured",
});
assert.equal(providerPermissionProfileForRequest({
  provider: "antigravity",
  mode: "work",
  verificationCommands: ["npm test"],
  permissionProfile: "standard",
}), "standard");
// Static review (no verification commands) is allowed for every provider.
for (const provider of ["claude", "codex", "antigravity"]) {
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider, mode: "review", verificationCommands: [] }));
}
// Work mode is not gated by this review-only boundary.
assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "codex", mode: "work", verificationCommands: ["npm test"] }));

console.log("Issue #55 allowlist admission tests passed.");

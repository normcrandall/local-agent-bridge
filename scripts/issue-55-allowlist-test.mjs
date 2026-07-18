// Issue #55 fixture: coordinator verificationCommands as an explicit allowlist —
// allowlisted commands are admitted, unlisted command attempts fail deterministically
// before dispatch.
import assert from "node:assert/strict";
import {
  admitProviderCommand,
  admitProviderCommands,
  effectiveCommandAllowlist,
  isCommandAllowlisted,
  normalizeVerificationAllowlist,
  ProviderCommandNotAllowlistedError,
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

console.log("Issue #55 allowlist admission tests passed.");

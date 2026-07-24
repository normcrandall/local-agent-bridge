// Issue #55 fixture: provider-specific verification planning keeps reviews alive while
// the lower-level command boundary remains fail closed. Antigravity's owner-selected
// policy is tested separately: command-running reviews use its unrestricted CLI profile.
import assert from "node:assert/strict";
import { createAgentPool, staticReviewBoundary } from "../src/agent-pool.mjs";
import { assertProviderVerificationCapability, providerVerificationPlanForRequest } from "../src/verification-allowlist.mjs";

{
  // The exact bounded review the chair described: Codex cannot enforce the grants, so
  // collaboration dispatch withholds them and continues as a static exact-head review.
  const verificationCommands = ["npm run test:collaboration", "node scripts/issue-55-allowlist-test.mjs"];
  const codexPlan = providerVerificationPlanForRequest({ provider: "codex", mode: "review", verificationCommands });
  assert.equal(codexPlan.staticOnly, true);
  assert.deepEqual(codexPlan.verificationCommands, []);
  assert.deepEqual(codexPlan.withheldVerificationCommands, verificationCommands);
  const boundary = staticReviewBoundary({ agent: "codex", prompt: "Review exact head.", verificationPlan: codexPlan });
  assert.deepEqual(boundary.progress, {
    progress: null,
    total: null,
    summary: "codex cannot enforce exact command grants; continuing as a static review with 2 verification commands withheld. Local and hosted CI remain separate evidence.",
  });
  assert.match(boundary.prompt, /Static-review boundary:/);
  assert.match(boundary.prompt, /Those commands were withheld\. Do not run or claim them\./);
  assert.doesNotThrow(() => assertProviderVerificationCapability({
    provider: "codex", mode: "review", verificationCommands: codexPlan.verificationCommands,
  }), "the provider-facing static review must survive preflight with no command grant");
  assert.throws(() => assertProviderVerificationCapability({
    provider: "codex", mode: "review", verificationCommands,
  }), /cannot enforce an exact command grant/, "the raw command-running request remains fail-closed");
  assert.throws(() => assertProviderVerificationCapability({
    provider: "misspelled-provider", mode: "review", verificationCommands,
  }), /cannot enforce an exact command grant/, "unknown providers must fail closed instead of silently becoming static");

  // Static review (no verification commands) is NOT denied by the boundary for the same
  // providers — they remain eligible when there is nothing to run.
  // The boundary itself must not throw for a static review; we assert via the pure guard
  // to avoid a real provider connection in this offline fixture.
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "antigravity", mode: "review", verificationCommands: [] }));
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "antigravity", mode: "review", verificationCommands }));
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "codex", mode: "review", verificationCommands: [] }));
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "docker", mode: "review", verificationCommands: [] }), "receipt-backed Docker review is static and receives no command");
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "ollama", mode: "review", verificationCommands: [] }), "receipt-backed Ollama review is static and receives no command");
  assert.throws(() => assertProviderVerificationCapability({ provider: "docker", mode: "review", verificationCommands }), /cannot enforce an exact command grant/);
  assert.throws(() => assertProviderVerificationCapability({ provider: "ollama", mode: "review", verificationCommands }), /cannot enforce an exact command grant/);
  // Claude may run a command-running review because it enforces exact Bash() grants.
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "claude", mode: "review", verificationCommands }));

  // Exercise the real pool.send wiring without spawning a provider. The request
  // reaching the adapter has no commands, includes the static boundary, and emits
  // the structured narrative shape consumed by collaboration-worker.
  let dispatchedRequest = null;
  const progressEvents = [];
  const fakeClient = {
    async connect() {},
    async callTool(request) {
      dispatchedRequest = request;
      return {
        content: [{ type: "text", text: "Static review complete." }],
        structuredContent: { threadId: "thread-static-review" },
      };
    },
    async close() {},
  };
  const pool = createAgentPool({
    root: process.cwd(),
    workspace: process.cwd(),
    verificationCommands,
    clientFactory: () => fakeClient,
    transportFactory: () => ({}),
  });
  const response = await pool.send(
    { agent: "codex", prompt: "Review exact head.", mode: "review", browser: false },
    (progress) => progressEvents.push(progress),
  );
  assert.equal(response.sessionId, "thread-static-review");
  assert.equal(dispatchedRequest.arguments.verificationCommands, undefined);
  assert.match(dispatchedRequest.arguments.prompt, /Static-review boundary:/);
  assert.equal(typeof progressEvents[0], "object");
  assert.match(progressEvents[0].summary, /continuing as a static review/);
  await pool.close();
}

console.log("Issue #55 provider capability boundary tests passed.");

// Issue #55 integration fixture: the fail-closed provider capability boundary. A bounded
// command-running review dispatched through the real delegated pool.send path to a
// provider that cannot enforce exact command grants (Codex, Antigravity) is denied with a
// typed error BEFORE any provider process is spawned — so the reviewer can never run the
// unlisted package-script loop that motivated this fix.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPool } from "../src/agent-pool.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-issue-55-capability-"));
try {
  // The exact bounded review the chair described: a command-running review whose gate the
  // reviewer is meant to run. Antigravity/Codex have no enforceable grant for it.
  const verificationCommands = ["npm run test:collaboration", "node scripts/issue-55-allowlist-test.mjs"];
  const pool = createAgentPool({ root, workspace: root, verificationCommands });

  // A sentinel would prove no MCP client was created; instead we rely on the boundary
  // being the first statement of send() (before clientFor), so a throw here is proof the
  // provider was never dispatched. A rejection that took real spawn time would hang, not
  // resolve — so a prompt typed rejection is the observable evidence.
  for (const provider of ["antigravity", "codex"]) {
    const startedAt = Date.now();
    await assert.rejects(
      pool.send({ agent: provider, prompt: "review the diff and run the gate", mode: "review" }),
      (error) => {
        assert.equal(error.code, "provider_command_grant_unsupported", `${provider} should be denied`);
        assert.equal(error.provider, provider);
        assert.ok(Array.isArray(error.commands) && error.commands.length === 2);
        return true;
      },
      `${provider} command-running review must be denied before dispatch`,
    );
    // Denied at the boundary, not after a spawn/connect attempt.
    assert.ok(Date.now() - startedAt < 1_000, `${provider} denial must be pre-dispatch and prompt`);
  }

  // Static review (no verification commands) is NOT denied by the boundary for the same
  // providers — they remain eligible when there is nothing to run.
  const staticPool = createAgentPool({ root, workspace: root, verificationCommands: [] });
  // The boundary itself must not throw for a static review; we assert via the pure guard
  // to avoid a real provider connection in this offline fixture.
  const { assertProviderVerificationCapability } = await import("../src/verification-allowlist.mjs");
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "antigravity", mode: "review", verificationCommands: [] }));
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "codex", mode: "review", verificationCommands: [] }));
  // Claude may run a command-running review because it enforces exact Bash() grants.
  assert.doesNotThrow(() => assertProviderVerificationCapability({ provider: "claude", mode: "review", verificationCommands }));

  await pool.close?.();
  await staticPool.close?.();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Issue #55 provider capability boundary tests passed.");

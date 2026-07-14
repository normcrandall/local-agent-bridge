import assert from "node:assert/strict";
import { resolveNativeChair } from "../src/native-chair.mjs";

const codexChair = resolveNativeChair({
  chair: { provider: "codex", sessionId: "thread-1", allowSameProviderDelegation: false },
  agents: ["codex", "claude", "antigravity"], startAgent: "codex", mode: "review",
});
assert.deepEqual(codexChair.agents, ["claude", "antigravity"]);
assert.equal(codexChair.startAgent, "claude");
assert.equal(codexChair.chair.source, "native-chair");

const explicit = resolveNativeChair({
  chair: { provider: "claude", allowSameProviderDelegation: true }, agents: ["claude", "codex"],
  startAgent: "claude", writer: "claude", mode: "work",
});
assert.equal(explicit.writer, "claude");
const rotatedChair = resolveNativeChair({
  chair: { provider: "codex", allowSameProviderDelegation: false }, agents: ["codex", "claude"],
  startAgent: "codex", writer: "codex", mode: "work",
});
assert.equal(rotatedChair.chairOwnsWork, true);
assert.equal(rotatedChair.writer, null);
assert.throws(() => resolveNativeChair({
  chair: { provider: "claude", allowSameProviderDelegation: false }, agents: ["claude"], mode: "review",
}), /select at least one peer/);

console.log("Native-chair reuse tests passed.");

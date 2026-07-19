import assert from "node:assert/strict";
import { parseProviderHelp } from "../src/provider-cli-capabilities.mjs";

const modernCodex = parseProviderHelp("codex", {
  version: "1", newHelp: "--json --model --sandbox --cd --skip-git-repo-check --config",
  resumeHelp: "--json --model --skip-git-repo-check --config",
});
assert.equal(modernCodex.newSession.sandbox, true);
assert.equal(modernCodex.resume.model, true);
const oldCodex = parseProviderHelp("codex", { newHelp: "--json --config", resumeHelp: "--json --config" });
assert.equal(oldCodex.newSession.skipGitRepoCheck, false);
assert.equal(oldCodex.resume.model, false);

const modernClaude = parseProviderHelp("claude", {
  mainHelp: "-p, --print --output-format --model --fallback-model --resume --strict-mcp-config --mcp-config --verbose --allowedTools --permission-mode --dangerously-skip-permissions --add-dir",
});
assert.equal(modernClaude.fallbackModel, true);
assert.equal(modernClaude.permissionMode, true);
assert.equal(modernClaude.addDir, true);
const oldClaude = parseProviderHelp("claude", { mainHelp: "-p, --print --output-format --model --resume --mcp-config" });
assert.equal(oldClaude.fallbackModel, false);
assert.equal(oldClaude.strictMcpConfig, false);

const modernAntigravity = parseProviderHelp("antigravity", {
  mainHelp: "--print --print-timeout --mode --model --sandbox --dangerously-skip-permissions --conversation --log-file --add-dir",
});
assert.equal(modernAntigravity.conversation, true);
assert.equal(modernAntigravity.yolo, true);
assert.equal(modernAntigravity.logFile, true);
assert.equal(modernAntigravity.addDir, true);
const oldAntigravity = parseProviderHelp("antigravity", { mainHelp: "--print --print-timeout --mode --sandbox" });
assert.equal(oldAntigravity.model, false);
assert.equal(oldAntigravity.conversation, false);
assert.equal(oldAntigravity.addDir, false);

console.log("Provider capability matrix tests passed for modern and legacy Codex, Claude, and Antigravity CLIs.");

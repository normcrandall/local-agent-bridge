#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  addCommandHook,
  configuredCodexHookPath,
  ensureCodexHookConfiguration,
  resolveCodexHookPath,
} from "../src/coordinator-hook-config.mjs";

const command = "/Users/test/.local/bin/agent-bridge-coordinator-hook codex stop";
const settings = addCommandHook({
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "existing-hook", timeout: 9 }] }],
  },
}, "Stop", command);
assert.equal(settings.hooks.Stop.length, 2);
assert.equal(addCommandHook(settings, "Stop", command).hooks.Stop.length, 2);

const hookPath = "/Users/test/.local/share/agent-bridge/hooks/codex-hooks.json";
const initial = `model = "gpt-test"\n\n[features]\nmemories = true\n\n[mcp_servers.demo]\ncommand = "demo"\n`;
const configured = ensureCodexHookConfiguration(initial);
assert.equal(configuredCodexHookPath(configured), null);
assert.match(configured, /\[features\]\nmemories = true\nhooks = true/);
assert.match(configured, /\[mcp_servers\.demo\]/);
assert.equal((configured.slice(0, configured.indexOf("[features]")).match(/^hooks\s*=/gm) || []).length, 0);
assert.equal((configured.match(/^\s*hooks = true$/gm) || []).length, 1);

const repeated = ensureCodexHookConfiguration(configured);
assert.equal(repeated, configured);

const existing = `hooks = "/custom/hooks.json"\n\n[features]\nhooks = false\n`;
const preserved = ensureCodexHookConfiguration(existing);
assert.equal(configuredCodexHookPath(preserved), null);
assert.match(preserved, /\[features\]\nhooks = true/);
assert.doesNotMatch(preserved, /^hooks\s*=\s*"/m);
assert.equal(configuredCodexHookPath("hooks = 'relative-hooks.json'\n"), "relative-hooks.json");
assert.equal(configuredCodexHookPath("[mcp_servers.demo]\nhooks = \"/wrong/hooks.json\"\n"), null);
assert.equal(
  resolveCodexHookPath("/tmp/codex/config.toml", "relative-hooks.json"),
  "/tmp/codex/relative-hooks.json",
);

console.log("Coordinator hook configuration tests passed: additive JSON hooks and idempotent Codex TOML configuration.");

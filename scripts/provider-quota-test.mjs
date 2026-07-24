#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_QUOTA_MAX_STALE_MS,
  PROVIDER_QUOTA_REFRESH_MS,
  collectClaudeQuota,
  collectCodexQuota,
  createProviderQuotaMonitor,
  parseClaudeUsage,
  parseCodexRateLimits,
} from "../src/provider-quota.mjs";
import { displayWidth, renderProviderQuotaFooter, stripAnsi } from "../src/mission-control.mjs";

assert.equal(PROVIDER_QUOTA_REFRESH_MS, 60_000);
assert.equal(PROVIDER_QUOTA_MAX_STALE_MS, 300_000);

const codex = parseCodexRateLimits({
  rateLimits: {
    planType: "pro",
    primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 200 },
  },
}, 1_000);
assert.equal(codex.windows.fiveHour.remainingPercent, 18);
assert.equal(codex.windows.week.remainingPercent, 59);
assert.equal(codex.windows.fiveHour.resetsAt, 100);
assert.equal(codex.windows.week.windowMinutes, 10_080);
assert.equal(parseCodexRateLimits({ rateLimits: { primary: { used_percent: 82, window_duration_mins: 300 } } }, 1_000).status, "unavailable");

const claudeWindows = parseClaudeUsage([
  "Current session: 49% used · resets Jul 24 at 2:20pm (America/New_York)",
  "Current week (all models): 54% used · resets Jul 27 at 1am (America/New_York)",
].join("\n"));
assert.equal(claudeWindows.fiveHour.remainingPercent, 51);
assert.equal(claudeWindows.week.remainingPercent, 46);
assert.equal(claudeWindows.fiveHour.resetsAt, null);

const executableRoot = await mkdtemp(join(tmpdir(), "bridge-provider-quota-"));
try {
  const claudeStub = join(executableRoot, "claude-stub");
  await writeFile(claudeStub, `#!/usr/bin/env node
const required = ["--safe-mode", "--no-session-persistence", "-p", "--output-format", "json", "/usage"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(required)) process.exit(9);
console.log(JSON.stringify({ type: "result", num_turns: 0, result: "Current session: 49% used · resets later\\nCurrent week (all models): 54% used · resets later" }));
`);
  await chmod(claudeStub, 0o755);
  const spawnedClaude = await collectClaudeQuota({ command: claudeStub, now: 2_000 });
  assert.equal(spawnedClaude.windows.fiveHour.remainingPercent, 51);
  assert.equal(spawnedClaude.windows.week.remainingPercent, 46);
  await writeFile(claudeStub, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "result", num_turns: 1, result: "This was not a built-in usage response." }));
`);
  await assert.rejects(
    () => collectClaudeQuota({ command: claudeStub, now: 2_500 }),
    (error) => error.permanent === true && /zero-turn/.test(error.message),
  );

  const codexStub = join(executableRoot, "codex-stub");
  await writeFile(codexStub, `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.jsonrpc !== "2.0") process.exit(8);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  }
  if (message.method === "account/rateLimits/read") {
    if (message.jsonrpc !== "2.0" || Object.hasOwn(message, "params")) process.exit(7);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { rateLimits: { primary: { usedPercent: 93, windowDurationMins: 10080, resetsAt: 1785258167 } } } }));
  }
});
`);
  await chmod(codexStub, 0o755);
  const spawnedCodex = await collectCodexQuota({ command: codexStub, now: 3_000 });
  assert.equal(spawnedCodex.windows.week.remainingPercent, 7);
} finally {
  await rm(executableRoot, { recursive: true, force: true });
}

let clock = Date.parse("2026-07-24T12:00:00.000Z");
let calls = 0;
let shouldFail = false;
const monitor = createProviderQuotaMonitor({
  now: () => clock,
  collectors: {
    codex: async ({ now }) => {
      calls += 1;
      if (shouldFail) throw new Error("temporary capacity failure");
      return parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }, now);
    },
  },
});
let snapshot = await monitor.snapshot({ waitForRefresh: true });
assert.equal(calls, 1);
assert.equal(snapshot.providers.codex.status, "available");
clock += 59_999;
snapshot = await monitor.snapshot({ waitForRefresh: true });
assert.equal(calls, 1, "quota must not refresh before one minute");
clock += 1;
shouldFail = true;
snapshot = await monitor.snapshot({ waitForRefresh: true });
assert.equal(calls, 2);
assert.equal(snapshot.providers.codex.status, "stale");
assert.equal(snapshot.providers.codex.windows.fiveHour.remainingPercent, 90, "failed refresh must retain the last good reading");
assert.match(snapshot.providers.codex.error, /temporary capacity failure/);
const retainedStaleSnapshot = structuredClone(snapshot);
clock += PROVIDER_QUOTA_MAX_STALE_MS + 1;
snapshot = await monitor.snapshot({ waitForRefresh: true });
assert.equal(snapshot.providers.codex.status, "unavailable", "an old stale reading must eventually expire");
assert.equal(snapshot.providers.codex.windows.fiveHour, null);

let aborted = false;
const abortMonitor = createProviderQuotaMonitor({
  collectors: {
    claude: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  },
});
const abortRefresh = abortMonitor.refresh();
abortMonitor.stop();
await abortRefresh;
assert.equal(aborted, true, "stop must abort an in-flight provider probe");

const footerSnapshot = {
  ...retainedStaleSnapshot,
  updatedAt: "2026-07-24T12:01:00.000Z",
  providers: {
    ...retainedStaleSnapshot.providers,
    claude: { provider: "claude", status: "available", windows: claudeWindows },
  },
};
const wide = renderProviderQuotaFooter(footerSnapshot, { width: 180, color: false });
assert.match(wide, /QUOTA REMAINING · refresh 1m/);
assert.match(wide, /Codex 5h ~90% · wk —/);
assert.match(wide, /Claude 5h 51% · wk 46%/);
assert.match(wide, /Antigravity —/);
assert.match(wide, /Docker local/);
assert.match(wide, /Ollama local/);
const compact = renderProviderQuotaFooter(footerSnapshot, { width: 74, color: true });
assert.ok(displayWidth(compact) <= 74);
assert.match(stripAnsi(compact), /C 5h~90%\/wk—/);
const narrow = renderProviderQuotaFooter(footerSnapshot, { width: 30, color: false });
assert.ok(displayWidth(narrow) <= 30);
assert.match(narrow, /D\+O:L/);

console.log("provider quota tests passed");

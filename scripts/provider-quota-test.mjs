#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  PROVIDER_QUOTA_REFRESH_MS,
  createProviderQuotaMonitor,
  parseClaudeUsage,
  parseCodexRateLimits,
} from "../src/provider-quota.mjs";
import { displayWidth, renderProviderQuotaFooter, stripAnsi } from "../src/mission-control.mjs";

assert.equal(PROVIDER_QUOTA_REFRESH_MS, 60_000);

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

const claudeWindows = parseClaudeUsage([
  "Current session: 49% used · resets Jul 24 at 2:20pm (America/New_York)",
  "Current week (all models): 54% used · resets Jul 27 at 1am (America/New_York)",
].join("\n"));
assert.equal(claudeWindows.fiveHour.remainingPercent, 51);
assert.equal(claudeWindows.week.remainingPercent, 46);
assert.equal(claudeWindows.fiveHour.resetsAt, null);

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

const footerSnapshot = {
  ...snapshot,
  updatedAt: "2026-07-24T12:01:00.000Z",
  providers: {
    ...snapshot.providers,
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

import assert from "node:assert/strict";
import {
  CLAIMED_ISSUE_CONTEXT_MARKER,
  buildClaimedIssueContext,
  hydrateClaimedIssueTask,
  isAgentBridgeClaimComment,
} from "../src/claimed-issue-context.mjs";

const issue = {
  title: "Private issue",
  body: "Implement the bounded change.",
  html_url: "https://github.com/owner/private/issues/42",
  updated_at: "2026-07-21T10:00:00Z",
};
const triage = {
  user: { login: "owner" },
  body: "## JIT triage — ready for execution\nUse the smallest coherent slice.",
  created_at: "2026-07-21T10:01:00Z",
  html_url: "https://github.com/owner/private/issues/42#issuecomment-1",
};
const lease = {
  user: { login: "builder[bot]" },
  body: "### Agent Bridge Issue Claim Lease\n<!-- agent-bridge-issue-claim\n{}\n-->",
  created_at: "2026-07-21T10:02:00Z",
};
const olderDiscussion = {
  user: { login: "contributor" },
  body: `## Design discussion\n${"old context ".repeat(600)}`,
  created_at: "2026-07-20T10:00:00Z",
};

assert.equal(isAgentBridgeClaimComment(lease), true);
assert.equal(isAgentBridgeClaimComment(triage), false);

const context = buildClaimedIssueContext({
  repository: "owner/private",
  issueNumber: 42,
  issue,
  comments: [lease, triage],
  capturedAt: "2026-07-21T10:03:00Z",
});
assert.match(context.text, new RegExp(CLAIMED_ISSUE_CONTEXT_MARKER));
assert.match(context.text, /Private issue/);
assert.match(context.text, /JIT triage/);
assert.match(context.text, /Do not use gh/);
assert.doesNotMatch(context.text, /Issue Claim Lease/);
assert.equal(context.metadata.commentsAvailable, 1);
assert.equal(context.metadata.commentsIncluded, 1);
assert.equal(context.metadata.truncated, false);
assert.match(context.metadata.sha256, /^[0-9a-f]{64}$/);

const bounded = buildClaimedIssueContext({
  repository: "owner/private",
  issueNumber: 42,
  issue: { ...issue, body: "x".repeat(10_000) },
  comments: [olderDiscussion, triage],
  capturedAt: "2026-07-21T10:03:00Z",
  maxChars: 4_000,
});
assert.ok(bounded.text.length <= 4_000);
assert.equal(bounded.metadata.truncated, true);
assert.match(bounded.text, /JIT triage/);

const calls = [];
const hydrated = await hydrateClaimedIssueTask({
  client: {
    async getIssue(number) { calls.push(["issue", number]); return issue; },
    async getIssueComments(number) { calls.push(["comments", number]); return [triage, lease]; },
  },
  repository: "owner/private",
  issueNumber: 42,
  task: "Implement issue #42 after inspecting it on GitHub.",
  capturedAt: "2026-07-21T10:03:00Z",
});
assert.deepEqual(calls.sort(), [["comments", 42], ["issue", 42]]);
assert.match(hydrated.task, /^Implement issue #42/);
assert.match(hydrated.task, /earlier instruction to inspect this issue.*is satisfied by this snapshot/s);

let providerLaunched = false;
await assert.rejects(
  hydrateClaimedIssueTask({
    client: {
      async getIssue() { throw new Error("private repository read denied"); },
      async getIssueComments() { return []; },
    },
    repository: "owner/private",
    issueNumber: 42,
    task: "Implement issue #42.",
  }).then(() => { providerLaunched = true; }),
  /Unable to hydrate claimed issue owner\/private#42 before provider launch: private repository read denied/,
);
assert.equal(providerLaunched, false);

console.log("Claimed issue context hydration tests passed.");

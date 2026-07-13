import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { reviewMarker, submitBoundReview } from "../src/github-review-client.mjs";
import { parseReviewEnvelope, reviewEnvelopeInstructions } from "../src/review-envelope.mjs";

const base = {
  apiUrl: "https://github.test",
  token: "secret-test-token",
  repository: "owner/repo",
  prNumber: 42,
  headSha: "a".repeat(40),
  expectedLogin: "review-bot",
  event: "REQUEST_CHANGES",
  body: "P1: Fix the boundary.",
  comments: [{ path: "src/a.js", line: 8, side: "RIGHT", body: "Validate this input." }],
};

const envelopeInstructions = reviewEnvelopeInstructions({
  githubReview: base,
  handoffPath: "docs/handoffs/task-12.md",
});
assert.match(envelopeInstructions, /owner\/repo PR #42/);
assert.match(envelopeInstructions, /BEGIN BOUND_GITHUB_REVIEW/);
const envelope = parseReviewEnvelope(`Independent review complete.\n---BEGIN BOUND_GITHUB_REVIEW---\n${JSON.stringify({
  handoff: "# Antigravity review\n\nVerified.",
  event: "APPROVE",
  body: "Antigravity independently verified the change.",
  comments: [],
})}\n---END BOUND_GITHUB_REVIEW---`);
assert.equal(envelope.event, "APPROVE");
assert.match(envelope.handoff, /Antigravity review/);
await assert.rejects(async () => parseReviewEnvelope("no envelope"), /required bound GitHub review envelope/);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeGitHub({ login = "review-bot", headSha = base.headSha, files = ["src/a.js"], reviews = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, "Bearer secret-test-token");
    if (url.endsWith("/user")) return json({ login });
    if (url.includes("/pulls/42/files")) return json(files.map((filename) => ({ filename })));
    if (url.includes("/pulls/42/reviews") && options.method !== "POST") return json(reviews);
    if (url.endsWith("/pulls/42") && options.method !== "POST") return json({ head: { sha: headSha } });
    if (url.endsWith("/pulls/42/reviews") && options.method === "POST") {
      return json({
        id: 99,
        html_url: "https://github.test/review/99",
        state: "CHANGES_REQUESTED",
        user: { login },
      }, 201);
    }
    return json({ message: `Unexpected URL ${url}` }, 404);
  };
  return { fetchImpl, calls };
}

const successApi = fakeGitHub();
const submitted = await submitBoundReview({ ...base, fetchImpl: successApi.fetchImpl });
assert.equal(submitted.login, "review-bot");
assert.equal(submitted.idempotent, false);
const post = successApi.calls.find((call) => call.options.method === "POST");
const payload = JSON.parse(post.options.body);
assert.equal(payload.commit_id, base.headSha);
assert.equal(payload.event, "REQUEST_CHANGES");
assert.deepEqual(payload.comments, base.comments);
assert.match(payload.body, /agent-bridge-review/);

await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ login: "wrong-user" }).fetchImpl }),
  /identity mismatch/,
);
await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ headSha: "b".repeat(40) }).fetchImpl }),
  /head changed/,
);
await assert.rejects(
  submitBoundReview({ ...base, fetchImpl: fakeGitHub({ files: ["src/other.js"] }).fetchImpl }),
  /not in the pull request diff/,
);

const marker = reviewMarker(base);
const prior = {
  id: 77,
  html_url: "https://github.test/review/77",
  state: "CHANGES_REQUESTED",
  body: `Already posted\n${marker}`,
  user: { login: "review-bot" },
};
const idempotentApi = fakeGitHub({ reviews: [prior] });
const idempotent = await submitBoundReview({ ...base, fetchImpl: idempotentApi.fetchImpl });
assert.equal(idempotent.id, 77);
assert.equal(idempotent.idempotent, true);
assert.equal(idempotentApi.calls.some((call) => call.options.method === "POST"), false);

const temporary = await mkdtemp(join(tmpdir(), "github-review-mcp-test-"));
const tokenFile = join(temporary, "token");
const handoffFile = join(temporary, "handoff.md");
await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
await writeFile(handoffFile, "", { mode: 0o600 });
let postedPayload = null;
let postCount = 0;
const httpServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method === "POST") {
    postCount += 1;
    postedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  response.setHeader("content-type", "application/json");
  if (request.url === "/user") response.end(JSON.stringify({ login: "review-bot" }));
  else if (request.url === "/repos/owner/repo/pulls/42") response.end(JSON.stringify({ head: { sha: base.headSha } }));
  else if (request.url.startsWith("/repos/owner/repo/pulls/42/reviews?") && request.method === "GET") response.end("[]");
  else if (request.url === "/repos/owner/repo/pulls/42/reviews" && request.method === "POST") {
    response.statusCode = 201;
    response.end(JSON.stringify({
      id: 123,
      html_url: "https://github.test/review/123",
      state: "APPROVED",
      user: { login: "review-bot" },
    }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `Unexpected ${request.method} ${request.url}` }));
  }
});
httpServer.listen(0, "127.0.0.1");
await once(httpServer, "listening");
const port = httpServer.address().port;
const mcpClient = new Client({ name: "github-review-integration", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../src/github-review-bridge.mjs")],
  env: {
    ...process.env,
    GITHUB_REVIEW_REPOSITORY: "owner/repo",
    GITHUB_REVIEW_PR_NUMBER: "42",
    GITHUB_REVIEW_HEAD_SHA: base.headSha,
    GITHUB_REVIEW_EXPECTED_LOGIN: "review-bot",
    GITHUB_REVIEW_HANDOFF_PATH: handoffFile,
    GITHUB_REVIEW_TOKEN_FILE: tokenFile,
    GITHUB_REVIEW_API_URL: `http://127.0.0.1:${port}`,
  },
});
try {
  await mcpClient.connect(transport);
  const handoffResult = await mcpClient.callTool({
    name: "write_handoff",
    arguments: { content: "# Review handoff\n\nVerified independently." },
  });
  assert.notEqual(handoffResult.isError, true);
  assert.equal(handoffResult.structuredContent.handoffPath, handoffFile);
  assert.match(await readFile(handoffFile, "utf8"), /Verified independently/);
  const result = await mcpClient.callTool({
    name: "submit_pr_review",
    arguments: { event: "APPROVE", body: "Approved after independent verification.", comments: [] },
  });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.login, "review-bot");
  assert.equal(postedPayload.commit_id, base.headSha);
  assert.equal(postedPayload.event, "APPROVE");
  assert.match(await readFile(handoffFile, "utf8"), /github\.test\/review\/123/);
  const duplicate = await mcpClient.callTool({
    name: "submit_pr_review",
    arguments: { event: "COMMENT", body: "A second payload must not create another review.", comments: [] },
  });
  assert.equal(duplicate.structuredContent.idempotent, true);
  assert.equal(postCount, 1);
} finally {
  await mcpClient.close().catch(() => {});
  httpServer.close();
  await once(httpServer, "close");
  await rm(temporary, { recursive: true, force: true });
}

console.log("Bound GitHub review tests passed: identity, SHA, inline scope, payload, idempotency, and MCP receipt.");

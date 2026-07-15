#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createInstallationToken, GITHUB_LOGIN_PATTERN, inspectGitHubAppRoles } from "./github-app-auth.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";

const repository = process.env.GITHUB_BUILDER_REPOSITORY;
const expectedLogin = process.env.GITHUB_BUILDER_EXPECTED_LOGIN;
const headSha = process.env.GITHUB_BUILDER_HEAD_SHA;
const prNumber = process.env.GITHUB_BUILDER_PR_NUMBER
  ? Number.parseInt(process.env.GITHUB_BUILDER_PR_NUMBER, 10)
  : null;
const headRef = process.env.GITHUB_BUILDER_HEAD_REF || null;
const baseRef = process.env.GITHUB_BUILDER_BASE_REF || null;
const apiUrl = process.env.GITHUB_BUILDER_API_URL || "https://api.github.com";
const allowedOperations = (process.env.GITHUB_BUILDER_ALLOWED_OPERATIONS || "ensure_pull_request,read_review_threads,reply_review_thread,resolve_review_thread,mark_ready")
  .split(",").map((value) => value.trim()).filter(Boolean);

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) throw new Error("GITHUB_BUILDER_REPOSITORY must be owner/name.");
if (!GITHUB_LOGIN_PATTERN.test(expectedLogin || "")) throw new Error("GITHUB_BUILDER_EXPECTED_LOGIN is invalid.");
if (!/^[0-9a-f]{40}$/i.test(headSha || "")) throw new Error("GITHUB_BUILDER_HEAD_SHA must be a full SHA.");

const credential = await createInstallationToken({ role: "builder", repository });
if (credential.expectedLogin !== expectedLogin) {
  throw new Error(`Configured builder identity ${credential.expectedLogin} does not match authorized identity ${expectedLogin}.`);
}
const appRoles = await inspectGitHubAppRoles();
const trustedReviewLogins = [
  appRoles.roles?.reviewer?.expectedLogin,
  ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.expectedLogin),
].filter(Boolean);
const client = createBoundBuilderClient({
  apiUrl,
  token: credential.token,
  verifiedLogin: credential.verifiedLogin,
  repository,
  expectedLogin,
  headSha,
  prNumber,
  headRef,
  baseRef,
  allowedOperations,
  requiredReviewStatusContext: process.env.GITHUB_BUILDER_REVIEW_STATUS_CONTEXT || "agent-review",
  trustedReviewLogins,
  trustedHumanReviewLogins: appRoles.mergePolicy?.trustedHumanReviewers || [],
});

const server = new McpServer(
  { name: "bounded-github-builder", version: "0.1.0" },
  { instructions: `Perform only these target-bound builder operations for ${repository} at ${headSha} as ${expectedLogin}: ${allowedOperations.join(", ")}.` },
);

const response = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

server.registerTool("ensure_pull_request", {
  title: "Create or update bound pull request",
  description: "Create or update the pull request for the pre-bound repository, head ref, base ref, and head SHA.",
  inputSchema: {
    title: z.string().min(1).max(256),
    body: z.string().max(60_000).default(""),
    draft: z.boolean().default(false),
  },
}, async (input) => response(await client.ensurePullRequest(input)));

server.registerTool("read_review_threads", {
  title: "Read bound pull request review threads",
  description: "Read review threads only from the pre-bound pull request and head SHA.",
  inputSchema: {},
}, async () => response({ threads: await client.reviewThreads(), repository, prNumber, headSha }));

server.registerTool("reply_review_thread", {
  title: "Reply to bound review thread",
  description: "Reply as the builder App to an exact thread proven to belong to the bound pull request.",
  inputSchema: { threadId: z.string().min(1), body: z.string().min(1).max(60_000) },
}, async (input) => response(await client.replyReviewThread(input)));

server.registerTool("resolve_review_thread", {
  title: "Resolve bound review thread",
  description: "Resolve an exact thread proven to belong to the bound pull request.",
  inputSchema: { threadId: z.string().min(1) },
}, async (input) => response(await client.resolveReviewThread(input)));

server.registerTool("mark_ready", {
  title: "Mark bound pull request ready",
  description: "Mark only the pre-bound pull request ready for review.",
  inputSchema: {},
}, async () => response(await client.markReady()));

server.registerTool("merge", {
  title: "Merge bound pull request",
  description: "Merge only the pre-bound pull request at the pre-bound head SHA.",
  inputSchema: { method: z.enum(["merge", "squash", "rebase"]).default("squash") },
}, async (input) => response(await client.merge(input)));

await server.connect(new StdioServerTransport());

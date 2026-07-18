#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInstallationToken, GITHUB_LOGIN_PATTERN, inspectGitHubAppRoles } from "./github-app-auth.mjs";
import { createBoundBuilderClient } from "./github-builder-client.mjs";
import { builderMcpInputSchema } from "./builder-contract.mjs";

const repository = process.env.GITHUB_BUILDER_REPOSITORY;
const expectedLogin = process.env.GITHUB_BUILDER_EXPECTED_LOGIN;
const headSha = process.env.GITHUB_BUILDER_HEAD_SHA;
const prNumber = process.env.GITHUB_BUILDER_PR_NUMBER
  ? Number.parseInt(process.env.GITHUB_BUILDER_PR_NUMBER, 10)
  : null;
const headRef = process.env.GITHUB_BUILDER_HEAD_REF || null;
const baseRef = process.env.GITHUB_BUILDER_BASE_REF || null;
const baseSha = process.env.GITHUB_BUILDER_BASE_SHA || null;
const apiUrl = process.env.GITHUB_BUILDER_API_URL || "https://api.github.com";
const allowedOperations = (process.env.GITHUB_BUILDER_ALLOWED_OPERATIONS || "ensure_pull_request,read_review_threads,reply_review_thread,resolve_review_thread,mark_ready")
  .split(",").map((value) => value.trim()).filter(Boolean);

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) throw new Error("GITHUB_BUILDER_REPOSITORY must be owner/name.");
if (!GITHUB_LOGIN_PATTERN.test(expectedLogin || "")) throw new Error("GITHUB_BUILDER_EXPECTED_LOGIN is invalid.");
if (!/^[0-9a-f]{40}$/i.test(headSha || "")) throw new Error("GITHUB_BUILDER_HEAD_SHA must be a full SHA.");
if (baseSha !== null && !/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("GITHUB_BUILDER_BASE_SHA must be a full SHA.");

const workspace = process.env.GITHUB_BUILDER_WORKSPACE || process.cwd();
const receiptPath = process.env.GITHUB_BUILDER_RECEIPT_PATH
  || `${workspace}/.bridge/github-builder-receipts.jsonl`;
const appRoles = await inspectGitHubAppRoles();
const trustedReviewLogins = [
  appRoles.roles?.reviewer?.expectedLogin,
  ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.expectedLogin),
].filter(Boolean);
const trustedReviewAppIds = [
  appRoles.roles?.reviewer?.appId,
  ...Object.values(appRoles.roles?.reviewers || {}).map((reviewer) => reviewer.appId),
].filter(Boolean).map(Number);

const getToken = async () => {
  const credential = await createInstallationToken({ role: "builder", repository });
  if (credential.expectedLogin !== expectedLogin) {
    throw new Error(`Configured builder identity ${credential.expectedLogin} does not match authorized identity ${expectedLogin}.`);
  }
  return { token: credential.token, verifiedLogin: credential.verifiedLogin };
};

const client = createBoundBuilderClient({
  apiUrl,
  getToken,
  workspace,
  receiptPath,
  repository,
  expectedLogin,
  headSha,
  prNumber,
  headRef,
  baseRef,
  baseSha,
  allowedOperations,
  requiredReviewStatusContext: process.env.GITHUB_BUILDER_REVIEW_STATUS_CONTEXT || "agent-review",
  trustedReviewLogins,
  trustedReviewAppIds,
  trustedHumanReviewLogins: appRoles.mergePolicy?.trustedHumanReviewers || [],
  mergeEnforcement: appRoles.github?.mergeEnforcement || "broker",
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
  inputSchema: builderMcpInputSchema("ensure_pull_request"),
}, async (input) => response(await client.ensurePullRequest(input)));

server.registerTool("read_review_threads", {
  title: "Read bound pull request review threads",
  description: "Read review threads only from the pre-bound pull request and head SHA.",
  inputSchema: {},
}, async () => response({ threads: await client.reviewThreads(), repository, prNumber, headSha }));

server.registerTool("reply_review_thread", {
  title: "Reply to bound review thread",
  description: "Reply as the builder App to an exact thread proven to belong to the bound pull request.",
  inputSchema: builderMcpInputSchema("reply_review_thread"),
}, async (input) => response(await client.replyReviewThread(input)));

server.registerTool("resolve_review_thread", {
  title: "Resolve bound review thread",
  description: "Resolve an exact thread proven to belong to the bound pull request.",
  inputSchema: builderMcpInputSchema("resolve_review_thread"),
}, async (input) => response(await client.resolveReviewThread(input)));

server.registerTool("mark_ready", {
  title: "Mark bound pull request ready",
  description: "Mark only the pre-bound pull request ready for review.",
  inputSchema: {},
}, async () => response(await client.markReady()));

server.registerTool("merge", {
  title: "Merge bound pull request",
  description: "Merge only the pre-bound pull request at the pre-bound head SHA.",
  inputSchema: builderMcpInputSchema("merge"),
}, async (input) => response(await client.merge(input)));

server.registerTool("create_branch", {
  title: "Create branch",
  description: "Create a branch for the pre-bound repository and head SHA.",
  inputSchema: builderMcpInputSchema("create_branch"),
}, async (input) => response(await client.createBranch(input)));

server.registerTool("push_branch", {
  title: "Push branch",
  description: "Update a branch for the pre-bound repository and head SHA using fast-forward push.",
  inputSchema: builderMcpInputSchema("push_branch"),
}, async (input) => response(await client.pushBranch(input)));

server.registerTool("replace_branch", {
  title: "Replace branch head",
  description: "Replace only the pre-bound bot-owned feature branch using exact old and new SHA compare-and-swap guards.",
  inputSchema: builderMcpInputSchema("replace_branch"),
}, async (input) => response(await client.replaceBranch(input)));

await server.connect(new StdioServerTransport());

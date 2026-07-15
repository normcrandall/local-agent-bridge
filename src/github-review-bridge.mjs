#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { submitBoundReview } from "./github-review-client.mjs";
import { canPublishReviewStatus, GITHUB_LOGIN_PATTERN, resolveReviewToken } from "./github-app-auth.mjs";

const repository = process.env.GITHUB_REVIEW_REPOSITORY;
const prNumber = Number.parseInt(process.env.GITHUB_REVIEW_PR_NUMBER || "", 10);
const headSha = process.env.GITHUB_REVIEW_HEAD_SHA;
const expectedLogin = process.env.GITHUB_REVIEW_EXPECTED_LOGIN;
const handoffPath = process.env.GITHUB_REVIEW_HANDOFF_PATH;
const tokenFile = process.env.GITHUB_REVIEW_TOKEN_FILE || resolve(homedir(), ".config/ghtoken");
const apiUrl = process.env.GITHUB_REVIEW_API_URL || "https://api.github.com";
const statusContext = process.env.GITHUB_REVIEW_STATUS_CONTEXT || "agent-review";
const publishStatusGate = process.env.GITHUB_REVIEW_PUBLISH_STATUS_GATE !== "0";

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
  throw new Error("GITHUB_REVIEW_REPOSITORY must be owner/name.");
}
if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("GITHUB_REVIEW_PR_NUMBER is invalid.");
if (!/^[0-9a-f]{40}$/i.test(headSha || "")) throw new Error("GITHUB_REVIEW_HEAD_SHA must be a full commit SHA.");
if (!GITHUB_LOGIN_PATTERN.test(expectedLogin || "")) throw new Error("GITHUB_REVIEW_EXPECTED_LOGIN is invalid.");
if (!handoffPath) throw new Error("GITHUB_REVIEW_HANDOFF_PATH is required.");

const credential = await resolveReviewToken({ repository, tokenFile, expectedLogin });
if (credential.expectedLogin && credential.expectedLogin !== expectedLogin) {
  throw new Error(`Configured reviewer identity ${credential.expectedLogin} does not match authorized identity ${expectedLogin}.`);
}
const { token, verifiedLogin } = credential;
const appCredential = credential.credentialSource === "github-app";
const statusGateEnabled = Boolean(
  appCredential
  && publishStatusGate
  && canPublishReviewStatus(credential.permissions),
);
const reviewApiUrl = verifiedLogin ? "https://api.github.com" : apiUrl;

const inlineComment = z.object({
  path: z.string().min(1),
  body: z.string().min(1).max(10_000),
  line: z.number().int().min(1),
  side: z.enum(["LEFT", "RIGHT"]),
  start_line: z.number().int().min(1).optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
}).strict();

const server = new McpServer(
  { name: "bounded-github-review", version: "0.1.0" },
  {
    instructions:
      `Submit exactly one formal review to ${repository} PR #${prNumber} at ${headSha} as ${expectedLogin}. Write the durable handoff first.${statusGateEnabled ? ` This reviewer App also publishes the exact-head ${statusContext} status.` : " This repository uses the formal App review as its merge gate; no machine status will be published."} A PAT compatibility credential is comment-only. This server cannot access any other repository, PR, commit, or GitHub mutation.`,
  },
);
let submittedReview = null;

server.registerTool(
  "write_handoff",
  {
    title: "Write bound review handoff",
    description: `Write the durable review artifact to the single pre-bound path ${handoffPath}. No other file can be changed.`,
    inputSchema: {
      content: z.string().min(1).max(100_000),
    },
  },
  async ({ content }) => {
    await writeFile(handoffPath, `${content.trimEnd()}\n`, { mode: 0o600 });
    return {
      content: [{ type: "text", text: `Wrote the bound review handoff: ${handoffPath}` }],
      structuredContent: { handoffPath, bytes: Buffer.byteLength(`${content.trimEnd()}\n`) },
    };
  },
);

server.registerTool(
  "submit_pr_review",
  {
    title: "Submit bound pull request review",
    description:
      `Submit the completed review to ${repository} PR #${prNumber}${statusGateEnabled ? " and publish its exact-head machine-review status" : " as the exact-head formal App review"}. The token identity, PR, and head commit are pre-bound outside the model context.`,
    inputSchema: {
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string().min(1).max(60_000),
      comments: z.array(inlineComment).max(50).default([]),
    },
  },
  async ({ event, body, comments }) => {
    if (submittedReview) {
      return {
        content: [{
          type: "text",
          text: `This delegated review session already submitted its bound review: ${submittedReview.url}`,
        }],
        structuredContent: { ...submittedReview, idempotent: true },
      };
    }
    const handoff = await readFile(handoffPath, "utf8");
    if (!handoff.trim()) throw new Error("The authorized handoff file is empty; write it before posting the review.");
    if (!appCredential && event !== "COMMENT") {
      throw new Error("A PAT fallback may post an attributed comment but cannot APPROVE or REQUEST_CHANGES; configure the reviewer GitHub App.");
    }
    const result = await submitBoundReview({
      apiUrl: reviewApiUrl,
      token,
      repository,
      prNumber,
      headSha,
      expectedLogin,
      verifiedLogin,
      event,
      body,
      comments,
      statusContext,
      publishGate: statusGateEnabled,
    });
    submittedReview = result;
    const gateReceipt = result.gate
      ? `gate \`${result.gate.context}\` = \`${result.gate.state}\``
      : appCredential
        ? "formal App review gate (no commit status configured)"
        : "no machine gate (PAT compatibility comment only)";
    const receipt = `- **PR review:** [${result.state || event}](${result.url}) as \`${result.login}\` at \`${headSha.slice(0, 12)}\`; ${gateReceipt}`;
    if (!handoff.includes(result.url)) await appendFile(handoffPath, `\n\n${receipt}\n`);
    return {
      content: [{
        type: "text",
        text: `${result.idempotent ? "Existing" : "Posted"} ${event} review as ${result.login}: ${result.url}`,
      }],
      structuredContent: result,
    };
  },
);

await server.connect(new StdioServerTransport());

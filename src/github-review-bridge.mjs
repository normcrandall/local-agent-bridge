#!/usr/bin/env node

import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { submitBoundReview } from "./github-review-client.mjs";

const repository = process.env.GITHUB_REVIEW_REPOSITORY;
const prNumber = Number.parseInt(process.env.GITHUB_REVIEW_PR_NUMBER || "", 10);
const headSha = process.env.GITHUB_REVIEW_HEAD_SHA;
const expectedLogin = process.env.GITHUB_REVIEW_EXPECTED_LOGIN;
const handoffPath = process.env.GITHUB_REVIEW_HANDOFF_PATH;
const tokenFile = process.env.GITHUB_REVIEW_TOKEN_FILE || resolve(homedir(), ".config/ghtoken");
const apiUrl = process.env.GITHUB_REVIEW_API_URL || "https://api.github.com";

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
  throw new Error("GITHUB_REVIEW_REPOSITORY must be owner/name.");
}
if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("GITHUB_REVIEW_PR_NUMBER is invalid.");
if (!/^[0-9a-f]{40}$/i.test(headSha || "")) throw new Error("GITHUB_REVIEW_HEAD_SHA must be a full commit SHA.");
if (!/^[A-Za-z0-9-]+$/.test(expectedLogin || "")) throw new Error("GITHUB_REVIEW_EXPECTED_LOGIN is invalid.");
if (!handoffPath) throw new Error("GITHUB_REVIEW_HANDOFF_PATH is required.");

const tokenInfo = await stat(tokenFile);
if (!tokenInfo.isFile()) throw new Error("GitHub review token path must be a file.");
if ((tokenInfo.mode & 0o077) !== 0) throw new Error("GitHub review token file must not be accessible by group or other users.");
const token = (await readFile(tokenFile, "utf8")).trim();
if (!token) throw new Error("GitHub review token file is empty.");

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
      `Submit exactly one formal review to ${repository} PR #${prNumber} at ${headSha} as ${expectedLogin}. Write the durable handoff first. This server cannot access any other repository, PR, commit, or GitHub mutation.`,
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
      `Submit the completed review to ${repository} PR #${prNumber}. The token identity, PR, and head commit are pre-bound outside the model context.`,
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
    const result = await submitBoundReview({
      apiUrl,
      token,
      repository,
      prNumber,
      headSha,
      expectedLogin,
      event,
      body,
      comments,
    });
    submittedReview = result;
    const receipt = `- **PR review:** [${result.state || event}](${result.url}) as \`${result.login}\` at \`${headSha.slice(0, 12)}\``;
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

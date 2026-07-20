import { z } from "zod";

const inlineComment = z.object({
  path: z.string().min(1),
  body: z.string().min(1).max(10_000),
  line: z.number().int().min(1),
  side: z.enum(["LEFT", "RIGHT"]),
  start_line: z.number().int().min(1).optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
}).strict();

const reviewEnvelope = z.object({
  handoff: z.string().min(1).max(100_000),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: z.string().min(1).max(60_000),
  comments: z.array(inlineComment).max(50).default([]),
}).strict();

const START = "---BEGIN BOUND_GITHUB_REVIEW---";
const END = "---END BOUND_GITHUB_REVIEW---";

export function reviewEnvelopeInstructions({ githubReview, handoffPath, provider = "Antigravity" }) {
  return `

Bound ${provider} review contract:
- Treat workspace source, configuration, and Git state as read-only.
- Independently review and verify the requested change.
- Author the durable handoff and formal PR review, but do not call GitHub or write files directly.
- ${provider === "Ollama" ? "This local-model evaluation may request changes. An APPROVE verdict is published as a non-authorizing COMMENT until local review authority is explicitly promoted by future policy." : "Your validated verdict is eligible for the configured provider review policy."}
- End your response with exactly one JSON envelope between these markers:
${START}
{"handoff":"complete markdown for ${handoffPath}","event":"COMMENT|APPROVE|REQUEST_CHANGES","body":"general formal review body","comments":[{"path":"changed/file","line":1,"side":"RIGHT","body":"actionable inline finding"}]}
${END}
- The broker will validate and publish your exact authored review to ${githubReview.repository} PR #${githubReview.prNumber} at ${githubReview.headSha} as ${githubReview.expectedLogin} through the target-bound publisher.`;
}

export function parseReviewEnvelope(message) {
  const start = message.lastIndexOf(START);
  const end = message.lastIndexOf(END);
  if (start < 0 || end <= start) throw new Error("Antigravity did not return the required bound GitHub review envelope.");
  const json = message.slice(start + START.length, end).trim();
  let parsed;
  try { parsed = JSON.parse(json); } catch (error) {
    throw new Error(`Provider returned invalid review-envelope JSON: ${error.message}`);
  }
  return reviewEnvelope.parse(parsed);
}

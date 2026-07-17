import { z } from "zod";

const operation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ensure_pull_request"), title: z.string().min(1).max(256), body: z.string().max(60_000), draft: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("reply_review_thread"), threadId: z.string().min(1), body: z.string().min(1).max(60_000) }).strict(),
  z.object({ operation: z.literal("resolve_review_thread"), threadId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("mark_ready") }).strict(),
  z.object({ operation: z.literal("merge"), method: z.enum(["merge", "squash", "rebase"]).default("squash") }).strict(),
  z.object({ operation: z.literal("create_branch"), ref: z.string().min(1).max(220), sha: z.string().regex(/^[0-9a-f]{40}$/i) }).strict(),
  z.object({ operation: z.literal("push_branch"), ref: z.string().min(1).max(220), sha: z.string().regex(/^[0-9a-f]{40}$/i), oldSha: z.string().regex(/^[0-9a-f]{40}$/i).optional() }).strict(),
]);

const envelope = z.object({ operations: z.array(operation).min(1).max(20) }).strict();
const START = "---BEGIN BOUND_GITHUB_BUILDER---";
const END = "---END BOUND_GITHUB_BUILDER---";

export function builderEnvelopeInstructions({ githubBuilder, threads = [] }) {
  return `

Bound Antigravity builder contract:
- GitHub mutations are authorized only for ${githubBuilder.repository}${githubBuilder.prNumber ? ` PR #${githubBuilder.prNumber}` : ""} at ${githubBuilder.headSha} as ${githubBuilder.expectedLogin}.
- Allowed operations: ${(githubBuilder.allowedOperations || []).join(", ")}.
- Do not use gh, general GitHub access, or another agent.
- Current bound review threads: ${JSON.stringify(threads)}
- End with exactly this validated envelope. The broker will publish it unchanged through bound builder credentials:
${START}
{"operations":[{"operation":"reply_review_thread","threadId":"exact thread id","body":"reply"}]}
${END}`;
}

export function parseBuilderEnvelope(text) {
  const start = text.lastIndexOf(START);
  const end = text.indexOf(END, start + START.length);
  if (start < 0 || end <= start) throw new Error("Antigravity did not return the required bound GitHub builder envelope.");
  let parsed;
  try { parsed = JSON.parse(text.slice(start + START.length, end).trim()); }
  catch (error) { throw new Error(`Antigravity returned invalid builder-envelope JSON: ${error.message}`); }
  return envelope.parse(parsed);
}

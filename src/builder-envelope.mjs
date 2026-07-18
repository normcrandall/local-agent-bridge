import { builderEnvelopeSchema } from "./builder-contract.mjs";

// The Antigravity envelope schema is derived from the single canonical builder
// contract so it can never drift from the Claude/Codex MCP tool schemas.
const envelope = builderEnvelopeSchema();
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

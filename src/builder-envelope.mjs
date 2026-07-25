import { BUILDER_OPERATIONS, builderEnvelopeSchema, builderOperationShapes } from "./builder-contract.mjs";

// The Antigravity envelope schema is derived from the single canonical builder
// contract so it can never drift from the Claude/Codex MCP tool schemas.
// Work-mode Antigravity conversations can legitimately have intermediate
// turns with no GitHub mutation. Keep the canonical operation schema strict,
// but permit an explicit empty batch so those turns are not misclassified as
// provider failures.
const envelope = builderEnvelopeSchema({ allowEmpty: true });
const START = "---BEGIN BOUND_GITHUB_BUILDER---";
const END = "---END BOUND_GITHUB_BUILDER---";

// A rejected envelope that is a *delivery syntax* failure only: the provider
// finished its implementation but described the mutation with non-canonical
// fields. These are repairable inside the same provider conversation without
// re-running implementation or transferring writer custody.
//
// stage:
//   missing - no envelope at all. NOT repairable here: it is indistinguishable
//             from a turn that never reached the delivery step, so the caller
//             keeps its normal handling instead of demanding an envelope.
//   json    - the delimiters were present but the payload is not valid JSON.
//   schema  - the payload parsed but violates the canonical operation contract.
export class BuilderEnvelopeError extends Error {
  constructor(message, { stage, diagnostics = [], operations = [] } = {}) {
    super(message);
    this.name = "BuilderEnvelopeError";
    this.stage = stage;
    this.diagnostics = diagnostics;
    // Operation names the provider attempted, used to quote only the relevant
    // canonical shapes back to it during repair.
    this.operations = operations;
    this.schemaOnly = stage === "json" || stage === "schema";
  }
}

// Example values for canonical fields. Keyed by field name so the rendered
// example follows the contract shape rather than a hand-maintained snippet.
function exampleValue(field, { githubBuilder, threads }) {
  const sha = /^[0-9a-f]{40}$/i.test(githubBuilder?.headSha || "")
    ? githubBuilder.headSha.toLowerCase()
    : "0".repeat(40);
  const threadId = threads?.[0]?.id || threads?.[0]?.threadId || "exact bound thread id";
  switch (field) {
    case "ref": return "refs/heads/your-delivery-branch";
    case "sha": return sha;
    case "oldSha": return sha;
    case "title": return "Concise pull request title";
    case "body": return "Pull request or reply body";
    case "draft": return false;
    case "threadId": return threadId;
    case "method": return "squash";
    default: return null;
  }
}

function optionalField(schema) {
  // Optional and defaulted fields both accept undefined; anything else is
  // required. Derived by probing the canonical schema so a contract change
  // cannot leave these instructions stale.
  return schema.safeParse(undefined).success;
}

function fieldTypeLabel(field, schema) {
  if (field === "sha" || field === "oldSha") return "40-character commit SHA";
  if (field === "ref") return "full git ref, e.g. refs/heads/<branch>";
  if (field === "method") return "merge | squash | rebase";
  const type = schema?.def?.type || schema?._def?.typeName || "value";
  return String(type).replace(/^Zod/, "").toLowerCase();
}

// One canonical, contract-derived specification per allowed operation, with a
// concrete example that is itself validated against the canonical schema.
export function builderOperationSpecifications({ githubBuilder, threads = [] } = {}) {
  const allowed = new Set(githubBuilder?.allowedOperations || BUILDER_OPERATIONS);
  const shapes = builderOperationShapes();
  const specifications = [];
  for (const operation of BUILDER_OPERATIONS) {
    if (!allowed.has(operation)) continue;
    const shape = shapes[operation];
    const fields = [];
    const example = { operation };
    for (const [field, schema] of Object.entries(shape)) {
      const optional = optionalField(schema);
      fields.push(`${field} (${fieldTypeLabel(field, schema)}${optional ? ", optional" : ", required"})`);
      const value = exampleValue(field, { githubBuilder, threads });
      if (value === null) continue;
      if (!optional || field === "body") example[field] = value;
    }
    specifications.push({
      operation,
      fields,
      example,
      canonical: fields.length ? fields.join(", ") : "no fields",
    });
  }
  // Fail closed if a contract change makes a generated example invalid, rather
  // than teaching Antigravity a shape the broker will reject.
  const check = specifications.length
    ? builderEnvelopeSchema({ maxOperations: specifications.length })
      .safeParse({ operations: specifications.map((entry) => entry.example) })
    : { success: true };
  if (!check.success) {
    throw new Error(`Generated builder-envelope examples do not satisfy the canonical contract: ${compactDiagnostics(check.error).join("; ")}`);
  }
  return specifications;
}

function renderSpecifications(specifications) {
  return specifications
    .map((entry) => `  - ${entry.operation}: ${entry.canonical}\n    example: ${JSON.stringify(entry.example)}`)
    .join("\n");
}

export function builderEnvelopeInstructions({ githubBuilder, threads = [] }) {
  const specifications = builderOperationSpecifications({ githubBuilder, threads });
  return `

Bound Antigravity builder contract:
- GitHub mutations are authorized only for ${githubBuilder.repository}${githubBuilder.prNumber ? ` PR #${githubBuilder.prNumber}` : ""} at ${githubBuilder.headSha} as ${githubBuilder.expectedLogin}.
- Do not use gh, general GitHub access, or another agent.
- Current bound review threads: ${JSON.stringify(threads)}
- Canonical operations you may emit, with their exact field names. Field names are literal: aliases such as branch, headCommit, head, base, or commit are rejected before publication.
${renderSpecifications(specifications)}
- End with exactly this validated envelope, containing one entry per intended mutation. Use {"operations":[]} when this turn has no GitHub mutation. The broker will publish non-empty operations unchanged through bound builder credentials:
${START}
{"operations":[${JSON.stringify(specifications[0]?.example ?? {})}]}
${END}`;
}

// Compact, provider-facing rendering of Zod issues: enough to correct the exact
// fields without echoing the whole schema back into the conversation.
export function compactDiagnostics(zodError, limit = 12) {
  const issues = zodError?.issues || [];
  const lines = issues.slice(0, limit).map((issue) => {
    const path = (issue.path || []).join(".") || "operations";
    if (issue.code === "unrecognized_keys") {
      return `${path}: unrecognized field${issue.keys?.length === 1 ? "" : "s"} ${(issue.keys || []).map((key) => `"${key}"`).join(", ")}`;
    }
    return `${path}: ${issue.message}`;
  });
  if (issues.length > limit) lines.push(`(+${issues.length - limit} more issues)`);
  return lines;
}

function attemptedOperations(parsed) {
  if (!parsed || !Array.isArray(parsed.operations)) return [];
  return [...new Set(parsed.operations.map((entry) => entry?.operation).filter((name) => typeof name === "string"))];
}

// A bounded, same-conversation correction request. It carries the compact
// diagnostics plus only the canonical shapes for the operations that were
// actually attempted, and forbids re-running implementation so the verified
// checkout and commit stay exactly where the provider left them.
export function builderEnvelopeRepairInstructions({ githubBuilder, threads = [], error, attempt = 1, maxAttempts = 1 }) {
  const specifications = builderOperationSpecifications({ githubBuilder, threads });
  const attempted = error?.operations?.length
    ? specifications.filter((entry) => error.operations.includes(entry.operation))
    : specifications;
  const relevant = attempted.length ? attempted : specifications;
  return `Your implementation is accepted and must not be repeated. Only the bound GitHub builder envelope was malformed, so this is a delivery-syntax correction (attempt ${attempt} of ${maxAttempts}).

Rejection reason (${error?.stage === "json" ? "invalid JSON" : "canonical schema validation"}):
${(error?.diagnostics || []).map((line) => `  - ${line}`).join("\n") || `  - ${error?.message || "unknown"}`}

Canonical operation shapes for what you attempted. Use these exact field names:
${renderSpecifications(relevant)}

Rules for this turn:
- Do not edit files, re-run the implementation, create commits, or change the checked-out commit.
- Do not run verification commands or shell commands.
- Do not perform any GitHub mutation yourself; the broker publishes your envelope unchanged.
- Reply with the corrected envelope and nothing else:
${START}
{"operations":[${JSON.stringify(relevant[0]?.example ?? {})}]}
${END}`;
}

export function parseBuilderEnvelope(text) {
  const source = typeof text === "string" ? text : "";
  const start = source.lastIndexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start < 0 || end <= start) {
    throw new BuilderEnvelopeError(
      "Antigravity did not return the required bound GitHub builder envelope.",
      { stage: "missing" },
    );
  }
  let parsed;
  try { parsed = JSON.parse(source.slice(start + START.length, end).trim()); }
  catch (error) {
    throw new BuilderEnvelopeError(
      `Antigravity returned invalid builder-envelope JSON: ${error.message}`,
      { stage: "json", diagnostics: [`envelope: invalid JSON (${error.message})`] },
    );
  }
  // Validate strictly (rejects any invalid operation) but publish the original
  // operation content UNCHANGED. Zod's defaults (draft, body, method) would
  // mutate the promised-unchanged envelope, so they are intentionally discarded
  // here and applied only inside the bound executor.
  const result = envelope.safeParse(parsed);
  if (!result.success) {
    const diagnostics = compactDiagnostics(result.error);
    throw new BuilderEnvelopeError(
      `Antigravity builder envelope failed canonical validation: ${diagnostics.join("; ")}`,
      { stage: "schema", diagnostics, operations: attemptedOperations(parsed) },
    );
  }
  return { operations: parsed.operations };
}

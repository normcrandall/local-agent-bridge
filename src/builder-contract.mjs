import { z } from "zod";

// Canonical, provider-neutral GitHub builder delivery contract.
//
// This module is the single source of truth for the shape of every builder
// operation request, the typed error vocabulary, and the lifecycle delivery
// outcome vocabulary. Every provider lane derives its validation from here so
// Claude (MCP tool inputSchema), Codex (same MCP tool), and Antigravity
// (free-text envelope) cannot drift apart:
//   - github-builder-bridge.mjs registers MCP tools using builderMcpInputSchema.
//   - builder-envelope.mjs validates Antigravity envelopes using
//     builderEnvelopeSchema and publishes them unchanged.

const sha = () => z.string().regex(/^[0-9a-f]{40}$/i);
const branchRef = () => z.string().min(1).max(220);

// The exact ordered set of operations expressible through a bound builder lane.
export const BUILDER_OPERATIONS = Object.freeze([
  "ensure_pull_request",
  "reply_review_thread",
  "resolve_review_thread",
  "mark_ready",
  "merge",
  "create_branch",
  "push_branch",
  "replace_branch",
]);

// Typed error codes for the builder lane. Untyped free-text throws elsewhere
// remain, but any contract-level rejection carries one of these codes so
// callers and lifecycle mapping can distinguish provider-neutral failure modes.
export const BUILDER_ERROR_CODES = Object.freeze({
  REJECTED: "rejected",
  INDETERMINATE: "indeterminate",
  UNSUPPORTED: "unsupported",
});

export class BuilderError extends Error {
  constructor(code, message, { operation = null, cause = null } = {}) {
    super(message);
    this.name = "BuilderError";
    this.code = code;
    this.operation = operation;
    if (cause) this.cause = cause;
  }
}

// Raised when a provider genuinely cannot hold a bound builder lane (capability
// difference), instead of silently routing around the gap.
export class BuilderUnsupportedError extends BuilderError {
  constructor(message, options = {}) {
    super(BUILDER_ERROR_CODES.UNSUPPORTED, message, options);
    this.name = "BuilderUnsupportedError";
  }
}

// Per-operation request field shapes. Built fresh on each call so no zod schema
// instance is shared across the MCP and envelope derivations.
export function builderOperationShapes() {
  return {
    ensure_pull_request: {
      title: z.string().min(1).max(256),
      body: z.string().max(60_000).default(""),
      draft: z.boolean().default(false),
    },
    reply_review_thread: {
      threadId: z.string().min(1),
      body: z.string().min(1).max(60_000),
    },
    resolve_review_thread: { threadId: z.string().min(1) },
    mark_ready: {},
    merge: { method: z.enum(["merge", "squash", "rebase"]).default("squash") },
    create_branch: { ref: branchRef(), sha: sha() },
    push_branch: { ref: branchRef(), sha: sha(), oldSha: sha().optional() },
    replace_branch: { ref: branchRef(), sha: sha(), oldSha: sha() },
  };
}

// The raw zod shape an MCP tool registers as its inputSchema (Claude/Codex lane).
export function builderMcpInputSchema(operation) {
  const shapes = builderOperationShapes();
  if (!Object.hasOwn(shapes, operation)) {
    throw new BuilderUnsupportedError(`Unknown builder operation: ${operation}.`, { operation });
  }
  return shapes[operation];
}

// The strict discriminated union one Antigravity envelope operation must match.
export function builderEnvelopeOperationSchema() {
  const shapes = builderOperationShapes();
  return z.discriminatedUnion(
    "operation",
    BUILDER_OPERATIONS.map((operation) =>
      z.object({ operation: z.literal(operation), ...shapes[operation] }).strict()),
  );
}

// The full Antigravity envelope schema: a bounded batch of canonical operations.
export function builderEnvelopeSchema({ maxOperations = 20 } = {}) {
  return z
    .object({ operations: z.array(builderEnvelopeOperationSchema()).min(1).max(maxOperations) })
    .strict();
}

// Provider-neutral lifecycle delivery outcomes. Every remote verification of a
// builder operation resolves to exactly one of these, letting coordinator wakes
// and lifecycle status distinguish real success, rejection, an unproven
// (indeterminate) state, and a reconciled-after-loss remote verification.
export const DELIVERY_OUTCOMES = Object.freeze({
  SUCCEEDED: "succeeded",
  REJECTED: "rejected",
  INDETERMINATE: "indeterminate",
  RECONCILED: "reconciled",
});

// Branch-receipt outcomes (github-builder-client.mjs) mapped onto the lifecycle
// delivery vocabulary. idempotent/created/fast_forwarded/replaced all mean the
// intended remote state is verified, i.e. succeeded.
const BRANCH_OUTCOME_TO_DELIVERY = Object.freeze({
  created: DELIVERY_OUTCOMES.SUCCEEDED,
  fast_forwarded: DELIVERY_OUTCOMES.SUCCEEDED,
  replaced: DELIVERY_OUTCOMES.SUCCEEDED,
  idempotent: DELIVERY_OUTCOMES.SUCCEEDED,
  reconciled: DELIVERY_OUTCOMES.RECONCILED,
  indeterminate: DELIVERY_OUTCOMES.INDETERMINATE,
  failed: DELIVERY_OUTCOMES.REJECTED,
});

// Classify a builder receipt (or a bare outcome/result object) into a single
// lifecycle delivery outcome. A non-branch success receipt has no `outcome`
// field but is a proven mutation, so it maps to succeeded; a rejection carries
// an explicit failed/indeterminate outcome or an error marker.
export function classifyDeliveryOutcome(receipt) {
  let outcome = receipt;
  if (receipt && typeof receipt === "object") {
    if (typeof receipt.deliveryOutcome === "string") return receipt.deliveryOutcome;
    if (receipt.error) return DELIVERY_OUTCOMES.REJECTED;
    outcome = receipt.outcome;
  }
  if (outcome === undefined || outcome === null) return DELIVERY_OUTCOMES.SUCCEEDED;
  return BRANCH_OUTCOME_TO_DELIVERY[outcome] ?? DELIVERY_OUTCOMES.SUCCEEDED;
}

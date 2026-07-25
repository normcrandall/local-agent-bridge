import { builderEnvelopeRepairInstructions, parseBuilderEnvelope } from "./builder-envelope.mjs";

// Bounded same-session repair for schema-only builder envelope failures.
//
// Issue #40 regression: a provider can finish a verified implementation and then
// describe the delivery with non-canonical fields (create_branch {branch,
// headCommit}, ensure_pull_request {head, base}). That is a delivery-syntax
// failure, not an implementation failure, so the correct response is to ask the
// SAME provider conversation for a canonical envelope rather than transfer
// writer custody and rerun the work.
export const MAX_BUILDER_REPAIR_ATTEMPTS = 2;

export function builderRepairNarrative({ attempt, maxAttempts, diagnostics = [], repaired = false }) {
  if (repaired) {
    return `Antigravity returned a canonical builder envelope after ${attempt} delivery repair attempt${attempt === 1 ? "" : "s"}; publishing it unchanged.`;
  }
  const count = diagnostics.length;
  return `Antigravity's builder envelope failed canonical validation (${count} issue${count === 1 ? "" : "s"}: ${diagnostics.slice(0, 2).join("; ")}); requesting a same-session delivery repair (attempt ${attempt}/${maxAttempts}) without re-running implementation.`;
}

// Validate, optionally repair, then publish exactly once.
//
// Publication runs only after the whole batch validates, so a repair round can
// never leave a partially published envelope behind and cannot produce a
// duplicate remote mutation: `publish` is invoked at most once per call, after
// the loop settles on a canonical envelope.
export async function deliverBuilderEnvelope({
  message,
  conversationId,
  githubBuilder,
  threads = [],
  publish,
  requestRepair,
  readWorkspaceHead = () => null,
  onProgress = () => {},
  emitTiming = async () => {},
  maxAttempts = MAX_BUILDER_REPAIR_ATTEMPTS,
}) {
  const deliveryRepair = { attempted: false, repaired: false, outcome: "none", attempts: [] };
  // A delivery-syntax repair must never move the writer's checkout. Capture the
  // exact commit the provider left behind and refuse to publish if it moved.
  const headBefore = readWorkspaceHead();
  let text = message;
  let conversation = conversationId;
  for (let attempt = 0; ; attempt += 1) {
    let envelope;
    try {
      envelope = parseBuilderEnvelope(text);
    } catch (error) {
      const exhausted = attempt >= maxAttempts;
      if (!error.schemaOnly || exhausted || !conversation) {
        deliveryRepair.outcome = !error.schemaOnly
          ? "not_repairable"
          : exhausted
            ? "exhausted"
            : "unavailable";
        error.deliveryRepair = deliveryRepair;
        throw error;
      }
      const at = new Date().toISOString();
      deliveryRepair.attempted = true;
      onProgress({
        at,
        progress: null,
        total: null,
        summary: builderRepairNarrative({
          attempt: attempt + 1,
          maxAttempts,
          diagnostics: error.diagnostics || [],
        }),
      });
      await emitTiming({
        action: "milestone",
        name: "delivery_repair",
        at,
        metadata: { agent: "antigravity", attempt: attempt + 1, stage: error.stage, diagnostics: error.diagnostics || [] },
      });
      const repaired = await requestRepair({
        prompt: builderEnvelopeRepairInstructions({
          githubBuilder,
          threads,
          error,
          attempt: attempt + 1,
          maxAttempts,
        }),
        conversationId: conversation,
      });
      deliveryRepair.attempts.push({
        attempt: attempt + 1,
        at,
        stage: error.stage,
        diagnostics: error.diagnostics || [],
      });
      text = repaired.message;
      // The repair must stay in the same session. A provider that cannot report
      // a conversation id keeps the prior one rather than silently starting over.
      conversation = repaired.conversationId || conversation;
      continue;
    }
    if (deliveryRepair.attempted) {
      if (headBefore) {
        const headAfter = readWorkspaceHead();
        if (headAfter !== headBefore) {
          const error = new Error(
            `Antigravity delivery repair changed the writer checkout from ${headBefore} to ${headAfter || "an unreadable head"}; refusing to publish a repaired envelope against a different commit.`,
          );
          deliveryRepair.outcome = "checkout_moved";
          error.deliveryRepair = deliveryRepair;
          throw error;
        }
      }
      deliveryRepair.repaired = true;
      deliveryRepair.outcome = "repaired";
      onProgress({
        at: new Date().toISOString(),
        progress: null,
        total: null,
        summary: builderRepairNarrative({ attempt: deliveryRepair.attempts.length, repaired: true }),
      });
    }
    const receipts = await publish(envelope);
    return { receipts, conversationId: conversation, deliveryRepair, envelope };
  }
}

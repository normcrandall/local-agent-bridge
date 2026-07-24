import { readFileSync } from "node:fs";
import { aggregateDeliveryOutcome, classifyDeliveryOutcome, DELIVERY_OUTCOME_VALUES } from "./builder-contract.mjs";

// Durable reconciliation state for the bound builder lane.
//
// The bound builder MCP server is spawned fresh for each delegated turn, so the
// in-memory "this ref has an indeterminate prior mutation" marker does not
// survive a process/agent restart on its own. This module reconstructs that
// marker from the append-only receipt log, so a restarted builder still refuses
// to blindly re-push a ref whose last outcome was never proven, and instead
// reconciles by remote read-back first (no duplicate mutation).

// Terminal branch outcomes: any of these proves the ref reached a determinate
// state after an earlier indeterminate marker, clearing the pending marker.
const TERMINAL_BRANCH_OUTCOMES = new Set([
  "created",
  "fast_forwarded",
  "replaced",
  "idempotent",
  "reconciled",
  "failed",
]);

// Replay the durable receipt log and return a Map of ref -> pending
// indeterminate marker for refs whose last recorded mutation ended without a
// provable outcome. Later terminal receipts for the same ref clear it.
export function loadBranchReconciliationState(receiptPath) {
  const pending = new Map();
  if (!receiptPath) return pending;
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return pending;
    throw new Error(`Failed to read durable builder receipts for reconciliation: ${error.message}`);
  }
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    // A complete record is always newline-terminated, so the only non-empty
    // final element is a torn trailing append (the writer died mid-line). That
    // single tail is tolerated; any corrupt INTERIOR record fails closed,
    // because it may have hidden an indeterminate marker.
    const isTornTail = index === lines.length - 1;
    let receipt;
    try {
      receipt = JSON.parse(trimmed);
    } catch (error) {
      if (isTornTail) continue;
      throw new Error(`Durable builder receipt log has a corrupt record at line ${index + 1}; refusing to load reconciliation state fail-closed: ${error.message}`);
    }
    if (!receipt || typeof receipt.ref !== "string" || typeof receipt.operation !== "string") {
      // Non-branch receipts (a content-addressed operationId, no ref) belong to
      // the non-branch reconciliation loader; skip them here.
      if (receipt && typeof receipt.operationId === "string") continue;
      // A record that claims to be indeterminate but has neither a resolvable ref
      // nor an operationId cannot be safely ignored.
      if (receipt && receipt.outcome === "indeterminate") {
        throw new Error(`Durable builder receipt log has an indeterminate record without a resolvable ref at line ${index + 1}; refusing to load reconciliation state fail-closed.`);
      }
      continue;
    }
    if (receipt.outcome === "indeterminate") {
      pending.set(receipt.ref, {
        operation: receipt.operation,
        requestedSha: receipt.requestedSha ?? null,
        expectedOldSha: receipt.expectedOldSha ?? null,
        recordedAt: receipt.recordedAt ?? null,
      });
    } else if (TERMINAL_BRANCH_OUTCOMES.has(receipt.outcome)) {
      pending.delete(receipt.ref);
    }
  }
  return pending;
}

// Terminal outcomes for a non-branch operation (PR create/update, review reply,
// resolve, mark-ready, merge). "intent" and "indeterminate" are pending.
const TERMINAL_NON_BRANCH_OUTCOMES = new Set([
  "succeeded",
  "idempotent",
  "reconciled",
  "failed",
]);

// Replay the durable receipt log and return the Set of non-branch operationIds
// whose last record is an unresolved intent or indeterminate outcome. A
// restarted client uses this to record "reconciled" (rather than "idempotent")
// when a prior process's intended mutation is now observed to have landed.
export function loadNonBranchIntents(receiptPath) {
  const pending = new Set();
  if (!receiptPath) return pending;
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return pending;
    throw new Error(`Failed to read durable builder receipts for reconciliation: ${error.message}`);
  }
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const isTornTail = index === lines.length - 1;
    let receipt;
    try {
      receipt = JSON.parse(trimmed);
    } catch (error) {
      if (isTornTail) continue;
      throw new Error(`Durable builder receipt log has a corrupt record at line ${index + 1}; refusing to load reconciliation state fail-closed: ${error.message}`);
    }
    if (!receipt || typeof receipt.operationId !== "string" || typeof receipt.ref === "string") continue;
    if (receipt.outcome === "intent" || receipt.outcome === "indeterminate") {
      pending.add(receipt.operationId);
    } else if (TERMINAL_NON_BRANCH_OUTCOMES.has(receipt.outcome)) {
      pending.delete(receipt.operationId);
    }
  }
  return pending;
}

// Aggregate the durable receipt log into a single provider-neutral delivery
// summary for a bound head SHA, so lifecycle status and coordinator wakes can
// distinguish succeeded / rejected / indeterminate / reconciled remote
// verification. Transient "intent" records are excluded; terminal receipts (for
// both branch and non-branch operations) are considered. Returns null when the
// log has no matching terminal delivery.
export function summarizeDeliveryOutcomes(receiptPath, { headSha = null } = {}) {
  if (!receiptPath) return null;
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Failed to read durable builder receipts for delivery summary: ${error.message}`);
  }
  // Replay the log to the LATEST effective state per stable operation identity,
  // so a later reconciled supersedes an earlier indeterminate, and a later
  // succeeded supersedes an earlier failed. Only these latest states aggregate;
  // superseded history must not permanently worsen the summary.
  const latest = new Map();
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const isTornTail = index === lines.length - 1;
    let receipt;
    try {
      receipt = JSON.parse(trimmed);
    } catch (error) {
      if (isTornTail) continue;
      throw new Error(`Durable builder receipt log has a corrupt record at line ${index + 1}; refusing to summarize delivery fail-closed: ${error.message}`);
    }
    if (!receipt || typeof receipt.outcome !== "string") continue;
    if (headSha
      && receipt.headSha !== headSha
      && receipt.requestedSha !== headSha
      && receipt.authorizationHeadSha !== headSha) continue;
    // Stable identity: the content-addressed operationId (present on every branch
    // and non-branch receipt), falling back to operation+ref for older records.
    const identity = typeof receipt.operationId === "string" && receipt.operationId
      ? receipt.operationId
      : `${receipt.operation || "?"}:${receipt.ref || ""}`;
    // A transient intent that is the latest record for its identity means the
    // outcome is still unproven (indeterminate); any terminal record supersedes it.
    const effective = receipt.outcome === "intent"
      ? "indeterminate"
      : (typeof receipt.deliveryOutcome === "string" && DELIVERY_OUTCOME_VALUES.has(receipt.deliveryOutcome)
          ? receipt.deliveryOutcome
          : classifyDeliveryOutcome(receipt));
    latest.set(identity, effective);
  }
  if (!latest.size) return null;
  const counts = {};
  for (const value of latest.values()) counts[value] = (counts[value] || 0) + 1;
  return { outcome: aggregateDeliveryOutcome([...latest.values()]), counts };
}

export function deliverySummaryForHandoff({ delivery, handoff, agent, writer, at = new Date().toISOString() }) {
  if (delivery) return { ...delivery, at };
  if (agent !== writer || !["completed", "needs_review"].includes(handoff?.outcome)) return null;
  return {
    outcome: "rejected",
    counts: { rejected: 1 },
    detail: "Writer completed a bound-delivery handoff without a remotely verified builder receipt.",
    at,
  };
}

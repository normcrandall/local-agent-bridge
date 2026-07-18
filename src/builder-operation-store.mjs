import { readFileSync } from "node:fs";

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
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let receipt;
    try {
      receipt = JSON.parse(trimmed);
    } catch {
      // A partially written trailing line is ignored rather than fatal; the
      // durable log is append-only and the next write self-heals it.
      continue;
    }
    if (!receipt || typeof receipt.ref !== "string" || typeof receipt.operation !== "string") continue;
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

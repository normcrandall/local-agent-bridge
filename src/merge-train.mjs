const SHA = /^[0-9a-f]{40}$/i;

function assertSha(value, label) {
  if (!SHA.test(value || "")) throw new Error(`${label} must be a full commit SHA.`);
}

function clone(train) {
  return structuredClone(train);
}

function candidate(train, itemId) {
  const entry = train.queue.find((item) => item.itemId === String(itemId));
  if (!entry) throw new Error(`Merge candidate ${itemId} is not queued.`);
  return entry;
}

export function createMergeTrain({ targetBranch, targetSha }) {
  if (typeof targetBranch !== "string" || !targetBranch.trim()) throw new Error("targetBranch is required.");
  assertSha(targetSha, "targetSha");
  return { targetBranch: targetBranch.trim(), targetSha, queue: [], active: null, history: [], revision: 1 };
}

export function enqueueMergeCandidate(train, { itemId, prNumber, headSha, priority = 0 }) {
  assertSha(headSha, "headSha");
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("prNumber must be a positive integer.");
  const next = clone(train);
  const id = String(itemId || "").trim();
  if (!id) throw new Error("itemId is required.");
  if (next.active?.itemId === id) {
    throw new Error(`Merge candidate ${id} is actively validating; recover that validation before changing its queue entry.`);
  }
  const existing = next.queue.find((entry) => entry.itemId === id);
  if (existing) {
    if (existing.headSha === headSha && existing.prNumber === prNumber) return next;
    existing.prNumber = prNumber;
    existing.headSha = headSha;
    existing.priority = Number(priority) || 0;
    existing.status = "queued";
    existing.validation = null;
    existing.dossier = null;
  } else {
    next.queue.push({ itemId: id, prNumber, headSha, priority: Number(priority) || 0, status: "queued", validation: null, dossier: null });
  }
  next.queue.sort((left, right) => right.priority - left.priority || left.itemId.localeCompare(right.itemId));
  next.revision += 1;
  return next;
}

export function beginMergeValidation(train, { itemId, observedTargetSha, observedHeadSha }) {
  if (train.active) throw new Error(`Merge validation is already active for ${train.active.itemId}.`);
  if (observedTargetSha !== train.targetSha) throw new Error(`Merge target changed: expected ${train.targetSha}, observed ${observedTargetSha}.`);
  const next = clone(train);
  const entry = candidate(next, itemId);
  if (entry.status !== "queued" && entry.status !== "needs_repair") throw new Error(`Merge candidate ${itemId} is not eligible for validation from status ${entry.status}.`);
  if (observedHeadSha !== entry.headSha) throw new Error(`Pull request head changed: expected ${entry.headSha}, observed ${observedHeadSha}.`);
  entry.status = "validating";
  entry.validation = { targetSha: observedTargetSha, headSha: observedHeadSha, startedAt: new Date().toISOString() };
  next.active = { itemId: entry.itemId, targetSha: observedTargetSha, headSha: observedHeadSha };
  next.revision += 1;
  return next;
}

export function createArbitrationDossier({ itemId, classification, files = [], currentIntent, incomingIntent, acceptanceCriteria = [] }) {
  const allowed = new Set(["mechanical", "structural", "semantic", "requirement"]);
  if (!allowed.has(classification)) throw new Error("Conflict classification is invalid.");
  if (!currentIntent?.trim() || !incomingIntent?.trim()) throw new Error("Both conflict intents are required.");
  return {
    itemId: String(itemId),
    classification,
    files: [...new Set(files.map(String))],
    currentIntent: currentIntent.trim(),
    incomingIntent: incomingIntent.trim(),
    acceptanceCriteria: [...new Set(acceptanceCriteria.map(String))],
    createdAt: new Date().toISOString(),
  };
}

export function recordMergeValidation(train, { itemId, outcome, checks = [], dossier = null, error = null }) {
  if (train.active?.itemId !== String(itemId)) throw new Error(`Merge validation is not active for ${itemId}.`);
  if (!["passed", "failed", "conflict"].includes(outcome)) throw new Error("Merge validation outcome is invalid.");
  if (outcome === "conflict" && !dossier) throw new Error("Conflict validation requires an arbitration dossier.");
  const next = clone(train);
  const entry = candidate(next, itemId);
  entry.status = outcome === "passed" ? "ready_to_merge" : outcome === "conflict" ? "arbitrating" : "needs_repair";
  entry.validation = {
    ...entry.validation,
    outcome,
    checks: checks.map(String),
    error: error || null,
    completedAt: new Date().toISOString(),
  };
  entry.dossier = dossier;
  next.active = null;
  next.revision += 1;
  return next;
}

export function mergeAuthorization(train, { itemId, observedTargetSha, observedHeadSha }) {
  const entry = candidate(train, itemId);
  if (entry.status !== "ready_to_merge") throw new Error(`Merge candidate ${itemId} is not ready to merge.`);
  if (observedTargetSha !== train.targetSha) throw new Error(`Merge target changed: expected ${train.targetSha}, observed ${observedTargetSha}.`);
  if (entry.validation?.targetSha !== observedTargetSha) throw new Error("Merge validation is stale for the target branch.");
  if (observedHeadSha !== entry.headSha || entry.validation?.headSha !== observedHeadSha) throw new Error("Pull request head changed after validation.");
  return {
    authorized: true,
    itemId: entry.itemId,
    prNumber: entry.prNumber,
    headSha: entry.headSha,
    targetBranch: train.targetBranch,
    targetSha: train.targetSha,
  };
}

export function recordMergeResult(train, { itemId, expectedTargetSha, expectedHeadSha, mergedSha }) {
  assertSha(expectedTargetSha, "expectedTargetSha");
  assertSha(expectedHeadSha, "expectedHeadSha");
  assertSha(mergedSha, "mergedSha");
  const next = clone(train);
  if (next.active) {
    throw new Error(`Cannot record a merge while validation is active for ${next.active.itemId}; recover that validation first.`);
  }
  const entry = candidate(next, itemId);
  if (entry.status !== "ready_to_merge") throw new Error(`Merge candidate ${itemId} is not ready to merge.`);
  if (next.targetSha !== expectedTargetSha || entry.validation?.targetSha !== expectedTargetSha) {
    throw new Error("Merge target no longer matches the validated target SHA.");
  }
  if (entry.headSha !== expectedHeadSha || entry.validation?.headSha !== expectedHeadSha) {
    throw new Error("Merged pull request head no longer matches the validated head SHA.");
  }
  next.history.push({ ...entry, status: "merged", mergedSha, mergedAt: new Date().toISOString() });
  next.queue = next.queue.filter((candidateEntry) => candidateEntry.itemId !== entry.itemId).map((candidateEntry) => ({
    ...candidateEntry,
    status: "queued",
    validation: null,
  }));
  next.targetSha = mergedSha;
  next.active = null;
  next.revision += 1;
  return next;
}

export function recoverMergeValidation(train, { itemId, reason, disposition = "requeue" }) {
  if (!reason?.trim()) throw new Error("Merge validation recovery requires a reason.");
  if (!["requeue", "repair"].includes(disposition)) throw new Error("Merge validation recovery disposition is invalid.");
  const next = clone(train);
  const entry = candidate(next, itemId);
  if (next.active && next.active.itemId !== entry.itemId) throw new Error(`Merge validation is active for ${next.active.itemId}, not ${entry.itemId}.`);
  next.history.push({
    itemId: entry.itemId,
    prNumber: entry.prNumber,
    headSha: entry.headSha,
    status: "validation_recovered",
    reason: reason.trim(),
    recoveredAt: new Date().toISOString(),
  });
  entry.status = disposition === "requeue" ? "queued" : "needs_repair";
  entry.validation = null;
  next.active = null;
  next.revision += 1;
  return next;
}

export function refreshMergeTarget(train, { observedTargetSha, reason }) {
  assertSha(observedTargetSha, "observedTargetSha");
  if (!reason?.trim()) throw new Error("Target refresh requires a reason.");
  if (train.active) throw new Error(`Cannot refresh the merge target while validation is active for ${train.active.itemId}.`);
  if (observedTargetSha === train.targetSha) return clone(train);
  const next = clone(train);
  const previousTargetSha = next.targetSha;
  next.targetSha = observedTargetSha;
  next.queue = next.queue.map((entry) => ({
    ...entry,
    status: entry.status === "arbitrating" || entry.status === "needs_repair" ? entry.status : "queued",
    validation: null,
  }));
  next.history.push({
    status: "target_refreshed",
    previousTargetSha,
    targetSha: observedTargetSha,
    reason: reason.trim(),
    refreshedAt: new Date().toISOString(),
  });
  next.revision += 1;
  return next;
}

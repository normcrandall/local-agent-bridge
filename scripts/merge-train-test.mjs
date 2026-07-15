import assert from "node:assert/strict";
import {
  beginMergeValidation,
  createArbitrationDossier,
  createMergeTrain,
  enqueueMergeCandidate,
  mergeAuthorization,
  recoverMergeValidation,
  recordMergeResult,
  recordMergeValidation,
  refreshMergeTarget,
} from "../src/merge-train.mjs";

const targetSha = "a".repeat(40);
const firstHead = "b".repeat(40);
const secondHead = "c".repeat(40);
let train = createMergeTrain({ targetBranch: "main", targetSha });
train = enqueueMergeCandidate(train, { itemId: "101", prNumber: 11, headSha: firstHead, priority: 100 });
train = enqueueMergeCandidate(train, { itemId: "102", prNumber: 12, headSha: secondHead, priority: 90 });
assert.deepEqual(train.queue.map((entry) => entry.itemId), ["101", "102"]);

train = beginMergeValidation(train, { itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead });
assert.equal(train.active.itemId, "101");
assert.throws(() => enqueueMergeCandidate(train, {
  itemId: "101", prNumber: 11, headSha: "d".repeat(40), priority: 100,
}), /actively validating/i);
assert.throws(() => beginMergeValidation(train, {
  itemId: "102", observedTargetSha: targetSha, observedHeadSha: secondHead,
}), /already active/i);

train = recordMergeValidation(train, { itemId: "101", outcome: "passed", checks: ["pnpm run ci"] });
const authorization = mergeAuthorization(train, {
  itemId: "101", observedTargetSha: targetSha, observedHeadSha: firstHead,
});
assert.equal(authorization.authorized, true);
assert.equal(authorization.prNumber, 11);
assert.throws(() => mergeAuthorization(train, {
  itemId: "101", observedTargetSha: "d".repeat(40), observedHeadSha: firstHead,
}), /target.*changed/i);

let activeOther = beginMergeValidation(train, {
  itemId: "102", observedTargetSha: targetSha, observedHeadSha: secondHead,
});
assert.throws(() => recordMergeResult(activeOther, {
  itemId: "101", expectedTargetSha: targetSha, expectedHeadSha: firstHead, mergedSha: "e".repeat(40),
}), /validation is active/i);
assert.throws(() => refreshMergeTarget(activeOther, {
  observedTargetSha: "f".repeat(40), reason: "External merge",
}), /validation is active/i);
activeOther = recoverMergeValidation(activeOther, {
  itemId: "102", reason: "Negative transition test", disposition: "requeue",
});
assert.equal(activeOther.active, null);

assert.throws(() => recordMergeResult(train, {
  itemId: "101", expectedTargetSha: targetSha, expectedHeadSha: "d".repeat(40), mergedSha: "e".repeat(40),
}), /head no longer matches/i);
train = recordMergeResult(train, {
  itemId: "101", expectedTargetSha: targetSha, expectedHeadSha: firstHead, mergedSha: "e".repeat(40),
});
assert.equal(train.targetSha, "e".repeat(40));
assert.equal(train.history.at(-1).status, "merged");
assert.equal(train.queue[0].itemId, "102");
assert.equal(train.queue[0].status, "queued");

train = beginMergeValidation(train, {
  itemId: "102", observedTargetSha: train.targetSha, observedHeadSha: secondHead,
});
const dossier = createArbitrationDossier({
  itemId: "102",
  classification: "semantic",
  files: ["src/contracts.ts"],
  currentIntent: "Preserve the merged API contract.",
  incomingIntent: "Add the issue 102 behavior.",
  acceptanceCriteria: ["Existing callers remain valid", "New behavior is available"],
});
train = recordMergeValidation(train, { itemId: "102", outcome: "conflict", dossier });
assert.equal(train.queue[0].status, "arbitrating");
assert.equal(train.queue[0].dossier.classification, "semantic");
assert.throws(() => mergeAuthorization(train, {
  itemId: "102", observedTargetSha: train.targetSha, observedHeadSha: secondHead,
}), /not ready/i);

const targetAfterConflict = refreshMergeTarget(train, {
  observedTargetSha: "d".repeat(40), reason: "External merge while arbitration is pending",
});
assert.equal(targetAfterConflict.queue[0].status, "arbitrating");
assert.equal(targetAfterConflict.queue[0].validation, null);

train = recoverMergeValidation(train, { itemId: "102", reason: "Chair app exited during arbitration", disposition: "requeue" });
assert.equal(train.active, null);
assert.equal(train.queue[0].status, "queued");
const externalTarget = "f".repeat(40);
train = refreshMergeTarget(train, { observedTargetSha: externalTarget, reason: "External merge reached main" });
assert.equal(train.targetSha, externalTarget);
assert.equal(train.queue[0].validation, null);
assert.equal(train.history.at(-1).status, "target_refreshed");

console.log("Merge-train tests passed: serialization, exact SHAs, invalidation, and arbitration.");

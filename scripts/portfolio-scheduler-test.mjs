import assert from "node:assert/strict";
import { analyzePortfolio, buildExecutionWaves } from "../src/portfolio-scheduler.mjs";

const items = [
  { id: "101", title: "Foundation", priority: 100, paths: ["src/foundation"] },
  { id: "102", title: "Dependent", priority: 90, blockedBy: ["101"], paths: ["src/dependent"] },
  { id: "103", title: "Independent", priority: 80, paths: ["src/independent"] },
  { id: "104", title: "Conflicts with independent", priority: 70, conflictsWith: ["103"], paths: ["src/other"] },
  { id: "105", title: "Migration one", priority: 60, resources: ["database-migration"] },
  { id: "106", title: "Migration two", priority: 50, resources: ["database-migration"] },
];

const initial = analyzePortfolio({ items, maxParallel: 2 });
assert.deepEqual(initial.selected.map((item) => item.id), ["101", "103"]);
assert.equal(initial.blocked.find((item) => item.id === "102").reasons[0].type, "dependency");
assert.equal(initial.deferred.find((item) => item.id === "104").reasons[0].type, "conflict");

const afterFoundation = analyzePortfolio({
  items: items.map((item) => item.id === "101" ? { ...item, status: "merged" } : item),
  maxParallel: 3,
});
assert.deepEqual(afterFoundation.selected.map((item) => item.id), ["102", "103", "105"]);
assert.equal(afterFoundation.deferred.find((item) => item.id === "106").reasons[0].type, "resource");

const activeReservation = analyzePortfolio({
  items: [
    { id: "a", status: "implementing", paths: ["packages/api"] },
    { id: "b", status: "ready", paths: ["packages/api/routes"] },
    { id: "c", status: "ready", paths: ["packages/web"] },
  ],
  maxParallel: 2,
});
assert.deepEqual(activeReservation.selected.map((item) => item.id), ["c"]);
assert.equal(activeReservation.deferred.find((item) => item.id === "b").reasons[0].with, "a");

const queuedDoesNotConsumeWriter = analyzePortfolio({
  items: [
    { id: "queued", status: "ready_to_merge", paths: ["packages/api"] },
    { id: "next", status: "ready", paths: ["packages/web"] },
  ],
  maxParallel: 1,
});
assert.deepEqual(queuedDoesNotConsumeWriter.selected.map((item) => item.id), ["next"]);

const queuedStillReservesScope = analyzePortfolio({
  items: [
    { id: "queued", status: "ready_to_merge", paths: ["packages/api"], resources: ["schema"] },
    { id: "path-overlap", status: "ready", paths: ["packages/api/routes"] },
    { id: "resource-overlap", status: "ready", paths: ["packages/jobs"], resources: ["schema"] },
    { id: "independent", status: "ready", paths: ["packages/web"] },
  ],
  maxParallel: 2,
});
assert.deepEqual(queuedStillReservesScope.selected.map((item) => item.id), ["independent"]);
assert.equal(queuedStillReservesScope.deferred.find((item) => item.id === "path-overlap").reasons[0].type, "path");
assert.equal(queuedStillReservesScope.deferred.find((item) => item.id === "resource-overlap").reasons[0].type, "resource");

const semanticFootprints = analyzePortfolio({
  items: [
    {
      id: "contract-writer",
      status: "implementing",
      footprint: { version: 2, symbols: ["reserveClaim"], contracts: [{ name: "claim-envelope", mode: "write", fingerprint: "v2" }] },
    },
    { id: "symbol-overlap", footprint: { symbols: ["reserveClaim"] } },
    { id: "contract-overlap", footprint: { contracts: [{ name: "claim-envelope", mode: "write", fingerprint: "v3" }] } },
    { id: "contract-reader", footprint: { contracts: [{ name: "claim-envelope", mode: "read" }] } },
  ],
  maxParallel: 4,
});
assert.equal(semanticFootprints.deferred.find((item) => item.id === "symbol-overlap").reasons[0].type, "symbol");
assert.equal(semanticFootprints.deferred.find((item) => item.id === "contract-overlap").reasons[0].type, "contract");
assert.equal(semanticFootprints.deferred.find((item) => item.id === "contract-reader").reasons[0].type, "contract");

const triageAhead = analyzePortfolio({
  items: [
    { id: "foundation", status: "implementing", priority: 100 },
    { id: "blocked-high", status: "ready", priority: 90, blockedBy: ["foundation"] },
    { id: "ready", status: "ready", priority: 80 },
    { id: "already-triaged", status: "ready", priority: 70, triageStatus: "triaged" },
  ],
  maxParallel: 1,
});
assert.deepEqual(triageAhead.triageAhead.map((item) => item.id), ["blocked-high", "ready"], "triage may run before dependencies merge without selecting blocked implementation");
assert.deepEqual(triageAhead.selected, [], "the active writer consumes implementation capacity");

assert.throws(() => analyzePortfolio({
  items: [
    { id: "a", blockedBy: ["b"] },
    { id: "b", blockedBy: ["a"] },
  ],
}), /cycle/i);

const waves = buildExecutionWaves({ items, maxParallel: 2 });
assert.deepEqual(waves[0], ["101", "103"]);
assert.ok(waves.flat().includes("102"));
assert.ok(waves.every((wave) => wave.length <= 2));

console.log("Portfolio scheduler tests passed: dependencies, conflicts, resources, capacity, and waves.");

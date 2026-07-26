import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archivePortfolio,
  createPortfolio,
  listPortfolios,
  listRepositoryFootprintReservations,
  readPortfolio,
  reconcilePortfolioItemFootprint,
  updatePortfolio,
  updatePortfolioItemWithFootprintReservation,
} from "../src/portfolio-store.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-portfolio-store-"));
try {
  const patchItem = (itemId, patch) => (state) => ({
    ...state,
    items: state.items.map((item) => item.id === itemId ? { ...item, ...patch } : item),
  });

  const firstLane = await createPortfolio(root, {
    repository: "veliqon/example",
    objective: "First cross-portfolio lane",
    workspace: "/tmp/example-a",
    maxParallel: 2,
    items: [{ id: "a", priority: 100, status: "ready", footprint: { version: 3, paths: ["src/api"], symbols: ["reserve"] } }],
  });
  const reservedFirst = await updatePortfolioItemWithFootprintReservation(
    root,
    firstLane.id,
    firstLane.revision,
    "a",
    { status: "implementing" },
    patchItem("a", { status: "implementing" }),
  );
  assert.equal(reservedFirst.items[0].footprintReservation.status, "reserved");
  assert.equal(reservedFirst.items[0].footprintReservation.version, 3);

  const conflictingLane = await createPortfolio(root, {
    repository: "veliqon/example",
    objective: "Conflicting lane",
    workspace: "/tmp/example-b",
    maxParallel: 2,
    items: [{ id: "b", priority: 90, status: "ready", footprint: { paths: ["src/api/routes"] } }],
  });
  await assert.rejects(
    updatePortfolioItemWithFootprintReservation(
      root,
      conflictingLane.id,
      conflictingLane.revision,
      "b",
      { status: "implementing" },
      patchItem("b", { status: "implementing" }),
    ),
    (error) => error.code === "FOOTPRINT_CONFLICT" && error.conflicts[0].portfolioId === firstLane.id,
    "cross-portfolio path reservations must serialize atomically",
  );

  const duplicateLane = await createPortfolio(root, {
    repository: "veliqon/example",
    objective: "Duplicate issue lane",
    workspace: "/tmp/example-duplicate",
    maxParallel: 2,
    items: [{ id: "a", priority: 1, status: "ready", footprint: { paths: ["docs/disjoint.md"] } }],
  });
  await assert.rejects(
    updatePortfolioItemWithFootprintReservation(root, duplicateLane.id, duplicateLane.revision, "a", { status: "implementing" }, patchItem("a", { status: "implementing" })),
    (error) => error.code === "FOOTPRINT_CONFLICT" && error.conflicts[0].type === "duplicate",
    "the same issue cannot be reserved in two portfolios even when its predicted paths differ",
  );

  const disjointLane = await createPortfolio(root, {
    repository: "veliqon/example",
    objective: "Disjoint lane",
    workspace: "/tmp/example-c",
    maxParallel: 2,
    items: [{ id: "c", priority: 80, status: "ready", footprint: { paths: ["src/web"] } }],
  });
  const reservedDisjoint = await updatePortfolioItemWithFootprintReservation(
    root,
    disjointLane.id,
    disjointLane.revision,
    "c",
    { status: "implementing" },
    patchItem("c", { status: "implementing" }),
  );
  assert.equal(reservedDisjoint.items[0].status, "implementing", "disjoint repositories paths must not be falsely serialized");

  const reconciled = await reconcilePortfolioItemFootprint(
    root,
    disjointLane.id,
    reservedDisjoint.revision,
    "c",
    { paths: ["src/api/new-route.mjs"], evidence: { source: "test" } },
    { phase: "pre_publish" },
  );
  assert.equal(reconciled.parked, true, "the newer lower-priority lane must be parked when its actual diff reveals a hard conflict");
  assert.equal(reconciled.item.status, "blocked");
  assert.equal(reconciled.item.footprintReservation.status, "reserved", "parked work retains its reservation until inspected retirement");
  assert.equal(reconciled.item.footprintReconciliation.accuracy.precision, 0);
  assert.equal((await readPortfolio(root, disjointLane.id)).items[0].actualFootprint.paths[0], "src/api/new-route.mjs", "actual footprints survive restart reads");
  const inspectedReservations = await listRepositoryFootprintReservations(root, reservedFirst);
  assert.equal(inspectedReservations.find((entry) => entry.itemId === "c").stale, true, "paused reservations remain visible instead of silently expiring");

  const integrationFirst = await updatePortfolioItemWithFootprintReservation(
    root,
    firstLane.id,
    reservedFirst.revision,
    "a",
    { status: "ready_to_merge" },
    patchItem("a", { status: "ready_to_merge" }),
  );
  assert.equal(integrationFirst.items[0].footprintReservation.status, "reserved", "merge validation retains the implementation reservation");
  const releasedFirst = await updatePortfolioItemWithFootprintReservation(
    root,
    firstLane.id,
    integrationFirst.revision,
    "a",
    { status: "merged" },
    patchItem("a", { status: "merged" }),
  );
  assert.equal(releasedFirst.items[0].footprintReservation.status, "released", "verified terminal delivery releases the reservation");

  const samePortfolio = await createPortfolio(root, {
    repository: "veliqon/same-portfolio",
    objective: "Same portfolio reconciliation",
    workspace: "/tmp/example-same",
    maxParallel: 2,
    items: [
      { id: "high", priority: 100, status: "ready", footprint: { paths: ["src/high"] } },
      { id: "low", priority: 50, status: "ready", footprint: { paths: ["src/low"] } },
    ],
  });
  const sameHigh = await updatePortfolioItemWithFootprintReservation(root, samePortfolio.id, samePortfolio.revision, "high", { status: "implementing" }, patchItem("high", { status: "implementing" }));
  const sameBoth = await updatePortfolioItemWithFootprintReservation(root, samePortfolio.id, sameHigh.revision, "low", { status: "implementing" }, patchItem("low", { status: "implementing" }));
  const sameReconciled = await reconcilePortfolioItemFootprint(root, samePortfolio.id, sameBoth.revision, "high", { paths: ["src/low/new.mjs"] });
  assert.equal(sameReconciled.portfolio.items.find((item) => item.id === "low").status, "blocked", "same-portfolio conflicts are parked in one revision-fenced write");

  const created = await createPortfolio(root, {
    objective: "Deliver the milestone",
    workspace: "/tmp/example",
    maxParallel: 2,
    items: [{ id: "101", status: "ready" }],
  });
  assert.match(created.id, /^helm-[0-9a-f-]{36}$/);
  assert.equal(created.revision, 1);
  const updated = await updatePortfolio(root, created.id, 1, (current) => ({
    ...current,
    items: current.items.map((item) => ({ ...item, status: "implementing" })),
  }));
  assert.equal(updated.revision, 2);
  assert.equal((await readPortfolio(root, created.id)).items[0].status, "implementing");
  await assert.rejects(() => updatePortfolio(root, created.id, 1, (current) => current), /revision/i);
  await writeFile(join(root, `${created.id}.lock`), "999999\n");
  const recovered = await updatePortfolio(root, created.id, 2, (current) => ({ ...current, status: "running" }));
  assert.equal(recovered.revision, 3);
  const listed = await listPortfolios(root);
  assert.ok(listed.some((portfolio) => portfolio.id === created.id));
  const completed = await updatePortfolio(root, created.id, 3, (current) => ({
    ...current,
    status: "complete",
    items: current.items.map((item) => ({ ...item, status: "merged" })),
  }));
  await assert.rejects(() => archivePortfolio(root, completed.id, { expectedRevision: completed.revision - 1 }), /revision changed/i);
  assert.equal((await archivePortfolio(root, completed.id, { expectedRevision: completed.revision })).archived, true);
  assert.equal((await listPortfolios(root)).some((portfolio) => portfolio.id === completed.id), false);
  assert.equal(JSON.parse(await readFile(join(root, "archive", `${completed.id}.json`), "utf8")).status, "complete");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Portfolio store tests passed: durable IDs, cross-portfolio reservations, actual-footprint reconciliation, release, revisions, updates, and listing.");

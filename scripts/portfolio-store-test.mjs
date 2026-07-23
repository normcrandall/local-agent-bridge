import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePortfolio, createPortfolio, listPortfolios, readPortfolio, updatePortfolio } from "../src/portfolio-store.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-portfolio-store-"));
try {
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
  assert.equal(listed[0].id, created.id);
  const completed = await updatePortfolio(root, created.id, 3, (current) => ({
    ...current,
    status: "complete",
    items: current.items.map((item) => ({ ...item, status: "merged" })),
  }));
  assert.equal((await archivePortfolio(root, completed.id)).archived, true);
  assert.equal((await listPortfolios(root)).length, 0);
  assert.equal(JSON.parse(await readFile(join(root, "archive", `${completed.id}.json`), "utf8")).status, "complete");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Portfolio store tests passed: durable IDs, revisions, updates, and listing.");

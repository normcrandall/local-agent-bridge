import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { queryControlPlane } from "../src/collaboration-store.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "agent-control-plane-test-"));
const now = Date.parse("2026-07-17T10:00:00.000Z");

try {
  // 1. Setup Collaborations
  // A: Concurrent active collaboration with fresh heartbeat but stale narrative
  const colA = {
    id: "bridge-00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:59:50.000Z",
    status: "running",
    task: "Concurrent active lane",
    workspace: "/Users/norm/workspace-a",
    agents: ["claude", "antigravity"],
    writer: "claude",
    runtime: {
      activeCall: {
        agent: "claude",
        status: "running",
        phase: "implementing",
        summary: "Old narrative summary",
        summaryAt: "2026-07-17T09:10:00.000Z", // 50 mins (3000s) ago
        summarySource: "provider",
        heartbeatAt: "2026-07-17T09:59:50.000Z" // 10s ago
      }
    },
    usage: {
      claude: { costUsd: 0.05, tokens: 12000 }
      // antigravity is missing (absent usage)
    }
  };

  // B: Terminal completion collaboration
  const colB = {
    id: "bridge-00000000-0000-4000-8000-000000000002",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:30:00.000Z",
    status: "agreed",
    task: "Terminal completion task",
    workspace: "/Users/norm/workspace-a",
    agents: ["codex"],
    writer: "codex",
    completion: {
      sequence: 1,
      acknowledged: true,
      phase: "verified_complete",
      nextAction: "chair_verify",
      lastHandoff: {
        agent: "codex",
        outcome: "completed",
        summary: "Completed work successfully"
      }
    }
  };

  // C: Indeterminate recovery collaboration
  const colC = {
    id: "bridge-00000000-0000-4000-8000-000000000003",
    createdAt: "2026-07-17T09:30:00.000Z",
    updatedAt: "2026-07-17T09:45:00.000Z",
    status: "indeterminate",
    task: "Indeterminate task",
    workspace: "/Users/norm/workspace-b",
    agents: ["claude"],
    writer: "claude",
    workerPid: 999999, // likely dead
    error: "Broker restart found no owned worker process."
  };

  // D: Archived collaboration
  const colD = {
    id: "bridge-00000000-0000-4000-8000-000000000004",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T01:00:00.000Z",
    status: "failed",
    task: "Archived failed task",
    workspace: "/Users/norm/workspace-a",
    agents: ["antigravity"],
    writer: "antigravity",
    error: "Unavailable provider"
  };

  await writeFile(join(stateRoot, `${colA.id}.json`), JSON.stringify(colA));
  await writeFile(join(stateRoot, `${colB.id}.json`), JSON.stringify(colB));
  await writeFile(join(stateRoot, `${colC.id}.json`), JSON.stringify(colC));

  await mkdir(join(stateRoot, "archive"), { recursive: true });
  await writeFile(join(stateRoot, "archive", `${colD.id}.json`), JSON.stringify(colD));

  // 2. Setup Portfolios
  await mkdir(join(stateRoot, "portfolios"), { recursive: true });
  const portfolio = {
    id: "helm-00000000-0000-4000-8000-000000000001",
    objective: "Milestone portfolio",
    workspace: "/Users/norm/workspace-a",
    status: "running",
    updatedAt: "2026-07-17T09:50:00.000Z",
    items: [
      { id: "lane-1", status: "implementing", writer: "claude", collaborationId: colA.id, priority: 10 },
      { id: "lane-2", status: "ready", writer: "codex", priority: 5 }
    ],
    mergeTrain: [
      { itemId: "lane-1", prNumber: 42, headSha: "a".repeat(40), priority: 10 }
    ]
  };
  await writeFile(join(stateRoot, "portfolios", `${portfolio.id}.json`), JSON.stringify(portfolio));

  // Read initial file bytes to verify byte-for-byte immutability later
  const bytesColA = await readFile(join(stateRoot, `${colA.id}.json`));
  const bytesColB = await readFile(join(stateRoot, `${colB.id}.json`));
  const bytesColC = await readFile(join(stateRoot, `${colC.id}.json`));
  const bytesPort = await readFile(join(stateRoot, "portfolios", `${portfolio.id}.json`));

  // 3. Run queryControlPlane
  const result = await queryControlPlane(stateRoot, { now });

  // 4. Assert Immutability
  assert.deepEqual(await readFile(join(stateRoot, `${colA.id}.json`)), bytesColA);
  assert.deepEqual(await readFile(join(stateRoot, `${colB.id}.json`)), bytesColB);
  assert.deepEqual(await readFile(join(stateRoot, `${colC.id}.json`)), bytesColC);
  assert.deepEqual(await readFile(join(stateRoot, "portfolios", `${portfolio.id}.json`)), bytesPort);

  // 5. Assert Non-Archived Lanes by default
  assert.equal(result.lanes.length, 4);

  // Find lanes
  const lane1 = result.lanes.find(l => l.id === colA.id);
  const lane2 = result.lanes.find(l => l.id === `${portfolio.id}:lane-2`);
  const laneB = result.lanes.find(l => l.id === colB.id);
  const laneC = result.lanes.find(l => l.id === colC.id);

  assert.ok(lane1, "lane-1 exists");
  assert.ok(lane2, "lane-2 exists");
  assert.ok(laneB, "laneB exists");
  assert.ok(laneC, "laneC exists");

  // Check lane-1 (combined)
  assert.equal(lane1.type, "combined");
  assert.equal(lane1.workspace, "/Users/norm/workspace-a");
  assert.deepEqual(lane1.participants, ["claude", "antigravity"]);
  assert.equal(lane1.writer, "claude");
  assert.equal(lane1.lifecyclePhase, "running");
  assert.equal(lane1.narrative.summary, "Old narrative summary");
  assert.equal(lane1.narrative.ageSeconds, 3000); // 10:00:00 - 09:10:00
  assert.equal(lane1.heartbeat.ageSeconds, 10); // 10:00:00 - 09:59:50
  assert.equal(lane1.portfolio.portfolioId, portfolio.id);
  assert.equal(lane1.portfolio.itemId, "lane-1");
  assert.equal(lane1.portfolio.mergeTrain.prNumber, 42);

  // Check lane-1 usage (recorded vs absent)
  assert.equal(lane1.usage.claude.costUsd, 0.05);
  assert.equal(lane1.usage.claude.metadata.source, "recorded");
  assert.equal(lane1.usage.antigravity.costUsd, null);
  assert.equal(lane1.usage.antigravity.metadata.source, "unknown");

  // Check lane-2 (portfolio_lane)
  assert.equal(lane2.type, "portfolio_lane");
  assert.equal(lane2.lifecyclePhase, "ready");
  assert.equal(lane2.writer, "codex");
  assert.equal(lane2.nextAction, "start_collaboration");

  // Check laneB (terminal completion)
  assert.equal(laneB.type, "collaboration");
  assert.equal(laneB.lifecyclePhase, "agreed");
  assert.equal(laneB.handoff.sequence, 1);
  assert.equal(laneB.handoff.outcome, "completed");
  assert.equal(laneB.nextAction, "chair_verify");

  // Check laneC (indeterminate recovery)
  assert.equal(laneC.type, "collaboration");
  assert.equal(laneC.lifecyclePhase, "indeterminate");
  assert.equal(laneC.blocker.error, "Broker restart found no owned worker process.");
  assert.equal(laneC.recovery.status, "indeterminate");
  assert.match(laneC.recovery.recommendation, /ambiguous/);
  assert.equal(laneC.recovery.processAlive, false);

  // 6. Test Include Archived filter
  const resultWithArchived = await queryControlPlane(stateRoot, { now, includeArchived: true });
  assert.equal(resultWithArchived.lanes.length, 5);
  assert.ok(resultWithArchived.lanes.some(l => l.id === colD.id));

  // 7. Test Filters
  // Filter by workspace
  const resWorkspace = await queryControlPlane(stateRoot, { now, workspace: "/Users/norm/workspace-b" });
  assert.equal(resWorkspace.lanes.length, 1);
  assert.equal(resWorkspace.lanes[0].id, colC.id);

  // Filter by status
  const resStatus = await queryControlPlane(stateRoot, { now, status: "ready" });
  assert.equal(resStatus.lanes.length, 1);
  assert.equal(resStatus.lanes[0].id, `${portfolio.id}:lane-2`);

  // Filter by provider
  const resProvider = await queryControlPlane(stateRoot, { now, provider: "antigravity" });
  assert.equal(resProvider.lanes.length, 1);
  assert.equal(resProvider.lanes[0].id, colA.id);

  // Filter by portfolio
  const resPortfolio = await queryControlPlane(stateRoot, { now, portfolio: portfolio.id });
  assert.equal(resPortfolio.lanes.length, 2);

  console.log("Control plane query & filtering tests passed successfully!");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

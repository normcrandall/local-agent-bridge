import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { queryControlPlane } from "../src/collaboration-store.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "agent-control-plane-test-"));
const now = Date.parse("2026-07-17T10:00:00.000Z");

try {
  // 1. Setup Collaborations
  // A: Concurrent active collaboration with fresh heartbeat, stale narrative, a pending decision, and a decision escalation
  const colA = {
    id: "bridge-00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:59:50.000Z",
    status: "running",
    task: "Concurrent active lane",
    workspace: "/Users/norm/workspace-a",
    agents: ["claude", "antigravity"],
    participants: ["codex", "claude", "antigravity"], // includes chair
    writer: "claude",
    runtime: {
      budgetExceeded: true, // test budget exceeded mapping
      activeCall: {
        agent: "claude",
        status: "running",
        phase: "implementing",
        summary: "Old narrative summary",
        summaryAt: "2026-07-17T09:10:00.000Z", // 50 mins (3000s) ago
        summarySource: "provider",
        heartbeatAt: "2026-07-17T09:59:50.000Z" // 10s ago
      },
      unavailableAgents: {
        claude: "rate_limit"
      },
      availableAgents: ["antigravity"]
    },
    providerRecoveryState: {
      attempts: 2
    },
    usage: {
      claude: { costUsd: 0.05, tokens: 12000 }
      // antigravity is missing (absent usage)
    },
    decisions: [
      {
        question: "Unrelated resolved decision",
        category: "reversible_technical",
        owner: "agent",
        action: "resolved",
        decision: "Use local store"
      },
      {
        question: "Active pending decision?",
        category: "money",
        owner: "user",
        action: "needs_user",
        reason: "Cost budget checks",
        extraUnboundedField: "secret token or internal path"
      }
    ],
    decisionEscalation: {
      question: "Escalated to User?",
      category: "money",
      owner: "user",
      reason: "Budget limit reached"
    },
    budget: 10.00
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

  // C: Indeterminate recovery collaboration with broker narrative placeholder
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
    error: "Broker restart found no owned worker process.",
    runtime: {
      activeCall: {
        agent: "claude",
        status: "running",
        phase: "planning",
        summary: "Waiting for coordinator wake...",
        summaryAt: "2026-07-17T09:40:00.000Z",
        summarySource: "broker", // placeholder
        heartbeatAt: "2026-07-17T09:45:00.000Z"
      }
    }
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

  // E: Active failed lane due to unavailable provider
  const colE = {
    id: "bridge-00000000-0000-4000-8000-000000000005",
    createdAt: "2026-07-17T09:40:00.000Z",
    updatedAt: "2026-07-17T09:45:00.000Z",
    status: "failed",
    task: "Failed due to unavailable provider",
    workspace: "/Users/norm/workspace-a",
    agents: ["antigravity"],
    writer: "antigravity",
    error: "No requested model is currently available."
  };

  await writeFile(join(stateRoot, `${colA.id}.json`), JSON.stringify(colA));
  await writeFile(join(stateRoot, `${colB.id}.json`), JSON.stringify(colB));
  await writeFile(join(stateRoot, `${colC.id}.json`), JSON.stringify(colC));
  await writeFile(join(stateRoot, `${colE.id}.json`), JSON.stringify(colE));

  await mkdir(join(stateRoot, "archive"), { recursive: true });
  await writeFile(join(stateRoot, "archive", `${colD.id}.json`), JSON.stringify(colD));

  // 2. Setup Portfolios (using the real mergeTrain object structure)
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
    mergeTrain: {
      targetBranch: "main",
      targetSha: "b".repeat(40),
      queue: [
        { itemId: "lane-1", prNumber: 42, headSha: "a".repeat(40), priority: 10, status: "validating" }
      ],
      active: { itemId: "lane-1", targetSha: "b".repeat(40), headSha: "a".repeat(40) },
      history: [],
      revision: 1
    }
  };
  await writeFile(join(stateRoot, "portfolios", `${portfolio.id}.json`), JSON.stringify(portfolio));

  // Read initial file bytes to verify byte-for-byte immutability later
  const bytesColA = await readFile(join(stateRoot, `${colA.id}.json`));
  const bytesColB = await readFile(join(stateRoot, `${colB.id}.json`));
  const bytesColC = await readFile(join(stateRoot, `${colC.id}.json`));
  const bytesColE = await readFile(join(stateRoot, `${colE.id}.json`));
  const bytesPort = await readFile(join(stateRoot, "portfolios", `${portfolio.id}.json`));

  // 3. Run queryControlPlane direct API tests
  const result = await queryControlPlane(stateRoot, { now });

  // 4. Assert Immutability
  assert.deepEqual(await readFile(join(stateRoot, `${colA.id}.json`)), bytesColA);
  assert.deepEqual(await readFile(join(stateRoot, `${colB.id}.json`)), bytesColB);
  assert.deepEqual(await readFile(join(stateRoot, `${colC.id}.json`)), bytesColC);
  assert.deepEqual(await readFile(join(stateRoot, `${colE.id}.json`)), bytesColE);
  assert.deepEqual(await readFile(join(stateRoot, "portfolios", `${portfolio.id}.json`)), bytesPort);

  // 5. Assert Non-Archived Lanes by default (should be 5 lanes now: colA/lane-1, lane-2, colB, colC, colE)
  assert.equal(result.lanes.length, 5);

  // Find lanes
  const lane1 = result.lanes.find(l => l.id === colA.id);
  const lane2 = result.lanes.find(l => l.id === `${portfolio.id}:lane-2`);
  const laneB = result.lanes.find(l => l.id === colB.id);
  const laneC = result.lanes.find(l => l.id === colC.id);
  const laneE = result.lanes.find(l => l.id === colE.id);

  assert.ok(lane1, "lane-1 exists");
  assert.ok(lane2, "lane-2 exists");
  assert.ok(laneB, "laneB exists");
  assert.ok(laneC, "laneC exists");
  assert.ok(laneE, "laneE exists");

  // Check lane sorting
  const ids = result.lanes.map(l => l.id);
  const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ids, sortedIds, "Lanes should be sorted alphabetically by id");

  // Check lane-1 (combined)
  assert.equal(lane1.type, "combined");
  assert.equal(lane1.workspace, "/Users/norm/workspace-a");
  assert.deepEqual(lane1.participants, ["codex", "claude", "antigravity"]); // verified state.participants (including chair)
  assert.equal(lane1.writer, "claude");
  assert.equal(lane1.lifecyclePhase, "running");
  assert.equal(lane1.narrative.summary, "Old narrative summary");
  assert.equal(lane1.narrative.ageSeconds, 3000);
  assert.equal(lane1.narrative.isPlaceholder, false);
  assert.equal(lane1.heartbeat.ageSeconds, 10);
  assert.equal(lane1.portfolio.portfolioId, portfolio.id);
  assert.equal(lane1.portfolio.itemId, "lane-1");
  assert.equal(lane1.portfolio.mergeTrain.prNumber, 42);

  // Check blocker & decisionEscalation
  assert.ok(lane1.blocker.pendingDecision, "lane-1 should have a pending decision");
  assert.equal(lane1.blocker.pendingDecision.question, "Active pending decision?");
  assert.equal(lane1.blocker.pendingDecision.category, "money");
  assert.equal(lane1.blocker.pendingDecision.owner, "user");
  assert.equal(lane1.blocker.pendingDecision.reason, "Cost budget checks");
  assert.equal(lane1.blocker.pendingDecision.extraUnboundedField, undefined);

  assert.ok(lane1.blocker.decisionEscalation, "lane-1 should have decision escalation projected");
  assert.equal(lane1.blocker.decisionEscalation.question, "Escalated to User?");
  assert.equal(lane1.blocker.decisionEscalation.category, "money");
  assert.equal(lane1.blocker.decisionEscalation.owner, "user");
  assert.equal(lane1.blocker.decisionEscalation.reason, "Budget limit reached");

  // Check recovery details
  assert.deepEqual(lane1.recovery.unavailableAgents, { claude: "rate_limit" });
  assert.deepEqual(lane1.recovery.availableAgents, ["antigravity"]);
  assert.deepEqual(lane1.recovery.providerRecoveryState, { attempts: 2 });

  // Check budget limit/exceeded
  assert.equal(lane1.budget.limit, 10.00);
  assert.equal(lane1.budget.exceeded, true);

  // Check laneC (indeterminate recovery) with placeholder narrative
  assert.equal(laneC.type, "collaboration");
  assert.equal(laneC.lifecyclePhase, "indeterminate");
  assert.equal(laneC.narrative.isPlaceholder, true);
  assert.equal(laneC.blocker.error, "Broker restart found no owned worker process.");
  assert.equal(laneC.recovery.status, "indeterminate");
  assert.match(laneC.recovery.recommendation, /ambiguous/);
  assert.equal(laneC.recovery.processAlive, false);

  // Check laneE (active failed lane due to unavailable provider)
  assert.equal(laneE.type, "collaboration");
  assert.equal(laneE.lifecyclePhase, "failed");
  assert.equal(laneE.blocker.error, "No requested model is currently available.");
  assert.equal(laneE.nextAction, "requeue_or_cancel");

  // 6. Test Include Archived filter
  const resultWithArchived = await queryControlPlane(stateRoot, { now, includeArchived: true });
  assert.equal(resultWithArchived.lanes.length, 6);
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
  // colA and colE both have antigravity as participant/writer
  assert.equal(resProvider.lanes.length, 2);
  assert.ok(resProvider.lanes.some(l => l.id === colA.id));
  assert.ok(resProvider.lanes.some(l => l.id === colE.id));

  // Filter by portfolio
  const resPortfolio = await queryControlPlane(stateRoot, { now, portfolio: portfolio.id });
  assert.equal(resPortfolio.lanes.length, 2);

  // Test BRIDGE_PORTFOLIO_DIR env override
  const customPortfolioDir = await mkdtemp(join(tmpdir(), "agent-custom-portfolio-dir-"));
  try {
    const customPortfolio = {
      id: "helm-00000000-0000-4000-8000-000000000009",
      objective: "Custom objective",
      workspace: "/Users/norm/workspace-c",
      status: "planning",
      updatedAt: "2026-07-17T09:55:00.000Z",
      items: [{ id: "lane-c1", status: "ready", writer: "claude", priority: 1 }]
    };
    await writeFile(join(customPortfolioDir, `${customPortfolio.id}.json`), JSON.stringify(customPortfolio));
    process.env.BRIDGE_PORTFOLIO_DIR = customPortfolioDir;
    const resCustomPort = await queryControlPlane(stateRoot, { now });
    assert.ok(resCustomPort.lanes.some(l => l.id === `${customPortfolio.id}:lane-c1`));
  } finally {
    delete process.env.BRIDGE_PORTFOLIO_DIR;
    await rm(customPortfolioDir, { recursive: true, force: true });
  }

  // 8. Test CLI Integration Coverage (both default versioned JSON and --human output)
  const opsScript = resolve(import.meta.dirname, "bridge-ops.mjs");

  // JSON mode
  const cliJsonRun = spawnSync(process.execPath, [opsScript, "status"], {
    env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateRoot },
    encoding: "utf8"
  });
  assert.equal(cliJsonRun.status, 0);
  const parsedJson = JSON.parse(cliJsonRun.stdout);
  assert.equal(parsedJson.version, "1.0.0");
  assert.equal(parsedJson.lanes.length, 5);

  // Human mode
  const cliHumanRun = spawnSync(process.execPath, [opsScript, "status", "--human"], {
    env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateRoot },
    encoding: "utf8"
  });
  assert.equal(cliHumanRun.status, 0);
  assert.match(cliHumanRun.stdout, /Local Council Control Plane Status/);
  assert.match(cliHumanRun.stdout, /Narrative \(Agent\/Adapter\):/);
  assert.match(cliHumanRun.stdout, /Narrative \(Broker Placeholder\):/);
  assert.match(cliHumanRun.stdout, /Escalation:/);
  assert.match(cliHumanRun.stdout, /Error: No requested model is currently available\./);

  console.log("Control plane query & filtering tests passed successfully!");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

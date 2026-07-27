import { performance } from "node:perf_hooks";
import { createMissionControlSubscriptionClient } from "./mission-control-client.mjs";
import {
  createMissionControlEventState,
  reduceMissionControlEvent,
} from "./mission-control-event-reducer.mjs";
import { MISSION_CONTROL_EVENT_PROTOCOL_VERSION } from "./mission-control-event-protocol.mjs";
import { missionControlEventProjection } from "./mission-control-event-stream.mjs";
import { renderMissionControl } from "./mission-control.mjs";
import { projectMissionControlViewModel } from "./mission-control-view-model.mjs";

export const MISSION_CONTROL_SCALE_BUDGETS = Object.freeze({
  version: 1,
  scale: {
    500: { snapshotMedianMs: 50, projectionMedianMs: 75, redrawMedianMs: 75 },
    2000: { snapshotMedianMs: 150, projectionMedianMs: 200, redrawMedianMs: 200 },
    10000: { snapshotMedianMs: 750, projectionMedianMs: 750, redrawMedianMs: 1_000 },
  },
  burst: { events: 500, applyMedianMs: 2_500 },
  reconnect: { recoverMs: 1_500 },
  cleanup: { removals: 500, applyMedianMs: 3_500 },
  outputDepth: {
    0: { projectionMedianMs: 3, renderMedianMs: 10 },
    100: { projectionMedianMs: 3, renderMedianMs: 10 },
    1000: { projectionMedianMs: 5, renderMedianMs: 12 },
    5000: { projectionMedianMs: 10, renderMedianMs: 12 },
  },
  memory: { maxScenarioHeapDeltaMiB: 512, maxProcessRssMiB: 1_024 },
  growthExponent: { snapshot: 1.8, projection: 1.8, redraw: 1.8, burst: 1.8, cleanup: 1.8 },
  diagnostics: {
    algorithmicSensitivity: {
      gating: false,
      collectionPassExponent: 1.2,
      incrementalEventExponent: 0.4,
    },
  },
});

const SCALE_POINTS = Object.freeze([500, 2_000, 10_000]);
const LIVE_LANES = 50;
const REPOSITORIES = Object.freeze([
  "benchmark/alpha",
  "benchmark/bravo",
  "benchmark/charlie",
  "benchmark/delta",
]);
const PROVIDERS = Object.freeze(["claude", "codex", "antigravity"]);
const BASE_TIME = Date.parse("2026-07-26T12:00:00.000Z");

function iso(offsetMs) {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function historicalLane(index, outputDepth = 0) {
  const repository = REPOSITORIES[index % REPOSITORIES.length];
  const id = `history-${String(index).padStart(5, "0")}`;
  return {
    id,
    repository,
    type: "collaboration",
    mode: index % 7 === 0 ? "review" : "work",
    role: index % 7 === 0 ? "reviewer" : "writer",
    lifecyclePhase: index % 17 === 0 ? "failed" : "completed",
    status: index % 17 === 0 ? "failed" : "completed",
    createdAt: iso(index * 1_000),
    updatedAt: iso(index * 1_000 + 500),
    task: `Deterministic historical benchmark lane ${index}`,
    completion: { id: `completion-${index}`, completedAt: iso(index * 1_000 + 500) },
    github: { prNumber: index + 1, headSha: index.toString(16).padStart(40, "0").slice(-40) },
    output: Array.from({ length: outputDepth }, (_, line) => ({ sequence: line + 1, text: `output ${line}` })),
  };
}

function liveLane(index) {
  const repository = REPOSITORIES[index % REPOSITORIES.length];
  const provider = PROVIDERS[index % PROVIDERS.length];
  return {
    id: `live-${String(index).padStart(3, "0")}`,
    repository,
    type: "collaboration",
    mode: index % 3 === 0 ? "review" : "work",
    role: index % 3 === 0 ? "reviewer" : "writer",
    lifecyclePhase: index % 4 === 0 ? "reviewing" : "running",
    status: index % 4 === 0 ? "reviewing" : "running",
    createdAt: iso(20_000_000 + index * 1_000),
    updatedAt: iso(20_000_000 + index * 1_000 + 500),
    activeAgent: provider,
    writer: provider,
    task: `Concurrent live benchmark lane ${index}`,
    heartbeat: { heartbeatAt: iso(20_100_000), processAlive: true },
    narrative: { summary: `Provider ${provider} is processing lane ${index}.` },
  };
}

export function seedMissionControlSnapshot({ historicalLanes, liveLanes = LIVE_LANES, outputDepth = 0 } = {}) {
  if (!Number.isSafeInteger(historicalLanes) || historicalLanes < 0) throw new Error("historicalLanes must be a non-negative safe integer.");
  if (!Number.isSafeInteger(liveLanes) || liveLanes < 0) throw new Error("liveLanes must be a non-negative safe integer.");
  const lanes = Array.from({ length: historicalLanes }, (_, index) => historicalLane(index, index === 0 ? outputDepth : 0));
  lanes.push(...Array.from({ length: liveLanes }, (_, index) => liveLane(index)));
  return {
    generatedAt: iso(21_000_000),
    mode: "all",
    selectedTab: "history",
    repositories: REPOSITORIES.map((repository) => ({ repository })),
    lanes,
    providerQuota: null,
  };
}

function snapshotEnvelope(snapshot, { streamId = "mission-control-scale", sequence = 0 } = {}) {
  return {
    version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
    streamId,
    sequence,
    cursor: sequence,
    type: "snapshot",
    occurredAt: iso(sequence),
    payload: missionControlEventProjection(snapshot),
  };
}

function deltaEnvelope({ sequence, type, repository, laneId, payload, streamId = "mission-control-scale" }) {
  return {
    version: MISSION_CONTROL_EVENT_PROTOCOL_VERSION,
    streamId,
    sequence,
    cursor: sequence,
    type,
    occurredAt: iso(sequence),
    repository,
    laneId,
    payload,
  };
}

export function linearPercentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeDurations(durations, maxHeapDeltaBytes) {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    sampleCount: durations.length,
    samples: durations.map((value) => round(value)),
    minMs: round(sorted[0] || 0),
    medianMs: round(linearPercentile(sorted, 0.5)),
    p95Ms: round(linearPercentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) || 0),
    spreadMs: round((sorted.at(-1) || 0) - (sorted[0] || 0)),
    maxHeapDeltaBytes: Math.max(0, maxHeapDeltaBytes),
  };
}

function timedSamples(operation, { samples = 5 } = {}) {
  const durations = [];
  let maxHeapDeltaBytes = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
    maxHeapDeltaBytes = Math.max(maxHeapDeltaBytes, process.memoryUsage().heapUsed - heapBefore);
  }
  return summarizeDurations(durations, maxHeapDeltaBytes);
}

function timedStateSamples(setup, operation, { samples = 3 } = {}) {
  const durations = [];
  let maxHeapDeltaBytes = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const state = setup();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    operation(state);
    durations.push(performance.now() - startedAt);
    maxHeapDeltaBytes = Math.max(maxHeapDeltaBytes, process.memoryUsage().heapUsed - heapBefore);
  }
  return summarizeDurations(durations, maxHeapDeltaBytes);
}

async function timedAsync(operation) {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = await operation();
  return {
    elapsedMs: round(performance.now() - startedAt),
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
    result,
  };
}

function scaleScenario(historicalLanes) {
  const heapBefore = process.memoryUsage().heapUsed;
  const snapshot = seedMissionControlSnapshot({ historicalLanes });
  const envelope = snapshotEnvelope(snapshot);
  const eventState = createMissionControlEventState(envelope);
  const fixtureBytes = Buffer.byteLength(JSON.stringify(envelope));
  const scenarioHeapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const snapshotTiming = timedSamples(() => createMissionControlEventState(envelope));
  const projectionTiming = timedSamples(() => projectMissionControlViewModel(eventState, { selectedTab: "history" }));
  const redrawTiming = timedSamples(() => renderMissionControl(snapshot, {
    width: 160,
    height: 50,
    color: false,
    interactive: false,
    selectedRepository: null,
    now: BASE_TIME + 21_000_000,
  }));
  return {
    historicalLanes,
    liveLanes: LIVE_LANES,
    totalLanes: snapshot.lanes.length,
    fixtureBytes,
    scenarioHeapDeltaBytes,
    snapshot: snapshotTiming,
    projection: projectionTiming,
    redraw: redrawTiming,
  };
}

function applyBurst(snapshot, eventCount) {
  const envelope = snapshotEnvelope(snapshot);
  const events = Array.from({ length: eventCount }, (_, index) => {
    const lane = snapshot.lanes[snapshot.lanes.length - LIVE_LANES + (index % LIVE_LANES)];
    return deltaEnvelope({
      sequence: index + 1,
      type: "lane.updated",
      repository: lane.repository,
      laneId: lane.id,
      payload: { updatedAt: iso(22_000_000 + index), narrative: { summary: `burst-${index}` } },
    });
  });
  const timing = timedStateSamples(
    () => createMissionControlEventState(envelope),
    (initialState) => {
      let state = initialState;
      for (const event of events) state = reduceMissionControlEvent(state, event);
      if (state.cursor !== eventCount) throw new Error("Event burst did not advance the reducer cursor.");
    },
  );
  return { eventCount, ...timing };
}

function applyCleanup(snapshot, removalCount) {
  const envelope = snapshotEnvelope(snapshot);
  const events = Array.from({ length: removalCount }, (_, index) => {
    const lane = snapshot.lanes[index];
    return deltaEnvelope({
      sequence: index + 1,
      type: "lane.removed",
      repository: lane.repository,
      laneId: lane.id,
      payload: {},
    });
  });
  const timing = timedStateSamples(
    () => createMissionControlEventState(envelope),
    (initialState) => {
      let state = initialState;
      for (const event of events) state = reduceMissionControlEvent(state, event);
      if (Object.keys(state.lanes).length !== snapshot.lanes.length - removalCount) {
        throw new Error("Cleanup did not remove the expected number of lanes.");
      }
    },
  );
  return { removalCount, ...timing };
}

function outputDepthScenarios() {
  return [0, 100, 1_000, 5_000].map((outputDepth) => {
    const snapshot = seedMissionControlSnapshot({ historicalLanes: 100, liveLanes: 1, outputDepth });
    const eventState = createMissionControlEventState(snapshotEnvelope(snapshot, { streamId: `mission-control-output-${outputDepth}` }));
    const renderOptions = {
      selectedIndex: 0,
      selectedRepository: REPOSITORIES[0],
      activePane: 2,
      detailExpanded: true,
      width: 160,
      height: 80,
      color: false,
      interactive: false,
      now: BASE_TIME + 21_000_000,
    };
    const rendered = renderMissionControl(snapshot, renderOptions);
    const expectedOutputCount = `OUTPUT  ${outputDepth} records`;
    if (!rendered.includes(expectedOutputCount)) {
      throw new Error(`Output-depth render guard failed: expected selected lane marker ${JSON.stringify(expectedOutputCount)}.`);
    }
    return {
      outputDepth,
      projection: timedSamples(() => projectMissionControlViewModel(eventState, {
        selectedRepository: REPOSITORIES[0],
        selectedTab: "history",
      })),
      render: timedSamples(() => renderMissionControl(snapshot, renderOptions)),
      renderGuard: { selectedLaneId: snapshot.lanes[0].id, expectedOutputCount, observed: true },
      fixtureBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    };
  });
}

async function reconnectScenario(snapshot) {
  const first = snapshotEnvelope(snapshot, { streamId: "mission-control-reconnect-a" });
  const second = snapshotEnvelope(snapshot, { streamId: "mission-control-reconnect-b" });
  let snapshotReads = 0;
  let eventReads = 0;
  const controller = new AbortController();
  const client = createMissionControlSubscriptionClient({
    runtimeRoot: process.cwd(),
    waitMs: 0,
    reconnectDelayMs: 0,
    snapshotReader: async () => (snapshotReads++ === 0 ? first : second),
    eventReader: async () => {
      eventReads += 1;
      if (eventReads === 1) throw new Error("deterministic transport disconnect");
      return { streamId: first.streamId, cursor: 0, events: [], resyncRequired: true, reason: "stream_changed" };
    },
    onUpdate: ({ reason }) => {
      if (reason === "resync:stream_changed") controller.abort();
    },
  });
  const timing = await timedAsync(() => client.run({ signal: controller.signal }));
  const observed = client.snapshot;
  if (observed.reconnectCount !== 1 || observed.resyncCount !== 1 || observed.checkpoint?.streamId !== second.streamId) {
    throw new Error("Reconnect benchmark did not preserve the cursor and perform exactly one resync.");
  }
  return {
    elapsedMs: timing.elapsedMs,
    heapDeltaBytes: timing.heapDeltaBytes,
    reconnectCount: observed.reconnectCount,
    resyncCount: observed.resyncCount,
    snapshotReads,
    eventReads,
  };
}

export function leastSquaresGrowthFit(points) {
  const usable = points.filter(({ size, medianMs }) => size > 0 && medianMs > 0);
  if (usable.length < 2) return { exponent: 0, intercept: 0, rSquared: 1, rmseLog: 0, slopeStdError: null, confidence95Approx: null, points: [] };
  const transformed = usable.map(({ size, medianMs }) => ({ size, medianMs, x: Math.log(size), y: Math.log(medianMs) }));
  const meanX = transformed.reduce((sum, point) => sum + point.x, 0) / transformed.length;
  const meanY = transformed.reduce((sum, point) => sum + point.y, 0) / transformed.length;
  const denominator = transformed.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const exponent = transformed.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - exponent * meanX;
  const evidence = transformed.map((point) => {
    const predictedLog = intercept + exponent * point.x;
    return { size: point.size, medianMs: round(point.medianMs), predictedMs: round(Math.exp(predictedLog)), residualLog: round(point.y - predictedLog, 6) };
  });
  const residualSumSquares = evidence.reduce((sum, point) => sum + point.residualLog ** 2, 0);
  const totalSumSquares = transformed.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const degreesOfFreedom = transformed.length - 2;
  const slopeStdError = degreesOfFreedom > 0 ? Math.sqrt((residualSumSquares / degreesOfFreedom) / denominator) : null;
  const t95 = degreesOfFreedom === 1 ? 12.706 : 1.96;
  return {
    exponent: round(exponent),
    intercept: round(intercept, 6),
    rSquared: round(totalSumSquares === 0 ? 1 : 1 - residualSumSquares / totalSumSquares, 6),
    rmseLog: round(Math.sqrt(residualSumSquares / transformed.length), 6),
    slopeStdError: slopeStdError === null ? null : round(slopeStdError, 6),
    confidence95Approx: slopeStdError === null ? null : { low: round(exponent - t95 * slopeStdError), high: round(exponent + t95 * slopeStdError) },
    points: evidence,
  };
}

function evaluateBudgets(results, budgets) {
  const failures = [];
  const check = (path, observed, limit, unit) => {
    if (observed > limit) failures.push({ kind: "budget", path, observed, limit, unit, message: null });
  };
  for (const scenario of results.scale) {
    const budget = budgets.scale[scenario.historicalLanes];
    check(`scale.${scenario.historicalLanes}.snapshot.medianMs`, scenario.snapshot.medianMs, budget.snapshotMedianMs, "ms");
    check(`scale.${scenario.historicalLanes}.projection.medianMs`, scenario.projection.medianMs, budget.projectionMedianMs, "ms");
    check(`scale.${scenario.historicalLanes}.redraw.medianMs`, scenario.redraw.medianMs, budget.redrawMedianMs, "ms");
    check(`scale.${scenario.historicalLanes}.scenarioHeapDeltaMiB`, scenario.scenarioHeapDeltaBytes / 2 ** 20, budgets.memory.maxScenarioHeapDeltaMiB, "MiB");
  }
  check("burst.apply.medianMs", results.burst.medianMs, budgets.burst.applyMedianMs, "ms");
  check("cleanup.apply.medianMs", results.cleanup.medianMs, budgets.cleanup.applyMedianMs, "ms");
  check("reconnect.elapsedMs", results.reconnect.elapsedMs, budgets.reconnect.recoverMs, "ms");
  for (const result of results.outputDepth) {
    const budget = budgets.outputDepth[result.outputDepth];
    check(`outputDepth.${result.outputDepth}.projection.medianMs`, result.projection.medianMs, budget.projectionMedianMs, "ms");
    check(`outputDepth.${result.outputDepth}.render.medianMs`, result.render.medianMs, budget.renderMedianMs, "ms");
  }
  check("process.rssMiB", results.processMemory.rss / 2 ** 20, budgets.memory.maxProcessRssMiB, "MiB");
  for (const [name, fit] of Object.entries(results.growthFit)) {
    check(`growthFit.${name}.exponent`, fit.exponent, budgets.growthExponent[name], "exponent");
  }
  return failures;
}

function rustEvaluation(results, failures, budgets) {
  const sensitivity = budgets.diagnostics.algorithmicSensitivity;
  const algorithmic = Object.entries(results.growthFit)
    .filter(([metric, fit]) => fit.exponent > (
      ["burst", "cleanup"].includes(metric)
        ? sensitivity.incrementalEventExponent
        : sensitivity.collectionPassExponent
    ))
    .map(([metric, fit]) => ({ metric, fit, advisory: true }));
  const latencyFailures = failures.filter((failure) => failure.unit === "ms");
  if (algorithmic.length) {
    return {
      classification: "algorithmic-scaling",
      rustRecommended: false,
      gating: false,
      evidence: algorithmic,
      decision: "Keep the orchestration path in JavaScript and first replace whole-collection cloning, sorting, or scanning with indexed incremental updates. Rewriting the same asymptotic work in Rust would only reduce a constant.",
      candidateBoundary: "After algorithmic repairs, isolate event projection/diffing plus snapshot serialization behind the versioned Mission Control event protocol if measured constant cost still exceeds redraw budgets.",
    };
  }
  if (latencyFailures.length) {
    return {
      classification: "constant-cost",
      rustRecommended: true,
      gating: false,
      evidence: latencyFailures,
      decision: "The measured curves remain near-linear but exceed latency budgets; a native implementation may reduce constant CPU and allocation cost.",
      candidateBoundary: "Move event projection/diffing and snapshot serialization behind the existing versioned event envelopes; keep navigation, policy, rendering, and MCP orchestration in JavaScript.",
    };
  }
  return {
    classification: "javascript-sufficient",
    rustRecommended: false,
    gating: false,
    evidence: [],
    decision: "JavaScript remains within the explicit scale budgets; a Rust migration is not justified by this run.",
    candidateBoundary: "Retain the versioned event projection/diff and snapshot-serialization seam as the only future native boundary.",
  };
}

export async function runMissionControlScaleBenchmark({ budgets = MISSION_CONTROL_SCALE_BUDGETS } = {}) {
  const startedAt = new Date().toISOString();
  // Warm the validator, Intl, rendering, and structured-clone paths before the
  // measured scenarios so process startup does not masquerade as scale cost.
  const warm = seedMissionControlSnapshot({ historicalLanes: 25, liveLanes: 5 });
  const warmState = createMissionControlEventState(snapshotEnvelope(warm, { streamId: "mission-control-warmup" }));
  projectMissionControlViewModel(warmState, {});
  renderMissionControl(warm, { width: 120, height: 30, color: false, interactive: false, now: BASE_TIME });

  const scale = SCALE_POINTS.map(scaleScenario);
  const sensitivity = SCALE_POINTS.map((historicalLanes) => {
    const snapshot = seedMissionControlSnapshot({ historicalLanes });
    return {
      historicalLanes,
      burst: applyBurst(snapshot, 100),
      cleanup: applyCleanup(snapshot, Math.min(100, historicalLanes)),
    };
  });
  const largest = seedMissionControlSnapshot({ historicalLanes: SCALE_POINTS.at(-1) });
  const burst = applyBurst(largest, budgets.burst.events);
  const cleanup = applyCleanup(largest, budgets.cleanup.removals);
  const outputDepth = outputDepthScenarios();
  const reconnect = await reconnectScenario(largest);
  const growthFit = {
    snapshot: leastSquaresGrowthFit(scale.map((point) => ({ size: point.historicalLanes, medianMs: point.snapshot.medianMs }))),
    projection: leastSquaresGrowthFit(scale.map((point) => ({ size: point.historicalLanes, medianMs: point.projection.medianMs }))),
    redraw: leastSquaresGrowthFit(scale.map((point) => ({ size: point.historicalLanes, medianMs: point.redraw.medianMs }))),
    burst: leastSquaresGrowthFit(sensitivity.map((point) => ({ size: point.historicalLanes, medianMs: point.burst.medianMs }))),
    cleanup: leastSquaresGrowthFit(sensitivity.map((point) => ({ size: point.historicalLanes, medianMs: point.cleanup.medianMs }))),
  };
  const results = {
    scale,
    historySensitivity: sensitivity,
    burst,
    cleanup,
    reconnect,
    outputDepth,
    growthFit,
    processMemory: process.memoryUsage(),
  };
  const failures = evaluateBudgets(results, budgets);
  return {
    schemaVersion: 1,
    benchmark: "mission-control-scale",
    resultKind: "measurements",
    status: failures.length ? "budget-failed" : "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    reproducibility: {
      historicalLaneCounts: [...SCALE_POINTS],
      concurrentLiveLanes: LIVE_LANES,
      seedTime: new Date(BASE_TIME).toISOString(),
      samplesPerScalePoint: 5,
      expensiveSamples: 3,
      percentileMethod: "linear-interpolation",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    budgets,
    results,
    failures,
    rustEvaluation: rustEvaluation(results, failures, budgets),
    error: null,
  };
}

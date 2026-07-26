import { createHash } from "node:crypto";

export const REVIEW_BENCHMARK_SCHEMA_VERSION = 1;
export const ADJUDICATION_STATES = Object.freeze(["unresolved", "accepted", "rejected", "duplicate", "advisory"]);

const EXACT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_KEY = /(?:^|_)(?:prompt|private_reasoning|chain_of_thought|secret|token|password|credential|authorization|api_key)(?:$|_)/i;
const SECRET_TEXT = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:bearer|authorization:)\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/gi;
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info", "unspecified"]);

function requiredString(value, field, { max = 4_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  return normalized.replace(SECRET_TEXT, "[REDACTED]");
}

function optionalString(value, field, options) {
  return value == null ? null : requiredString(value, field, options);
}

function rejectSensitiveShape(value, path = "record") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (SECRET_KEY.test(canonicalKey)) throw new TypeError(`${path}.${key} is forbidden in the redacted benchmark ledger`);
    rejectSensitiveShape(child, `${path}.${key}`);
  }
}

function finiteMetric(value, field, { integer = false } = {}) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${field} must be a non-negative ${integer ? "integer" : "finite number"} or null`);
  }
  return value;
}

function booleanMetric(value, field, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean or null`);
  return value;
}

function optionalDigest(value, field) {
  if (value == null) return null;
  const digest = requiredString(value, field, { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${field} must be a 64-character SHA-256 digest`);
  return digest;
}

export function validateBenchmarkTarget(repository, headSha) {
  const normalizedRepository = requiredString(repository, "repository", { max: 200 });
  const normalizedHead = requiredString(headSha, "headSha", { max: 40 }).toLowerCase();
  if (!REPOSITORY.test(normalizedRepository)) throw new TypeError("repository must use owner/name form");
  if (!EXACT_SHA.test(normalizedHead)) throw new TypeError("headSha must be an exact 40-character hexadecimal commit SHA");
  return { repository: normalizedRepository.toLowerCase(), headSha: normalizedHead };
}

function normalizePath(value) {
  const path = requiredString(value, "finding.path", { max: 1_024 }).replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").includes("..")) throw new TypeError("finding.path must be repository-relative");
  return path.replace(/^\.\//, "");
}

function normalizeLine(value, field = "finding.line") {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer or null`);
  return value;
}

function canonicalFindingKey(finding) {
  const identity = [finding.path, finding.startLine ?? "", finding.endLine ?? "", finding.ruleId ?? "", finding.claim.toLowerCase().replace(/\s+/g, " ")].join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

export function normalizeFinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("finding must be an object");
  rejectSensitiveShape(input, "finding");
  const startLine = normalizeLine(input.startLine ?? input.line, "finding.startLine");
  const endLine = normalizeLine(input.endLine ?? input.line, "finding.endLine");
  if (startLine == null && endLine != null) throw new TypeError("finding.endLine requires finding.startLine");
  if (startLine != null && endLine != null && endLine < startLine) throw new TypeError("finding.endLine must not precede finding.startLine");
  const severity = String(input.severity ?? "unspecified").trim().toLowerCase() || "unspecified";
  if (!SEVERITIES.has(severity)) throw new TypeError(`unsupported finding severity: ${severity}`);
  const claim = requiredString(input.claim ?? input.summary ?? input.message, "finding.claim");
  const finding = {
    path: normalizePath(input.path),
    line: startLine,
    startLine,
    endLine,
    severity,
    blocking: booleanMetric(input.blocking, "finding.blocking", ["critical", "high"].includes(severity)),
    ruleId: optionalString(input.ruleId, "finding.ruleId", { max: 200 }),
    claim,
    summary: claim,
    proposedFix: optionalString(input.proposedFix, "finding.proposedFix"),
    citationValid: booleanMetric(input.citationValid, "finding.citationValid"),
    evidenceSupported: booleanMetric(input.evidenceSupported, "finding.evidenceSupported"),
    actionable: booleanMetric(input.actionable, "finding.actionable"),
  };
  return Object.freeze({ ...finding, key: canonicalFindingKey(finding) });
}

function compareFindings(left, right) { return left.key.localeCompare(right.key); }

function normalizeReliability(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("reliability must be an object");
  return Object.freeze({
    timedOut: booleanMetric(input.timedOut, "reliability.timedOut", false),
    emptyResponse: booleanMetric(input.emptyResponse, "reliability.emptyResponse", false),
    invalidEnvelope: booleanMetric(input.invalidEnvelope, "reliability.invalidEnvelope", false),
    recoveryCount: finiteMetric(input.recoveryCount ?? 0, "reliability.recoveryCount", { integer: true }),
    fallbackCount: finiteMetric(input.fallbackCount ?? 0, "reliability.fallbackCount", { integer: true }),
  });
}

function normalizePerformance(input, latencyMs) {
  if (input != null && (typeof input !== "object" || Array.isArray(input))) throw new TypeError("performance must be an object");
  const source = input ?? {};
  return Object.freeze({
    latencyMs,
    localWallTimeMs: finiteMetric(source.localWallTimeMs, "performance.localWallTimeMs"),
    inputTokens: finiteMetric(source.inputTokens, "performance.inputTokens", { integer: true }),
    outputTokens: finiteMetric(source.outputTokens, "performance.outputTokens", { integer: true }),
    estimatedCostUsd: finiteMetric(source.estimatedCostUsd, "performance.estimatedCostUsd"),
    peakMemoryMb: finiteMetric(source.peakMemoryMb, "performance.peakMemoryMb"),
  });
}

function normalizeOutcomes(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("outcomes must be an object");
  return Object.freeze({
    laterCiFailures: finiteMetric(input.laterCiFailures ?? 0, "outcomes.laterCiFailures", { integer: true }),
    reviewFollowUps: finiteMetric(input.reviewFollowUps ?? 0, "outcomes.reviewFollowUps", { integer: true }),
    revertedFixes: finiteMetric(input.revertedFixes ?? 0, "outcomes.revertedFixes", { integer: true }),
    postMergeDefects: finiteMetric(input.postMergeDefects ?? 0, "outcomes.postMergeDefects", { integer: true }),
    escapedIssues: finiteMetric(input.escapedIssues ?? 0, "outcomes.escapedIssues", { integer: true }),
  });
}

function normalizeReviewArtifact(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("reviewArtifact must be an object");
  const kind = requiredString(input.kind, "reviewArtifact.kind", { max: 50 }).toLowerCase();
  if (!["github-review", "redacted-handoff"].includes(kind)) throw new TypeError(`unsupported reviewArtifact.kind: ${kind}`);
  return Object.freeze({
    kind,
    reference: requiredString(input.reference, "reviewArtifact.reference", { max: 1_000 }),
    digest: optionalDigest(input.digest, "reviewArtifact.digest"),
  });
}

export function normalizeReviewEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("review envelope must be an object");
  rejectSensitiveShape(input);
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_BENCHMARK_SCHEMA_VERSION) {
    const error = new Error(`unsupported review benchmark schema version: ${String(input.schemaVersion)}`);
    error.code = "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA";
    throw error;
  }
  if (input.localProvider !== undefined && typeof input.localProvider !== "boolean") throw new TypeError("localProvider must be a boolean when supplied");
  const target = validateBenchmarkTarget(input.repository, input.headSha);
  const timestamp = requiredString(input.timestamp, "timestamp", { max: 100 });
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("timestamp must be an ISO-compatible date-time");
  const latencyMs = finiteMetric(input.latencyMs, "latencyMs");
  if (latencyMs == null) throw new TypeError("latencyMs must be a non-negative finite number");
  const localProvider = input.localProvider === true;
  const findingsByKey = new Map((input.findings ?? []).map(normalizeFinding).map((finding) => [finding.key, finding]));
  const normalized = {
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION,
    recordType: "review_run",
    ...target,
    provider: requiredString(input.provider, "provider", { max: 100 }).toLowerCase(),
    model: optionalString(input.model, "model", { max: 200 })?.toLowerCase() ?? null,
    repositoryCohort: optionalString(input.repositoryCohort, "repositoryCohort", { max: 100 })?.toLowerCase() ?? "default",
    contractDigest: optionalDigest(input.contractDigest, "contractDigest"),
    evidenceSurfaceDigest: optionalDigest(input.evidenceSurfaceDigest, "evidenceSurfaceDigest"),
    runId: requiredString(input.runId, "runId", { max: 200 }),
    timestamp: new Date(timestamp).toISOString(),
    latencyMs,
    localProvider,
    mode: "shadow-review",
    authority: "non-authorizing",
    exactHeadComplete: booleanMetric(input.exactHeadComplete, "exactHeadComplete", null),
    verdict: optionalString(input.verdict, "verdict", { max: 50 })?.toUpperCase() ?? null,
    findings: [...findingsByKey.values()].sort(compareFindings),
    reviewArtifact: normalizeReviewArtifact(input.reviewArtifact),
    performance: normalizePerformance(input.performance, latencyMs),
    reliability: normalizeReliability(input.reliability),
    outcomes: normalizeOutcomes(input.outcomes),
  };
  return Object.freeze(normalized);
}

function normalizeAdjudications(values, observedKeys) {
  if (!Array.isArray(values)) throw new TypeError("findingAdjudications must be an array");
  const result = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("finding adjudication must be an object");
    rejectSensitiveShape(value, "findingAdjudication");
    const normalizedFinding = value.finding ? normalizeFinding(value.finding) : null;
    const findingKey = requiredString(value.findingKey ?? normalizedFinding?.key, "findingAdjudication.findingKey", { max: 64 });
    if (normalizedFinding && value.findingKey && value.findingKey !== normalizedFinding.key) throw new Error("adjudication findingKey does not match its normalized finding");
    if (!/^[0-9a-f]{64}$/.test(findingKey) || !observedKeys.has(findingKey)) throw new Error(`adjudication references unknown finding: ${findingKey}`);
    const status = requiredString(value.status, "findingAdjudication.status", { max: 20 }).toLowerCase();
    if (!ADJUDICATION_STATES.includes(status)) throw new TypeError(`unsupported adjudication state: ${status}`);
    if (status === "accepted" && !normalizedFinding) throw new Error("accepted adjudication requires the chair-assigned normalized finding");
    const evidence = Array.isArray(value.evidence) ? value.evidence.map((entry) => requiredString(entry, "findingAdjudication.evidence", { max: 1_000 })) : [];
    if (status !== "unresolved" && evidence.length === 0) throw new Error(`${status} adjudication requires chair verification or implementation/re-review evidence`);
    const duplicateOf = status === "duplicate" ? requiredString(value.duplicateOf, "findingAdjudication.duplicateOf", { max: 64 }) : null;
    result.set(findingKey, Object.freeze({ findingKey, finding: normalizedFinding, status, evidence, duplicateOf }));
  }
  return result;
}

export function transitionFindingAdjudication(current, next) {
  const currentState = current?.status ?? "unresolved";
  const nextState = requiredString(next?.status, "adjudication.status", { max: 20 }).toLowerCase();
  if (!ADJUDICATION_STATES.includes(currentState) || !ADJUDICATION_STATES.includes(nextState)) throw new TypeError("unsupported adjudication transition state");
  if (currentState !== "unresolved" && nextState === "unresolved") throw new Error(`adjudication cannot transition from ${currentState} back to unresolved`);
  const evidence = Array.isArray(next.evidence) ? next.evidence.map((entry) => requiredString(entry, "adjudication.evidence", { max: 1_000 })) : [];
  if (nextState !== "unresolved" && evidence.length === 0) throw new Error(`${nextState} adjudication requires evidence`);
  return Object.freeze({ status: nextState, evidence, duplicateOf: nextState === "duplicate" ? requiredString(next.duplicateOf, "adjudication.duplicateOf", { max: 64 }) : null });
}

export function normalizeBenchmarkAdjudication(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("benchmark adjudication must be an object");
  rejectSensitiveShape(input);
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_BENCHMARK_SCHEMA_VERSION) {
    const error = new Error(`unsupported review benchmark schema version: ${String(input.schemaVersion)}`);
    error.code = "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA"; throw error;
  }
  const target = validateBenchmarkTarget(input.repository, input.headSha);
  const timestamp = requiredString(input.timestamp, "timestamp", { max: 100 });
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("timestamp must be an ISO-compatible date-time");
  const finding = input.finding ? normalizeFinding(input.finding) : null;
  const findingKey = requiredString(input.findingKey ?? finding?.key, "findingKey", { max: 64 });
  if (!/^[0-9a-f]{64}$/.test(findingKey)) throw new TypeError("findingKey must be a normalized 64-character finding key");
  if (finding && finding.key !== findingKey) throw new Error("adjudication findingKey does not match its normalized finding");
  const transition = transitionFindingAdjudication(input.previousStatus ? { status: input.previousStatus } : null, input);
  if (transition.status === "accepted" && !finding) throw new Error("accepted adjudication requires the chair-assigned normalized finding");
  return Object.freeze({
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION, recordType: "finding_adjudication", ...target,
    adjudicationId: requiredString(input.adjudicationId, "adjudicationId", { max: 200 }),
    timestamp: new Date(timestamp).toISOString(), findingKey, finding, previousStatus: input.previousStatus ?? "unresolved", ...transition,
  });
}

export function normalizeBenchmarkOutcome(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("benchmark outcome must be an object");
  rejectSensitiveShape(input);
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_BENCHMARK_SCHEMA_VERSION) {
    const error = new Error(`unsupported review benchmark schema version: ${String(input.schemaVersion)}`);
    error.code = "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA"; throw error;
  }
  const target = validateBenchmarkTarget(input.repository, input.headSha);
  const timestamp = requiredString(input.timestamp, "timestamp", { max: 100 });
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("timestamp must be an ISO-compatible date-time");
  const evidence = Array.isArray(input.evidence) ? input.evidence.map((entry) => requiredString(entry, "outcome.evidence", { max: 1_000 })) : [];
  if (evidence.length === 0) throw new Error("review outcome requires durable evidence");
  const outcomes = normalizeOutcomes(input.outcomes);
  if (Object.values(outcomes).every((value) => value === 0)) throw new Error("review outcome must record at least one observed event");
  return Object.freeze({
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION, recordType: "review_outcome", ...target,
    outcomeId: requiredString(input.outcomeId, "outcomeId", { max: 200 }),
    provider: requiredString(input.provider, "provider", { max: 100 }).toLowerCase(),
    model: optionalString(input.model, "model", { max: 200 })?.toLowerCase() ?? null,
    runId: requiredString(input.runId, "runId", { max: 200 }), timestamp: new Date(timestamp).toISOString(),
    outcomes, evidence,
  });
}

export function adjudicateReviewRuns(runs, options = {}) {
  if (!Array.isArray(runs) || runs.length === 0) throw new TypeError("runs must contain at least one review envelope");
  const normalizedRuns = runs.map(normalizeReviewEnvelope);
  const { repository, headSha } = normalizedRuns[0];
  if (normalizedRuns.some((run) => run.repository !== repository || run.headSha !== headSha)) throw new Error("all benchmark runs must target the same exact repository and head SHA");
  const observedFindings = new Map(normalizedRuns.flatMap((run) => run.findings).map((finding) => [finding.key, finding]));
  for (const entry of options.findingAdjudications ?? []) {
    if (entry?.finding) {
      const finding = normalizeFinding(entry.finding);
      if (entry.findingKey && entry.findingKey !== finding.key) throw new Error("adjudication findingKey does not match its normalized finding");
      observedFindings.set(finding.key, finding);
    }
  }
  const contractDigests = new Set(normalizedRuns.map((run) => run.contractDigest ?? "missing"));
  const evidenceDigests = new Set(normalizedRuns.map((run) => run.evidenceSurfaceDigest ?? "missing"));
  if (contractDigests.size > 1 || evidenceDigests.size > 1) throw new Error("all benchmark runs must use the same prompt contract and bounded evidence surface digests");
  if (options.acceptedFindings !== undefined || options.rejectedFindings !== undefined) {
    throw new Error("acceptedFindings/rejectedFindings are unsupported; use evidenced findingAdjudications");
  }
  const adjudications = normalizeAdjudications(options.findingAdjudications ?? [], new Set(observedFindings.keys()));
  const accepted = new Set([...adjudications.values()].filter((entry) => entry.status === "accepted").map((entry) => entry.findingKey));

  const results = normalizedRuns.map((run) => {
    const observed = new Set(run.findings.map((finding) => finding.key));
    const runFindings = new Map(run.findings.map((finding) => [finding.key, finding]));
    const byStatus = Object.fromEntries(ADJUDICATION_STATES.map((status) => [status, []]));
    for (const key of observed) byStatus[adjudications.get(key)?.status ?? "unresolved"].push(key);
    for (const keys of Object.values(byStatus)) keys.sort();
    const truePositives = byStatus.accepted;
    const falsePositives = byStatus.rejected;
    const falseNegatives = [...accepted].filter((key) => !observed.has(key)).sort();
    const validCitationCount = run.findings.filter((finding) => finding.citationValid === true).length;
    const supportedCount = run.findings.filter((finding) => finding.evidenceSupported === true).length;
    const actionableCount = run.findings.filter((finding) => finding.actionable === true || finding.proposedFix).length;
    const severityComparisons = truePositives.map((key) => runFindings.get(key)?.severity === adjudications.get(key)?.finding?.severity);
    return Object.freeze({
      provider: run.provider, model: run.model, repositoryCohort: run.repositoryCohort, runId: run.runId,
      latencyMs: run.latencyMs, performance: run.performance, reliability: run.reliability, exactHeadComplete: run.exactHeadComplete,
      outcomes: run.outcomes,
      truePositives, falsePositives, falseNegatives, unadjudicated: byStatus.unresolved,
      duplicateFindings: byStatus.duplicate, advisoryFindings: byStatus.advisory,
      blockingTruePositives: truePositives.filter((key) => runFindings.get(key)?.blocking),
      blockingFalseNegatives: falseNegatives.filter((key) => adjudications.get(key)?.finding?.blocking),
      validCitationCount, supportedCount, actionableCount,
      severityCalibratedCount: severityComparisons.filter(Boolean).length, severityEvaluatedCount: severityComparisons.length,
      contractBound: Boolean(run.contractDigest && run.evidenceSurfaceDigest),
      adjudicationComplete: run.findings.every((finding) => (adjudications.get(finding.key)?.status ?? "unresolved") !== "unresolved"),
    });
  }).sort((left, right) => left.provider.localeCompare(right.provider) || (left.model ?? "").localeCompare(right.model ?? "") || left.runId.localeCompare(right.runId));

  const findingProviders = new Map();
  for (const run of normalizedRuns) for (const finding of run.findings) {
    const providers = findingProviders.get(finding.key) ?? new Set();
    providers.add(`${run.provider}/${run.model ?? "unknown"}`); findingProviders.set(finding.key, providers);
  }
  const resultsWithIncremental = results.map((result) => Object.freeze({ ...result,
    uniqueValidFindings: result.truePositives.filter((key) => findingProviders.get(key)?.size === 1),
  }));
  return Object.freeze({
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION, repository, headSha,
    acceptedFindingKeys: [...accepted].sort(),
    rejectedFindingKeys: [...adjudications.values()].filter((entry) => entry.status === "rejected").map((entry) => entry.findingKey).sort(),
    adjudications: [...adjudications.values()].sort((a, b) => a.findingKey.localeCompare(b.findingKey)),
    results: resultsWithIncremental,
  });
}

import { createHash } from "node:crypto";

export const REVIEW_BENCHMARK_SCHEMA_VERSION = 1;

const EXACT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function validateBenchmarkTarget(repository, headSha) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedHead = requiredString(headSha, "headSha").toLowerCase();
  if (!REPOSITORY.test(normalizedRepository)) {
    throw new TypeError("repository must use owner/name form");
  }
  if (!EXACT_SHA.test(normalizedHead)) {
    throw new TypeError("headSha must be an exact 40-character hexadecimal commit SHA");
  }
  return { repository: normalizedRepository.toLowerCase(), headSha: normalizedHead };
}

function normalizePath(value) {
  const path = requiredString(value, "finding.path").replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new TypeError("finding.path must be repository-relative");
  }
  return path.replace(/^\.\//, "");
}

function normalizeLine(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("finding.line must be a positive integer or null");
  }
  return value;
}

function canonicalFindingKey(finding) {
  const identity = [
    finding.path,
    finding.line ?? "",
    finding.ruleId ?? "",
    finding.summary.toLowerCase().replace(/\s+/g, " "),
  ].join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

export function normalizeFinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("finding must be an object");
  }
  const finding = {
    path: normalizePath(input.path),
    line: normalizeLine(input.line),
    severity: String(input.severity ?? "unspecified").trim().toLowerCase() || "unspecified",
    ruleId: input.ruleId == null ? null : requiredString(input.ruleId, "finding.ruleId"),
    summary: requiredString(input.summary ?? input.message, "finding.summary"),
  };
  return Object.freeze({ ...finding, key: canonicalFindingKey(finding) });
}

function compareFindings(left, right) {
  return left.key.localeCompare(right.key);
}

export function normalizeReviewEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("review envelope must be an object");
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_BENCHMARK_SCHEMA_VERSION) {
    const error = new Error(`unsupported review benchmark schema version: ${String(input.schemaVersion)}`);
    error.code = "UNSUPPORTED_REVIEW_BENCHMARK_SCHEMA";
    throw error;
  }
  if (input.localProvider !== undefined && typeof input.localProvider !== "boolean") {
    throw new TypeError("localProvider must be a boolean when supplied");
  }
  const target = validateBenchmarkTarget(input.repository, input.headSha);
  const timestamp = requiredString(input.timestamp, "timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("timestamp must be an ISO-compatible date-time");
  }
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
    throw new TypeError("latencyMs must be a non-negative finite number");
  }
  const localProvider = input.localProvider === true;
  const findingsByKey = new Map(
    (input.findings ?? []).map(normalizeFinding).map((finding) => [finding.key, finding]),
  );
  const normalized = {
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION,
    ...target,
    provider: requiredString(input.provider, "provider").toLowerCase(),
    runId: requiredString(input.runId, "runId"),
    timestamp: new Date(timestamp).toISOString(),
    latencyMs: input.latencyMs,
    localProvider,
    authority: localProvider ? "non-authorizing" : "observational",
    findings: [...findingsByKey.values()].sort(compareFindings),
  };
  return Object.freeze(normalized);
}

function findingKeys(values, field) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  return new Set(values.map((value) => {
    if (typeof value === "string") return requiredString(value, field);
    return normalizeFinding(value).key;
  }));
}

export function adjudicateReviewRuns(runs, { acceptedFindings = [], rejectedFindings = [] } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new TypeError("runs must contain at least one review envelope");
  }
  const normalizedRuns = runs.map(normalizeReviewEnvelope);
  const { repository, headSha } = normalizedRuns[0];
  if (normalizedRuns.some((run) => run.repository !== repository || run.headSha !== headSha)) {
    throw new Error("all benchmark runs must target the same exact repository and head SHA");
  }
  const accepted = findingKeys(acceptedFindings, "acceptedFindings");
  const rejected = findingKeys(rejectedFindings, "rejectedFindings");
  for (const key of accepted) {
    if (rejected.has(key)) throw new Error(`finding ${key} cannot be both accepted and rejected`);
  }

  const results = normalizedRuns.map((run) => {
    const observed = new Set(run.findings.map((finding) => finding.key));
    const truePositives = [...accepted].filter((key) => observed.has(key)).sort();
    const falseNegatives = [...accepted].filter((key) => !observed.has(key)).sort();
    const falsePositives = [...rejected].filter((key) => observed.has(key)).sort();
    const unadjudicated = [...observed].filter((key) => !accepted.has(key) && !rejected.has(key)).sort();
    return Object.freeze({
      provider: run.provider,
      runId: run.runId,
      latencyMs: run.latencyMs,
      truePositives,
      falsePositives,
      falseNegatives,
      unadjudicated,
    });
  }).sort((left, right) => left.provider.localeCompare(right.provider) || left.runId.localeCompare(right.runId));

  return Object.freeze({
    schemaVersion: REVIEW_BENCHMARK_SCHEMA_VERSION,
    repository,
    headSha,
    acceptedFindingKeys: [...accepted].sort(),
    rejectedFindingKeys: [...rejected].sort(),
    results,
  });
}

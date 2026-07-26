function ratio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const index = Math.ceil(fraction * values.length) - 1;
  return values[Math.max(0, index)];
}

function summarize(values) {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return Object.freeze({
    min: sorted[0] ?? null,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
  });
}

export function confidenceLabel(sampleCount, adjudicatedFindingCount) {
  if (sampleCount < 5 || adjudicatedFindingCount < 10) return "insufficient";
  if (sampleCount < 15 || adjudicatedFindingCount < 30) return "directional";
  if (sampleCount < 30 || adjudicatedFindingCount < 75) return "moderate";
  return "strong";
}

function cohortKey(result, repository) {
  return [result.provider, result.model ?? "unknown", result.repositoryCohort ?? "default", repository].join("\u0000");
}

export function aggregateReviewBenchmarks(adjudications) {
  if (!Array.isArray(adjudications)) throw new TypeError("adjudications must be an array");
  const cohorts = new Map();
  for (const adjudication of adjudications) {
    if (!adjudication || !Array.isArray(adjudication.results)) throw new TypeError("each adjudication must contain results");
    for (const result of adjudication.results) {
      const key = cohortKey(result, adjudication.repository ?? "unknown/unknown");
      const aggregate = cohorts.get(key) ?? {
        provider: result.provider, model: result.model ?? null, repository: adjudication.repository ?? null,
        repositoryCohort: result.repositoryCohort ?? "default", runs: 0, truePositives: 0, falsePositives: 0,
        falseNegatives: 0, unadjudicated: 0, duplicates: 0, advisories: 0, blockingTruePositives: 0,
        blockingFalseNegatives: 0, uniqueValidFindingKeys: new Set(), validCitations: 0, evidenceSupported: 0,
        actionable: 0, findings: 0, severityCalibrated: 0, severityEvaluated: 0, exactHeadCompleted: 0,
        exactHeadObserved: 0, contractBound: 0, adjudicationComplete: 0,
        timeouts: 0, emptyResponses: 0, invalidEnvelopes: 0, recoveries: 0, fallbacks: 0,
        laterCiFailures: 0, reviewFollowUps: 0, revertedFixes: 0, postMergeDefects: 0, escapedIssues: 0,
        latencies: [], localWallTimes: [], inputTokens: [], outputTokens: [], costs: [], peakMemory: [],
      };
      aggregate.runs += 1;
      aggregate.truePositives += result.truePositives.length;
      aggregate.falsePositives += result.falsePositives.length;
      aggregate.falseNegatives += result.falseNegatives.length;
      aggregate.unadjudicated += result.unadjudicated.length;
      aggregate.duplicates += result.duplicateFindings?.length ?? 0;
      aggregate.advisories += result.advisoryFindings?.length ?? 0;
      aggregate.blockingTruePositives += result.blockingTruePositives?.length ?? 0;
      aggregate.blockingFalseNegatives += result.blockingFalseNegatives?.length ?? 0;
      for (const findingKey of result.uniqueValidFindings ?? []) aggregate.uniqueValidFindingKeys.add(findingKey);
      aggregate.validCitations += result.validCitationCount ?? 0;
      aggregate.evidenceSupported += result.supportedCount ?? 0;
      aggregate.actionable += result.actionableCount ?? 0;
      const currentFindingCount = result.truePositives.length
        + result.falsePositives.length
        + result.unadjudicated.length
        + (result.duplicateFindings?.length ?? 0)
        + (result.advisoryFindings?.length ?? 0);
      aggregate.findings += currentFindingCount;
      aggregate.severityCalibrated += result.severityCalibratedCount ?? 0;
      aggregate.severityEvaluated += result.severityEvaluatedCount ?? 0;
      aggregate.exactHeadObserved += result.exactHeadComplete == null ? 0 : 1;
      aggregate.exactHeadCompleted += result.exactHeadComplete === true ? 1 : 0;
      aggregate.contractBound += result.contractBound ? 1 : 0;
      aggregate.adjudicationComplete += result.adjudicationComplete ? 1 : 0;
      aggregate.timeouts += result.reliability?.timedOut ? 1 : 0;
      aggregate.emptyResponses += result.reliability?.emptyResponse ? 1 : 0;
      aggregate.invalidEnvelopes += result.reliability?.invalidEnvelope ? 1 : 0;
      aggregate.recoveries += result.reliability?.recoveryCount ?? 0;
      aggregate.fallbacks += result.reliability?.fallbackCount ?? 0;
      aggregate.laterCiFailures += result.outcomes?.laterCiFailures ?? 0;
      aggregate.reviewFollowUps += result.outcomes?.reviewFollowUps ?? 0;
      aggregate.revertedFixes += result.outcomes?.revertedFixes ?? 0;
      aggregate.postMergeDefects += result.outcomes?.postMergeDefects ?? 0;
      aggregate.escapedIssues += result.outcomes?.escapedIssues ?? 0;
      aggregate.latencies.push(result.latencyMs);
      aggregate.localWallTimes.push(result.performance?.localWallTimeMs);
      aggregate.inputTokens.push(result.performance?.inputTokens);
      aggregate.outputTokens.push(result.performance?.outputTokens);
      aggregate.costs.push(result.performance?.estimatedCostUsd);
      aggregate.peakMemory.push(result.performance?.peakMemoryMb);
      cohorts.set(key, aggregate);
    }
  }

  const providers = [...cohorts.values()].map((entry) => {
    const adjudicatedFindingCount = entry.truePositives + entry.falsePositives + entry.falseNegatives;
    const exactHeadCompletionCoverage = ratio(entry.exactHeadObserved, entry.runs);
    const exactHeadCompletionRate = ratio(entry.exactHeadCompleted, entry.exactHeadObserved);
    const contractBindingCoverage = ratio(entry.contractBound, entry.runs);
    const adjudicationCoverage = ratio(entry.adjudicationComplete, entry.runs);
    const evidenceComplete = exactHeadCompletionCoverage === 1 && exactHeadCompletionRate === 1
      && contractBindingCoverage === 1 && adjudicationCoverage === 1;
    return Object.freeze({
      provider: entry.provider, model: entry.model, repository: entry.repository, repositoryCohort: entry.repositoryCohort,
      runs: entry.runs, truePositives: entry.truePositives, falsePositives: entry.falsePositives,
      falseNegatives: entry.falseNegatives, unadjudicated: entry.unadjudicated, duplicateFindings: entry.duplicates,
      advisoryFindings: entry.advisories,
      precision: ratio(entry.truePositives, entry.truePositives + entry.falsePositives),
      recall: ratio(entry.truePositives, entry.truePositives + entry.falseNegatives),
      blockingRecall: ratio(entry.blockingTruePositives, entry.blockingTruePositives + entry.blockingFalseNegatives),
      duplicateRate: ratio(entry.duplicates, entry.findings),
      citationValidity: ratio(entry.validCitations, entry.findings), evidenceSupport: ratio(entry.evidenceSupported, entry.findings),
      actionability: ratio(entry.actionable, entry.findings), severityCalibration: ratio(entry.severityCalibrated, entry.severityEvaluated),
      uniqueValidFindings: entry.uniqueValidFindingKeys.size, exactHeadCompletionRate, exactHeadCompletionCoverage,
      contractBindingCoverage, adjudicationCoverage,
      confidence: evidenceComplete ? confidenceLabel(entry.runs, adjudicatedFindingCount) : "incomplete", adjudicatedFindingCount,
      reliability: Object.freeze({ timeouts: entry.timeouts, emptyResponses: entry.emptyResponses, invalidEnvelopes: entry.invalidEnvelopes, recoveries: entry.recoveries, fallbacks: entry.fallbacks }),
      outcomes: Object.freeze({ laterCiFailures: entry.laterCiFailures, reviewFollowUps: entry.reviewFollowUps, revertedFixes: entry.revertedFixes, postMergeDefects: entry.postMergeDefects, escapedIssues: entry.escapedIssues }),
      latencyMs: summarize(entry.latencies), localWallTimeMs: summarize(entry.localWallTimes),
      inputTokens: summarize(entry.inputTokens), outputTokens: summarize(entry.outputTokens),
      estimatedCostUsd: summarize(entry.costs), peakMemoryMb: summarize(entry.peakMemory),
    });
  }).sort((a, b) => a.provider.localeCompare(b.provider) || (a.model ?? "").localeCompare(b.model ?? "") || (a.repository ?? "").localeCompare(b.repository ?? ""));

  return Object.freeze({ providers, providerCount: providers.length, runCount: providers.reduce((sum, row) => sum + row.runs, 0) });
}

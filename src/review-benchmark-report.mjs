function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const index = Math.ceil(fraction * values.length) - 1;
  return values[Math.max(0, index)];
}

export function aggregateReviewBenchmarks(adjudications) {
  if (!Array.isArray(adjudications)) throw new TypeError("adjudications must be an array");
  const providers = new Map();
  for (const adjudication of adjudications) {
    if (!adjudication || !Array.isArray(adjudication.results)) {
      throw new TypeError("each adjudication must contain results");
    }
    for (const result of adjudication.results) {
      const aggregate = providers.get(result.provider) ?? {
        provider: result.provider,
        runs: 0,
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        unadjudicated: 0,
        latencies: [],
      };
      aggregate.runs += 1;
      aggregate.truePositives += result.truePositives.length;
      aggregate.falsePositives += result.falsePositives.length;
      aggregate.falseNegatives += result.falseNegatives.length;
      aggregate.unadjudicated += result.unadjudicated.length;
      aggregate.latencies.push(result.latencyMs);
      providers.set(result.provider, aggregate);
    }
  }

  const report = [...providers.values()].map((entry) => {
    const latencies = [...entry.latencies].sort((left, right) => left - right);
    return Object.freeze({
      provider: entry.provider,
      runs: entry.runs,
      truePositives: entry.truePositives,
      falsePositives: entry.falsePositives,
      falseNegatives: entry.falseNegatives,
      unadjudicated: entry.unadjudicated,
      precision: ratio(entry.truePositives, entry.truePositives + entry.falsePositives),
      recall: ratio(entry.truePositives, entry.truePositives + entry.falseNegatives),
      latencyMs: Object.freeze({
        min: latencies[0] ?? null,
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.at(-1) ?? null,
        mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      }),
    });
  }).sort((left, right) => left.provider.localeCompare(right.provider));

  return Object.freeze({ providers: report, providerCount: report.length, runCount: report.reduce((sum, row) => sum + row.runs, 0) });
}

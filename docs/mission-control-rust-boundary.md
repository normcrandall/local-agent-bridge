# Mission Control scale and Rust boundary

Mission Control has a deterministic scale harness for deciding whether its hot path needs a native implementation. The benchmark is evidence, not a reason to rewrite working JavaScript by intuition.

## Reproduce the measurements

Run the benchmark from the repository root:

```sh
npm run --silent test:mission-control-scale > mission-control-scale.json
```

The command seeds the same timestamps, repositories, lanes, providers, and output on every run. It exercises:

- 500, 2,000, and 10,000 historical lanes, each with 50 concurrent live lanes;
- snapshot validation/indexing, view-model projection, and a complete terminal redraw;
- a 500-event live update burst and 500-lane cleanup at the 10,000-lane point;
- fixed 100-event update and cleanup probes at every history size, which expose history-sensitive algorithms;
- a transport disconnect, cursor-preserving reconnect, and one snapshot resynchronization;
- selected-lane output depths of 0, 100, 1,000, and 5,000 records;
- heap deltas and final process RSS.

The JSON contains every sample, interpolated p95, median, min/max spread, memory, all-point log-log regression evidence, budgets, failures, and the resulting Rust diagnostic. Hard latency gates use the median of at least five normal samples or three expensive state samples; p95 and max remain visible as diagnostic evidence. A growth regression fails only when the fit's approximate 95% lower bound exceeds its ceiling, because a point estimate from three scale points is not sufficient evidence by itself. Missing or invalid fit uncertainty fails the benchmark as an execution error. Absolute latency and memory budgets remain independent hard backstops when the growth curve is inconclusive. The script writes the stable report envelope before setting a failing exit code, so CI retains either complete measurements or a typed execution error. `MISSION_CONTROL_SCALE_BUDGETS` in `src/mission-control-benchmark.mjs` and the generated JSON are the machine-readable sources of truth.

Timing results naturally vary by host. Compare the JSON's Node version, platform, architecture, sample counts, and seeded fixture dimensions before comparing runs.

## Indicative evidence

The table below is an indicative example from one implementation run on 2026-07-26 (Node v24.14.0, Darwin arm64). It is not normative and is not a substitute for the generated JSON from the host under evaluation. The report's medians drive hard gates; its max and spread show run variability.

| Scenario | Example observation from the original run |
| --- | ---: |
| 500 historical + 50 live: snapshot / projection / redraw | 2.0 / 4.7 / 3.8 ms |
| 2,000 historical + 50 live: snapshot / projection / redraw | 8.2 / 7.0 / 6.6 ms |
| 10,000 historical + 50 live: snapshot / projection / redraw | 87.1 / 86.3 / 122.4 ms |
| 500 updates against 10,000 historical lanes | 881.8 ms |
| 500 removals against 10,000 historical lanes | 1,720.1 ms |
| disconnect, reconnect, and full resync | 190.5 ms |
| projection with 5,000 selected-lane output records | 1.8 ms |

The largest retained scenario added about 30.7 MiB of heap while the completed benchmark process reported 357.5 MiB RSS. Raw values, including individual samples, remain in the generated report rather than this rounded summary.

The harness now also renders the expanded details pane with the deep-output lane selected and asserts that the render consumed the lane's output record count. This prevents a cheap view-model-only measurement from masquerading as an output-depth rendering result. Mission Control intentionally renders only the last three output records, so render medians should remain flat as depth grows: the uniform render budget guards that bound, while the depth-sensitive cost appears in the projection measurements. The render result is not a throughput claim for rendering every retained record.

The history-sensitivity probes are important diagnostics alongside the absolute latency. The regression uses all three history sizes and reports residuals, R-squared, standard error, and an approximate confidence interval rather than fitting only the endpoints:

| Operation | 500 lanes | 2,000 lanes | 10,000 lanes | measured exponent |
| --- | ---: | ---: | ---: | ---: |
| Apply 100 updates | 2.4 ms | 26.9 ms | 174.1 ms | 1.426 |
| Remove 100 lanes | 47.1 ms | 174.8 ms | 239.4 ms | 0.542 |

An incremental event cost should be largely independent of unrelated history size; the machine-readable advisory threshold is exponent 0.4. This threshold and the resulting `rustEvaluation` classification are explicitly non-gating. Only the latency, memory, and hard growth-exponent budgets fail the command. In the original sample both operations exceeded the advisory threshold. The reducer currently creates replacement collection objects for updates and scans collections for removals. That is algorithmic scaling, not evidence that JavaScript instruction dispatch is the bottleneck.

## Decision

Do not move Mission Control to Rust yet.

Based on the indicative run, first keep the existing JavaScript protocol and replace whole-collection copy/scan work with indexed incremental state:

1. update one keyed lane/provider entry without copying all unrelated entries;
2. remove a keyed entry without rebuilding the complete collection;
3. retain stable tab order and repository rollups incrementally instead of repeatedly sorting unchanged history;
4. rerun this exact harness and compare the hard-gated medians, reported max/spread, and all-point history-sensitivity fits.

A Rust rewrite of the current algorithms would improve only a constant while retaining the wrong growth curve. If those JavaScript algorithmic changes bring the event exponents below 0.4 but snapshot or burst latency still exceeds the hard budgets, the appropriate native boundary is narrow: event projection/diffing plus snapshot serialization behind the existing versioned Mission Control event envelopes. Navigation, attention policy, pane state, terminal rendering, MCP orchestration, and operator actions should remain in JavaScript.

That seam is already explicit in `mission-control-event-protocol.mjs`. A future Rust component must consume and emit the same validated envelopes so it can be benchmarked against the JavaScript implementation without changing user-visible behavior.

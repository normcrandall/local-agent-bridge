# Shadow review benchmark

The review benchmark compares reviewer/model cohorts on immutable pull-request heads. It is an evaluation system, not a merge gate: every recorded run is normalized to `mode: "shadow-review"` and `authority: "non-authorizing"`, including hosted-provider runs and `APPROVE` verdicts.

## Safe record boundary

The JSONL ledger is schema-versioned and append-only. Its normalizer copies only documented scalar metrics and normalized findings. Prompt text, private reasoning, credentials, authorization headers, tokens, passwords, and secret fields are rejected; recognizable credential material in allowed prose is replaced with `[REDACTED]`. Store only SHA-256 `contractDigest` and `evidenceSurfaceDigest` values to prove that reviewers saw the same bounded contract and evidence without retaining either body.

Each review run binds:

- repository and a full 40-character head SHA;
- provider, model, repository cohort, and run ID;
- a digest and safe reference to the raw public GitHub review or separately redacted handoff, so the authored review remains auditable without copying it into the ledger;
- normalized path/range, severity, claim, proposed fix, and evidence-quality fields;
- latency, token/cost/local-resource observations when available;
- timeout, empty-response, invalid-envelope, recovery, and fallback counts;
- later CI failures, review follow-ups, reverted fixes, post-merge defects, and escaped issues.

The ledger deliberately has no network or provider dependency. Collection adapters may append normalized observations separately; reporting and tests operate entirely on files and fixtures.

## Independent adjudication

Cloud agreement is not ground truth. A chair assigns each normalized finding one of `accepted`, `rejected`, `duplicate`, `advisory`, or `unresolved`, with implementation, re-review, CI, revert, or post-merge evidence. Non-unresolved decisions without evidence are rejected. A decision cannot be moved back to unresolved; later contrary evidence must make another explicit, evidenced terminal transition.

Adjudication files are JSON arrays grouped by repository and exact head:

```json
[
  {
    "repository": "owner/repo",
    "headSha": "0123456789012345678901234567890123456789",
    "findingAdjudications": [
      {
        "findingKey": "<normalized 64-character finding key>",
        "status": "accepted",
        "evidence": ["fixed by PR head abc... and verified by regression test"]
      }
    ]
  }
]
```

Generate a human report or deterministic JSON:

```sh
npm run review-benchmark:report -- --ledger .bridge/evaluation/reviews.jsonl --adjudications .bridge/evaluation/adjudications.json
npm run review-benchmark:report -- --ledger .bridge/evaluation/reviews.jsonl --provider docker --model qwen3.6 --cohort typescript-services --json
```

Reports include precision, defect and blocking-defect recall, citation/evidence/actionability rates, severity calibration, duplicate rate, unique valid findings, exact-head completion, reliability, performance, and observed downstream outcomes. Missing observations remain `null`; the report does not turn missing data into success.

Severity calibration compares each provider's label with the chair-assigned severity on an accepted finding. Exact-head completion reports both rate and observation coverage. Contract/evidence binding and adjudication coverage are also explicit; any incomplete binding, unknown or failed exact-head completion, or incomplete adjudication forces the cohort confidence to `incomplete` regardless of sample count.

Confidence is intentionally conservative and cohort-specific:

| Label | Minimum sample |
| --- | --- |
| `insufficient` | fewer than 5 runs or 10 adjudicated finding observations |
| `directional` | at least 5 runs and 10 adjudicated observations |
| `moderate` | at least 15 runs and 30 adjudicated observations |
| `strong` | at least 30 runs and 75 adjudicated observations |

Never publish a global provider ranking from mixed repositories or small samples.

## Promotion rule

A local model may be proposed as a trusted review signal only after all of the following hold for the specific pinned model and repository cohort:

1. at least `moderate` confidence, including representative blocking defects;
2. no regression in blocking-defect recall, exact-head completion, or invalid-envelope reliability across two consecutive reporting windows;
3. evidence that incremental valid findings are useful and false-positive/duplicate load remains operationally acceptable;
4. a documented security and credential-boundary review of the adapter;
5. an explicit human-owned repository policy change.

Promotion changes neither GitHub rulesets nor human approval policy automatically. Benchmark data can support that separate decision, but cannot make it.

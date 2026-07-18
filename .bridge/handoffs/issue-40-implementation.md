# Handoff: Issue #40 — Provider-neutral canonical builder delivery contract

Base commit: `9e722d4bc92cba572249f6b6e88665fc3aeb4b52`
Prior commit on branch: `423944b335fd4aeeb5643b3b1428779abd8813f6` (rejected by audit)
Branch: `codex/helm-40-canonical-delivery`
Writer: Claude Code (Opus 4.8, `claude-opus-4-8[1m]`). No delegation; no Fable.

## Scope

Delivers the canonical builder delivery contract and repairs every point of the
independent audit that rejected the first commit.

## Changes

- **`src/builder-contract.mjs` (new)** — single source of truth: per-operation
  request shapes feeding both the Claude/Codex MCP `inputSchema` and the
  Antigravity envelope; typed `BuilderError`/`BuilderUnsupportedError`
  (`rejected|indeterminate|unsupported`); the `succeeded|rejected|indeterminate|
  reconciled` vocabulary; `classifyDeliveryOutcome()` (fail-closed on unknown
  values); `aggregateDeliveryOutcome()` (most-severe-present).
- **`src/builder-operation-store.mjs` (new)** — `loadBranchReconciliationState()`,
  `loadNonBranchIntents()`, and `summarizeDeliveryOutcomes()`. Fail-closed load:
  a corrupt interior record or an indeterminate record with neither ref nor
  operationId throws; only a torn trailing append is tolerated.
- **`src/github-builder-client.mjs`** — restart-durable reconciliation seeded from
  the store; **SHA-safe** `reconcileBeforeMutation` (a different-SHA retry never
  erases an unresolved marker — it reconciles/fails the prior marker on its own
  requestedSha first); durable **intent-before-mutation + terminal receipts** with
  content-addressed operationIds and `deliveryOutcome` for all five non-branch
  operations, with restart read-back reconciliation; every receipt stamped with
  its lifecycle `deliveryOutcome`.
- **`src/builder-envelope.mjs`** — derived from the contract and published
  **unchanged**: strict validation without injecting zod defaults.
- **`src/github-builder-bridge.mjs`** — MCP `inputSchema`s derived from the contract.
- **`src/agent-pool.mjs`** — `autonomous` flag; an autonomous pool with no bound
  `githubBuilder` is **fail-closed** against `workProfile: deliver` and any
  smuggled raw-delivery `workCommand` (`git push`, `gh pr *`, `gh api`).
- **`src/coordinator-wake.mjs`** — `classifyCoordinatorWake` surfaces the structural
  `deliveryOutcome`; an indeterminate/rejected delivery forces an actionable
  wake (`writer_fix`/`inspect`); wake key and stored wake include the outcome.
- **`scripts/collaboration-worker.mjs`** — passes `autonomous: true`; records the
  provider-neutral delivery summary from the durable log into completion state.
- **`scripts/github-builder-test.mjs`**, **`scripts/issue-40-autonomy-test.mjs`
  (new)**, **`scripts/collaboration-test.mjs`** — direct tests for every point.

## Audit points → resolution

1. Reconcile SHA-safety — `reconcileBeforeMutation` keyed on the marker's own
   `requestedSha`; test: different-SHA retry durably reconciles, never erases.
2. Lifecycle→wakes — durable delivery summary in completion; `classifyCoordinatorWake`
   distinguishes the four outcomes; Antigravity receipts carried structurally.
3. Durable non-branch ops — intent+terminal receipts, operationIds, request
   envelopes, restart read-back reconciliation; test: dangling merge intent →
   `reconciled` with no merge PUT.
4. Fail-closed autonomy — autonomous deliver/raw command without a bound builder
   is rejected at the `createAgentPool` execution chokepoint; legacy non-autonomous
   lane preserved.
5. Provider-equivalence fixtures — the MCP and envelope boundaries normalize the
   six scenarios (create/fast-forward/rework/ambiguous-transport/restart/denied)
   identically and dispatch to the same shared client method.
6. Fail-closed classification and log load — unknown outcome throws; corrupt
   interior log records throw; torn tail tolerated.
7. Unchanged Antigravity envelopes — validated without injecting defaults.

## Risks / follow-ups

- Reconciliation/summary read the full receipt log per client construction / per
  recorded completion; bounded by log size (future compaction possible).
- The delivery summary attaches to completion on any handoff turn when a builder
  is bound; it reflects the cumulative durable state for the bound head SHA.
- The autonomy gate treats the collaboration worker as the sole autonomous
  execution path; direct single-shot `ask_agent` remains the explicit legacy lane.

## Verification (observed)

1. `npm run test:collaboration` — **PASSED** (incl. fail-closed autonomy + lifecycle wakes).
2. `npm run test:github-builder` — **PASSED** (contract, SHA-safe reconcile, non-branch
   durability, fail-closed classify/log-load, unchanged envelopes, delivery summary,
   provider-equivalence fixtures).
3. `npm run test:operations` — **PASSED**.
4. `npm run test:skills` — **PASSED**.
5. `npm run test:secrets` — **PASSED**.
6. `npm run smoke` — **PASSED**.
7. `git diff --check` — **CLEAN**.

HANDOFF READY.

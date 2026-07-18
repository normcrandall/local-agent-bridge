# Handoff: Issue #40 — Provider-neutral canonical builder delivery contract

Base commit: `9e722d4bc92cba572249f6b6e88665fc3aeb4b52`
Branch: `codex/helm-40-canonical-delivery`
Writer: Claude Code (Opus 4.8, `claude-opus-4-8[1m]`). No delegation; no Fable.

## Intent

Issue #40 asks that all three delivery lanes share one validated canonical
builder request/receipt/error contract; that Antigravity envelopes are
schema-validated and published unchanged; that durable operation IDs, receipts,
and reconciliation state survive a restart without duplicate mutations; that
lifecycle state distinguishes succeeded / rejected / indeterminate / reconciled
remote verification; that skills, docs, and install artifacts describe generic
user-owned GitHub App setup and canonical operations rather than raw push; and
that autonomous delivery never silently falls back to PAT, ambient git
credentials, or arbitrary shell push, while preserving provider capability
differences and explicit unsupported errors.

Investigation showed the mature codebase already satisfied several of these
outcomes (verified below). The genuine remaining gap was two hand-maintained
schemas that had already drifted and a reconciliation guard that did not survive
process restart. This change closes those gaps and unifies the contract.

## Summary of changes

- **`src/builder-contract.mjs` (new)** — single provider-neutral source of truth:
  per-operation request field shapes, `builderMcpInputSchema()` (Claude/Codex MCP
  lane), `builderEnvelopeSchema()` / `builderEnvelopeOperationSchema()`
  (Antigravity lane), typed `BuilderError` / `BuilderUnsupportedError` with codes
  `rejected|indeterminate|unsupported`, the `succeeded|rejected|indeterminate|reconciled`
  delivery vocabulary, and `classifyDeliveryOutcome()`.
- **`src/builder-operation-store.mjs` (new)** — `loadBranchReconciliationState()`
  replays the append-only receipt JSONL to rebuild pending-indeterminate refs so
  the fail-closed reconcile-before-retry guard survives a process/agent restart.
- **`src/github-builder-client.mjs`** — seeds `indeterminateRefs` from the durable
  store instead of an empty `Map()`; stamps every persisted branch receipt (and
  failure receipt) with a provider-neutral `deliveryOutcome`
  (`succeeded|rejected|indeterminate|reconciled`) for restart inspection.
- **`src/builder-envelope.mjs`** — Antigravity envelope schema now derived from
  `builder-contract.mjs`; instructions/parse/publish-unchanged behavior preserved.
- **`src/github-builder-bridge.mjs`** — all eight MCP tool `inputSchema`s now come
  from `builderMcpInputSchema()`; removed the now-unused `zod` import. The two
  provider schemas can no longer drift.
- **`scripts/github-builder-test.mjs`** — added canonical-contract-derivation,
  delivery-outcome mapping, durable-store replay, durable receipt lifecycle stamp,
  and two restart-durability tests (a fresh client reconciles by remote read-back
  without re-pushing; stays fail-closed when read-back is unavailable).

## Outcomes already present in the base (verified, unchanged)

- Bound builder rejects any non-`ghs_` token (`github-builder-client.mjs`
  token-prefix guards) — no PAT/ambient path into the autonomous builder lane.
- `github-command-fallback.mjs` denies `git push`, merge, review, and arbitrary
  API for the human-invoked PAT compatibility CLI.
- Skills already route delivery through bound `githubBuilder` with explicit
  `allowedOperations` and forbid raw `gh api`, owner bypass, and PAT substitution
  (`take-the-helm/SKILL.md`, `pair-program/SKILL.md`, `council-implement/SKILL.md`,
  `goal-loop/SKILL.md`, `run-roundtable/SKILL.md`). No raw-push guidance was found.
- The `workProfile: deliver` shell grants (`git push`, `gh pr …`) are an explicit,
  user-selected, exact-command-pinned lane (SHA-pinned merges enforced by
  `validatePinnedMergeCommands`), not a silent fallback; it is locked by
  `smoke-test.mjs` and `model-routing-test.mjs` and was intentionally left intact.

## Risks / follow-ups

- The canonical `create_branch`/`push_branch`/`replace_branch` `ref` bound is now a
  uniform 220 chars on both lanes (previously the MCP lane was unbounded). This is
  strictly tighter and safe for real branch refs.
- Reconciliation rehydration reads the full receipt log at client construction
  (once per builder MCP-server spawn). Bounded by log size; a future compaction or
  index could reduce cost for very large logs.
- Coordinator-wake surfacing: durable receipts now carry `deliveryOutcome`, the
  clean seam for lifecycle wakes to distinguish succeeded/rejected/indeterminate/
  reconciled. Wiring it into `coordinator-wake.mjs` is left as an additive
  follow-up because `test:coordinator-wake` is outside this task's runnable
  command set and I did not want to change that surface unverified.

## Verification (observed)

1. `npm run test:github-builder` — **PASSED** (canonical contract derivation,
   delivery-outcome mapping, durable store replay, receipt lifecycle stamp,
   restart reconciliation, plus all pre-existing PR/merge/transport assertions).
2. `npm run test:operations` — **PASSED**.
3. `npm run test:collaboration` — **PASSED**.
4. `npm run test:skills` — **PASSED**.
5. `npm run test:secrets` — **PASSED**.
6. `git diff --check` — **CLEAN**.
7. `npm run smoke` — **NOT YET RUN**: this worktree has no `node_modules`, so
   `@playwright/mcp/cli.js` is absent and smoke dies launching the Playwright MCP
   subprocess. The change is not referenced by smoke; the collaboration bridge
   (which imports `agent-pool → builder-envelope`) enumerates its tools cleanly.
   Requires `npm ci` / `npm install` in this worktree to run.

HANDOFF READY — pending the final `npm run smoke` run once dependencies are
installed in this worktree.

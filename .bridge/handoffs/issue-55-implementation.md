# Issue #55 — reviewer capacity deadlock & cancel reaping

Branch: `codex/helm-55-reviewer-deadlock` (base `6d067aef1c390c1b1725b31f97f84b6405e0693f`)
Implementation commit: `7396950a5cf38404f156396f2679805d04d0468d`
Writer: Claude Opus 4.8 (1M context) — sole implementation agent.

## What changed and why

### 1. verificationCommands as an explicit allowlist (every provider request path)
- New `src/verification-allowlist.mjs`: `normalizeVerificationAllowlist`,
  `effectiveCommandAllowlist` (review = verification gates only; work = union with
  work commands), `admitProviderCommand`, `admitProviderCommands`, and the typed
  `ProviderCommandNotAllowlistedError` (`code: "provider_command_not_allowlisted"`).
- Wired provider-agnostically in `src/agent-pool.mjs` `send()` (runs before any
  provider spawns) and at the actual grant-construction point in
  `src/claude-bridge.mjs` (review + work `Bash(...)` grants). Unlisted commands fail
  deterministically before dispatch. Provider CLI config is untouched.

### 2. Typed self-deadlock fast-fail
- `src/provider-concurrency.mjs`: `ProviderSelfDeadlockError`
  (`code: "provider_self_deadlock"`, `selfDeadlock: true`) + pure
  `detectProviderSelfDeadlock({ownedSlots, limit})`. `acquireProviderCapacity` counts
  the collaboration's own live slots *before* registering a waiter and throws when it
  already holds `>= limit` — no waiter is registered.
- `scripts/collaboration-worker.mjs` emits a distinct `provider_self_deadlock` event
  (vs generic `provider_capacity_failed`) on that typed error.

### 3. ps-based descendant reaping on cancel
- New `src/process-reaper.mjs`: `readProcessTable` (`/bin/ps -A -o pid= -o ppid=`),
  `discoverDescendants` (BFS PPID walk, cycle-safe), `reapProcessTree`
  (process-group + descendant SIGTERM → bounded grace → SIGKILL survivors). No new
  dependency; signalling via `process.kill`.
- `src/collaboration-bridge.mjs` `cancel_collaboration` now reaps the worker tree
  instead of a single group SIGTERM, preserving the existing owner-match guard.

### 4. Deterministic lease release on cancel (ownership preserved)
- `src/collaboration-store.mjs`: `workspaceLockPath` + `releaseOwnedCollaborationLocks`
  — removes the reaped worker's own worker/update/workspace locks (owner PID match, or
  dead owner), never a lock held by a *different live* process.
- `cancel_collaboration` calls it after reaping, alongside the existing
  `releaseProviderCapacityForCollaboration`. The `cancelled` event now records
  `reaped`, `releasedLocks`, and `releasedProviderCapacity`.

### 5. Command-aware / capacity-wait narrative
- New `src/collaboration-narrative.mjs`: `capacityWaitNarrative` (explicit wait
  reason + structured capacity), `activeVerificationCommand` (longest allowlisted
  match), `verificationNarrative` (folds the active command into the summary).
- `scripts/collaboration-worker.mjs` uses these: the capacity-wait `activeCall` now
  carries `waitReason`; running provider progress names the active verification
  command (`activeCall.verificationCommand`).

Public MCP schemas and existing behavior are unchanged (additive fields only).

## Files
Source: `src/verification-allowlist.mjs`, `src/process-reaper.mjs`,
`src/collaboration-narrative.mjs`, `src/provider-concurrency.mjs`,
`src/collaboration-store.mjs`, `src/collaboration-bridge.mjs`, `src/agent-pool.mjs`,
`src/claude-bridge.mjs`, `scripts/collaboration-worker.mjs`.
Tests: `scripts/issue-55-allowlist-test.mjs`, `scripts/issue-55-narrative-test.mjs`,
`scripts/issue-55-reaping-test.mjs`, `scripts/issue-55-locks-test.mjs` (imported by
the collaboration/cleanup gates), plus additions to
`scripts/provider-concurrency-test.mjs`, `scripts/collaboration-test.mjs`,
`scripts/collaboration-cleanup-test.mjs`.

## Verification (observed)
Run inside this provider call:
- `npm run test:cleanup` — PASS (incl. real shell→node descendant reap + owned-lock release).
- `npm run test:collaboration` — PASS (incl. allowlist admission, command-aware
  narrative, and the live waiting_capacity / activeCall.capacity integration path).
- `npm run test:secrets` — PASS.
- `npm run smoke` — FAILS only at the Playwright MCP server listing: `@playwright/mcp`
  is not installed in this worktree (`ERR_PACKAGE_PATH_NOT_EXPORTED`). All four bridge
  servers this change touches (Claude, Codex, Antigravity, Persistent collaboration)
  list successfully and the broker schema-compatibility check passes; the crash is a
  pre-existing environment gap unrelated to issue #55 and aborts smoke before it
  reaches any changed code path.

## Delegated chair gate
- `npm run test:provider-concurrency` was intentionally **not** run here (it would run
  inside the occupied provider pool). Codex must run it outside this pool to validate
  the added same-owner fast-rejection, deterministic lease-release, and immediate
  slot-reacquisition fixtures.
- Recommended chair verification: re-run the four safe gates, then
  `npm run test:provider-concurrency`, and (optionally) `npm run smoke` in an
  environment where `@playwright/mcp` is installed.

## Risks / notes
- `reapProcessTree`'s default `ps` uses `/bin/ps -A -o pid= -o ppid=` (portable across
  macOS/Linux); all signalling is injectable and unit-covered, real termination is
  covered by a spawned SIGTERM-ignoring tree in the cleanup gate.
- Allowlist enforcement is fail-closed and provider-agnostic; review dispatch can no
  longer smuggle a work command that is not a declared verification gate.
- The self-deadlock guard triggers only when a collaboration holds `>= limit` of its
  own live slots, so legitimate multi-slot review fan-out is unaffected.

HANDOFF READY

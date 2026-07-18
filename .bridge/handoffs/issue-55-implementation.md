# Issue #55 — reviewer capacity deadlock & cancel reaping

Branch: `codex/helm-55-reviewer-deadlock` (base `6d067aef1c390c1b1725b31f97f84b6405e0693f`)
Implementation commit: `7396950a5cf38404f156396f2679805d04d0468d`
Test-ordering repair commit: `1a61821b78925dfc6261d1a64e730da656dc44a8`
Capability-boundary repair commit: `d20c1a981da34f13ae066b4e636d588cf25d55c4`
Integration + matcher-tightening repair commit: `6a48ec38e3a0135672142886dff573d5914ce424`
(branch HEAD is the immediately following handoff-update commit, which Codex pushes)

## Chair acceptance-blocker follow-up (worker-path integration + precise matcher)
- **Real start/worker self-deadlock integration fixture.** Added to
  `scripts/collaboration-test.mjs` (offline fake-claude harness, no real provider). It
  starts a review whose only verification gate re-enters the same live provider-capacity
  pool (`npm run test:provider-concurrency`) and proves: terminal status `failed`, a
  typed `provider_self_deadlock` event in the transcript, **no `agent_started`/provider
  work call**, zero turns, and **no waiter or slot referencing the collaboration**. This
  exercises `scripts/collaboration-worker.mjs` end-to-end, not a mirror.
- **Tightened `verificationCommandReentersProviderPool` (structural, not substring).**
  Replaced raw substring markers (which false-matched any path containing
  `collaboration-bridge`/`provider-concurrency`) with a tokenizer that recognizes only:
  (a) a direct same-provider CLI invocation (`claude …`, `/usr/local/bin/claude …`, incl.
  leading `env`/VAR=val), (b) a known broker pool-entry executable run directly or via
  `node` (`collaboration-worker.mjs`, `collaboration-bridge.mjs`, `bridge`), and (c) a
  local package-script alias resolving to a known pool-entry gate
  (`npm|pnpm|yarn run test:provider-concurrency`). A name appearing only as a file-path
  or argument (`cat src/collaboration-bridge.mjs`, `grep provider-concurrency`,
  `eslint src/provider-concurrency.mjs`, `node scripts/lint.mjs --rule provider-concurrency`)
  no longer matches; a cross-provider CLI (`codex …` during a claude review) is not a
  claude self-deadlock. Positive/negative unit tests added in
  `scripts/provider-concurrency-test.mjs`.
Writer: Claude Opus 4.8 (1M context) — sole implementation agent.

## Chair-rejection repair (capability boundary + pool reentry)
Two blocking gaps from the chair's Antigravity-approval rejection are now fixed:

1. **Fail-closed provider capability boundary.** The prior allowlist was toothless
   for providers that cannot express an enforceable exact command grant: Codex
   (sandbox mode only) and Antigravity (no command grant at all) received no
   enforceable constraint, and Antigravity ran unlisted `node scripts/issue-55-*.mjs`
   and the doctor script during a bounded review. New provider-neutral capability
   (`PROVIDERS_ENFORCING_EXACT_COMMAND_GRANTS = ["claude"]`,
   `assertProviderVerificationCapability`, typed
   `ProviderCommandGrantUnsupportedError` / `provider_command_grant_unsupported`)
   in `src/verification-allowlist.mjs`, enforced at the provider-agnostic
   `agent-pool.send()` choke point **before `clientFor`/spawn**. A bounded
   command-running review (review mode + verification commands) is dispatched only
   to a provider that enforces exact grants (Claude); Codex/Antigravity are denied
   before dispatch and remain eligible for static review with no verification
   commands. No provider CLI config is weakened.
   - Integration fixture `scripts/issue-55-capability-boundary-test.mjs` drives the
     unlisted package-script review through the real delegated `pool.send` path and
     proves prompt typed denial before dispatch.
2. **Pre-acquire pool-reentry self-deadlock.** The own-slot check alone missed a
   verification command that re-enters the same live capacity pool under a *different*
   collaborationId. New `assertNoProviderPoolReentry` +
   `verificationCommandReentersProviderPool` in `src/provider-concurrency.mjs`,
   called in the worker **before** `acquireProviderCapacity`: such a command fails
   fast with `provider_self_deadlock` and registers no waiter. Fixture in
   `scripts/provider-concurrency-test.mjs` mirrors the worker guard-then-acquire
   order and asserts no waiter/slot is created.

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
- `npm run test:provider-concurrency` — PASS (incl. Gap-2 reentry guard + FIFO repair).
- `npm run test:provider-capabilities` — PASS (no regression).
- `npm run smoke` — PASS in this run (Playwright MCP available; full browser runtime
  green). Note: an earlier run failed only because `@playwright/mcp` was not installed
  in the worktree — a pre-existing environment gap, never a code defect.

All six gates pass (observed after the integration + matcher repair):
test:provider-concurrency PASS, test:collaboration PASS (incl. the real start/worker
self-deadlock integration fixture), test:provider-capabilities PASS, test:cleanup PASS,
test:secrets PASS, smoke PASS (full Playwright browser runtime green).

## Push status
Work profile `implement` authorizes local work through commit only; pushing and PR
mutation are not authorized here, and no builder push operation is available in this
call. **Stopped after commit for Codex to push the current branch HEAD of
`codex/helm-55-reviewer-deadlock` (latest code repair `6a48ec38` plus this
handoff-update commit) to the existing branch/PR.**

## Provider-concurrency gate (now run and green)
- `npm run test:provider-concurrency` — PASS (run twice, deterministic). Validates the
  added same-owner fast-rejection, deterministic lease-release, and immediate
  slot-reacquisition fixtures.
- Chair-found pre-existing defect repaired: the third/fourth queued-waiter block in
  `scripts/provider-concurrency-test.mjs` started both acquisitions concurrently and
  assumed #3 registered before #5. Under real scheduling #5 could register first, take
  the freed slot, and hang the suite at `await thirdPromise`. Fixed with a minimal
  deterministic ordering barrier (`waitForWaiterCount`) that waits for #3's `.wait`
  file before starting #5 — no reliance on concurrent call scheduling, no production
  change.
- Recommended remaining chair verification: re-run the four safe gates, and
  (optionally) `npm run smoke` in an environment where `@playwright/mcp` is installed.

## Risks / notes
- `reapProcessTree`'s default `ps` uses `/bin/ps -A -o pid= -o ppid=` (portable across
  macOS/Linux); all signalling is injectable and unit-covered, real termination is
  covered by a spawned SIGTERM-ignoring tree in the cleanup gate.
- Allowlist enforcement is fail-closed and provider-agnostic; review dispatch can no
  longer smuggle a work command that is not a declared verification gate.
- The self-deadlock guard triggers only when a collaboration holds `>= limit` of its
  own live slots, so legitimate multi-slot review fan-out is unaffected.

HANDOFF READY

# Provider concurrency review — final verdict

Target: uncommitted worktree diff vs `origin/main` (branch `codex/provider-concurrency`).
Anchor: `src/provider-concurrency.mjs` 324 lines / 11468 bytes, mtime 2026-07-16 04:58:32;
`scripts/collaboration-worker.mjs` 438 lines / 16981 bytes, mtime 04:58:32;
`scripts/provider-concurrency-test.mjs` 5385 bytes, mtime 05:00:12;
`src/collaboration-bridge.mjs` 54085 bytes, mtime 04:54:18.

Policy applied: machine-local provider concurrency is a **hard safety ceiling**; per-collaboration settings may
only lower it. A dead/unknown worker retains capacity until cancellation or reconciliation, because provider
execution may be indeterminate.

## Verification run

| Command | Result |
| --- | --- |
| `npm run test:provider-concurrency` | pass |
| `npm run test:collaboration` | pass |
| `npm run test:cleanup` | pass |
| `npm run smoke` | pass |
| `git diff --check` | pass (no whitespace errors) |

The provider-concurrency run executed the 05:00:12 test file — confirmed by its banner ("config ceilings"),
which exists only in that revision. Caveat: `git diff --check` inspects tracked files only;
`src/provider-concurrency.mjs`, `scripts/provider-concurrency-test.mjs`, and
`config/provider-concurrency.example.json` are untracked and therefore uncovered by it.

## Settled findings (not reopened)

Findings 1 (release ownership via `leaseId` + live-slot refusal in cancel cleanup), 2 (override clamping on both
mutation paths), 3 (vanished waiter throws), and 5 (lock release verifies `lockId`; live locks not age-stolen)
were verified closed in the prior round and are unaffected by the final edits. Finding 4 (dead worker retains
capacity) remains accepted under the stated safety policy, with recovery via cancellation and lazy sweep traced.

## Residual A — ceiling enforced at admission → **CLOSED**

`acquireProviderCapacity:240-243` now resolves its limit through
`loadProviderConcurrency({ overrides: normalizeProviderConcurrency(limits) })`, so the effective limit is
`min(machine, requested)` computed at the point of admission (`:71-74`) rather than trusted from the caller. The
slot-name loop uses that clamped limit (`:266`), so the namespace and the admission count agree.

Two consequences worth stating, both in the intended direction:

1. Every acquirer now resolves against the same machine config, so mixed-limit skew between collaborations is
   eliminated. This is a genuine strengthening of the global invariant, not just a defense-in-depth layer — a
   caller passing inflated limits can no longer widen the slot namespace.
2. A *lowered* machine ceiling now binds at the next acquisition, which was the retroactivity gap I raised. A
   *raised* ceiling still does not widen a collaboration that persisted lower limits — correct under `min`.

Covered by test `:125-156`: with a machine config of `claude: { work: 1, review: 1 }` and a caller requesting
`review: 3`, `ceilingFirst.limit` is `1` and the second acquisition blocks until release. That asserts
admission-time clamping specifically, not merely config merging.

## Residual B — `activeCall` cleared on capacity failure → **CLOSED**

`collaboration-worker.mjs:151-206` wraps acquisition in `try/catch`; on failure it sets `runtime.activeCall` to
`null` (`:194-197`), appends a `provider_capacity_failed` event with the agent, role, and error message
(`:198-204`), then rethrows (`:205`). This also resolves the ≤5s ordering race I flagged: `onWait` only runs
inside `acquireProviderCapacity`, so once it throws no further `onWait` write can occur and the catch's clear is
the last write. A cancelled collaboration therefore converges to `activeCall: null` rather than a stale
`waiting_capacity`.

## Residual findings (non-blocking, severity ordered)

### C. Low — test hermeticity for acquisitions outside the ceiling block
`AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG` is set only for the ceiling block
(`scripts/provider-concurrency-test.mjs:132`, cleared at `:158`). Because residual A made
`acquireProviderCapacity` read the machine config on every acquire, the earlier acquisitions (`:41-123`) now
resolve against the developer's real `~/.config/local-agent-bridge/provider-concurrency.json`. That file is
absent here, so ENOENT yields the `work 1 / review 2` defaults and the suite is green. On a machine where an
operator has set `claude.review: 1`, the `second` acquisition at `:49` would clamp to `1` and — with no wait
deadline (residual D) — the suite would **hang rather than fail**. Setting the env var for the whole test would
restore hermeticity. New consequence of edit A; environmental, not a product defect.

### D. Low — no wait deadline
`:257` still loops without a deadline. Consistent with the retention policy, and observable via
`waiting_capacity` status plus `provider_capacity_wait` events, so a stuck queue is diagnosable. A bounded
`maxWaitMs` would convert operator-visible stalls into automatic failures.

### E. Low — error masking in the capacity-failure handler
If `updateCollaboration` or `appendEvent` throws inside the catch (`collaboration-worker.mjs:194-204`) — e.g.
the collaboration was archived between cancel and the handler — that error replaces the original capacity error.
Narrow, and the rethrow path is still fail-closed.

### F. Low — `inUse: Math.min(slots.length, limit)` (`:314`) clamps the display. Largely moot now that admission is ceiling-bound, but it would mask an over-limit condition rather than surface it.

## Unchanged assessment — what remains sound

Slot exclusion is atomic: the namespace is fixed at `1.slot`..`limit.slot` with `open(..., "wx")`, so the
count-check→create window cannot over-admit. FIFO registration is correct — `.sequence` increments under the
directory lock, waiter names zero-pad to 20 digits so lexical sort is arrival order, and a late waiter that polls
first still defers via `position < availableSlots` (`:265`). Backward compatibility holds: absent
`state.providerConcurrency` falls back to the machine policy (`collaboration-worker.mjs:148`, now redundant but
harmless given admission-time clamping), `compactStatusView` strips the field
(`collaboration-bridge.mjs:237`), and no state migration is required.

## Verdict

Residuals A and B are closed, A with targeted test coverage. Findings 1, 2, 3, and 5 remain closed; finding 4
remains accepted under policy. Residuals C–F are non-blocking. **No blocking findings remain.**

HANDOFF: {"outcome":"completed","summary":"Final confirmation of provider-concurrency diff at anchor src/provider-concurrency.mjs 324 lines mtime 04:58:32, worker 438 lines mtime 04:58:32, test mtime 05:00:12. Residual A closed: acquireProviderCapacity now clamps to min(machine, requested) at admission via loadProviderConcurrency, covered by a new test asserting limit 1 against a requested 3 under a machine ceiling of 1. Residual B closed: worker wraps acquisition in try/catch clearing runtime.activeCall and recording provider_capacity_failed before rethrow, which also resolves the prior onWait-after-cancel ordering race. Settled findings 1/2/3/5 unaffected and not reopened; finding 4 remains accepted under the stated safety policy. Four non-blocking residuals recorded, including one new environmental consequence of edit A: acquisitions outside the ceiling block now read the real machine config, so a customized config could hang the suite. All five permitted commands pass; git diff --check is clean but covers tracked files only, not the three untracked new files.","artifacts":["docs/handoffs/provider-concurrency-review.md"],"verification":["npm run test:provider-concurrency: pass (ran the 05:00:12 test revision)","npm run test:collaboration: pass","npm run test:cleanup: pass","npm run smoke: pass","git diff --check: pass, no whitespace errors, tracked files only"],"commit":null,"pullRequest":null,"remaining":["Optional: set AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG for the whole provider-concurrency test to restore hermeticity","Optional: bounded maxWaitMs for capacity waits","Optional: avoid masking the original error in the capacity-failure handler"],"nextAction":"chair_verify"}

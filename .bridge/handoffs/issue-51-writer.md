# Durable GitHub Issue Claim Leases Handoff (Writer)

This handoff details the complete implementation and validation of the durable GitHub issue claim leases subsystem (GitHub Issue #51).

## Implementation Details

- **Atomic Locking Mutex**: Utilizes GitHub Git database API tag reference creation (`refs/tags/claims/issue-<issueNumber>`) as a server-side atomic lock. This guarantees single-winner execution under concurrency.
- **Explicit target-binding / Authorization**: Target-binds the bound builder client to a single issue number and requires calling `authorize()` for all REST and Git endpoints to enforce least-privilege constraints.
- **Whole Issue Lane Claim Lifetime**: Ensures the claim lease spans the entire lifetime of the issue lane. The worker refreshes the lease on phase transitions, but only releases it on terminal lane outcomes (`cancelled`, `obsolete`, or `rolled_back`).
- **Initialization Rollback**: Wraps the workspace creation and preflight checks in a rollback try-catch block, releasing the lease with `rolled_back` status and deleting the tag lock ref if the initialization fails.
- **Restart Reconciliation**: Performs conservative reconciliation, preserving ambiguous ownership and avoiding local-PID-only conclusions for out-of-process/remote collaborations.
- **Rate-Limited Refreshes**: Refreshes same-phase and same-head comments at most once every 60 seconds.

## Staged Files

- `src/github-issue-claims.mjs` (Core lease manager)
- `scripts/github-claims-test.mjs` (Mock integration tests)
- `src/github-builder-client.mjs` (REST / Git reference endpoints, target-bound validations, and authorization checks)
- `src/collaboration-bridge.mjs` (Acquisition before worktree setup, start rollback logic)
- `scripts/collaboration-worker.mjs` (Lease refresh on state transitions, exit only on explicit cancellation)
- `src/collaboration-store.mjs` (Pre-generated collaboration IDs)
- `package.json` (Claims test runner script)
- `skills/pair-program/SKILL.md` (Skills guidelines update)
- `skills/take-the-helm/SKILL.md` (Skills guidelines update)
- `skills/council-implement/SKILL.md` (Skills guidelines update)

## Verification Evidence

Commit SHA: `49fdbcf33379399b44ec40e654a57dd30a0175a8`

### Claim Subsystem Tests Output (`npm run test:claims`)
```
1. Testing target-bound check & wrong target validation...
2. Testing negative authorization validation...
3. Testing durable claim lease idempotency...
4. Testing true concurrent collision (atomic tag lock mutex)...
5. Testing spoofed comments check...
6. Testing stale lease takeover...
7. Testing phase no-op / regression checks & rate limiting...
8. Testing terminal lifecycle transitions...
9. Testing initialization rollback...
10. Testing restart recovery / Indeterminate reconciliation...
All claim subsystem unit tests passed successfully!
```

### Existing Builder Tests Output (`node scripts/github-builder-test.mjs`)
```
Running real local-repository transport integration tests...
Bound GitHub builder tests passed: PR lifecycle, exact head, trusted latest review gate, merge paths, bounded no-shell transport, create_branch, fast-forward push_branch, and guarded replace_branch with fail-closed validations.
```

### Skill Validation Output (`node scripts/skill-test.mjs`)
```
Codex agent-dialogue skill: valid
Claude agent-dialogue skill: valid
CLI dialogue skill tests passed without invoking either model.
Partial-export merge, orphan cleanup, and symlink-rejection tests passed.
Global bridge skills are synchronized across Codex, Claude, Antigravity App, and Antigravity CLI.
```

## Risks and Mitigation

- **Lease Leftovers on Hard Broker Crashing**: If the broker machine or node process crashes completely and cannot write a release comment, the Git reference remains. This is mitigated by **Stale Lease Detection & Takeover** utilizing a TTL fallback (300 seconds) when no active local worker heartbeat is recorded.
- **GitHub API Rate Limits**: Refresh comments could consume rate limits. Mitigated by enforcing a 60-second rate-limit on same-phase / same-head refreshes.

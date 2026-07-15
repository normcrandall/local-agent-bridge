# Review: formal reviewer-App decision precedes optional status fallback

**Reviewer:** Claude (read-only review mode)
**Scope:** uncommitted diff — `src/github-builder-client.mjs`, `scripts/github-builder-test.mjs`, `README.md`
**Verdict:** APPROVE — no blocking correctness or security issues; both prior low-severity notes resolved.

## Objective mapping (all satisfied)

1. **No Commit-statuses permission required when a reviewer App APPROVED.** `effectiveAppReviews` is
   fetched from the PR reviews endpoint first (`github-builder-client.mjs:273-288`). An exact-head
   APPROVED trusted-App review sets `reviewGate = trusted_app_review`; the statuses endpoint is
   guarded by `!reviewGate && effectiveAppReviews.length === 0` (line 289) so it is never called.
   Asserted at test lines 129 and 138 (`/statuses?` never invoked, incl. the 403-permission fixture).

2. **Formal App decisions evaluated before the status fallback.** App-review block (273-288) runs
   before the status block (289-309). Correct ordering; README now documents this precedence.

3. **CHANGES_REQUESTED / same-reviewer DISMISSED fail closed and are NOT overridden by a success
   status.** Any decisive exact-head trusted-App review (APPROVED/CHANGES_REQUESTED/DISMISSED) makes
   `effectiveAppReviews` non-empty, which both (a) suppresses the status read via the `length === 0`
   guard and (b) triggers the new accurate terminal throw at lines 324-329
   (`Configured reviewer App decisions do not authorize merge on exact head <sha>: <login>:<state>`).
   `effectiveReviewsFor` keeps the latest decisive state per login at exact head (260-271), so
   approved-then-dismissed resolves to DISMISSED. Now pinned by tests that use `reviewStatus:"success"`:
   line 139-148 (CHANGES_REQUESTED + success → rejects `/…do not authorize merge.*CHANGES_REQUESTED/`)
   and line 149-161 (APPROVED-then-DISMISSED + success → rejects `/…do not authorize merge.*DISMISSED/`).

4. **403 reading statuses non-fatal; other status errors fail.** `responseJson` stamps `error.status`
   (17-21). The status fetch is wrapped in try/catch (290-308): a 403 records
   `machineStatusUnavailableReason` and continues so a trusted-human exact-head approval still
   authorizes (human block 310-323); any non-403 error (and paginator errors, which carry no
   `.status`) rethrows and fails. Asserted at test lines 130-138 (App+403 authorized, no status call)
   and 181-188 (human+403 authorized).

## Resolution of prior low-severity notes

- **Note 1 (test did not pin "success cannot override DISMISSED"):** RESOLVED. The DISMISSED test now
  uses `reviewStatus: "success"` (test line ~152) and still rejects.
- **Note 2 (misleading status-centric error on an App negative decision):** RESOLVED. New terminal
  branch (324-329) reports the actual App decision(s) and precedes the status-centric branch. The
  branch is guarded by `!trustedHumanReviewLogins.length`, so it only fires when no human path exists,
  and only when `!reviewGate` — it cannot mask an authorized merge. Fail-closed.

## README clarification
`README.md:139` now states the builder checks formal reviewer-App decisions first, needs no Commit
statuses permission when an exact-head App approval exists, and consults `agent-review` only as a
fallback. Accurate to the implemented behavior.

## Verification run (only the permitted commands)
- `npm run test:github-builder` — PASS
- `git diff --check` — clean
- `npm run smoke` — FAIL in `callAntigravityWithoutModel` ("Antigravity Git metadata directories were
  not added explicitly", `smoke-test.mjs:301`). `smoke-test.mjs` is not part of this diff; unrelated
  pre-existing Antigravity-path failure, not a regression from the reviewed change.

## Findings
No blocking or significant correctness/security findings. Both prior low-severity notes are resolved.

## Conclusion
Every gate path traced remains fail-closed: negative or dismissed App decisions block and are immune
to a success status (with an accurate error), the statuses endpoint is consulted only when no decisive
trusted-App review exists, and a 403 on statuses degrades to human authorization without opening a
bypass. **APPROVED.**

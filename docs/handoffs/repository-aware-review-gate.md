# Repository-aware GitHub reviewer gate — review handoff (Claude)

## Scope
Independent review of the full uncommitted diff (`git diff --stat`: 14 files) for
the repository-aware reviewer gate, plus a narrow re-review of three follow-up
changes. Focus: the fail-closed merge-authorization path and the reviewer
permission relaxation.

## Verification (all run, all green)
- `npm run test:github-app-auth` — PASS (JWT, role routing, fail-closed).
- `npm run test:review-publication` — PASS (publishable-first ordering, degradation, human escalation; asserts `binding.publishStatusGate` false without `statuses:write`, true with it).
- `npm run test:github-review` — PASS (identity, exact SHA, App status gate, PAT comment-only, idempotency).
- `npm run test:github-builder` — PASS (exact head, trusted latest review gate, dismissal rejection, pagination, merge paths).
- `npm run test:models` — PASS.
- `git diff --check` — clean (no whitespace errors).

## Core objective — satisfied
- `src/github-app-auth.mjs:10` — reviewer role required permissions are now
  `{contents:read, pull_requests:write, metadata:read}`; `statuses:write` is not
  required, so an App lacking it still passes `assertGitHubAppPermissions` and can
  publish a formal review.
- Status publication is a true optional enhancement. `src/github-review-bridge.mjs:36-40`
  gates it behind `appCredential && publishStatusGate(requested) && canPublishReviewStatus(permissions)`;
  an absent `statuses:write` permission skips (does not fail) publication.
- `src/github-builder-client.mjs:284-297` — new `trusted_app_review` gate: an
  exact-head (`commit_id === headSha`), trusted-App-login, latest-per-login
  `APPROVED` review with no latest `CHANGES_REQUESTED` authorizes merge. Stale
  heads, foreign logins, later changes-requested, and dismissals are excluded via
  the `commit_id`/`trustedLogins`/`decisiveStates` filter plus latest-per-login
  reduction. The `merge` PUT pins `sha: headSha` (line 325) as defense-in-depth.
- Trusted-login lists are cleanly separated at `src/github-builder-bridge.mjs:30-47`
  (reviewer App logins vs. `mergePolicy.trustedHumanReviewers`).

## Re-review of follow-up changes — all confirmed
1. **Dismissal rejection is tested.** `scripts/github-builder-test.mjs:127-139`:
   a configured reviewer App `APPROVED` (id 9) followed by `DISMISSED` (id 10) on
   the same exact head is now asserted to REJECT
   (`/No exact-head approval.*machine-review status.*not successful/i`). This
   confirms the latest-per-login reduction correctly revokes a dismissed approval.
   Related coverage: stale head (line 143-147), cross-login CHANGES_REQUESTED
   (line 201-205), human APPROVED-then-DISMISSED (line 216-221), and 100-review
   pagination (line 225+).
2. **`canPublishReviewStatus` is now wired into production** — used by
   `src/review-publication.mjs:33,36`, `src/github-review-bridge.mjs:39`, and the
   verifier `scripts/github-app-permission-check.mjs:28`. Prior finding #1 (dead
   helper) is RESOLVED; the tested helper and live gate share one definition.
3. **`publishStatusGate` default + clamp.** `src/claude-bridge.mjs:465` now
   defaults the input to `true`; `src/github-review-bridge.mjs:20,36-40` clamps
   actual publication to App credential AND the requested env flag AND live
   `statuses:write`. The requested flag is honored, not inert. Prior finding #2 is
   RESOLVED (the resolver path in `review-publication.mjs` still derives the
   binding value from permission, which is correct "publish-if-able" behavior and
   is asserted by `review-publication-test.mjs:27,37`).

## Findings
None blocking. Both LOW findings from the first pass (dead `canPublishReviewStatus`
helper; inert `publishStatusGate` field) are resolved by the follow-up changes.
No outstanding correctness or security issues.

## Verdict
**APPROVE.** The reviewer permission set permits formal exact-head reviews without
`statuses:write`; status publication remains an optional, permission-clamped
enhancement; and the fail-closed merge gate authorizes only exact-head APPROVED
reviews from configured trusted reviewer Apps, trusted exact-head `agent-review`
success statuses, or configured trusted human approvals, while rejecting stale
reviews, later changes-requested/dismissals, foreign identities, and unauthorized
heads. All five verification suites pass and `git diff --check` is clean.

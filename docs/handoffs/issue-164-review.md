# Review handoff — PR #171 (issue #164, provider-specific writer GitHub Apps)

- Repository: normcrandall/local-agent-bridge
- Exact head reviewed: f40b2ea87f279aaec20b6682e25ae0f36c4ec60d
- Diff base: main (18 files, +356/-76)
- Reviewer: veliqon-claude-reviewer[bot]
- Verdict: **REQUEST_CHANGES**

## Verification (all eight supplied commands run at the exact head; all passed)

| Command | Result |
| --- | --- |
| `npm run test:github-app-auth` | pass — JWT, discovery, role routing, repository scope, fallback, fail-closed |
| `npm run test:models` | pass — routing + antigravity model selection |
| `npm run test:github-builder` | pass — PR lifecycle, exact head, merge paths, branch ops, delivery repair |
| `npm run test:claims` | pass — 17 claim subsystem groups + claimed-issue hydration |
| `npm run test:collaboration` | pass — allowlist, capability boundary, fail-closed delivery, control plane |
| `npm run test:operations` | pass — rotation, preflight, worktrees, reconciliation, budgets, portability |
| `npm run test:mission-control` | pass — incl. `test:provider-quota` |
| `npm run test:provider-capabilities` | pass — incl. collaboration doctor |

No source, config, or Git state was modified. Only this handoff was written.

## What the PR gets right

- `configuredRole()` (`src/github-app-auth.mjs:57-92`) resolves `roles.writers.<provider>` first and falls back to `roles.builder` when the provider entry is absent, so an existing single-builder config keeps working unchanged. `scripts/github-app-auth-test.mjs` proves both the provider path and the compatibility fallback.
- `assertGitHubAppPermissions` (`src/github-app-auth.mjs:31-38`) maps `writer:*` role labels onto the `builder` permission floor, and `createInstallationToken` now asserts against `selected.roleLabel` rather than the raw `role`, so a writer token is held to the same floor.
- Writer selection never crosses into `roles.reviewers`: an `expectedLogin` that matches a reviewer App resolves to `selected: null` and throws (`GitHub App role is not configured: builder`), which is asserted in the new test.
- Reviewer inspection was refactored into a shared `inspectProviderRoles` helper rather than duplicated, and `roles.writers` inspection reuses the same key-hygiene checks.
- `providerCapabilities` (`src/operations.mjs:67, 96-98`) now reports per-provider `githubBuilder` capability with the builder fallback, replacing the single shared `builderBot` flag.
- Attribution is plumbed end to end: `writerAuthority` on the turn metadata → `collaboration-worker.mjs:917` → `collaboration-store.mjs:574` → Mission Control `WRITER` pane row.
- Merge is deliberately withheld from writer bindings so merge authority stays with the compatibility builder — the stated "merge independence" goal.

## Findings (severity order)

### 1. HIGH — a merge-only authorization silently widens to the default five-operation grant

`src/agent-pool.mjs:189` strips `merge` from the writer binding:

```js
allowedOperations: (baseBinding.allowedOperations || []).filter((op) => op !== "merge"),
```

`allowedOperations` is schema-validated with `.min(1)` (`src/collaboration-bridge.mjs:572`), so `["merge"]` is a valid input. After the strip it becomes `[]`. Both writer bridges then serialize it as:

```js
GITHUB_BUILDER_ALLOWED_OPERATIONS: githubBuilder.allowedOperations?.join(",") || null,
```

(`src/claude-bridge.mjs:256`, `src/tool-requests.mjs:131`). `[].join(",")` is `""`, which is falsy, so the variable is unset. `src/github-builder-bridge.mjs:21` then falls back to its permissive default:

```js
const allowedOperations = (process.env.GITHUB_BUILDER_ALLOWED_OPERATIONS
  || "ensure_pull_request,read_review_threads,reply_review_thread,resolve_review_thread,mark_ready").split(",")…
```

Failure scenario: a lane authorized solely for `merge` is stripped to nothing and the Claude/Codex writer receives `ensure_pull_request`, `read_review_threads`, `reply_review_thread`, `resolve_review_thread`, and `mark_ready` instead. An empty authorization must fail closed, not fall open to defaults. Note the antigravity path is not affected (it passes `allowedOperations: []` in-process), which makes the asymmetry easy to miss.

Proposed fix: in `writerBuilderContext`, throw when the strip empties the set (`"Writer bindings cannot be authorized for merge alone; merge remains with the compatibility builder."`). Independently, make `github-builder-bridge.mjs` treat an absent env variable as an empty grant when a sentinel such as `GITHUB_BUILDER_OPERATIONS_BOUND=1` is present, so the default list can never re-authorize a bounded lane. Also record the removed `merge` operation in `writerAuthority` so the strip is auditable rather than silent.

### 2. MEDIUM-HIGH — the writer installation token is cached for the pool's lifetime, and a failed mint is cached permanently

`src/agent-pool.mjs:156-203` memoizes the whole `writerBuilderContext` promise, including `credential.token`, in `writerBindings`. `boundBuilderClient()` (`src/agent-pool.mjs:284-312`) then passes that static `token` to `createBoundBuilderClient` with no `getToken` refresher. On `main`, `boundBuilderClient()` minted a fresh installation token on every call.

GitHub installation tokens expire after one hour. The pool is constructed once per collaboration run (`scripts/collaboration-worker.mjs:269`) and survives every turn, so `publishAntigravityBuilder` and `builder.reviewThreads()` will start returning 401 in any collaboration that runs longer than an hour. `src/github-builder-bridge.mjs:44-52` gets this right by supplying `getToken`; the in-process path regressed.

Second defect in the same block: `writerBindings.set(agent, promise)` at line 202 stores the *pending* promise. If the mint rejects (transient network failure, momentary GitHub 5xx), the rejection is cached and every subsequent turn for that agent throws the same error for the rest of the run, with no retry. `main` retried on the next call.

Proposed fix: cache only `{ binding, authority }`; mint the credential per call and pass `getToken: () => createInstallationToken({ role: "builder", writerProvider: agent, repository })` to `createBoundBuilderClient`. Add `promise.catch(() => writerBindings.delete(agent))` so a failed mint does not poison the pool.

### 3. MEDIUM — caller-supplied `expectedLogin` stops being an authorization pin in work mode

`src/collaboration-bridge.mjs:1027-1040` unconditionally overwrites the caller's `githubBuilder.expectedLogin` with `configuredWriterLogin(writerProvider)`, validating only the *optional* `expectedLogins[writerProvider]`. A caller that deliberately pinned a specific identity is silently rebound to whatever `roles.writers.<provider>` currently names, with no error and no receipt of the substitution.

`src/agent-pool.mjs:170-180` widens this further: `priorWriterLogin` lets a binding pinned to provider A's writer login authorize provider B's credential. That is the intended failover-rebinding behavior, but the consequence is that the singular `expectedLogin` now grants the union of every configured writer identity rather than one. `expectedLogins` is the only strict pin, and it is optional.

Proposed fix: require either `expectedLogins` or an explicit `writerRebindable: true` before substituting; otherwise fail closed with the mismatch error that already exists for the pinned case. If the permissive default is intentional, record `{ requestedLogin, resolvedLogin, rebindReason }` in `writerAuthority` and in the durable receipt so the substitution is auditable after the fact.

### 4. LOW-MEDIUM — the new tests cover the auth layer only

`scripts/github-app-auth-test.mjs:148-190` exercises provider selection, `configuredWriterLogin`, the reviewer-crossover rejection, and the compatibility fallback. Nothing covers the seams where findings 1-3 live: the merge strip, the empty-grant widening, the three authorization branches in `writerBuilderContext`, credential caching, the bridge-level rebinding, or `writerAuthority` propagation through `scripts/collaboration-worker.mjs:878-918`. All eight suites passing is therefore weaker evidence than it appears for the new agent-pool logic. Add unit tests at the `createAgentPool` seam with an injected `createInstallationToken`.

### 5. LOW — startup token mint and non-canonical login comparison in the writer bridge

`src/github-builder-bridge.mjs:43-46` mints an installation token at module load purely to populate `authority`, and compares identities with strict `!==` rather than `sameGitHubAppLogin`. The canonical comparator is used everywhere else in this PR. A configured login written without the `[bot]` suffix — which `canonicalGitHubAppLogin` is designed to normalize — now fails at bridge launch rather than at first use. The `!==` was pre-existing in `getToken`, but moving it to startup converts a lazy, recoverable failure into a hard launch failure.

Proposed fix: use `sameGitHubAppLogin(initialCredential.expectedLogin, expectedLogin)`, and derive `authority` lazily on first use (or from `getToken`'s first result) to avoid an unconditional API call at bridge startup.

## Recommendation

Findings 1 and 2 are blocking: 1 is a fail-open authorization widening, 2 is a live-token regression against `main`. Finding 3 is a design decision that should at minimum become auditable. Findings 4 and 5 are follow-ups. The provider-selection, permission-floor, reviewer-isolation, and backwards-compatibility work is otherwise sound.


- **PR review:** [CHANGES_REQUESTED](https://github.com/normcrandall/local-agent-bridge/pull/171#pullrequestreview-4780580283) as `veliqon-claude-reviewer[bot]` at `f40b2ea87f27`; formal App review gate (no commit status configured)

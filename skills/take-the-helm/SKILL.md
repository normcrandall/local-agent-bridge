---
name: take-the-helm
description: Give the Claude, Codex, and Antigravity council operational ownership of a goal or work queue so it resolves routine questions, executes independent issues in safe parallel worktree lanes, serializes exact-SHA integration through a bridge-owned merge train, arbitrates conflicts, verifies and reviews the work, and continues without asking the user for ordinary decisions. Use for autonomous backlog execution, multi-issue delivery, parallel milestone work, or requests to take charge and drive work to completion. Escalate only for material financial risk, legal or potentially illegal activity, missing authority or credentials, destructive or irreversible external action, an explicit user-owned choice, or a question the agents genuinely cannot resolve after evidence and reversible experiments.
---

# Take the Helm

Own the outcome. Treat the user as the sponsor, not the day-to-day operator. Drive the queue, make reversible decisions, keep the three-model council aligned, and surface only genuine escalation boundaries.

## Compose the existing workflows

Read and apply the installed `goal-loop`, `pair-program`, `council-grill-agents`, and `show-collaboration` skills. Use:

- `goal-loop` for explicit completion criteria, bounded recovery cycles, and verification;
- `pair-program` for one-writer ownership, worktree isolation, CI, provider roles, and PR review;
- `council-grill-agents` to resolve material questions among the models instead of interviewing the user;
- `show-collaboration` for durable status, handoffs, and resumability.

This skill sets the autonomy policy; it does not weaken their safety, permission, identity, verification, or single-writer rules.

Use the persistent collaboration portfolio tools for multi-issue work:

- `plan_portfolio` validates the dependency graph and computes dry-run execution waves;
- `create_portfolio` creates the durable `helm-<uuid>` ledger and exact-SHA merge train;
- `update_portfolio_item` records every lane transition with optimistic revision control;
- `enqueue_portfolio_merge`, `begin_portfolio_merge_validation`, `record_portfolio_merge_validation`, `authorize_portfolio_merge`, and `record_portfolio_merge` serialize integration and release newly unblocked work;
- `recover_portfolio_merge_validation` explicitly releases an interrupted integration slot, while `refresh_portfolio_target` records an external target advance and invalidates stale validation;
- `get_portfolio` and `list_portfolios` make the aggregate state portable across host apps.

## Derive the commander's intent

Infer the objective, source-of-truth queue, scope, priorities, repository policy, and completion condition from the request, current issue or Wayfinder map, tracker, and repository. Do not ask for information that can be discovered.

Prefer work in this order:

1. the exact issues or milestone named by the user;
2. the unblocked frontier of the named Wayfinder map or parent issue;
3. repository-labelled ready work in priority and dependency order;
4. the smallest coherent work that advances the stated objective.

If the request names a finite set, continue until every item is complete, blocked by a true escalation, or rendered obsolete with recorded evidence. For an open-ended backlog, work the current ready frontier until no eligible item remains. Respect explicit cost, token, time, or issue-count budgets; do not invent a smaller limit merely to return control early.

Define done from repository evidence: implementation, exact gates, independent review, required documentation or handoff, PR status, issue state, and deployment or merge boundaries authorized by repository policy.

Default to `maxParallel: 2`. Increase it only when more independent issues, healthy distinct writers, isolated worktrees, provider capacity, and repository resources are available. Reduce it automatically when a provider is unavailable or the safe frontier is smaller. Sequential execution is the correct degraded mode when only one safe lane exists.

Provider live-call capacity is separate from issue-lane capacity. Omit `providerConcurrency` to use the machine policy at `~/.config/local-agent-bridge/provider-concurrency.json`; without that file the broker defaults every provider to `{ work: 1, review: 2 }`. Per-collaboration values may lower but never raise this machine ceiling. Keep work at one unless the user deliberately configures a higher machine ceiling. Read-only reviews may use both default slots concurrently.

## Build the safe frontier

Before starting implementation, normalize every candidate issue into a scheduling manifest containing its ID, priority, status, hard blockers, explicit conflicts, expected paths, exclusive resources, acceptance criteria, and verification commands. Treat GitHub, Wayfinder, and parent-issue dependency links as the source of truth, then add temporary scheduling constraints discovered from repository inspection.

Distinguish:

- a **dependency edge**, which requires the predecessor to be merged or otherwise proven complete;
- a **conflict edge**, which prevents simultaneous work but does not impose permanent product ordering;
- a **path reservation**, which prevents overlapping directory or file ownership;
- a **resource reservation**, for migrations, generated artifacts, lockfiles, shared environments, provider call capacity, or another exclusive surface.

Call `plan_portfolio` before mutation. Reject dependency cycles. Do not treat an open PR, passing branch CI, or a provider handoff as satisfying a hard dependency that requires merged behavior. Recompute the frontier whenever an issue, PR, target branch, provider, or lane manifest changes.

## Reconstruct intent from Git history

Before planning or changing an affected area, inspect its relevant Git and GitHub history. Use commit and pull-request history, including recent commits, merged pull requests, linked issues, review discussions, reversions, and blame when needed to recover why the current design exists, what was already attempted, and which constraints maintainers have established. Follow renamed files and inspect the actual diff; do not rely on commit subjects alone.

Keep the search bounded to the objective, affected paths, and enough recent history to explain the present state. Expand farther only when the current behavior or an apparent contradiction remains unexplained.

Treat history as evidence, not permanent policy. Weight current owner instructions, repository policy, ADRs, tests, and current behavior above older commits. A revert, superseding PR, changed requirement, or later correction overrides the earlier decision. Record the inherited constraint or prior failed approach that materially shaped the plan so reviewers can distinguish an intentional departure from accidental rediscovery.

## Know what the agents own

Do not ask the user about:

- naming, formatting, code organization, implementation details, or library choices consistent with repository policy;
- reversible architecture and UX tradeoffs;
- which unblocked item to take next when tracker priority and dependencies decide it;
- test strategy, debugging approach, refactoring needed to make the change safe, or how to address validated review findings;
- routine branch, commit, push, PR, review, and CI operations already authorized by the workflow;
- disagreement among models that evidence, a prototype, a test, or a reversible decision can settle.

Choose a reasonable default, record the decision and rollback path, and proceed.

## Escalate only at a hard boundary

Contact the user only when at least one of these is true:

1. **Material financial exposure** — spending, pricing, billing, refunds, contractual commitment, lost revenue, or a credible risk of material financial loss is not already bounded by policy.
2. **Legal or potentially illegal activity** — legality, licensing, compliance, regulated data, contractual interpretation, or a request that may facilitate unlawful activity requires an accountable human decision.
3. **Missing authority** — required credentials, permissions, ownership, approval, identity, secrets, or access cannot be obtained within the existing authorization.
4. **Destructive or irreversible external action** — production data deletion, destructive migration, public release, disclosure, deployment, or another mutation lacks an explicit standing policy or exact authorization.
5. **Explicitly user-owned choice** — product values, brand commitments, public promises, or stakeholder tradeoffs are reserved to the owner and evidence cannot infer the answer.
6. **Genuinely unanswerable** — after the resolution ladder below, the agents still lack a fact or decision that materially changes the safe next action.

Phrase one decision-ready escalation: what is blocked, why the council cannot resolve it, evidence and attempts, available options, the recommended option, consequences, and the smallest answer needed. Continue every independent item while waiting.

Routine uncertainty, model disagreement, low confidence without investigation, or a preference for confirmation is not an escalation.

## Exhaust the resolution ladder

Before declaring something unanswerable:

1. inspect the repository, issue history, ADRs, domain language, tests, current application, and prior decisions;
2. verify unstable facts against current primary sources;
3. ask Claude, Codex, and Antigravity for sealed independent answers;
4. run `council-grill-agents` on the decisive disagreement;
5. build a cheap prototype, focused test, or reversible experiment when it can produce evidence;
6. choose the lowest-risk reversible option with a validation and rollback path;
7. record remaining uncertainty and proceed if failure is recoverable.

Escalate as genuinely unanswerable only when these attempts cannot produce a safe action and guessing could materially harm the objective.

## Start visibly

Use `plan_portfolio`, then `create_portfolio`, before starting issue collaborations. Include Claude, Codex, and Antigravity as the writer pool. Pass the current host as `chair` when it owns a lane, keep chair work native, and omit model overrides so every provider uses the user's configured model and fallback policy.

Before starting, display:

```text
TAKE THE HELM
Objective: <goal>
Queue: <issues, map, milestone, or frontier>
Completion: <evidence-based done condition>
Portfolio: <helm-id after creation>
Safe frontier: <selected issue IDs>
Max parallel: <default 2>
Provider capacity: Claude work 1/review 2 · Codex work 1/review 2 · Antigravity work 1/review 2
Participants: Claude, Codex, Antigravity
Chair: <provider>
Writer lanes: <issue -> provider, or pending>
Autonomy: routine decisions owned by council
Escalation: finance, legal/illegal, authority, irreversible action, owner-only choice, genuinely unanswerable
Tools: collaboration.plan_portfolio → collaboration.create_portfolio → collaboration.start_collaboration per selected lane
Models: provider configured
GitHub identities: provider-configured Apps; no embedded maintainer identities
```

Return the portfolio ID immediately, followed by each lane's collaboration ID when started. Poll each active collaboration with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`; do not put one long poll around the entire portfolio. Fetch completed output once when a lane's `runtime.turnCount` advances. Show changed provider-authored narrative and one aggregate liveness receipt per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

Treat each lane's terminal `coordinatorWake` as a durable scheduler event. Fetch the new turn once, process `nextAction`, acknowledge the exact wake sequence with `acknowledge_coordinator_wake`, update the portfolio lane, and immediately recompute or dispatch the next safe action. Stop/AfterAgent hooks keep the native coordinator from ending with actionable work; SessionStart restores unprocessed events. Never acknowledge merely to clear the queue. `needs_user` and `indeterminate` wakes are protected boundaries for that lane, while independent healthy lanes continue.

## Run parallel issue lanes

Start only the items selected by the portfolio's current safe frontier. Assign exactly one writer to every selected item and give it an isolated worktree. During implementation, use a writer-only collaboration for that lane. The broker enforces the provider's work capacity and queues excess calls. Schedule independent review calls immediately after a writer handoff; do not manually hold a review merely because the provider is busy. The broker admits up to the configured review capacity, publishes `waiting_capacity` for queued calls, and wakes the oldest queued call automatically when a slot is released.

For each selected lane:

1. **Claim and reserve** — claim the issue, create its worktree and branch, record its expected paths/resources, writer, and collaboration ID with `update_portfolio_item`, then recheck that it does not overlap another active lane.
2. **Orient and plan** — read the issue, comments, parent, blockers, prior attempts, relevant code, and pertinent commit and PR history. Resolve consequential disagreement through evidence or `council-grill-agents` before source mutation.
3. **Implement with one writer** — select `workProfile: implement` for local delivery through commit or `workProfile: deliver` for authorized push and PR creation. No other lane or reviewer may write that worktree.
4. **Expand reservations before scope** — if implementation must touch an undeclared path, contract, migration, generated artifact, or shared resource, update the manifest and recompute the portfolio before editing it. Pause the lower-priority lane on a new collision.
5. **Verify and hand off** — run exact issue gates and require a structured `HANDOFF`. The chair verifies and acknowledges that sequence before recording the lane as ready for review.
6. **Review independently** — assign providers that did not write the lane. When the PR is the source of truth, use the exact PR head and configured reviewer Apps. Accept either their resulting exact-head `agent-review` gate or an exact-head approval from a machine-locally configured trusted human. A PAT compatibility comment is not approval. Submit every review-ready lane to the broker immediately. It permits up to the configured live review limit per provider—two by default—while retaining one live work call by default.

   Start a review leg with an ordered roster containing the preferred reviewer and all eligible non-writer fallbacks in the same collaboration. Set `maxTurns` to the number of successful reviews required; a failed or disconnected provider does not consume a turn and the broker advances to the next candidate. Never make a single provider the only critical-review candidate unless the owner explicitly pins it. Reviewer-App publication is preflighted: publishable identities run first, unbound reviewers remain available for local handoff, and an all-unbound roster completes locally then waits for exact-head trusted-human approval instead of abandoning the portfolio.

   After every completed, failed, cancelled, or indeterminate provider call, refresh all review-ready lanes. A released slot must dispatch the oldest compatible queued review without another user turn. Show `PR #<n> queued — waiting for <provider> review capacity (<used>/<limit>)` while it waits, then announce the automatic dispatch when capacity opens.
7. **Repair with the same writer** — validate review findings, return valid blockers to the original writer, rerun gates, refresh the exact head, and request focused re-review.
8. **Enqueue** — after current reviews and checks pass, call `enqueue_portfolio_merge` with the exact PR head. A queued PR is not yet complete and does not release its dependents.

Continue healthy lanes when another becomes blocked, indeterminate, or enters arbitration. Never let two writers edit overlapping workspace state. Never have the chair impersonate a delegated reviewer or repost its review through a personal identity.

## Serialize integration through the bridge merge train

Process one queued PR at a time. Refresh the current target SHA and PR head, then call `begin_portfolio_merge_validation`. In a disposable integration worktree based on the observed target SHA, combine the exact PR head without changing either source branch. Run both the lane gates and repository integration gates against that combined state.

If another actor advances the target branch, call `refresh_portfolio_target` before the next validation. If a host exits while holding the integration slot, inspect the disposable worktree and Git state, then call `recover_portfolio_merge_validation` with a factual reason and an explicit requeue-or-repair disposition. Never silently steal an active slot.

On success, call `record_portfolio_merge_validation` with `outcome: passed`, then `authorize_portfolio_merge` using the freshly observed target and head SHAs. This authorization proves validation freshness but grants no GitHub permission. Merge only when repository policy contains standing auto-merge authority or the exact head SHA has been explicitly authorized, GitHub's required CI/rules pass, and the exact head has an `APPROVED` review from a configured reviewer App, the optional exact-head `agent-review=success` status from that App, or an `APPROVED` review from a machine-locally configured trusted human. A delegated writer uses its separately bound builder App. A native coordinator calls collaboration `merge_pull_request` with the exact repository, PR number, and current head SHA; never request Bash permission for `gh pr merge`. The broker requires the repository to match machine-local `mergePolicy.autonomousMergeRepositories` and rechecks the gate. A bot review does not satisfy a nonzero human-approval count. If GitHub requires a human, pause for that person's real review and never use an owner PAT bypass. Record the validated pre-merge target SHA, exact PR head SHA, and GitHub's resulting merge SHA with `record_portfolio_merge`; this invalidates other combined validations and recomputes the ready frontier.

On textual, structural, semantic, or requirement conflict, record `outcome: conflict` with a dossier containing the files, current-main intent, incoming intent, and both sets of acceptance criteria. Use two read-only advocates and a third-model arbiter when available. Apply the resolution to the later PR with exactly one integration writer, then require new tests, reviews, head SHA, and queue entry. Prefer current owner policy, current `main`, security/data integrity, public compatibility, acceptance criteria, tests, ADRs, and recent history—in that order. Never use last-writer-wins or a model majority as the decision rule.

If the target branch or PR head changes between validation and merge, discard the authorization and revalidate. Do not push a temporary integration commit directly to the protected branch.

## Require council agreement at consequential gates

Require explicit acceptance from every available provider at:

- the item plan when it changes architecture, data, public behavior, security, or operating cost;
- readiness after implementation and verification;
- the response to blocking review findings;
- completion of the item and release of dependent work.

Consensus is not a majority vote. A blocking objection must be resolved with evidence, a narrower reversible change, or a recorded escalation. Routine implementation choices may use the configured `decisionPolicy` without a full council round.

Three providers produce **full consensus**. Two may produce **degraded consensus** and continue with reversible work. With one provider, continue safe local implementation and verification as a **single-agent provisional result**, but do not perform irreversible external actions or claim council consensus.

Continue with two models or one model rather than stalling the queue; reduce the authority of the result as described above.

## Recover instead of stopping

Use configured overload fallbacks within the same turn. For a confirmed unavailable provider, display `PROVIDER SKIPPED`, the reason, remaining providers, current writer, and collaboration ID. Do not repeatedly retry it during the same phase.

A timeout or lost transport is indeterminate: preserve writer ownership, inspect state, and explicitly cancel before reassignment. Recover failed worktrees, stale branches, interrupted reviews, CI failures, and orphaned collaborations using the underlying skills. Reassign a writer only after confirming the previous writer cannot still mutate the workspace.

If one item is truly blocked, record the blocker and continue every independent ready item. Stop the run only when the objective is complete, no ready work remains, every remaining item is at a hard escalation boundary, or an explicit budget is exhausted.

## Report without handing the helm back

Status updates are receipts, not requests for approval. Show the portfolio ID; ready, active, reviewing, queued, arbitrating, blocked, and merged counts; each active lane's writer, phase, latest narrative, gates, and PR; the merge-train candidate; and the next automatic action.

Use an aggregate receipt rather than repeating every lane heartbeat:

```text
HELM <portfolio-id> · <running> RUNNING · <reviewing> REVIEWING · <ready> READY · <blocked> BLOCKED
Lane <issue> · <writer> · <phase> · <changed narrative>
Merge train · <idle | validating PR/head | arbitrating conflict>
Released: <newly unblocked IDs or none>
Next: <automatic scheduling action>
```

At the end, report:

1. completed, obsolete, blocked, and remaining items;
2. decisions made autonomously, dissent, and rollback paths;
3. branches, commits, PRs, reviews, checks, merges, and issue updates;
4. provider failures and fallback models used;
5. genuine escalations, with one recommended answer each;
6. collaboration IDs and the exact condition that ended the run.

Do not ask “what next?” when the queue already determines the next action.

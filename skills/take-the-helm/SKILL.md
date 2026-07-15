---
name: take-the-helm
description: Give the Claude, Codex, and Antigravity council operational ownership of a goal or work queue so it resolves routine questions, implements items sequentially, verifies and reviews the work, and continues without asking the user for ordinary decisions. Use for autonomous backlog execution, multi-issue delivery, or requests to take charge and drive work to completion. Escalate only for material financial risk, legal or potentially illegal activity, missing authority or credentials, destructive or irreversible external action, an explicit user-owned choice, or a question the agents genuinely cannot resolve after evidence and reversible experiments.
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

## Derive the commander's intent

Infer the objective, source-of-truth queue, scope, priorities, repository policy, and completion condition from the request, current issue or Wayfinder map, tracker, and repository. Do not ask for information that can be discovered.

Prefer work in this order:

1. the exact issues or milestone named by the user;
2. the unblocked frontier of the named Wayfinder map or parent issue;
3. repository-labelled ready work in priority and dependency order;
4. the smallest coherent work that advances the stated objective.

If the request names a finite set, continue until every item is complete, blocked by a true escalation, or rendered obsolete with recorded evidence. For an open-ended backlog, work the current ready frontier until no eligible item remains. Respect explicit cost, token, time, or issue-count budgets; do not invent a smaller limit merely to return control early.

Define done from repository evidence: implementation, exact gates, independent review, required documentation or handoff, PR status, issue state, and deployment or merge boundaries authorized by repository policy.

## Reconstruct intent from Git history

Before planning or changing an affected area, inspect its relevant Git and GitHub history. Use recent commits, merged pull requests, linked issues, review discussions, reversions, and blame when needed to recover why the current design exists, what was already attempted, and which constraints maintainers have established. Follow renamed files and inspect the actual diff; do not rely on commit subjects alone.

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

Use `$run-roundtable`, backed by the persistent `collaboration` MCP. Include Claude, Codex, and Antigravity. Pass the current host as `chair` with its provider and absolute workspace. Keep chair work native and delegate only to peers. Omit model overrides so every provider uses the user's configured model and fallback policy.

Before starting, display:

```text
TAKE THE HELM
Objective: <goal>
Queue: <issues, map, milestone, or frontier>
Completion: <evidence-based done condition>
Participants: Claude, Codex, Antigravity
Chair: <provider>
Current writer: <one provider or none during planning>
Autonomy: routine decisions owned by council
Escalation: finance, legal/illegal, authority, irreversible action, owner-only choice, genuinely unanswerable
Tool: collaboration.start_collaboration
Models: provider configured
GitHub identities: provider-configured Apps; no embedded maintainer identities
```

Return the `collaborationId` immediately. Poll with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`. Fetch completed output once when `runtime.turnCount` advances. Show changed provider-authored narrative from `runtime.activeCall.summary`; rate-limit heartbeat-only output to one compact line per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

## Run the autonomous work loop

For each ready item:

1. **Claim and orient** — claim the issue using repository convention; read its body, comments, parent, blockers, prior attempts, relevant code, and the affected paths' pertinent commit and pull-request history.
2. **Resolve the plan** — have all available models independently inspect the item. Resolve material disagreement through evidence or `council-grill-agents`. Record the selected plan, dissent, validation, and rollback path.
3. **Assign exactly one writer** — use an isolated worktree or branch. Select `workProfile: implement` for local delivery through commit or `workProfile: deliver` when push and PR creation are authorized. Other models remain read-only.
4. **Implement and verify** — follow repository TDD and quality rules, run exact local gates, and inspect the resulting diff. Do not reduce coverage or bypass gates to create progress.
5. **Review independently** — the non-writing models review the actual diff and verification evidence. When the PR is the source of truth, pass `githubReview` with repository, PR, and current head SHA so each reviewer authors its own formal review through its configured App.
6. **Reconcile and repair** — validate findings locally, fix valid blockers with the same writer, rerun gates, and request focused re-review. Use evidence rather than votes.
7. **Complete delivery** — push and create or update the PR through the configured builder identity. Merge only when repository policy contains standing auto-merge authority or the exact head SHA has been explicitly authorized; otherwise leave the verified PR ready without manufacturing permission.
8. **Advance the queue** — update or close the issue according to repository policy, release newly unblocked items, rotate roles when useful, and immediately begin the next ready item.

Never let two writers edit overlapping workspace state. Never have the chair impersonate a delegated reviewer or repost its review through a personal identity.

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

Status updates are receipts, not requests for approval. Show current item, writer, phase, latest narrative, gates, PR, consensus level, and next automatic action.

At the end, report:

1. completed, obsolete, blocked, and remaining items;
2. decisions made autonomously, dissent, and rollback paths;
3. branches, commits, PRs, reviews, checks, merges, and issue updates;
4. provider failures and fallback models used;
5. genuine escalations, with one recommended answer each;
6. collaboration IDs and the exact condition that ended the run.

Do not ask “what next?” when the queue already determines the next action.

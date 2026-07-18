---
name: pair-program
description: Run a durable Claude, Codex, and optionally Antigravity pair-programming task with deterministic implementer/reviewer rotation, preflight, isolated worktrees, heartbeats, CI tracking, formal bot reviews, reconciliation, budgets, recovery, and portable history. Use when agents should alternate who codes and who reviews across tasks or PRs.
---

# Pair Program

Use the persistent collaboration broker. Keep exactly one writer and make the PR plus repository handoff the durable source of truth.

## Prepare

1. Resolve the absolute workspace, task number, selected agents, acceptance criteria, verification commands, PR target, and whether delivery is authorized.
2. Run `bridge capabilities` and `bridge preflight --workspace <path> --agents <csv> --mode work --profile <implement|deliver>`.
3. Run `bridge roles --task <number> --agents <csv>`. Honor an explicit user-selected writer over rotation.
4. Default to an isolated worktree. Pass `worktree: { taskId, branch, base }` to `start_collaboration`; omit it only when repository policy forbids worktrees or the task already owns one.
5. Inspect the issue's `agent:in-progress` label and trusted builder-App claim comment. Exclude a fresh claim owned by another collaboration, then acquire a durable GitHub issue claim lease before worktree creation or delegation.
6. Refuse to start on an indeterminate ownership conflict. Use `bridge recover <id>` to inspect it.
7. If the active host is the implementer, declare `chair` and call only peer providers. Same-provider delegation requires an explicit opt-in.

## Start

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-4-8[1m]` and remove Fable from `modelFallbacks.claude`. Announce an explicitly authorized Fable use before starting. For that authorized phase only, pass `allowClaudeFable: true` to collaboration or `allowFable: true` to a direct Claude call. Never set either field otherwise; authorization resets on every collaboration continuation.

Call `collaboration.start_collaboration` with:

- `workspace`: absolute repository path.
- `agents`: Claude and Codex by default; add Antigravity when requested or valuable.
- `taskNumber`: enables deterministic rotation.
- `mode: work`, one `writer`, and `workProfile: implement|deliver`.
- `permissionProfile: standard` unless the user explicitly says `yolo`. If explicit, warn before starting and set `permissionProfile: yolo` for the writer. Reviewers remain source-read-only, but an Antigravity review carrying `verificationCommands` automatically uses `--dangerously-skip-permissions` because `agy` exposes no exact command grant; static Antigravity reviews remain sandboxed.
- exact `verificationCommands`, unusual `workCommands`, and repository handoff path.
- `githubReview` when the PR is the source of truth.
- `githubBuilder` when the writer owns bounded PR delivery, with an explicit `allowedOperations` list. Merge remains absent unless the user explicitly authorizes the exact-head merge.

For an autonomous merge, require an exact-head `APPROVED` review from a configured reviewer App, the optional exact-head `agent-review=success` status from that App, or an exact-head `APPROVED` review from a machine-locally configured trusted human, plus GitHub's required CI and rules. A bot verdict does not satisfy a nonzero human-approval count. If GitHub requires a human approval, pause for the person's real review; never replace the App with a personal PAT, manufacture the human approval, or use owner bypass.

For every autonomous review leg, pass an ordered roster containing the preferred reviewer plus every eligible non-writer fallback in the same collaboration. Set `maxTurns` to the number of successful reviews required; a provider failure does not consume a turn, so the broker advances to the next candidate. Never launch a critical review with one candidate unless the user explicitly pins that provider. The broker checks reviewer-App publication before the turn, prefers publishable identities, and degrades an unbound participant to a local durable handoff. If no bot can publish, continue the review and require an exact-head approval from a configured trusted human instead of terminating the pipeline.
- `ciTracking.prNumber` when a PR exists.
- optional `budget.maxCostUsd`, `budget.maxTokens`, and `budget.maxMinutes`.
- optional `modelFallbacks.claude`, filtered through the Claude model policy above, and `modelFallbacks.codex`, preserving ordered overload-only downgrade chains; omit them to use machine-local policies.
- optional `providerConcurrency`; omit it to use the machine policy, defaulting each provider to one live work call and two concurrent read-only review calls. A collaboration may lower but never raise that machine ceiling. Excess calls remain visibly queued and start automatically when the oldest compatible slot opens.

A recognized provider model overload advances inside the active turn without rotating or reassigning the writer. Claude Code owns its native fallback; the Codex bridge records attempted and selected models. Show any downgrade narrative. Treat authentication, quota, permission, configuration, and transport errors through their existing failure or indeterminate paths instead of model fallback.

Return the collaboration ID immediately. For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds: 8` (or less). Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Show the narrative `runtime.activeCall.summary` with its age, heartbeat age, writer, worktree/branch, CI, and usage when those fields change. Never expose private reasoning.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Render a full update on lifecycle or narrative changes; for liveness-only changes, emit at most one compact line per 60 seconds. Never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

For a native coordinator, every stopped leg produces a durable `coordinatorWake`. Read the new turn and completion receipt, perform `nextAction`, then call `acknowledge_coordinator_wake` with the exact sequence before dispatching repair, re-review, merge validation, or another task. Host Stop/AfterAgent hooks hold the turn open and SessionStart restores missed receipts. Do not acknowledge without processing. `needs_user` and `indeterminate` remain protected stop boundaries.

## Rotate and review

For task N, let the selected writer implement test-first, verify, commit, and deliver only within its profile. Every other agent remains read-only. Reviewers author the handoff and formal PR review through their provider-specific, user-owned Apps selected from machine-local configuration. Omit identity fields unless repository policy requires strict login pins; never embed App credentials or maintainer-specific identities in the skill. On task N+1, run role selection again; do not transfer an active task's writer merely to satisfy rotation.

After multiple reviews, reconcile evidence rather than vote. Use `bridge reconcile --reviews <json>` for structured findings. Show accepted, disputed, and rejected findings; the writer fixes only validated findings and reviewers re-check the actual new head.

Submit review-ready PRs immediately even when a provider is occupied. The broker enforces role-specific capacity and displays `waiting_capacity`; do not serialize reviews in the chair merely because another review is active.

Resolve reversible technical disagreements with `decisionPolicy` and one `DECISION:` receipt containing alternatives, confidence, dissent, rollback, and owner. Always escalate money, legal/compliance, authority expansion, destructive external effects, and user-owned product choices.

## Recover and stop

- A timeout or lost transport is `indeterminate`, not failed. Preserve writer ownership.
- Use `bridge status` for all active tasks and `bridge recover <id>` for process, heartbeat, and Git evidence.
- Use `bridge recover <id> --mark-indeterminate` only when the worker is confirmed dead.
- Use `bridge recover <id> --cancel` only after inspecting Git state; cancellation terminates the worker group and releases ownership.
- Stop after the current turn when a configured budget is reached.
- Archive terminal history with `archive_collaboration` or retention-based `prune_collaborations`; never prune active or indeterminate ownership.
- Ensure claim leases are released only at terminal delivery (merge, cancel, obsolete) or explicit recovery. Failed, indeterminate, completed, and review-pending work stays claimed so another provider cannot silently duplicate it.

Finish only when acceptance criteria, local gates, hosted CI, durable handoff, formal reviewer publication, and clean ownership state are all verified.

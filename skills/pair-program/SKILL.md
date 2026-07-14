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
5. Refuse to start on an indeterminate ownership conflict. Use `bridge recover <id>` to inspect it.
6. If the active host is the implementer, declare `chair` and call only peer providers. Same-provider delegation requires an explicit opt-in.

## Start

Call `collaboration.start_collaboration` with:

- `workspace`: absolute repository path.
- `agents`: Claude and Codex by default; add Antigravity when requested or valuable.
- `taskNumber`: enables deterministic rotation.
- `mode: work`, one `writer`, and `workProfile: implement|deliver`.
- `permissionProfile: standard` unless the user explicitly says `yolo`. If explicit, warn before starting and set `permissionProfile: yolo`; reviewers remain read-only.
- exact `verificationCommands`, unusual `workCommands`, and repository handoff path.
- `githubReview` when the PR is the source of truth.
- `githubBuilder` when the writer owns bounded PR delivery, with an explicit `allowedOperations` list. Merge remains absent unless the user explicitly authorizes the exact-head merge.
- `ciTracking.prNumber` when a PR exists.
- optional `budget.maxCostUsd`, `budget.maxTokens`, and `budget.maxMinutes`.
- optional `modelFallbacks.claude` and `modelFallbacks.codex`, preserving ordered overload-only downgrade chains; omit them to use machine-local policies.

A recognized provider model overload advances inside the active turn without rotating or reassigning the writer. Claude Code owns its native fallback; the Codex bridge records attempted and selected models. Show any downgrade narrative. Treat authentication, quota, permission, configuration, and transport errors through their existing failure or indeterminate paths instead of model fallback.

Return the collaboration ID immediately. For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds: 8` (or less). Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Show the narrative `runtime.activeCall.summary` with its age, heartbeat age, writer, worktree/branch, CI, and usage when those fields change. Never expose private reasoning.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Render a full update on lifecycle or narrative changes; for liveness-only changes, emit at most one compact line per 60 seconds. Never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

## Rotate and review

For task N, let the selected writer implement test-first, verify, commit, and deliver only within its profile. Every other agent remains read-only. Reviewers author the handoff and formal PR review through their provider-specific, user-owned Apps selected from machine-local configuration. Omit identity fields unless repository policy requires strict login pins; never embed App credentials or maintainer-specific identities in the skill. On task N+1, run role selection again; do not transfer an active task's writer merely to satisfy rotation.

After multiple reviews, reconcile evidence rather than vote. Use `bridge reconcile --reviews <json>` for structured findings. Show accepted, disputed, and rejected findings; the writer fixes only validated findings and reviewers re-check the actual new head.

Resolve reversible technical disagreements with `decisionPolicy` and one `DECISION:` receipt containing alternatives, confidence, dissent, rollback, and owner. Always escalate money, legal/compliance, authority expansion, destructive external effects, and user-owned product choices.

## Recover and stop

- A timeout or lost transport is `indeterminate`, not failed. Preserve writer ownership.
- Use `bridge status` for all active tasks and `bridge recover <id>` for process, heartbeat, and Git evidence.
- Use `bridge recover <id> --mark-indeterminate` only when the worker is confirmed dead.
- Use `bridge recover <id> --cancel` only after inspecting Git state; cancellation terminates the worker group and releases ownership.
- Stop after the current turn when a configured budget is reached.
- Archive terminal history with `archive_collaboration` or retention-based `prune_collaborations`; never prune active or indeterminate ownership.

Finish only when acceptance criteria, local gates, hosted CI, durable handoff, formal reviewer publication, and clean ownership state are all verified.

---
name: run-roundtable
description: Start and visibly monitor a persistent collaboration between two or three of Claude Code, Codex, and Antigravity. Use for debates, planning plus implementation, cross-review, consensus, or any request where agents should work together and the user needs clear handoffs, progress, and a portable collaboration ID.
---

# Run Roundtable

Use the `collaboration` MCP server. Keep the user oriented throughout the detached run.

Accept natural language or an explicit form such as `$run-roundtable --agents claude,codex,antigravity --writer codex <task>`.

## Start visibly

Resolve participants, order, mode, maximum turns, and roles. Default to all three agents, review mode, and six turns. In work mode select exactly one writer; default the writer to the starting agent. Omit all model fields unless the user explicitly overrides them.

Pass user-provided downgrade chains as `modelFallbacks.claude` and `modelFallbacks.codex`; otherwise omit them so the machine-local policy applies. Claude Code advances natively and Codex advances through the bridge only for recognized overload. Render any downgrade narrative immediately and never classify authentication, quota, permission, configuration, or transport errors as overload.

Extract exact verification commands from the task or repository guidance and choose one project-relative handoff file for Claude, normally under `.bridge/handoffs/`. Pass both `verificationCommands` and `handoffPath` to `start_collaboration` and every `continue_collaboration` phase. Claude reviewers may run only those commands and write only that handoff file.

When Claude is the work-mode writer, select `workProfile: implement` for local ownership through commit or `workProfile: deliver` when repository policy also assigns push and pull-request ownership. The profile avoids mid-task permission extensions for discovered tests, checksums, and normal Git/PR variants. Use additive `workCommands` only for unusual repository-specific tools.

Apply the same profile to a Codex writer: `implement` runs with workspace write access but no network; `deliver` enables network and authorizes requested push/PR delivery. Always pass the explicit absolute workspace. A collaboration retains its original workspace, writer, and profile even if the user later changes directories in Claude Code or Codex.

For pull-request work, read repository policy before starting. If it requires reviewer-authored PR feedback, resolve the exact repository, PR number, current head SHA, and required bot login and pass them as `githubReview`. Claude and Codex reviewers receive bound `write_handoff` and `submit_pr_review` tools backed by `~/.config/ghtoken`. Antigravity authors the same handoff/verdict/comment payload in a validated envelope, and the broker publishes it unchanged through the target-bound publisher. No reviewer receives general GitHub or `gh` access, and the writer never receives publication authority. Refresh the head SHA before each re-review phase.

Before `start_collaboration`, show:

```text
ROUNDTABLE STARTING
Participants: <ordered agents>
Task: <one sentence>
Mode: <review or work>
Writer: none | <agent>
Turns: <maximum>
Models: provider configured | <overrides>
Model fallbacks: machine configured | none | Claude <chain>; Codex <chain>
Tool: collaboration.start_collaboration
Verification commands: none | <exact commands>
Claude work commands: none | <exact commands>
Claude work profile: exact | implement | deliver
Claude handoff: response only | <project-relative path>
PR review: off | <repository>#<number>@<head SHA> as <bot login>
```

Call `start_collaboration`, then immediately show its `collaborationId`. Explain that the ID works from Codex App, Claude App, Antigravity App, and their CLIs.

While a provider turn is active, read `runtime.activeCall` from every `get_collaboration` result. Show its `agent`, `phase`, narrative `summary`, `summaryAt`, `heartbeatAt`, and elapsed time when the narrative or lifecycle changes. The summary is provider-authored or adapter-observed and must be shown verbatim; never invent an update. A process heartbeat proves liveness even when no fresh model summary exists.

The broker preflights requested participants. If one cannot start or later fails, show `PROVIDER SKIPPED`, its concise reason, the remaining participants, and any writer reassignment. Continue with two participants or one; do not retry the failed provider during the same phase. Stop only if none remain. Label a reduced result as degraded, not unanimous full-council consensus.

## Watch instead of disappearing

Unless the user explicitly asks for background execution, do not finish while status is `queued`, `running`, or `cancelling`.

Call `get_collaboration` repeatedly. For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds` at most 8. Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Show a full update when lifecycle or narrative fields change; if only heartbeat time or elapsed time changed, show at most one compact liveness line per 60 seconds. Never leave the UI at a static “Calling …” message.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Poll cadence is not display cadence: do not repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

```text
ROUND <number>
Finished: <agent> — <status>
Next: <agent or terminal state>
Summary: <one sentence>
Collaboration: <id>
```

For an unchanged running state, show:

```text
STILL WORKING
Active: <agent>
Phase: <phase>
Summary: <latest provider-authored summary | No new agent summary>
Last heartbeat: <timestamp or age>
Elapsed: <duration>
Collaboration: <id>
```

Do not expose chain-of-thought. Report only lifecycle state, handoff destination, elapsed activity when available, and completed peer output.

## Handle terminal states

- `agreed`: show the joint result and verification status.
- `needs_user`: show the exact question; use `continue_collaboration` after the answer.
- `turn_limit`: explain what remains and offer another bounded phase.
- `failed`: identify the failing peer and error; do not claim other work completed.
- `indeterminate`: preserve the writer and tell the user that execution state is unknown. Do not reassign ownership or start replacement work in the workspace; inspect provider/workspace state or explicitly cancel first.
- `cancelled`: confirm cancellation.

End with a timeline of participants and turn statuses plus the portable collaboration ID.

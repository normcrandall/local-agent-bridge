---
name: run-roundtable
description: Start and visibly monitor a persistent collaboration among Claude Code, Codex, Antigravity, and optional review-only Docker Model Runner or Ollama providers.
---

# Run Roundtable

Use the `collaboration` MCP server. Keep the user oriented throughout the detached run.

Accept natural language or an explicit form such as `$run-roundtable --agents claude,codex,antigravity --writer codex <task>`.

## Start visibly

Resolve participants, order, mode, maximum turns, and roles. Default to the three cloud agents, review mode, and six turns. For local review, include Docker Model Runner first. Include Ollama only as an availability fallback; its adapter must suppress it whenever Docker preflight is healthy, even if Ollama was explicitly named. In work mode select exactly one writer from Claude, Codex, or Antigravity. Docker and Ollama are always reviewers and can never be selected or promoted as writer. Omit all model fields unless the user explicitly overrides them.

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-4-8[1m]` and remove Fable from `modelFallbacks.claude`. Announce an explicitly authorized Fable use before starting. For that authorized phase only, pass `allowClaudeFable: true` to collaboration or `allowFable: true` to a direct Claude call. Never set either field otherwise; authorization resets on every collaboration continuation.

Pass user-provided downgrade chains as `modelFallbacks.claude` only after applying the Claude model policy above, and pass `modelFallbacks.codex` unchanged; otherwise omit them so the machine-local policy applies. Claude Code advances natively and Codex advances through the bridge only for recognized overload. Render any downgrade narrative immediately and never classify authentication, quota, permission, configuration, or transport errors as overload.

Extract exact verification commands from the task or repository guidance and choose one project-relative handoff file for Claude, normally under `.bridge/handoffs/`. Pass both `verificationCommands` and `handoffPath` to `start_collaboration` and every `continue_collaboration` phase. Claude reviewers may run only those commands and write only that handoff file.

When Claude is the work-mode writer, select `workProfile: implement` for local ownership through commit or `workProfile: deliver` when repository policy also assigns push and pull-request ownership. The profile avoids mid-task permission extensions for discovered tests, checksums, and normal Git/PR variants. Use additive `workCommands` only for unusual repository-specific tools.

Apply the same profile to a Codex writer: `implement` runs with workspace write access but no network; `deliver` enables network and authorizes requested push/PR delivery. Always pass the explicit absolute workspace. A collaboration retains its original workspace, writer, and profile even if the user later changes directories in Claude Code or Codex.

If the current host is a participant, pass `chair` with provider, optional session ID, exact workspace, and capabilities. The broker must suppress ordinary delegation to that same provider. Host-owned work remains in the native session; use `record_native_chair_turn` after the peer phase so the portable history distinguishes native-chair and delegated turns.

For pull-request work, read repository policy before starting. If it requires reviewer-authored PR feedback, resolve the exact repository, PR number, and current head SHA and pass them as `githubReview`. Omit identity fields so the broker selects each provider's user-owned reviewer App from machine-local configuration; use `expectedLogin` or `expectedLogins` only for an explicit strict bot policy. Never place App IDs, installation IDs, keys, or tokens in the skill or prompt. Claude and Codex reviewers receive bound `write_handoff` and `submit_pr_review` tools. Antigravity authors the same handoff/verdict/comment payload in a validated envelope, and the broker publishes it unchanged through the target-bound publisher. No reviewer receives general GitHub or `gh` access, and the writer never receives publication authority. Refresh the head SHA before each re-review phase.

An App verdict publishes exact-head `agent-review`; PAT compatibility is comment-only and cannot approve or publish the gate. Do not claim a bot approval satisfies GitHub's human-approval count, and never use a personal PAT to bypass that rule.

When the writer also owns PR lifecycle work, use `githubBuilder` for target-bound builder-App operations and set `allowedOperations` explicitly. Do not grant general `gh api` access. Creating/updating the PR, replying/resolving exact threads, and marking ready may follow the task contract; add `merge` only for an explicit user-approved policy and the exact current head SHA.

When the purpose includes resolving uncertainty, pass `decisionPolicy`. Reversible technical choices may be resolved within its turn/budget bound and recorded as one `DECISION:` receipt. Protected human categories always become `needs_user`; agreement never broadens permissions.

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
PR review: off | <repository>#<number>@<head SHA> using provider-configured identities | strict pins <bot logins>
```

Call `start_collaboration`, then immediately show its `collaborationId`. Explain that the ID works from Codex App, Claude App, Antigravity App, and their CLIs.

While a provider turn is active, read `runtime.activeCall` from every `get_collaboration` result. Show its `agent`, `phase`, narrative `summary`, `summaryAt`, `heartbeatAt`, and elapsed time when the narrative or lifecycle changes. The summary is provider-authored or adapter-observed and must be shown verbatim; never invent an update. A process heartbeat proves liveness even when no fresh model summary exists.

The broker preflights requested participants. If one cannot start or later fails, show `PROVIDER SKIPPED`, its concise reason, the remaining participants, and any writer reassignment. Continue with two participants or one; do not retry the failed provider during the same phase. Stop only if none remain. Label a reduced result as degraded, not unanimous full-council consensus.

## Watch instead of disappearing

Unless the user explicitly asks for background execution, do not finish while status is `queued`, `running`, or `cancelling`.

Call `get_collaboration` repeatedly. For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds` at most 8. Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Show a full update when lifecycle or narrative fields change; if only heartbeat time or elapsed time changed, show at most one compact liveness line per 60 seconds. Never leave the UI at a static “Calling …” message.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Poll cadence is not display cadence: do not repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

For a declared native chair, inspect `coordinatorWake` at terminal state. Fetch the newly completed turn, process `nextAction`, and call `acknowledge_coordinator_wake` with its exact sequence before continuing or recording native-chair completion. Host Stop/AfterAgent hooks prevent the coordinator from quietly ending while work or an actionable wake remains; SessionStart restores an unprocessed wake after restart. Never acknowledge a wake before acting on it. Let `needs_user` and `indeterminate` stop normally because they are protected human or inspection boundaries.

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

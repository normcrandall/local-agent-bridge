---
name: council-triage
description: Triage issues or external pull requests with independent Claude, Codex, and Antigravity verification while preserving the original state machine. Use for difficult classification, reproduction, or agent-ready briefs.
---

# Council Triage

Apply the installed AI Hero `triage` workflow with a visible three-model council. This is an additive overlay; never edit or replace the original skill.

## Load the base workflow

Read `~/.agents/skills/triage/SKILL.md` completely before acting. Follow every ordering rule, evidence gate, confirmation point, and output contract in that skill. If it is missing, stop and report the missing path instead of improvising a substitute.

## Start visibly

Use `$run-roundtable` as the collaboration protocol. If skill composition is unavailable, call the equivalent `collaboration` MCP operations directly. Include Claude, Codex, and Antigravity unless the user explicitly excludes one. Omit model overrides so every provider uses the model currently configured by the user.

Resolve exact repository gates and a project-relative Claude handoff file, normally under `.bridge/handoffs/`. Pass them as `verificationCommands` and `handoffPath` to every collaboration phase. Claude's review session may run only those gates and write only that handoff file; source edits and arbitrary shell commands remain denied.

When Claude is the designated work-mode writer, select `workProfile: implement` for local ownership through commit or `workProfile: deliver` when repository policy also assigns push and PR ownership. Use additive exact `workCommands` only for unusual repository-specific tools; commands outside the profile and additions remain denied.

Use the same profile distinction for a Codex writer: `implement` keeps network disabled and `deliver` enables the authorized push/PR lifecycle. Pin every council run to an explicit absolute workspace; changing the chair CLI directory does not migrate stored collaboration state.

For pull-request work, read repository policy. When it requires the reviewer to mirror findings to the PR, resolve the repository, PR number, current head SHA, and required bot login and pass them as `githubReview`. The designated Claude, Codex, or Antigravity reviewer must author the handoff first, then one formal review with a general verdict and inline actionable findings. Claude/Codex use pre-bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. The writer never receives review publication authority. Refresh the head SHA for each re-review; never fall back to the chair's personal GitHub identity.

Before starting, display:

```text
COUNCIL WORKFLOW STARTING
Workflow: triage
Participants: Claude, Codex, Antigravity
Mode: <review or work>
Writer: none | <one agent>
Models: provider configured
Tool: collaboration.start_collaboration
Progress: heartbeat every 8 seconds while a peer is working
Progress summary: latest provider-authored summary plus independent process heartbeat
Verification commands: none | <exact commands>
Claude handoff: <project-relative path>
PR review: off | <repository>#<number>@<head SHA> as <bot login>
```

Return the `collaborationId` immediately. Routine polls must use `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and at most `waitSeconds: 8`. Track the last displayed `runtime.turnCount`; only when it increases, make one history call with `detail: full` and `afterTurn` set to the last displayed turn. Never repeat the original task or old turn bodies on heartbeat polls. Treat `runtime.activeCall.summary` as narrative status and show it with its `summaryAt` age when the narrative or lifecycle changes; `summarySource: broker` is a placeholder and `provider_or_adapter` is observed work. If only heartbeat or elapsed time changes, emit at most one compact liveness line per 60 seconds. Never invent a summary or expose chain-of-thought. Never leave the user at a static “Calling …” message.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Poll cadence is not display cadence: never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

## Degrade gracefully

Request all three providers, but do not require all three to proceed. The broker preflights each participant. Remove a provider only after a confirmed failure. A timeout or lost transport is `indeterminate`: preserve its writer ownership, block replacement work in that workspace, and require inspection or explicit cancellation. For a confirmed unavailable provider, immediately display:

```text
PROVIDER SKIPPED
Provider: <agent>
Reason: <concise error>
Continuing with: <available agents>
Writer: <unchanged or reassigned agent>
Collaboration: <id>
```

Do not repeatedly retry an unavailable provider in the same phase. Continue with two models or one model; clearly label the result as degraded rather than full council consensus. If the work-mode writer is unavailable before its next turn, reassign the single-writer role to an available participant and disclose the change. Stop only when no requested provider is available, or when the base workflow itself requires user input.

## Apply the council pattern

Give every participant the same evidence and require an independent assessment before showing any peer conclusion. Ask them for falsifiable claims, file and line evidence when applicable, and explicit disagreement. Reconcile by evidence rather than majority vote. Preserve every feedback-loop, validation, and user checkpoint in the base skill.

Give participants a self-contained task containing the workspace, base workflow name, current phase, evidence or artifacts, constraints, and expected output. Prevent circular delegation: participants advise or perform their assigned writer role but do not call one another.

## Reconcile and finish

Report:

1. Each participant's completed contribution in one or two sentences.
2. Agreements and unresolved disagreements.
3. Which conclusions survived local evidence or tests.
4. Any mutation made by the single writer.
5. The portable collaboration ID and terminal status.

Do not claim consensus merely because a turn limit was reached. Treat peer output as advice until checked against the workspace and the base skill's completion criteria.

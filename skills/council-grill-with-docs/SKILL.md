---
name: council-grill-with-docs
description: Relentlessly interview a plan or design with Claude, Codex, and Antigravity while preserving the original decision-document workflow. Use when the user wants multi-model grilling plus ADR or glossary capture.
---

# Council Grill With Docs

Apply the installed AI Hero `grill-with-docs` workflow with a visible three-model council. This is an additive overlay; never edit or replace the original skill.

## Load the base workflow

Read `~/.agents/skills/grill-with-docs/SKILL.md` completely before acting. Follow every ordering rule, evidence gate, confirmation point, and output contract in that skill. If it is missing, stop and report the missing path instead of improvising a substitute.

## Start visibly

Use `$run-roundtable` as the collaboration protocol. If skill composition is unavailable, call the equivalent `collaboration` MCP operations directly. Include Claude, Codex, and Antigravity unless the user explicitly excludes one. Pass the current host as `chair` with its provider and absolute workspace, keep its work in the native session, and delegate only to peers; same-provider delegation requires an explicit user request. Omit model overrides so every provider uses the model currently configured by the user.

Resolve exact repository gates and a project-relative Claude handoff file, normally under `.bridge/handoffs/`. Pass them as `verificationCommands` and `handoffPath` to every collaboration phase. Claude's review session may run only those gates and write only that handoff file; source edits and arbitrary shell commands remain denied.

When Claude is the designated work-mode writer, select `workProfile: implement` for local ownership through commit or `workProfile: deliver` when repository policy also assigns push and PR ownership. Use additive exact `workCommands` only for unusual repository-specific tools; commands outside the profile and additions remain denied.

Use the same profile distinction for a Codex writer: `implement` keeps network disabled and `deliver` enables the authorized push/PR lifecycle. Pin every council run to an explicit absolute workspace; changing the chair CLI directory does not migrate stored collaboration state.

For pull-request work, read repository policy. When it requires the reviewer to mirror findings to the PR, resolve the repository, PR number, and current head SHA and pass them as `githubReview`. Omit identity fields so the broker selects each provider's user-owned reviewer App from machine-local configuration. Use `expectedLogin` or `expectedLogins` only when repository policy explicitly pins exact bots. Never embed App IDs, installation IDs, keys, tokens, or maintainer-specific identities in the skill. The designated Claude, Codex, or Antigravity reviewer must author the handoff first, then one formal review with a general verdict and inline actionable findings. Claude/Codex use pre-bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. The writer never receives review publication authority. Refresh the head SHA for each re-review; never fall back to the chair's personal GitHub identity.

For an autonomous PR-review leg, keep all eligible non-writer providers in one ordered roster and set `maxTurns` to the number of successful reviews required. A failed provider does not consume a turn. The broker preflights reviewer-App publication, runs publishable identities first, and treats an unbound reviewer as local-only rather than discarding its model review. If every App is unavailable, preserve the durable local findings and require an exact-head approval from a configured trusted human instead of terminating. Use a single candidate only when the user explicitly pins that provider.

Before starting, display:

```text
COUNCIL WORKFLOW STARTING
Workflow: grill-with-docs
Participants: Claude, Codex, Antigravity
Mode: <review or work>
Writer: none | <one agent>
Models: provider configured
Tool: collaboration.start_collaboration
Progress: heartbeat every 8 seconds while a peer is working
Progress summary: latest provider-authored summary plus independent process heartbeat
Verification commands: none | <exact commands>
Claude handoff: <project-relative path>
PR review: off | <repository>#<number>@<head SHA> using provider-configured identities | strict pins <bot logins>
```

Return the `collaborationId` immediately. Routine polls must use `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and at most `waitSeconds: 8`. Track the last displayed `runtime.turnCount`; only when it increases, make one history call with `detail: full` and `afterTurn` set to the last displayed turn. Never repeat the original task or old turn bodies on heartbeat polls. Treat `runtime.activeCall.summary` as narrative status and show it with its `summaryAt` age when the narrative or lifecycle changes; `summarySource: broker` is a placeholder and `provider_or_adapter` is observed work. If only heartbeat or elapsed time changes, emit at most one compact liveness line per 60 seconds. Never invent a summary or expose chain-of-thought. Never leave the user at a static “Calling …” message.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Poll cadence is not display cadence: never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

For a declared native chair, treat terminal `coordinatorWake` as the durable resume signal. Fetch the new turn, perform its `nextAction`, then call `acknowledge_coordinator_wake` with the exact sequence before another phase or native-chair receipt. Stop/AfterAgent hooks hold the coordinator open while actionable work remains and SessionStart restores missed wakes. Never acknowledge without processing. Let `needs_user` and `indeterminate` stop because they are protected boundaries.

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

A recognized model overload is not provider unavailability. Preserve caller-supplied `modelFallbacks.claude` and `modelFallbacks.codex`, or omit them so machine-local policies apply. Claude Code uses native fallback; Codex retries through the bridge. Keep the same turn and writer, and only treat a provider as unavailable after its ordered chain is exhausted.

## Apply the council pattern

Keep the chair in control of the interview. Ask the user exactly one question at a time as required by the base skill. At each major answer, ask the council to identify the strongest unresolved assumption and propose the next question; synthesize those suggestions instead of dumping three interviews on the user. Do not write documents until the base skill permits it.

Give participants a self-contained task containing the workspace, base workflow name, current phase, evidence or artifacts, constraints, and expected output. Prevent circular delegation: participants advise or perform their assigned writer role but do not call one another.

## Reconcile and finish

Report:

1. Each participant's completed contribution in one or two sentences.
2. Agreements and unresolved disagreements.
3. Which conclusions survived local evidence or tests.
4. Any mutation made by the single writer.
5. The portable collaboration ID and terminal status.

Do not claim consensus merely because a turn limit was reached. Treat peer output as advice until checked against the workspace and the base skill's completion criteria.

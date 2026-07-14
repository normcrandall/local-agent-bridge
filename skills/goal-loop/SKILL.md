---
name: goal-loop
description: Build a feature, application, document, or other workspace artifact through bounded plan, implement, review, and verification cycles with Claude, Codex, and Antigravity. Use when the user says to keep working until a concrete goal is done, asks for an autonomous build loop, wants several models to plan and cross-review implementation, or needs a resumable collaboration with explicit completion criteria.
---

# Goal Loop

Drive one concrete objective to verified completion using the persistent collaboration broker. The collaboration ID is the portable goal ID; do not depend on a chair-specific goal feature that other apps cannot inspect.

Accept natural language or an explicit form such as:

```text
$goal-loop --writer codex --max-cycles 4 --agents claude,codex,antigravity <goal>
```

## Establish the goal contract

Before starting, derive and show:

- **Objective:** one observable outcome.
- **Done when:** a finite checklist of independently verifiable conditions.
- **Verification:** commands, inspections, or artifact checks for each condition.
- **Review handoff:** one project-relative file that Claude may write while source remains read-only; follow a repository-specified handoff path, otherwise use `.bridge/handoffs/`.
- **PR source of truth:** when repository policy requires it, the exact PR head and bot identity that must receive each review phase.
- **Constraints:** scope, safety, compatibility, and user decisions already made.
- **Non-goals:** nearby work that must not expand the loop.
- **Writer:** exactly one participant allowed to mutate the workspace.
- **Native chair:** when the current Codex App, Claude Code, or Antigravity session owns the work, declare it with `chair` and delegate only to peers.
- **Merge policy:** default `human merge`; enable a builder-App merge only when the user explicitly authorizes it.
- **Bounds:** default four cycles and six peer turns per cycle.

Make reasonable reversible assumptions. Ask the user only when a missing decision would materially change the deliverable, authorize an external side effect, or make “done” impossible to verify.

Display:

```text
GOAL LOOP STARTING
Objective: <one sentence>
Done when: <count> checks
Participants: Claude, Codex, Antigravity
Writer: <one agent>
Cycles: <maximum, default 4>
Turns per cycle: <maximum, default 6>
Models: provider configured
Browser: <on or off>
Tool: collaboration.start_collaboration
Claude handoff: <project-relative path>
PR review: off | <repository>#<number>@<head SHA> as <bot login>
```

## Start the durable loop

Use `$run-roundtable` in work mode with the goal contract embedded in the shared task. If skill composition is unavailable, call `collaboration.start_collaboration` directly. Include all three providers unless the user narrows the set. Omit model fields unless the user explicitly supplies overrides.

Preserve `modelFallbacks.claude` and `modelFallbacks.codex` across every cycle, or omit them so machine-local policies apply. A recognized overload stays inside the provider turn and must not consume a goal cycle, reassign the writer, or mark the provider unavailable. Display any downgrade narrative and retain the routing policy or receipt in turn metadata.

Pass every exact shell gate from the goal contract as `verificationCommands` and the review handoff as `handoffPath`. These fields give Claude enough non-interactive permission to rerun the declared gates and maintain the handoff without allowing source edits or arbitrary shell commands.

If Claude is the designated writer, pass `workProfile: implement` for local ownership through commit or `workProfile: deliver` when the goal contract also assigns push and PR ownership. These profiles cover common TDD, checksum, package-manager, Git, and bounded PR commands across cycles. Use additive `workCommands` only for unusual repository-specific tooling.

Default `permissionProfile` to `standard`. Use `permissionProfile: yolo` only when the user explicitly says `yolo`, announce the bypass before starting, persist it across cycles, and never apply it to reviewer turns.

Use the same profile for a Codex writer. `implement` keeps network disabled; `deliver` enables network for the authorized push/PR lifecycle. Pin the goal to an explicit absolute workspace when it starts and never infer that an existing goal moved because the chair CLI changed directories.

When the pull request is the repository's source of truth for fixes, resolve and pass `githubReview` so the designated Claude, Codex, or Antigravity reviewer authors its own formal review as the required bot. Require the reviewer to author the durable handoff first, then actionable inline comments plus a general verdict. Antigravity's validated envelope is published unchanged by the bound broker adapter. Refresh `headSha` before every re-review cycle; a stale authorization must fail closed rather than comment on an older commit.

When PR delivery is assigned to the writer, pass `githubBuilder` with the exact repository, expected builder App login, current head SHA, PR/ref fields, and `allowedOperations`. Prefer its bound create/update, thread reply/resolve, ready, and merge operations over broad `gh` permissions. Leave `merge` out of the allowlist unless the goal contract explicitly says agents may merge; pin it to the verified head SHA.

For reversible technical questions, pass `decisionPolicy` and let participants emit a validated `DECISION:` receipt. Repository/user policy may add escalation categories. Money, legal/compliance, external authorization, destructive actions, and explicit user preferences always stop for the user and never gain authority through consensus.

Return the `collaborationId` immediately and label it as the goal ID. It must remain the same across every cycle so the work can be inspected or resumed from another configured app.

Give participants this cycle order:

1. Inspect current workspace state and verification evidence.
2. Identify the smallest remaining slice that advances a done condition.
3. Let only the designated writer implement that slice.
4. Have non-writers review the actual diff or artifact without editing.
5. Let the writer address validated findings.
6. Return concise completion evidence and remaining conditions.

Never allow overlapping writers. Do not commit, push, deploy, publish, send messages, or perform other external side effects unless the user authorized that action.

## Keep progress visible

For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds: 8` (or less). Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Display a full update when lifecycle or narrative fields change. If only heartbeat time or elapsed time changed, display at most one compact liveness line per 60 seconds:

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Poll cadence is not display cadence: never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

```text
GOAL <collaborationId>
Cycle: <current>/<maximum>
Phase: plan | implement | review | fix | verify
Active: <agent or chair verification>
Completed checks: <passed>/<total>
Elapsed: <duration>
```

Show completed peer output and lifecycle state, never chain-of-thought. Never leave the user at a static “Calling …” message.

Use `runtime.activeCall.summary` as the working agent's factual narrative update and `heartbeatAt` as the independent liveness signal. Display both. Never synthesize a model summary from silence. If a call becomes `indeterminate`, preserve writer ownership, stop the loop, and require inspection or explicit cancellation before replacement work.

## Degrade gracefully

Use the broker's provider fallback. When a provider is unavailable, display `PROVIDER SKIPPED`, the reason, remaining providers, and any writer reassignment. Continue with two models or one model. Do not retry the unavailable provider during the same cycle. Label reduced review as degraded. Stop only if no requested provider remains.

## Verify and decide after every cycle

The chair, not a peer's assertion, owns the completion check. Inspect the workspace and run the goal contract's relevant verification. Then display:

```text
LOOP CHECKPOINT
Goal: <collaborationId>
Cycle: <current>/<maximum>
Passed: <done conditions with evidence>
Remaining: <failed or unverified conditions>
Progress: advanced | no material progress
Decision: complete | continue | needs user | stopped
```

Use `continue_collaboration` with the same ID for the next cycle. Include failed checks, reviewer findings, current diff or artifact summary, and the next smallest slice. Preserve `workProfile` and pass the same or deliberately updated `verificationCommands`, additive `workCommands`, and `handoffPath`; when PR publication is required, pass `githubReview` with the refreshed head SHA. Preserve provider sessions; do not start a separate roundtable for each cycle.

If the host was declared as `chair`, keep its provider out of delegated agents and record completed host work with `record_native_chair_turn`. This preserves one portable history without launching a duplicate same-provider CLI session.

Mark the goal complete only when every “done when” condition has current evidence. Peer agreement without verification is insufficient.

## Stop conditions

Stop the loop when any condition is true:

- Every done condition passes: `complete`.
- A material user decision or new authorization is required: `needs user`.
- Two consecutive cycles make no material progress: `stalled`.
- The configured cycle limit is reached: `cycle limit`.
- The user cancels: `cancelled`.
- No requested provider remains available: `unavailable`.

Never silently extend the cycle limit. The user may explicitly start another bounded phase with the same collaboration ID.

## Finish visibly

End with the goal ID, terminal reason, files or artifacts changed, verification results, provider participation and skips, unresolved risks, and exact next action if incomplete. For completion, use:

```text
GOAL COMPLETE
Goal: <collaborationId>
Cycles used: <used>/<maximum>
Writer: <agent>
Verified: <passed>/<total>
Artifacts: <paths>
```

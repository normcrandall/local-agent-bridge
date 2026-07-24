---
name: ask-agent
description: Hand off one bounded task to Claude Code, Codex, Antigravity, or a local review-only Docker Model Runner or Ollama provider with a visible receipt showing the exact peer, MCP tool, workspace, permissions, and model policy.
---

# Ask Agent

Make one peer delegation legible. Keep orchestration in the current chair.

Accept natural language or an explicit form such as `$ask-agent --to codex --mode review <task>`.

## Resolve the call

Map the requested peer to its provider adapter:

| Peer | Start | Continue |
|---|---|---|
| Claude Code | `ask_claude` | `continue_claude` |
| Codex | `codex` | `codex-reply` |
| Antigravity | `ask_antigravity` | `continue_antigravity` |
| Docker Model Runner (preferred local review) | `ask_docker` | `continue_docker` |
| Ollama (review-only) | `ask_ollama` | `continue_ollama` |

If the required tool is unavailable, stop and identify the missing server. Never silently substitute a different peer.

Use the persistent `collaboration.start_collaboration` interface with `agents: [<peer>]` and `maxTurns: 1` for the actual handoff, including reviews. This returns immediately with a durable collaboration ID and makes `runtime.activeCall`, provider-authored summaries, automatic heartbeats, cancellation, and history available to every chair. The one-turn bound prevents the broker from starting a redundant second call to the same peer. The provider adapter tools in the table are the implementation layer used by the detached worker; do not block the chair inside a raw direct tool call.

Pass the current host as `chair` with its provider and absolute workspace. Do not delegate to that same provider unless the user explicitly requests same-provider delegation; otherwise keep the native chair and call only the named peer.

Default to read-only review. Permit work mode only when the user requested edits. Omit `model` unless the user explicitly supplied an override. Use browser access only when required by the task.

Docker Model Runner and Ollama are hard review-only providers. Always call Docker when it is available. Use Ollama only after Docker preflight reports unavailable; an explicit Ollama request does not override this machine policy. Never select either as `writer` or request `mode: work`; do not pass browser or `verificationCommands`. They may inspect repository state, files, literal searches, and Git diffs only through bounded adapter tools. Their `APPROVE` and `REQUEST_CHANGES` verdicts are evaluation-only and publish as non-authorizing comments while findings remain visible.

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-4-8[1m]` and remove Fable from `modelFallbacks.claude`. Announce an explicitly authorized Fable use before starting. For that authorized phase only, pass `allowClaudeFable: true` to collaboration or `allowFable: true` to a direct Claude call. Never set either field otherwise; authorization resets on every collaboration continuation.

Pass caller-supplied downgrade chains through `modelFallbacks.claude` only after applying the Claude model policy above, and pass `modelFallbacks.codex` unchanged. Otherwise omit them so `~/.config/local-agent-bridge/model-fallbacks.json` applies. Claude Code handles its chain natively; the Codex adapter repeats the original ask, preserves an established continuation thread when applicable, and emits a downgrade narrative. Fallback applies only to recognized model overload, never authentication, permission, quota, configuration, or transport failures.

For a Claude review, identify the exact repository verification commands and one project-relative handoff file before calling. Pass them as `verificationCommands` and `handoffPath`. Claude may read the workspace, run only those commands, and create or edit only that handoff file; arbitrary Bash, source edits, posting, commits, pushes, and other writes remain denied. Reuse the same fields with `continue_claude`.

For work mode, default `permissionProfile` to `standard`. Set `permissionProfile: yolo` only when the user explicitly says `yolo`; never infer it from urgency or broad implementation language. Before calling, warn that the designated writer will bypass provider approvals and sandbox protections. One provider-specific review exception is automatic: an Antigravity review carrying `verificationCommands` uses `--dangerously-skip-permissions` because `agy` exposes no exact non-interactive command grant. Static Antigravity reviews remain sandboxed; Claude keeps exact command grants. Codex automatically continues as a static exact-head review with the commands withheld, while local/full and hosted CI remain separate evidence; do not manually restart it without commands.

For Claude work mode, use `workProfile: implement` when Claude owns local implementation through commit. Use `workProfile: deliver` when repository policy also assigns Claude the push and pull-request lifecycle. These profiles cover common package-manager, test, checksum, Git, and bounded `gh pr` command families so discovered commands do not require a continuation. Keep `workCommands` only as an additive escape hatch for unusual repository-specific tools.

Use the same `workProfile` distinction when Codex is the delegated writer. `implement` keeps delegated Codex network-disabled and instructs it to stop after local verification/commit. `deliver` enables workspace network access and authorizes the requested push and PR lifecycle. Do not assume moving the chair CLI changes an existing session or collaboration's stored workspace, writer, or profile.

If repository instructions require the reviewer to mirror findings to the pull request, treat that as standing authorization for the review publication only. Resolve the repository, PR number, and exact current head SHA, then pass them as `githubReview` for Claude, Codex, or Antigravity. Omit identity fields so the broker selects the active provider's user-owned reviewer App from machine-local configuration. Set `expectedLogin` or a provider entry in `expectedLogins` only when repository policy explicitly pins an exact bot. Never embed App IDs, installation IDs, private keys, or tokens in a skill. The reviewer must author the durable handoff first, then one formal PR review with a general verdict and inline comments for actionable line-specific findings. Claude and Codex use the bound review tools directly. Antigravity authors a validated review envelope that the broker sends unchanged through the target-bound publisher because `agy` lacks per-session MCP injection. Do not substitute the chair's personal `gh` identity.

An App-authored formal approval is an exact-head machine-review gate. When the reviewer App also has Commit statuses write, its verdict publishes the optional exact-head `agent-review` status. A PAT compatibility credential is comment-only: it cannot approve, request changes, or publish either gate. Never describe a bot approval as satisfying GitHub's nonzero human-approval count, and never switch to a personal token to make it count.

## Show the handoff receipt

Before calling the tool, show:

```text
HANDOFF
From: <current chair>
To: <peer>
Purpose: <one sentence>
Tool: <exact MCP tool>
Broker: collaboration.start_collaboration
Mode: <review or work>
Workspace: <path>
Model: provider configured | <explicit override>
Model fallbacks: machine configured | none | Claude <chain>; Codex <chain>
Browser: off | isolated
Verification commands: none | <exact commands>
Work commands: none | <exact commands>
Work profile: exact | implement | deliver
Handoff file: response only | <project-relative path>
PR review: off | <repository>#<number>@<head SHA> using provider-configured identity | strict pin <bot login>
```

Then send a self-contained prompt containing the objective, constraints, relevant paths or diff, acceptance criteria, and expected output. Tell the peer not to invoke another agent.

Return the collaboration ID immediately. For routine polling call `get_collaboration` with `detail: status`, `includeTurns: 0`, the last `updatedAt` as `afterUpdatedAt`, and `waitSeconds: 8` (or less). Track the last displayed `runtime.turnCount`. Only when that count increases, make one history call with `detail: full`, `includeTurns` equal to the bounded number needed, and `afterTurn` set to the last displayed turn. Never request or repeat the original task and completed turn bodies on heartbeat-only polls. Continue until terminal. Treat `runtime.activeCall.summary` as the narrative status and show it verbatim with its `summaryAt` age; `summarySource: broker` is only a placeholder and `provider_or_adapter` is observed work. Distinguish narrative from the automatic liveness heartbeat. Never infer progress from silence or expose private reasoning.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each `get_collaboration` call separately and let it return within eight seconds. Render a full update immediately when status, agent, phase, summary, turn count, error, or terminal state changes. If only heartbeat time or elapsed time changed, emit at most one compact liveness line per 60 seconds. Never repeat an unchanged narrative card on every poll. Check GitHub only after the broker reports a completed turn or terminal state.

## Show the result receipt

After the call, show:

```text
HANDOFF COMPLETE
Peer: <peer>
Session: <sessionId or threadId or conversationId>
Handoff: response only | <path>
PR review: not requested | <event and URL>
Outcome: <short result>
Verification: unverified | <checks performed by chair>
```

Treat the peer response as advice until the chair checks relevant files and tests. For a follow-up, announce the continuation receipt and use the exact returned session identifier.

---
name: show-collaboration
description: Display the status, participants, handoffs, turns, errors, and portable ID for persistent agent collaborations. Use when the user asks what agents called, what happened during a handoff, whether work is still running, to resume a prior collaboration, or to inspect collaboration history.
---

# Show Collaboration

Turn bridge state into a readable audit timeline.

Accept natural language or `$show-collaboration <collaborationId>`.

## Locate the collaboration

If the user supplied an ID, call `get_collaboration` with `detail: full`; request turns only when the user wants history. Otherwise call `list_collaborations`, show the recent choices, and select the latest only when the user's intent is unambiguous.

Request up to 50 turns when the user asks for full history. `$ask-agent`, roundtable, goal-loop, pair-program, and council calls use the persistent collaboration ledger. Never invent history from raw provider calls made outside that broker.

If `runtime.activeCall` exists, lead with its active provider, phase, latest provider-authored summary, heartbeat age, start time, and status. Distinguish the automatic process heartbeat from the latest narrative summary. If status is `indeterminate`, state that writer ownership is preserved and replacement work is blocked until inspection and explicit cancellation.

If `coordinatorWake` exists, show its sequence, provider, kind, status, summary, next action, delivery adapter, and acknowledgement. An actionable pending or delivered wake means the native chair has not yet processed the terminal event. Acknowledge it only after the chair performs that action. `needs_user` and `indeterminate` wakes are intentionally non-actionable.

When monitoring a running collaboration, never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. Make separate bounded `get_collaboration` calls so the host CLI can redraw between heartbeats. Check external sources only after a completed turn or terminal state.

## Render the timeline

Show:

```text
COLLABORATION <id>
Status: <status>
Task: <task>
Participants: <ordered agents>
Mode: <mode>
Writer: <agent or none>
Workspace: <path>
Turns: <count>
Created: <time>
Updated: <time>

1. <time if available> <agent> — <status>
   <concise result summary>
2. ...
```

Include provider session IDs only when the user requests diagnostic detail. Show errors exactly and identify whether the run can be continued.

## Continue or monitor

For active work, long-poll compactly with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8` or less. Fetch `detail: full` with `afterTurn` only when `runtime.turnCount` advances. For `needs_user`, surface the question and use `continue_collaboration` only after receiving the answer. For a new phase, state that existing provider sessions will be reused.

If MCP history tools are unavailable, report the configuration problem. As a diagnostic fallback only, persistent state is stored under `~/.local/share/agent-bridge/state`.

---
name: replay-collaboration
description: Given an active or archived collaboration ID, run a deterministic replay workflow that produces a chronological, evidence-linked incident narrative, identifies the last confirmed state and next safe action, and drafts remediation without changing the original record.
---

# Replay Collaboration

Reconstruct a clean, chronological audit timeline from durable bridge records to diagnose failures and anomalies.

Accept natural language or `$replay-collaboration <collaborationId>`.

## Locate the target files

Locate the target files using the collaboration ID. If it is active, files reside in `.bridge/collaborations/`. If archived, they reside in `.bridge/collaborations/archive/`.

Call `replay_incident` to perform stream-based, incremental parsing of the `transcript.jsonl` file and any corresponding `github-builder-receipts.jsonl` in the workspace. Never load the entire file into memory at once or perform a state-mutating command.

## Analyze and classify the incident

Categorize the failure according to the observed evidence:
1. **Clean completion**: Timeline terminates with a successful `run_finished` or state `agreed`/`completed`, and cleanup successfully released all locks.
2. **Stale narrative with live heartbeat**: Worker is alive and sending heartbeats, but the narrative/summary is stale or is a generic broker placeholder.
3. **Lost completion wake**: Work completed successfully, but the chair has not acknowledged the final `coordinatorWake`.
4. **Overload fallback**: Standard model failed with overload or demand failures, triggering model recovery or fallback.
5. **Permission denial**: Git or directory EPERM, EACCES, or authorization failures occurred.
6. **Indeterminate mutation**: Mutation failed mid-operation, leaving the workspace in an indeterminate state.
7. **Orphan cleanup**: Worker terminated but locks/leases were not released.
8. **Truncated history**: History file ended abruptly or contained malformed JSON lines at the end.

## Report formatting

The human-readable output must strictly structure the findings:
- **Observed facts**: Facts directly backed by a line-numbered stable event reference (e.g. `[transcript.jsonl:12]` or `[github-builder-receipts.jsonl:1]`).
- **Inferred contributing factors**: Hypotheses based on observations. Visible separation between observation and inference is mandatory.
- **Remediation & next steps**:
  - Last Confirmed State
  - Unresolved Ownership (none, provider, user, chair, system, unknown)
  - Next Safe Action
- **Remediation Issue Draft**: Title and body draft for a GitHub remediation issue.

Ensure all outputs are fully sanitized: redact credentials (like GitHub personal access tokens or private keys) and omit provider-private data not present in the shared ledger.

## Polling & Wake Channel Rules

If monitoring or waiting for a running recovery process, apply the default-deny rules:
- Long-poll compactly with `detail: status`, `includeTurns: 0`, and `waitSeconds: 8` or less. Never block the host CLI with a long-running sleep or bash loop.
- Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Override to `claude-opus-5` and remove Fable from `modelFallbacks.claude` if Fable would be triggered without authorization.
- Process coordinator wakes deterministically. Acknowledge wakes only after executing the next action. Wakes with `needs_user` or `indeterminate` status must stop and prompt the user.

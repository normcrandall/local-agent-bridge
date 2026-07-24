---
name: agent-dialogue
description: Conduct a bounded, evidence-driven dialogue between Claude Code and Codex inside the current Claude Code session. Use when the user asks Claude to talk, debate, collaborate, cross-review, or reach agreement with Codex on a task.
argument-hint: "[--claude-model <id>] [--codex-model <id>] <shared task>"
disable-model-invocation: true
allowed-tools:
  - mcp__codex__codex
  - mcp__codex__codex-reply
---

# Agent Dialogue

Shared task: $ARGUMENTS

Act as both the Claude Code participant and the conversation chair. Talk to Codex through the `codex` MCP tools while keeping the full exchange in this Claude Code session.

## Workflow

1. Extract the objective, constraints, acceptance criteria, and requested mode from the shared task.
2. Default to read-only review. Use `sandbox: workspace-write` only when the user explicitly authorizes implementation or edits. Otherwise use `sandbox: read-only`. Use `approval-policy: never` inside that sandbox so an invisible nested prompt cannot stall the dialogue.
3. Form an initial Claude position grounded in the workspace.
4. Call `codex` with a self-contained task, the Claude position, `cwd` set to the project root, and this protocol:
   - Respond directly to Claude Code.
   - Challenge unsupported claims and cite workspace evidence.
   - End with `STATUS: CONTINUE`, `STATUS: AGREED`, or `STATUS: NEEDS_USER`.
5. Keep the returned `threadId`. Evaluate Codex's reply yourself and verify relevant claims locally.
6. If useful disagreement remains, call `codex-reply` with that `threadId`, your evidence-based response, and one focused question.
7. Make at most three Codex calls. Stop earlier when both sides agree or Codex returns `NEEDS_USER`.

## Model selection

- Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If this Claude session or its configured default resolves to Fable without that permission, tell the user to run `/model claude-opus-5` and re-invoke the skill. Remove Fable from any Claude fallback chain. Announce an explicitly authorized Fable use before starting. If this skill directly delegates back to Claude for an explicitly authorized phase, pass `allowFable: true`; never pass it otherwise.
- Treat both model flags as optional. When a flag is absent, omit the MCP `model` field entirely so the delegated CLI uses the user's saved settings or environment, subject to the Claude model policy.
- Accept `--codex-model <alias-or-id>` and pass the value unchanged as `model` on the initial `codex` call. `codex-reply` keeps that thread's model.
- Accept `--claude-model <alias-or-id>` as the requested host model only after applying the Claude model policy. If it differs from the active Claude session, tell the user to run `/model <alias-or-id>` and re-invoke the skill.
- Apart from the deny-by-default Fable rule, do not maintain a model allowlist or silently substitute another model. Let each provider validate availability.
- Keep any explicit model fixed for the associated `threadId`; otherwise keep using the provider-selected thread model.

## Planner and implementer roles

When the user assigns separate planning and implementation roles, enforce one writer and use the planner again for final review.

### Claude plans, Codex implements

1. Plan in this Claude session without editing. Produce file scope, risks, acceptance criteria, and verification commands.
2. Call `codex` with the requested `model`, `sandbox: workspace-write`, the complete plan, explicit file ownership, and `approval-policy: never`.
3. Review Codex's diff and verification evidence in Claude.
4. Use `codex-reply` only for specific validated fixes, then perform a final read-only review.

### Codex plans, Claude implements

1. Call `codex` with the requested `model`, `sandbox: read-only` and request a concrete plan with file scope, risks, acceptance criteria, and verification commands.
2. Validate the plan in Claude and resolve material uncertainty with `codex-reply` before editing.
3. Implement in this Claude session as the only writer and run verification.
4. Send the diff summary and test results to the same Codex `threadId` for final read-only review.

## Guardrails

- Never ask Codex to invoke Claude. Keep orchestration in this CLI session.
- Never use concurrent edits. In write mode, finish one agent's file changes before asking the other to inspect them.
- Treat peer claims as unverified until checked against files, tests, or primary sources.
- Ask the user one concrete question and stop when a product decision, credential, or new authority is required.
- Do not manufacture agreement. Preserve material disagreement in the final result.

## Final response

Return:

1. `Joint conclusion`
2. `Verified evidence`
3. `Remaining disagreement` (omit when empty)
4. `Actions taken or recommended`
5. `Peer calls used: N/3`

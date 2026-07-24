---
name: agent-dialogue
description: Conduct a bounded, evidence-driven dialogue between Codex and Claude Code inside the current Codex CLI session. Use when the user asks Codex to talk, debate, collaborate, cross-review, or reach agreement with Claude on a task. Do not use for a simple one-shot delegation when one Claude call is enough.
---

# Agent Dialogue

Act as both the Codex participant and the conversation chair. Talk to Claude through the `claude_code` MCP tools while keeping the full exchange in this Codex session.

## Workflow

1. Extract the shared objective, constraints, acceptance criteria, and requested mode from the user's prompt.
2. Default to read-only review. Use `mode: work` only when the user explicitly authorizes implementation or edits. Set `browser: true` only when explicitly requested.
   In review mode, pass the repository's exact gates as `verificationCommands` and one project-relative review artifact as `handoffPath`. Reuse both on continuations so Claude can rerun gates and maintain the handoff without editing source.
   When repository policy requires reviewer-authored PR feedback, resolve the exact repository, PR number, current head SHA, and required bot login and pass `githubReview`. Claude writes the handoff, then posts its formal review directly through the bound bot tool. Refresh the SHA for re-review.
3. Form an initial Codex position grounded in the workspace.
4. Call `ask_claude` with a self-contained task, the Codex position, and this protocol:
   - Respond directly to Codex.
   - Challenge unsupported claims and cite workspace evidence.
   - End with `STATUS: CONTINUE`, `STATUS: AGREED`, or `STATUS: NEEDS_USER`.
5. Evaluate Claude's reply yourself. Inspect the workspace or run read-only verification when useful. Do not merely relay messages.
6. If useful disagreement remains, call `continue_claude` with the returned `sessionId`, your evidence-based response, and one focused question.
7. Make at most three Claude calls. Stop earlier when both sides agree or Claude returns `NEEDS_USER`.

## Model selection

- Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-5` and remove Fable from any Claude fallback chain. Announce an explicitly authorized Fable use before starting. For that authorized direct call only, pass `allowFable: true`; never pass it otherwise.
- Treat both model flags as optional. When a flag is absent, omit the MCP `model` field entirely so the delegated CLI uses the user's saved settings or environment, except when the Claude model policy requires the Opus override.
- Accept `--claude-model <alias-or-id>` and pass the value as `model` to `ask_claude` and `continue_claude` only after applying the Claude model policy.
- Accept `--codex-model <alias-or-id>` as the requested host model. If it differs from the active Codex session, tell the user to restart with `codex -m <alias-or-id>` and re-invoke the skill.
- Apart from the deny-by-default Fable rule, do not maintain a model allowlist or silently substitute another model. Let each provider validate availability.
- Keep any explicit model fixed for the associated `sessionId`; otherwise keep using the provider-selected session model.

## Planner and implementer roles

When the user assigns separate planning and implementation roles, enforce one writer and use the planner again for final review.

### A Claude model plans, Codex implements

1. Call `ask_claude` with `model: <claude-model>`, `mode: review`, and request a concrete plan with file scope, risks, acceptance criteria, and verification commands.
2. Validate the plan against the workspace. Resolve material uncertainty with `continue_claude` before editing.
3. Implement with Codex as the only writer.
4. Run verification, then send the diff summary and test results to the same Claude `sessionId` and model in `mode: review` for final review.

### Codex plans, a Claude model implements

1. Produce and verify the Codex plan without editing.
2. Call `ask_claude` with `model: <claude-model>`, `mode: work`, the complete plan, explicit file ownership, acceptance criteria, verification commands, and `workProfile: implement` or `workProfile: deliver` according to whether Claude also owns push and PR delivery. Use additive `workCommands` only for unusual repository tooling.
3. Review Claude's changes and run verification with Codex.
4. Use `continue_claude` with the same model and `mode: work` only for specific validated fixes; otherwise keep re-review read-only.

## Guardrails

- Never ask Claude to invoke Codex. Keep orchestration in this CLI session.
- Never use concurrent edits. In work mode, finish one agent's file changes before asking the other to inspect them.
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

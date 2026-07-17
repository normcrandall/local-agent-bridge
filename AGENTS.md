# Codex collaboration guidance

Claude Code is available through the `claude_code` MCP server. Antigravity is available through the `antigravity` MCP server.

Prefer the installed collaboration skills as the user-facing interface. Announce the skill and the exact peer or broker it will call before starting:

- Use `$ask-agent` for one bounded handoff or review.
- Use `$run-roundtable` for a persistent multi-agent collaboration.
- Use `$show-collaboration` to inspect, monitor, or resume collaboration history.
- Use `$goal-loop` to build toward explicit completion criteria through bounded plan, implement, review, and verification cycles.
- Use `$pair-program` for rotating Claude/Codex/Antigravity implementer and reviewer roles with preflight, worktree isolation, CI tracking, budgets, recovery, and formal PR reviews.
- Use `$collaboration-doctor` for a read-only effective-policy audit of one workspace, provider roster, role, permission profile, fallback chain, and GitHub App boundary before delegation.
- Use `$take-the-helm` when the user delegates operational ownership of a goal or work queue and wants the council to resolve routine decisions without human interruption.
- Use `$council-discovery` to inspect an existing app, systematically search the public web for competitors and substitutes, reconcile evidence-backed feature proposals from Claude, Codex, and Antigravity, and publish implementation-ready GitHub issues through Wayfinder.
- Use `$council-grill-agents` when the user wants the chair to cross-examine Claude, Codex, and Antigravity for a defensible answer instead of interviewing the user.
- Use `$council-ux-review` to challenge a rendered application's UI and end-to-end UX with independent browser passes, cross-verification, and prioritized GitHub issues.
- Use a `$council-*` companion when the user wants an installed AI Hero workflow run by Claude, Codex, and Antigravity together. The original skill remains the single-agent option.

The raw MCP tools are the implementation layer behind these skills. Invoke them directly only when a skill is unavailable or the user explicitly asks for the low-level tool.

For a dialogue hosted in the current Codex CLI, use `$agent-dialogue`. Use `./bridge talk "<task>"` only when the user wants a neutral external broker and a standalone JSONL transcript. Do not simulate an unbounded back-and-forth through nested MCP calls.

For a persistent collaboration that can be inspected or resumed from Codex App, Claude App, or Antigravity App, use the `collaboration` MCP server. Start with `start_collaboration`, keep its returned `collaborationId`, poll with `get_collaboration`, answer or begin another phase with `continue_collaboration`, and cancel with `cancel_collaboration`. The call is asynchronous and survives the chair app closing.

For parallel `$take-the-helm` work, call `plan_portfolio` before mutation, then `create_portfolio` and retain its `helm-<uuid>`. Start only its selected non-conflicting frontier as separate work-mode collaborations in isolated worktrees with distinct writers. Record lane changes with `update_portfolio_item`. Queue verified exact PR heads with `enqueue_portfolio_merge`; serialize combined validation through `begin_portfolio_merge_validation`, `record_portfolio_merge_validation`, and `authorize_portfolio_merge`. The authorization proves SHA freshness but never grants merge permission. Use `recover_portfolio_merge_validation` for an inspected interrupted slot and `refresh_portfolio_target` for external target advances. After an independently authorized GitHub merge, call `record_portfolio_merge` to invalidate stale validations and release newly unblocked work.

Submit review-ready lanes immediately. The broker enforces machine-local `providerConcurrency`, defaulting every provider to one live work call and two concurrent review calls. Excess calls show `waiting_capacity` and wake automatically in FIFO order when a slot opens; do not serialize reviews manually in the chair.

When this Codex session is participating, pass `chair: { provider: "codex", workspace: <absolute workspace> }` so the broker calls only peers and records Codex work with `record_native_chair_turn`; do not launch a second Codex CLI unless the user explicitly requests same-provider delegation. Use `decisionPolicy` for bounded reversible technical choices. Money, legal/compliance, authorization expansion, destructive external actions, and explicit user-owned choices always require the user.

Poll compactly: use `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and a bounded `waitSeconds`. Track `runtime.turnCount`; only when it advances, fetch new completed output once with `detail: full`, a bounded `includeTurns`, and `afterTurn` set to the last displayed turn. Do not repeat the original task or old turn bodies on heartbeat-only polls.

Treat `runtime.activeCall.summary` as narrative status and show it with its `summaryAt` age when it changes. `summarySource: broker` is a placeholder, while `provider_or_adapter` is observed work; do not present the placeholder as agent-authored progress. Poll every eight seconds or less for detection, but do not print on every poll: render lifecycle or narrative changes immediately, and rate-limit liveness-only output to one compact line per 60 seconds. A fresh heartbeat with an old summary means the process is alive but its narrative is stale; say that plainly instead of repeating the old card.

Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling. Make separate `get_collaboration` calls that return within eight seconds so the host CLI can redraw between heartbeats. Consult GitHub only after the broker reports a completed turn or terminal state.

When a native-chair collaboration stops, treat `coordinatorWake` as the authoritative resume signal. Fetch the new terminal turn and completion receipt, perform its exact next action, then call `acknowledge_coordinator_wake` with the current sequence. Stop and session-start hooks keep the chair alive or restore the pending wake across restarts. Never acknowledge before processing it. A `needs_user` or `indeterminate` wake is a protected boundary: explain it and allow the host turn to stop instead of looping.

- Use `ask_claude` for an independent second opinion, review, or bounded delegated task.
- Use `ask_antigravity` for a bounded Gemini/Antigravity second opinion and `continue_antigravity` only with its returned `conversationId`.
- Default to `mode: review`. Use `mode: work` only when the user asked for implementation and concurrent edits will not conflict.
- Set `browser: true` only when the delegated task needs browser interaction. This supplies an isolated Playwright browser, not the Codex app's built-in browser or a signed-in profile.
- Give Claude a self-contained prompt with the relevant paths, constraints, and expected output.
- For Claude review calls, pass exact gates as `verificationCommands` and one project-relative artifact as `handoffPath`; this permits gate execution and that single handoff write while source remains read-only.
- For Claude work calls, choose `workProfile: implement` for local ownership through commit or `workProfile: deliver` when Claude also owns push and pull-request delivery. Use additive exact `workCommands` only for unusual repository-specific tools. Work mode permits file edits but denies commands outside the profile and explicit additions.
- For Codex work calls, use the same profiles: `implement` grants workspace writes with network disabled; `deliver` enables network for authorized push and pull-request delivery.
- Always pass the explicit absolute workspace when starting collaboration. Existing sessions retain their original workspace, writer, and work profile even if the chair CLI later changes directories.
- If repository policy makes the PR the review source of truth, pass `githubReview` with the exact repository, PR number, and current head SHA. Omit `expectedLogin` to select the active provider's configured reviewer App, or set it to pin a strict identity. The delegated Claude, Codex, or Antigravity reviewer must author its handoff and formal review. Claude/Codex use bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. An App review optionally publishes the exact-head `agent-review` status when the App has Commit statuses write; a PAT compatibility identity may only comment and never satisfies the gate.
- If the writer owns PR lifecycle operations, pass `githubBuilder` bound to the repository, expected builder App login, current head SHA, PR/ref, and explicit `allowedOperations`. Use these tools instead of broad `gh` access. Leave `merge` out unless the user explicitly authorizes the exact verified head SHA; otherwise stop at a green reviewed PR. Even with standing authorization, merge requires an exact-head `APPROVED` review from a configured reviewer App, exact-head `agent-review=success` from that App, or an exact-head `APPROVED` review from a machine-locally configured trusted human, plus GitHub's required CI/rules; bot approval does not satisfy a nonzero human-approval count.
- For autonomous critical reviews, pass the preferred reviewer and all eligible non-writer fallbacks as one ordered `agents` roster. A failed provider does not consume a successful-review turn. The broker preflights reviewer-App publication, prefers publishable identities, and degrades an unbound reviewer to a clearly labeled local handoff. If no App can publish, preserve the review and require exact-head approval from a configured trusted human; do not terminate solely because the bot channel is unavailable. Keep an explicitly user-pinned single-provider handoff single-provider.
- For chair-owned GitHub operations, try the configured App identity first. PAT fallback is restricted to allowlisted issue and non-authorizing PR lifecycle operations. Never use it for a push, merge, formal review decision, status/check, ruleset or branch-protection change, arbitrary API mutation, or to satisfy/bypass a human approval requirement. A policy rejection stops the pipeline.
- For a native-chair merge, call the collaboration broker's `merge_pull_request` with the exact repository, PR number, and current 40-character head SHA. It uses the configured builder App, rechecks the review gate and GitHub rules, and requires the repository to match machine-local `mergePolicy.autonomousMergeRepositories`. Never ask for a Bash allow rule for `gh pr merge`.
- Use `continue_claude` only with the returned session ID.
- Do not ask Claude to invoke Codex. The bridge disables nested MCP, and circular delegation is prohibited.
- Do not ask Antigravity to invoke Codex or Claude. The broker owns participant routing.
- Treat Claude's output as advice until it is verified against the workspace and tests.
- Omit provider model overrides unless the user explicitly requests one; the persistent broker preserves each provider's configured model by default.
- Preserve caller-supplied `modelFallbacks.claude` and `modelFallbacks.codex` across collaboration phases. If omitted, let each adapter use the machine-local policy. Claude Code uses its native fallback option; Codex repeats the original ask and preserves an established continuation thread when applicable. A recognized overload stays within the same turn; show any downgrade narrative and do not mark the provider unavailable or reassign its writer unless the ordered chain is exhausted. Never use model fallback for authentication, permission, quota, configuration, timeout, or transport errors.
- Preserve `modelFallbacks.antigravity` as well. Antigravity and Codex use bridge-managed overload retries; Claude uses its native chain. After every provider in an eligible roster is confirmed unavailable, the broker enters visible `recovering` state and retries the full roster using `providerRecovery`. Each recovery attempt begins again at every provider's preferred configured model, allowing automatic upgrade after capacity returns. Autonomous work lanes must list all eligible providers with an explicit preferred writer; use `wait_for_portfolio_lane` so expected head/CI progress is always raced against handoff, failure, cancellation, indeterminate ownership, and recovery.

For implementation followed by review:

1. Finish the implementation and relevant tests first.
2. Ask Claude in `review` mode to inspect the explicit diff or file list without editing.
3. Require findings ordered by severity with file and line references.
4. Validate each finding locally before changing code.
5. Use `continue_claude` for a focused re-review after fixes.
